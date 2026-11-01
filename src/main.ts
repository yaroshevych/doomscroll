import { Plugin, normalizePath } from 'obsidian';
import { FeedFilters, isPreviewSize, PluginData, StoredNotePreview } from './types';
import { DEFAULT_SETTINGS, DoomscrollSettingTab } from './settings';
import { Indexer } from './indexer';
import { uuidv7 } from './uuid';
import { DoomscrollView, VIEW_TYPE_DOOMSCROLL } from './view';

const INDEX_FORMAT_VERSION = 3;

export default class DoomscrollPlugin extends Plugin {
  data!: PluginData;
  indexer!: Indexer;
  private settingsRefreshTimer: number | null = null;
  private feedCommandIds: string[] = [];
  private feedSettingsTab!: DoomscrollSettingTab;
  debugSettingsFeedId = 'default';

  async onload(): Promise<void> {
    type LegacySettings = PluginData['settings'] & {
      frontmatterDisplayProps?: unknown;
    };
    type LoadedPluginData = Omit<PluginData, 'settings'> & {
      settings?: LegacySettings;
    };

    // Load data
    const loadedData = (await this.loadData()) as LoadedPluginData | null;
    const loadedSettings = loadedData?.settings;
    const legacyDisplayProps = Array.isArray(
      loadedSettings?.frontmatterDisplayProps
    )
      ? loadedSettings.frontmatterDisplayProps.filter(
          (property): property is string => typeof property === 'string'
        )
      : [];
    const hasBeforeProps = Array.isArray(loadedSettings?.frontmatterBeforeProps);
    const hasAfterProps = Array.isArray(loadedSettings?.frontmatterAfterProps);
    const settings = {
      ...DEFAULT_SETTINGS,
      excludeFolders: [...DEFAULT_SETTINGS.excludeFolders],
      excludeTags: [...DEFAULT_SETTINGS.excludeTags],
      excludeGlobs: [...DEFAULT_SETTINGS.excludeGlobs],
      frontmatterImageProps: [...DEFAULT_SETTINGS.frontmatterImageProps],
      additionalFeeds: [...DEFAULT_SETTINGS.additionalFeeds],
      ...loadedSettings,
      frontmatterBeforeProps: hasBeforeProps
        ? loadedSettings?.frontmatterBeforeProps ?? []
        : [],
      frontmatterAfterProps: hasAfterProps
        ? loadedSettings?.frontmatterAfterProps ?? []
        : legacyDisplayProps,
    };
    delete (settings as LegacySettings).frontmatterDisplayProps;

    this.data = {
      settings,
      previews: loadedData?.previews || {},
      feedPreviews: loadedData?.feedPreviews || {},
      history: loadedData?.history || [],
      indexFormatVersion: loadedData?.indexFormatVersion ?? 0,
    };

    // Migrate: earlier versions stored path/title/ctime on each preview
    // (duplicating the map key and an unused field) and kept imagePath as
    // an explicit null. Strip them so old vaults' data.json shrinks; the
    // index-format migration below also refreshes cached metadata once.
    let migrated =
      loadedData?.settings !== undefined &&
      (!hasBeforeProps ||
        !hasAfterProps ||
        Boolean(
          loadedSettings && 'frontmatterDisplayProps' in loadedSettings
        ));
    if (!loadedSettings || typeof loadedSettings.name !== 'string') {
      migrated = true;
    }
    if (this.data.settings.name === 'Doom Scroll') {
      this.data.settings.name = 'Default feed';
      migrated = true;
    }
    if (!this.data.settings.id) {
      this.data.settings.id = uuidv7();
      migrated = true;
    }
    const legacyIds = this.data.settings.legacyFeedIds ??= {};
    this.data.settings.additionalFeeds.forEach((feed, index) => {
      if (!feed.id) {
        feed.id = uuidv7();
        const oldId = `additional-${index}`;
        legacyIds[oldId] = feed.id;
        const previews = this.data.feedPreviews[oldId];
        if (previews) this.data.feedPreviews[feed.id] = previews;
        delete this.data.feedPreviews[oldId];
        migrated = true;
      }
    });
    const feedOptionKeys = ['includeMediaOnlyNotes', 'showNonMarkdownFiles', 'simplifiedView', 'previewSize', 'openNoteBehavior', 'frontmatterImageProps', 'frontmatterBeforeProps', 'frontmatterAfterProps'] as const;
    this.data.settings.additionalFeeds.forEach((feed) => {
      for (const key of feedOptionKeys) {
        if (feed[key] === undefined) {
          const value = this.data.settings[key];
          Object.assign(feed, { [key]: Array.isArray(value) ? [...value] : value });
          migrated = true;
        }
      }
    });
    this.data.settings.additionalFeeds.forEach((feed, index) => {
      if (typeof feed.name !== 'string') {
        feed.name = `Feed ${index + 1}`;
        migrated = true;
      }
    });
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

    if (!loadedData?.settings || !('infiniteScroll' in loadedData.settings)) {
      migrated = true;
    }

    if (!loadedData?.settings || !('reduceAnimations' in loadedData.settings)) {
      migrated = true;
    }

    if (!isPreviewSize(this.data.settings.previewSize)) {
      this.data.settings.previewSize = 'medium';
      migrated = true;
    }

    if (this.data.indexFormatVersion !== INDEX_FORMAT_VERSION) {
      // Rebuild all cached metadata once. This also repairs data written by
      // the intermediate on-demand-preview migration, which removed legacy
      // snippets before mediaOnly classification was persisted.
      const allPreviews = [
        ...Object.values(this.data.previews),
        ...Object.values(this.data.feedPreviews).flatMap(Object.values),
      ];
      for (const preview of allPreviews) {
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
    this.registerEvent(this.app.metadataCache.on('changed', () => {
      this.indexer.markDirty();
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      this.indexer.markDirty();
      let historyChanged = false;
      for (const entry of this.data.history) {
        if (entry.path === oldPath || entry.path.startsWith(`${oldPath}/`)) {
          entry.path = file.path + entry.path.slice(oldPath.length);
          historyChanged = true;
        }
      }
      if (historyChanged) void this.saveSettings();
      const views = this.app.workspace.getLeavesOfType(VIEW_TYPE_DOOMSCROLL);
      for (const leaf of views) {
        if (leaf.view instanceof DoomscrollView) {
          void leaf.view.refreshForCurrentSettings();
        }
      }
    }));

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
    this.refreshFeedCommands();

    // Settings tab
    this.feedSettingsTab = new DoomscrollSettingTab(this.app, this);
    this.addSettingTab(this.feedSettingsTab);
    if (__DEBUG__) {
      this.registerDomEvent(document, 'keydown', (event: KeyboardEvent) => {
        if (event.key !== ',' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return;
        const target = event.target;
        if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]'))) return;
        const { setting } = this.app as unknown as { setting: { open(): void; openTabById(id: string): void } };
        setting.open();
        setting.openTabById('doomscroll');
        event.preventDefault();
        event.stopPropagation();
      }, true);
    }
  }

  async activateView(feedId = 'default'): Promise<void> {
    const existingLeaf = this.app.workspace
      .getLeavesOfType(VIEW_TYPE_DOOMSCROLL)
      .find(
        (leaf) =>
          leaf.view instanceof DoomscrollView &&
          leaf.view.getFeedId() === feedId
      );

    if (existingLeaf) {
      await this.app.workspace.revealLeaf(existingLeaf);
      const view = existingLeaf.view;
      if (view instanceof DoomscrollView) {
        await view.activateFeed(feedId);
      }
      return;
    }

    // Create new leaf in main workspace
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({
      type: VIEW_TYPE_DOOMSCROLL,
      active: true,
      state: {
        feedId,
        batchPaths: [],
        batchHistoryPaths: [],
        batchHistoryCursor: -1,
        scrollTop: 0,
        focusedPath: null,
        scrollAnchor: null,
      },
    });
    await this.app.workspace.revealLeaf(leaf);
  }

  getFeedFilters(feedId = 'default'): FeedFilters {
    if (feedId === 'default') return this.data.settings;
    const id = this.resolveFeedId(feedId);
    return this.data.settings.additionalFeeds.find((feed) => feed.id === id) ?? this.data.settings;
  }

  resolveFeedId(feedId: string): string {
    return this.data.settings.legacyFeedIds?.[feedId] ?? feedId;
  }

  getFeedPreviews(
    feedId = 'default'
  ): Record<string, StoredNotePreview> {
    if (feedId === 'default') return this.data.previews;
    return (this.data.feedPreviews[feedId] ??= {});
  }

  async removeAdditionalFeed(index: number): Promise<void> {
    const feeds = this.data.settings.additionalFeeds;
    if (index < 0 || index >= feeds.length) return;
    const feed = feeds[index];
    if (!feed) return;
    const views = this.app.workspace.getLeavesOfType(VIEW_TYPE_DOOMSCROLL)
      .map((leaf) => leaf.view)
      .filter((view): view is DoomscrollView => view instanceof DoomscrollView);
    feeds.splice(index, 1);
    delete this.data.feedPreviews[feed.id];
    for (const view of views) {
      if (view.getFeedId() === feed.id) await view.activateFeed('default');
    }
    await this.saveSettings();
    this.refreshFeedCommands();
  }

  refreshFeedCommands(): void {
    for (const commandId of this.feedCommandIds) {
      this.removeCommand(commandId);
    }
    this.feedCommandIds = [];

    const feeds: Array<{ id: string; filters: FeedFilters; fallbackName: string }> = [
      {
        id: 'default',
        filters: this.data.settings,
        fallbackName: 'Default feed',
      },
      ...this.data.settings.additionalFeeds.map((filters, index) => ({
        id: filters.id,
        filters,
        fallbackName: `Feed ${index + 1}`,
      })),
    ];

    for (const feed of feeds) {
      const command = this.addCommand({
        id: `open-${feed.id}`,
        name: `Open ${feed.filters.name.trim() || feed.fallbackName}`,
        callback: () => {
          void this.activateView(feed.id);
        },
      });
      this.feedCommandIds.push(command.id);
    }

    void this.refreshOpenFeedTitles();
  }

  private async refreshOpenFeedTitles(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_DOOMSCROLL);
    for (const leaf of leaves) {
      if (!(leaf.view instanceof DoomscrollView)) continue;
      const viewState = leaf.getViewState();
      await leaf.setViewState({
        ...viewState,
        state: leaf.view.getState(),
      });
    }
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
