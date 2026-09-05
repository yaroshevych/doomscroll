import { Plugin, normalizePath } from 'obsidian';
import { PluginData, StoredNotePreview } from './types';
import { DEFAULT_SETTINGS, DoomscrollSettingTab } from './settings';
import { Indexer } from './indexer';
import { DoomscrollView, VIEW_TYPE_DOOMSCROLL } from './view';

const INDEX_FORMAT_VERSION = 2;

export default class DoomscrollPlugin extends Plugin {
  data!: PluginData;
  indexer!: Indexer;
  private settingsRefreshTimer: number | null = null;

  async onload(): Promise<void> {
    // Load data
    const loadedData = (await this.loadData()) as PluginData | null;

    this.data = {
      settings: { ...DEFAULT_SETTINGS, ...loadedData?.settings },
      previews: loadedData?.previews || {},
      history: loadedData?.history || [],
      indexFormatVersion: loadedData?.indexFormatVersion ?? 0,
    };

    // Migrate: earlier versions stored path/title/ctime on each preview
    // (duplicating the map key and an unused field) and kept imagePath as
    // an explicit null. Strip them so old vaults' data.json shrinks; the
    // index-format migration below also refreshes cached metadata once.
    let migrated = false;
    type LegacyPreview = Omit<StoredNotePreview, 'imagePath'> & {
      path?: unknown;
      title?: unknown;
      ctime?: unknown;
      imagePath?: string | null;
    };

    for (const preview of Object.values(
      this.data.previews
    ) as LegacyPreview[]) {
      if (
        'path' in preview ||
        'title' in preview ||
        'ctime' in preview ||
        preview.imagePath === null ||
        'snippet' in preview
      ) {
        delete preview.path;
        delete preview.title;
        delete preview.ctime;
        if (preview.imagePath === null) {
          delete preview.imagePath;
        }
        if ('snippet' in preview) {
          // Legacy indexes used the snippet text to identify media-only
          // notes. Preserve that classification until the forced rebuild
          // below replaces the entry with the current metadata format.
          if (
            preview.snippet === '(no preview text)' ||
            /^📎 .+ attached$/.test(preview.snippet ?? '')
          ) {
            preview.mediaOnly = true;
          }
          // New metadata also considers piped embeds and code blocks, so do
          // not let an old mtime-valid entry bypass reclassification.
          preview.mtime = 0;
          delete preview.snippet;
        }
        migrated = true;
      }
    }

    const normalizedExcludedFolders = Array.from(
      new Set(
        this.data.settings.excludeFolders
          .map((folder) => normalizePath(folder.trim()).replace(/\/+$/, ''))
          .filter((folder) => folder.length > 0 && folder !== '.')
      )
    );
    if (
      JSON.stringify(normalizedExcludedFolders) !==
      JSON.stringify(this.data.settings.excludeFolders)
    ) {
      this.data.settings.excludeFolders = normalizedExcludedFolders;
      migrated = true;
    }

    if (!loadedData?.settings || !('simplifiedView' in loadedData.settings)) {
      migrated = true;
    }

    if (this.data.indexFormatVersion !== INDEX_FORMAT_VERSION) {
      // Rebuild all cached metadata once. This also repairs data written by
      // the intermediate on-demand-preview migration, which removed legacy
      // snippets before mediaOnly classification was persisted.
      for (const preview of Object.values(this.data.previews)) {
        preview.mtime = 0;
      }
      this.data.indexFormatVersion = INDEX_FORMAT_VERSION;
      migrated = true;
    }

    if (migrated) {
      await this.saveSettings();
    }

    // Instantiate indexer
    this.indexer = new Indexer(this.app, this.data);

    // Register view
    this.registerView(
      VIEW_TYPE_DOOMSCROLL,
      (leaf) => new DoomscrollView(leaf, this)
    );

    // Ribbon icon
    this.addRibbonIcon('gallery-vertical', 'Open feed', () => {
      void this.activateView();
    });

    // Command to open Doomscroll
    this.addCommand({
      id: 'open-feed',
      name: 'Open feed',
      callback: () => {
        void this.activateView();
      },
    });

    // Settings tab
    this.addSettingTab(new DoomscrollSettingTab(this.app, this));
  }

  async activateView(): Promise<void> {
    // Try to reuse existing leaf
    const existingLeaf = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_DOOMSCROLL
    )[0];

    if (existingLeaf) {
      await this.app.workspace.revealLeaf(existingLeaf);
      const view = existingLeaf.view;
      if (view instanceof DoomscrollView) {
        await view.refreshForCurrentSettings();
      }
      return;
    }

    // Create new leaf in main workspace
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({
      type: VIEW_TYPE_DOOMSCROLL,
      active: true,
    });
    await this.app.workspace.revealLeaf(leaf);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.data);
  }

  async saveSettingsAndRefreshViews(): Promise<void> {
    await this.saveSettings();
    this.scheduleViewRefresh();
  }

  private scheduleViewRefresh(): void {
    if (this.settingsRefreshTimer !== null) {
      window.clearTimeout(this.settingsRefreshTimer);
    }

    this.settingsRefreshTimer = window.setTimeout(() => {
      this.settingsRefreshTimer = null;
      const views = this.app.workspace
        .getLeavesOfType(VIEW_TYPE_DOOMSCROLL)
        .map((leaf) => leaf.view)
        .filter((view): view is DoomscrollView => view instanceof DoomscrollView);

      void Promise.all(views.map((view) => view.refreshForCurrentSettings()));
    }, 250);
  }

  onunload(): void {
    if (this.settingsRefreshTimer !== null) {
      window.clearTimeout(this.settingsRefreshTimer);
      this.settingsRefreshTimer = null;
    }
  }
}
