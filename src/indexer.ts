import { App, TFile } from 'obsidian';
import { PluginData, StoredNotePreview } from './types';
import { extractImage, extractSnippet } from './extract';
import { compileGlob } from './glob';

const INDEX_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export class Indexer {
  app: App;
  data: PluginData;
  private lastRefreshStartedAt = 0;
  private refreshPromise: Promise<void> | null = null;

  constructor(app: App, data: PluginData) {
    this.app = app;
    this.data = data;
  }

  async refreshIfStale(
    onProgress?: (done: number, total: number) => void,
    force = false
  ): Promise<boolean> {
    if (this.refreshPromise) {
      await this.refreshPromise;
      return false;
    }

    if (
      !force &&
      Date.now() - this.lastRefreshStartedAt < INDEX_REFRESH_INTERVAL_MS
    ) {
      return false;
    }

    this.lastRefreshStartedAt = Date.now();
    this.refreshPromise = this.buildOrUpdateIndex(onProgress);

    try {
      await this.refreshPromise;
      return true;
    } finally {
      this.refreshPromise = null;
    }
  }

  getCandidateFiles(): TFile[] {
    const candidates: TFile[] = [];
    const allFiles = this.app.vault.getMarkdownFiles();
    const excludeFolders = this.data.settings.excludeFolders
      .map((folderPath) => folderPath.replace(/\/+$/, ''))
      .filter((folderPath) => folderPath.length > 0);
    const excludeGlobs = this.data.settings.excludeGlobs.map(compileGlob);
    const excludeTags = new Set(
      this.data.settings.excludeTags.map((tag) => tag.toLowerCase())
    );

    for (const file of allFiles) {
      // Filter out files inside any excluded folder.
      let excluded = false;

      for (const folderPath of excludeFolders) {
        if (
          file.path === folderPath ||
          file.path.startsWith(`${folderPath}/`)
        ) {
          excluded = true;
          break;
        }
      }

      if (excluded) {
        continue;
      }

      // Filter out files matching any excludeGlobs
      for (const glob of excludeGlobs) {
        if (glob.test(file.path)) {
          excluded = true;
          break;
        }
      }

      if (excluded) {
        continue;
      }

      if (excludeTags.size === 0) {
        candidates.push(file);
        continue;
      }

      // Filter out files whose tags intersect excludeTags
      const fileCache = this.app.metadataCache.getFileCache(file);
      const fileTags = new Set<string>();

      // Get tags from frontmatter
      if (fileCache?.frontmatter?.tags) {
        const frontmatterTags: unknown = fileCache.frontmatter.tags;
        if (Array.isArray(frontmatterTags)) {
          frontmatterTags.forEach((tag) => {
            if (typeof tag === 'string') {
              fileTags.add(tag.toLowerCase());
            }
          });
        } else if (typeof frontmatterTags === 'string') {
          frontmatterTags.split(/\s+/).forEach((tag) => {
            if (tag) {
              fileTags.add(tag.toLowerCase());
            }
          });
        }
      }

      // Get tags from body
      if (fileCache?.tags) {
        fileCache.tags.forEach((tagRef) => {
          fileTags.add(tagRef.tag.substring(1).toLowerCase()); // remove # prefix
        });
      }

      let hasExcludedTag = false;
      for (const excludeTag of excludeTags) {
        if (fileTags.has(excludeTag)) {
          hasExcludedTag = true;
          break;
        }
      }

      if (hasExcludedTag) {
        continue;
      }

      candidates.push(file);
    }

    return candidates;
  }

  async buildOrUpdateIndex(
    onProgress?: (done: number, total: number) => void
  ): Promise<void> {
    const candidates = this.getCandidateFiles();
    const total = candidates.length;

    // Keep reads parallel but bounded for mobile devices and large notes.
    const chunkSize = 8;

    for (let i = 0; i < candidates.length; i += chunkSize) {
      const chunk = candidates.slice(i, i + chunkSize);

      await Promise.all(
        chunk.map(async (file) => {
          // Check if cached preview is still valid
          if (this.data.previews[file.path]?.mtime === file.stat.mtime) {
            // Reuse cached preview
            return;
          }

          // Build new preview
          const content = await this.app.vault.cachedRead(file);
          const fileCache = this.app.metadataCache.getFileCache(file);
          const rawFrontmatter: unknown = fileCache?.frontmatter;
          const frontmatter = isRecord(rawFrontmatter)
            ? rawFrontmatter
            : undefined;

          const imagePath = extractImage(
            content,
            frontmatter,
            this.data.settings.frontmatterImageProps
          );
          const snippet = extractSnippet(content);
          const mediaOnly =
            (Boolean(imagePath) && snippet === '(no preview text)') ||
            /^📎 .+ attached$/.test(snippet);

          const preview: StoredNotePreview = {
            mtime: file.stat.mtime,
            ...(imagePath ? { imagePath } : {}),
            ...(mediaOnly ? { mediaOnly: true as const } : {}),
            snippet: snippet,
          };

          this.data.previews[file.path] = preview;
        })
      );

      // Yield to UI
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));

      if (onProgress) {
        onProgress(Math.min(i + chunkSize, total), total);
      }
    }

    // Remove stale entries
    const candidatePaths = new Set(candidates.map((f) => f.path));
    const previewKeys = Object.keys(this.data.previews);

    for (const path of previewKeys) {
      if (!candidatePaths.has(path)) {
        delete this.data.previews[path];
      }
    }
  }

  resolveImageSrc(imagePath: string, file: TFile): string | null {
    // Check if it's a URL
    if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
      return imagePath;
    }

    // Markdown-style image links (![alt](path)) are URL-encoded (e.g. %20 for
    // spaces); vault lookup needs the literal decoded path.
    let lookupPath = imagePath;
    try {
      lookupPath = decodeURIComponent(imagePath);
    } catch {
      // Not valid percent-encoding — use as-is.
    }

    // Try to resolve as a vault path
    const resolvedFile = this.app.metadataCache.getFirstLinkpathDest(
      lookupPath,
      file.path
    );

    if (resolvedFile) {
      return this.app.vault.getResourcePath(resolvedFile);
    }

    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
