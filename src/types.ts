export interface PluginSettings {
  batchSize: number;
  excludeFolders: string[];
  excludeTags: string[];
  excludeGlobs: string[];
  frontmatterImageProps: string[];
}

// Persisted per note. path/title are omitted — path is the map key in
// PluginData.previews, and title is always the file basename, so both are
// cheap to derive at read time instead of duplicating them on disk.
export interface StoredNotePreview {
  mtime: number;
  // Omitted entirely (not `null`) when the note has no image — most notes
  // don't, and skipping the key avoids paying for "imagePath":null on each.
  imagePath?: string;
  snippet: string;
}

export interface NotePreview extends StoredNotePreview {
  path: string;
  title: string;
}

export interface ViewHistoryEntry {
  path: string;
  viewedAt: number;
}

export interface PluginData {
  settings: PluginSettings;
  previews: Record<string, StoredNotePreview>;
  history: ViewHistoryEntry[];
}

export function titleFromPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}

export function toNotePreview(path: string, stored: StoredNotePreview): NotePreview {
  return { path, title: titleFromPath(path), ...stored };
}
