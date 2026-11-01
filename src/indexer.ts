import { App, TFile } from 'obsidian';
import { FeedFilters, PluginData, StoredNotePreview } from './types';
import {
  extractImage,
  extractFrontmatterImages,
  hasMediaEmbed,
  hasTextualPreviewContent,
} from './extract';
import { isImagePath } from './media';
import { compileGlob } from './glob';
import { matchesSearchQuery } from './search';

const INDEX_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export class Indexer {
  app: App;
  data: PluginData;
  private lastRefreshStartedAt = new Map<string, number>();
  private lastIndexedSettingsKey = new Map<string, string>();
  private refreshPromises = new Map<string, Promise<void>>();

  constructor(app: App, data: PluginData) {
    this.app = app;
    this.data = data;
  }

  markDirty(): void {
    this.lastRefreshStartedAt.clear();
  }

  async refreshIfStale(
    onProgress?: (done: number, total: number) => void,
    force = false,
    filters: FeedFilters = this.data.settings,
    feedId = 'default'
  ): Promise<boolean> {
    const runningRefresh = this.refreshPromises.get(feedId);
    if (runningRefresh) {
      await runningRefresh;
      // The caller waited for another refresh; it did not start one itself.
      return false;
    }

    const settingsKey = this.getIndexSettingsKey(filters);
    const settingsChanged =
      settingsKey !== this.lastIndexedSettingsKey.get(feedId);
    const lastRefreshStartedAt = this.lastRefreshStartedAt.get(feedId) ?? 0;

    if (
      !force &&
      !settingsChanged &&
      Date.now() - lastRefreshStartedAt < INDEX_REFRESH_INTERVAL_MS
    ) {
      return false;
    }

    this.lastRefreshStartedAt.set(feedId, Date.now());
    const refreshPromise = this.buildOrUpdateIndex(
      onProgress,
      filters,
      feedId
    );
    this.refreshPromises.set(feedId, refreshPromise);

    try {
      await refreshPromise;
      // Keep the key captured at refresh start. If settings changed while an
      // index was being built, the next refresh will rebuild for the new key.
      this.lastIndexedSettingsKey.set(feedId, settingsKey);
      return true;
    } finally {
      if (this.refreshPromises.get(feedId) === refreshPromise) {
        this.refreshPromises.delete(feedId);
      }
    }
  }

  private getIndexSettingsKey(filters: FeedFilters): string {
    return JSON.stringify({
      excludeFolders: filters.excludeFolders,
      excludeTags: filters.excludeTags,
      excludeGlobs: filters.excludeGlobs,
      searchQuery: filters.searchQuery,
      frontmatterImageProps: this.data.settings.frontmatterImageProps,
      showNonMarkdownFiles: this.data.settings.showNonMarkdownFiles,
    });
  }

  getCandidateFiles(filters: FeedFilters = this.data.settings): TFile[] {
    const candidates: TFile[] = [];
    const allFiles = this.app.vault.getFiles();
    const referencedAttachmentPaths = new Set<string>();
    if (this.data.settings.showNonMarkdownFiles) {
      for (const sourceFile of allFiles) {
        if (sourceFile.extension.toLowerCase() !== 'md') continue;
        const fileCache = this.app.metadataCache.getFileCache(sourceFile);
        for (const embed of fileCache?.embeds ?? []) {
          const linkedFile = this.app.metadataCache.getFirstLinkpathDest(
            embed.link,
            sourceFile.path
          );
          if (linkedFile instanceof TFile) {
            referencedAttachmentPaths.add(linkedFile.path);
          }
        }

        const frontmatter = fileCache?.frontmatter;
        if (!isRecord(frontmatter)) continue;

        for (const imagePath of extractFrontmatterImages(
          frontmatter,
          this.data.settings.frontmatterImageProps
        )) {
          if (/^https?:\/\//i.test(imagePath)) continue;
          let lookupPath = imagePath;
          try {
            lookupPath = decodeURIComponent(imagePath);
          } catch {
            // Keep the original path when it is not URI-encoded.
          }
          const directFile = this.app.vault.getAbstractFileByPath(lookupPath);
          const linkedFile =
            directFile instanceof TFile
              ? directFile
              : this.app.metadataCache.getFirstLinkpathDest(
                  lookupPath,
                  sourceFile.path
                );
          if (linkedFile instanceof TFile && isImagePath(linkedFile.path)) {
            referencedAttachmentPaths.add(linkedFile.path);
          }
        }
      }
    }
    const excludeFolders = filters.excludeFolders
      .map((folderPath) => folderPath.replace(/\/+$/, ''))
      .filter((folderPath) => folderPath.length > 0);
    const excludeGlobs = filters.excludeGlobs.map(compileGlob);
    const excludeTags = new Set(
      filters.excludeTags.map((tag) => tag.toLowerCase())
    );

    for (const file of allFiles) {
      // Filter out files inside any excluded folder.
      let excluded = false;
      const filePath = file.path.toLowerCase();
      const fileName = file.path.slice(file.path.lastIndexOf('/') + 1);

      for (const folderPath of excludeFolders) {
        const normalizedFolderPath = folderPath.toLowerCase();
        if (
          filePath === normalizedFolderPath ||
          filePath.startsWith(`${normalizedFolderPath}/`)
        ) {
          excluded = true;
          break;
        }
      }

      if (excluded) {
        continue;
      }

      // Match filename patterns against both the full vault path and the
      // filename, so `Daily/*` can target a folder while `*.draft.md` or
      // `*.*` works for files in any folder.
      for (const glob of excludeGlobs) {
        if (glob.test(file.path) || glob.test(fileName)) {
          excluded = true;
          break;
        }
      }

      if (excluded) {
        continue;
      }

      // Standalone attachments cannot have Markdown tags. They still pass
      // folder/glob filters and can be matched by path search terms.
      const isMarkdown = file.extension.toLowerCase() === 'md';
      if (
        !isMarkdown &&
        referencedAttachmentPaths.has(file.path)
      ) {
        continue;
      }
      if (!isMarkdown && !this.data.settings.showNonMarkdownFiles) {
        continue;
      }
      if (!isMarkdown || excludeTags.size === 0) {
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

  private getPreviewCache(
    feedId: string
  ): Record<string, StoredNotePreview> {
    if (feedId === 'default') return this.data.previews;
    return (this.data.feedPreviews[feedId] ??= {});
  }

  async buildOrUpdateIndex(
    onProgress?: (done: number, total: number) => void,
    filters: FeedFilters = this.data.settings,
    feedId = 'default'
  ): Promise<void> {
    const candidates = this.getCandidateFiles(filters);
    const total = candidates.length;
    const searchQuery = filters.searchQuery.trim();
    const previews = this.getPreviewCache(feedId);
    const matchedCandidatePaths = new Set<string>();

    // Keep reads parallel but bounded for mobile devices and large notes.
    const chunkSize = 8;

    for (let i = 0; i < candidates.length; i += chunkSize) {
      const chunk = candidates.slice(i, i + chunkSize);

      await Promise.all(
        chunk.map(async (file) => {
          let content: string | null = null;
          let fileCache = this.app.metadataCache.getFileCache(file);
          const isMarkdown = file.extension.toLowerCase() === 'md';

          if (!isMarkdown) {
            if (
              searchQuery &&
              !matchesSearchQuery(searchQuery, {
                path: file.path,
                content: '',
                frontmatter: undefined,
              })
            ) {
              return;
            }

            matchedCandidatePaths.add(file.path);
            if (
              previews[file.path]?.mtime === file.stat.mtime &&
              previews[file.path]?.attachment
            ) {
              return;
            }

            previews[file.path] = {
              mtime: file.stat.mtime,
              mediaOnly: true,
              attachment: true,
              ...(isImagePath(file.path) ? { imagePath: file.path } : {}),
            };
            return;
          }

          if (searchQuery) {
            content = await this.app.vault.cachedRead(file);
            const frontmatter = isRecord(fileCache?.frontmatter)
              ? fileCache.frontmatter
              : undefined;
            if (!matchesSearchQuery(searchQuery, {
              path: file.path,
              content,
              frontmatter,
            })) {
              return;
            }
          }

          matchedCandidatePaths.add(file.path);

          // Check if cached preview is still valid
          if (previews[file.path]?.mtime === file.stat.mtime) {
            // Reuse cached preview
            return;
          }

          // Build new preview
          content ??= await this.app.vault.cachedRead(file);
          fileCache ??= this.app.metadataCache.getFileCache(file);
          const rawFrontmatter: unknown = fileCache?.frontmatter;
          const frontmatter = isRecord(rawFrontmatter)
            ? rawFrontmatter
            : undefined;

          const imagePath = extractImage(
            content,
            frontmatter,
            this.data.settings.frontmatterImageProps
          );
          const mediaOnly =
            (Boolean(imagePath) || hasMediaEmbed(content)) &&
            !hasTextualPreviewContent(content);

          const preview: StoredNotePreview = {
            mtime: file.stat.mtime,
            ...(imagePath ? { imagePath } : {}),
            ...(mediaOnly ? { mediaOnly: true as const } : {}),
          };

          previews[file.path] = preview;
        })
      );

      // Yield to UI
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));

      if (onProgress) {
        onProgress(Math.min(i + chunkSize, total), total);
      }
    }

    // Remove stale entries
    const candidatePaths = matchedCandidatePaths;
    const previewKeys = Object.keys(previews);

    for (const path of previewKeys) {
      if (!candidatePaths.has(path)) {
        delete previews[path];
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

    // A standalone attachment points directly at itself. Resolve it without
    // asking the metadata cache to interpret the path as a link from that
    // same file.
    const directFile = this.app.vault.getAbstractFileByPath(lookupPath);
    if (directFile instanceof TFile) {
      return this.app.vault.getResourcePath(directFile);
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
