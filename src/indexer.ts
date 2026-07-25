import { App, TFile } from 'obsidian';
import { PluginData, StoredNotePreview } from './types';
import { extractImage, extractSnippet } from './extract';
import { globMatch } from './glob';

export class Indexer {
  app: App;
  data: PluginData;

  constructor(app: App, data: PluginData) {
    this.app = app;
    this.data = data;
  }

  getCandidateFiles(): TFile[] {
    const candidates: TFile[] = [];

    const allFiles = this.app.vault.getMarkdownFiles();

    for (const file of allFiles) {
      // Filter out files whose path starts with any excludeFolders
      let excluded = false;

      for (const folderPath of this.data.settings.excludeFolders) {
        if (file.path.startsWith(folderPath)) {
          excluded = true;
          break;
        }
      }

      if (excluded) {
        continue;
      }

      // Filter out files matching any excludeGlobs
      for (const glob of this.data.settings.excludeGlobs) {
        if (globMatch(glob, file.path)) {
          excluded = true;
          break;
        }
      }

      if (excluded) {
        continue;
      }

      // Filter out files whose tags intersect excludeTags
      const fileCache = this.app.metadataCache.getFileCache(file);
      const fileTags = new Set<string>();

      // Get tags from frontmatter
      if (fileCache?.frontmatter?.tags) {
        const frontmatterTags = fileCache.frontmatter.tags;
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
      for (const excludeTag of this.data.settings.excludeTags) {
        if (fileTags.has(excludeTag.toLowerCase())) {
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

    // Process in chunks of 20
    const chunkSize = 20;

    for (let i = 0; i < candidates.length; i += chunkSize) {
      const chunk = candidates.slice(i, i + chunkSize);

      for (const file of chunk) {
        // Check if cached preview is still valid
        if (this.data.previews[file.path]?.mtime === file.stat.mtime) {
          // Reuse cached preview
          continue;
        }

        // Build new preview
        const content = await this.app.vault.cachedRead(file);
        const fileCache = this.app.metadataCache.getFileCache(file);
        const frontmatter = fileCache?.frontmatter;

        const imagePath = extractImage(
          content,
          frontmatter,
          this.data.settings.frontmatterImageProps
        );
        const snippet = extractSnippet(content);

        const preview: StoredNotePreview = {
          mtime: file.stat.mtime,
          ...(imagePath ? { imagePath } : {}),
          snippet: snippet,
        };

        this.data.previews[file.path] = preview;
      }

      // Yield to UI
      await new Promise((r) => setTimeout(r, 0));

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
