import {
  ItemView,
  Component,
  EventRef,
  Events,
  MarkdownRenderer,
  WorkspaceLeaf,
  TFile,
  setIcon,
} from 'obsidian';
import DoomscrollPlugin from './main';
import { preparePreviewMarkdown, prepareRenderedPreview } from './extract';
import {
  isPreviewSize,
  NotePreview,
  PreviewSize,
  toNotePreview,
} from './types';
import { selectBatch } from './selector';
import { recordView } from './history';
import { removePathFromBatches } from './batches';

export const VIEW_TYPE_DOOMSCROLL = 'doomscroll-view';
const HISTORY_SAVE_DELAY_MS = 2_000;
const MAX_BATCH_HISTORY = 20;
const MAX_RENDERED_SNIPPET_CACHE_ENTRIES = 100;
const MAX_IMAGE_DIMENSION_CACHE_ENTRIES = 200;
const MAX_CARD_SIZE_CACHE_ENTRIES = 200;
const INFINITE_SCROLL_CHUNK_SIZE = 20;
const PLUGIN_INDEX_READY_TIMEOUT_MS = 10_000;
const BASES_RENDER_TIMEOUT_MS = 3_000;
const PLUGIN_RENDER_QUIET_MS = 200;
const PLUGIN_RENDER_TIMEOUT_MS = 3_000;
const IMAGE_FILE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

interface ImageDimensions {
  width: number;
  height: number;
}

interface CardSize {
  height: number;
}

// Keep dimensions across Doomscroll view instances while the plugin is
// loaded. This lets a feed recreated by tab history reserve image space
// before lazy loading runs again.
const imageDimensionCache = new Map<string, ImageDimensions>();
const cardSizeCache = new Map<string, CardSize>();

interface AppWithSettings {
  setting: {
    open(): void;
    openTabById(id: string): void;
  };
}

interface DoomscrollViewState {
  batchPaths: string[];
  batchHistoryPaths: string[][];
  batchHistoryCursor: number;
  scrollTop: number;
}

interface DataviewApiLike {
  index?: {
    initialized?: boolean;
    revision?: number;
  };
}

interface WindowWithDataviewApi extends Window {
  DataviewAPI?: DataviewApiLike;
}

export class DoomscrollView extends ItemView {
  plugin: DoomscrollPlugin;
  containerEl: HTMLElement;
  hasRendered: boolean = false;
  currentBatch: NotePreview[] = [];
  imageObserver: IntersectionObserver | null = null;
  cardObserver: IntersectionObserver | null = null;
  private infiniteScrollObserver: IntersectionObserver | null = null;
  private infiniteScrollLoading = false;
  private infiniteScrollExhausted = false;
  viewedPathsInBatch: Set<string> = new Set();
  batchHistory: NotePreview[][] = [];
  batchHistoryCursor: number = -1;
  backButton: HTMLButtonElement | null = null;
  private refreshStatusEl: HTMLElement | null = null;
  private isRefreshing = false;
  private pendingSettingsRefresh = false;
  private batchSettingsKey: string | null = null;
  private historySaveTimer: number | null = null;
  private historySavePending = false;
  private restoredScrollTop = 0;
  private renderedSnippetCache = new Map<string, HTMLElement>();
  private renderedSimplifiedView: boolean | null = null;
  private renderedPreviewSize: PreviewSize | null = null;
  private renderedFrontmatterPropertiesKey: string | null = null;
  private snippetRenderGenerations = new WeakMap<HTMLElement, number>();
  private isClosed = false;
  private pluginRefreshTimer: number | null = null;
  private pluginRefreshExcludePaths = new Set<string>();

  constructor(leaf: WorkspaceLeaf, plugin: DoomscrollPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.containerEl = this.contentEl;
    this.registerEvent(
      this.plugin.app.vault.on('modify', (file) => {
        if (file instanceof TFile) {
          if (IMAGE_FILE_EXT_RE.test(file.path)) {
            invalidateImageCaches();
          }
          if (file.extension === 'base') {
            this.schedulePluginPreviewRefresh();
          }
        }
      })
    );
    this.registerEvent(
      this.plugin.app.metadataCache.on('changed', (file) => {
        void this.refreshModifiedCard(file);
        this.schedulePluginPreviewRefresh(file.path);
      })
    );
    const workspaceEvents = this.plugin.app.workspace as unknown as Events;
    this.registerEvent(
      workspaceEvents.on('dataview:refresh-views', () => {
        this.schedulePluginPreviewRefresh();
      })
    );
    this.registerEvent(
      this.plugin.app.vault.on('delete', (file) => {
        void this.removeDeletedNote(file.path);
      })
    );
  }

  getViewType(): string {
    return VIEW_TYPE_DOOMSCROLL;
  }

  getDisplayText(): string {
    return 'Doomscroll';
  }

  getIcon(): string {
    return 'gallery-vertical';
  }

  getState(): Record<string, unknown> {
    const body = this.containerEl.querySelector('.doomscroll-body');
    const scrollTop =
      body instanceof HTMLElement ? body.scrollTop : this.restoredScrollTop;

    return {
      batchPaths: this.currentBatch.map((preview) => preview.path),
      batchHistoryPaths: this.batchHistory.map((batch) =>
        batch.map((preview) => preview.path)
      ),
      batchHistoryCursor: this.batchHistoryCursor,
      scrollTop,
    } satisfies DoomscrollViewState;
  }

  async setState(state: unknown): Promise<void> {
    const restored = parseViewState(state);
    if (!restored) return;

    this.currentBatch = this.resolvePreviewPaths(restored.batchPaths);
    this.batchHistory = restored.batchHistoryPaths
      .map((paths) => this.resolvePreviewPaths(paths))
      .filter((batch) => batch.length > 0)
      .slice(0, MAX_BATCH_HISTORY);
    this.batchHistoryCursor = Math.min(
      restored.batchHistoryCursor,
      this.batchHistory.length - 1
    );
    this.restoredScrollTop = restored.scrollTop;
    this.batchSettingsKey = this.getBatchSettingsKey();

    if (this.hasRendered) {
      this.renderBatch();
      this.restoreScrollPosition();
    }
  }

  async onOpen(): Promise<void> {
    this.isClosed = false;
    this.snippetRenderGenerations = new WeakMap();
    await this.render();
  }

  async refreshForCurrentSettings(): Promise<void> {
    if (this.isRefreshing) {
      this.pendingSettingsRefresh = true;
      return;
    }

    this.setRefreshing(true);
    let indexRefreshed = false;
    let refreshFailed = false;
    try {
      indexRefreshed = await this.plugin.indexer.refreshIfStale();
      if (this.batchSettingsKey !== this.getBatchSettingsKey()) {
        indexRefreshed =
          (await this.plugin.indexer.refreshIfStale()) || indexRefreshed;
      }
    } catch (error) {
      console.error('Error refreshing vault index:', error);
      refreshFailed = true;
    } finally {
      this.setRefreshing(false);
    }

    const settingsChanged =
      this.batchSettingsKey !== this.getBatchSettingsKey();
    const previewModeChanged =
      this.renderedSimplifiedView !== this.isSimplifiedView();
    const previewSizeChanged =
      this.renderedPreviewSize !== this.getPreviewSize();
    const frontmatterPropertiesChanged =
      this.renderedFrontmatterPropertiesKey !==
      this.getFrontmatterPropertiesKey();
    if (
      !refreshFailed &&
      (indexRefreshed ||
        settingsChanged ||
        previewModeChanged ||
        previewSizeChanged ||
        frontmatterPropertiesChanged)
    ) {
      if (indexRefreshed || settingsChanged) {
        this.currentBatch = [];
      }
      if (settingsChanged) {
        this.batchHistory = [];
        this.batchHistoryCursor = -1;
      } else if (indexRefreshed) {
        this.revalidateBatchHistory();
      } else if (previewModeChanged || previewSizeChanged) {
        if (previewModeChanged) {
          this.renderedSnippetCache.clear();
        }
        clearCardSizeCache();
      }

      if (this.hasRendered) {
        this.renderBatch();
        this.containerEl.querySelector('.doomscroll-body')?.scrollTo({ top: 0 });
      }
    }

    if (this.pendingSettingsRefresh) {
      this.pendingSettingsRefresh = false;
      await this.refreshForCurrentSettings();
    }
  }

  private async render(): Promise<void> {
    this.containerEl.empty();
    this.containerEl.addClass('doomscroll-view-container');

    // Header row
    const header = this.containerEl.createDiv('doomscroll-header');

    const title = header.createEl('h2');
    title.textContent = 'Doomscroll';
    title.className = 'doomscroll-title';

    this.refreshStatusEl = header.createDiv('doomscroll-refresh-status');
    this.refreshStatusEl.setAttribute('aria-live', 'polite');
    const controls = header.createDiv('doomscroll-controls');

    // Reshuffle button (refresh icon)
    const reshuffleBtn = controls.createEl('button');
    reshuffleBtn.className = 'doomscroll-reshuffle-btn';
    reshuffleBtn.setAttribute('aria-label', 'Reshuffle');
    setIcon(reshuffleBtn, 'refresh-cw');
    reshuffleBtn.addEventListener('click', () => {
      void this.showNewBatch();
    });

    // Previous batch button
    this.backButton = controls.createEl('button');
    this.backButton.className = 'doomscroll-back-btn';
    this.backButton.setAttribute('aria-label', 'Previous card set');
    setIcon(this.backButton, 'arrow-left');
    this.backButton.addEventListener('click', () => {
      void this.showPreviousBatch();
    });
    this.updateBackButton();

    // Settings button
    const settingsBtn = controls.createEl('button');
    settingsBtn.className = 'doomscroll-settings-btn';
    settingsBtn.setAttribute('aria-label', 'Settings');
    setIcon(settingsBtn, 'settings');
    settingsBtn.addEventListener('click', () => {
      const { setting } = this.plugin.app as unknown as AppWithSettings;
      setting.open();
      setting.openTabById('doomscroll');
    });

    // Body - scrollable container
    const bodyContainer = this.containerEl.createDiv('doomscroll-body');
    bodyContainer.addEventListener(
      'scroll',
      () => {
        this.restoredScrollTop = bodyContainer.scrollTop;
      },
      { passive: true }
    );

    // Refresh on every plugin session so a persisted index cannot outlive the
    // filters that were active when it was created. The indexer also detects
    // filter changes made while the plugin is running.
    const needsInitialIndex = Object.keys(this.plugin.data.previews).length === 0;
    const loadingEl = needsInitialIndex
      ? bodyContainer.createDiv('doomscroll-loading')
      : null;
    if (loadingEl) {
      loadingEl.textContent = 'Indexing your vault…';
    }

    let indexRefreshed = false;
    let indexRefreshSucceeded = false;
    this.setRefreshing(true);
    try {
      indexRefreshed = await this.plugin.indexer.refreshIfStale(
        (done, total) => {
          if (loadingEl) {
            loadingEl.textContent = `Indexed ${done}/${total}`;
          }
        },
        needsInitialIndex
      );
      indexRefreshSucceeded = true;
      if (indexRefreshed) {
        await this.plugin.saveSettings();
      }
    } catch (error) {
      console.error('Error indexing vault:', error);
      if (loadingEl) {
        loadingEl.textContent = 'Error indexing vault';
      }
    } finally {
      this.setRefreshing(false);
    }

    // A restored batch was built from the previous session's index and may
    // contain notes excluded by the current settings. Keep it when the index
    // check was a no-op so returning from a note preserves the same feed.
    if (indexRefreshSucceeded) {
      if (indexRefreshed) {
        if (this.currentBatch.length > 0) {
          this.currentBatch = this.resolvePreviewPaths(
            this.currentBatch.map((preview) => preview.path)
          );
          this.revalidateBatchHistory();
        } else {
          this.batchHistory = [];
          this.batchHistoryCursor = -1;
          this.batchSettingsKey = null;
        }
      }
    }
    loadingEl?.remove();

    // Render batch
    this.hasRendered = true;
    this.renderBatchIntoContainer(bodyContainer);
    this.restoreScrollPosition();
  }

  private resolvePreviewPaths(paths: readonly string[]): NotePreview[] {
    return paths.flatMap((path) => {
      const stored = this.plugin.data.previews[path];
      return stored ? [toNotePreview(path, stored)] : [];
    });
  }

  private restoreScrollPosition(): void {
    const scrollTop = this.restoredScrollTop;
    const restore = (): void => {
      const body = this.containerEl.querySelector('.doomscroll-body');
      if (body instanceof HTMLElement) {
        body.scrollTop = scrollTop;
      }
    };

    restore();
    window.requestAnimationFrame(() => {
      restore();
      window.requestAnimationFrame(restore);
    });
    window.setTimeout(restore, 100);
  }

  private renderBatchIntoContainer(
    container: HTMLElement,
    previousOrder?: readonly string[]
  ): void {
    // Get fresh batch if not already loaded
    if (this.currentBatch.length === 0) {
      const candidates = Object.entries(this.plugin.data.previews)
        .map(([path, stored]) => toNotePreview(path, stored))
        .filter(
          (preview) =>
            this.plugin.data.settings.includeMediaOnlyNotes ||
            !isMediaOnlyPreview(preview)
        );
      this.currentBatch = selectBatch(
        candidates,
        this.plugin.data.history,
        this.plugin.data.settings.infiniteScroll
          ? INFINITE_SCROLL_CHUNK_SIZE
          : this.plugin.data.settings.batchSize,
        Date.now()
      );
      this.batchSettingsKey = this.getBatchSettingsKey();
      if (
        previousOrder &&
        this.currentBatch.length > 1 &&
        hasSameOrder(this.currentBatch, previousOrder)
      ) {
        [this.currentBatch[0], this.currentBatch[1]] = [
          this.currentBatch[1]!,
          this.currentBatch[0]!,
        ];
      }
      this.batchHistory.unshift(this.currentBatch);
      this.batchHistory.length = Math.min(
        this.batchHistory.length,
        MAX_BATCH_HISTORY
      );
      this.batchHistoryCursor = 0;
    }

    this.renderedSimplifiedView = this.isSimplifiedView();
    this.renderedPreviewSize = this.getPreviewSize();
    this.renderedFrontmatterPropertiesKey = this.getFrontmatterPropertiesKey();
    this.updateBackButton();

    // Stop observing cards from the previous batch before replacing them.
    this.cardObserver?.disconnect();
    this.infiniteScrollObserver?.disconnect();
    this.infiniteScrollObserver = null;
    this.infiniteScrollLoading = false;
    this.infiniteScrollExhausted = false;
    this.viewedPathsInBatch.clear();

    this.cardObserver = new IntersectionObserver(
      (entries) => {
        let historyChanged = false;

        for (const entry of entries) {
          if (!entry.isIntersecting) continue;

          const card = entry.target as HTMLElement;
          const path = card.dataset.path;
          const preview = this.currentBatch.find(
            (candidate) => candidate.path === path
          );
          const snippetEl = card.querySelector('.doomscroll-card-snippet');
          if (preview && snippetEl instanceof HTMLElement) {
            void this.renderSnippet(preview, snippetEl);
          }

          if (path && !this.viewedPathsInBatch.has(path)) {
            this.viewedPathsInBatch.add(path);
            this.plugin.data.history = recordView(
              this.plugin.data.history,
              path,
              Date.now()
            );
            historyChanged = true;
          }
          this.cardObserver?.unobserve(card);
        }

        if (historyChanged) {
          this.scheduleHistorySave();
        }
      },
      { root: container, threshold: 0.1 }
    );

    // Clear previous content
    container.empty();

    // Render cards
    for (const preview of this.currentBatch) {
      const card = this.renderCard(container, preview);
      this.cardObserver.observe(card);
    }

    // Reshuffle button at end
    const reshuffleSection = container.createDiv(
      'doomscroll-reshuffle-section'
    );
    const reshuffleBtn = reshuffleSection.createEl('button');
    reshuffleBtn.className = 'doomscroll-reshuffle-end-btn';
    reshuffleBtn.textContent = 'Reshuffle';
    reshuffleBtn.dataset.defaultLabel = 'Reshuffle';
    reshuffleBtn.addEventListener('click', () => {
      void this.showNewBatch();
    });

    if (this.plugin.data.settings.infiniteScroll) {
      const sentinel = container.createDiv(
        'doomscroll-infinite-scroll-sentinel'
      );
      this.infiniteScrollObserver = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            void this.loadMoreCards(container, sentinel);
          }
        },
        { root: container, rootMargin: '400px' }
      );
      this.infiniteScrollObserver.observe(sentinel);
    }
  }

  private async loadMoreCards(
    container: HTMLElement,
    sentinel: HTMLElement
  ): Promise<void> {
    if (
      this.infiniteScrollLoading ||
      this.infiniteScrollExhausted ||
      !this.plugin.data.settings.infiniteScroll ||
      !sentinel.isConnected
    ) {
      return;
    }

    this.infiniteScrollLoading = true;
    sentinel.textContent = 'Loading more notes…';

    try {
      const loadedPaths = new Set(
        this.currentBatch.map((preview) => preview.path)
      );
      const candidates = Object.entries(this.plugin.data.previews)
        .map(([path, stored]) => toNotePreview(path, stored))
        .filter(
          (preview) =>
            !loadedPaths.has(preview.path) &&
            (this.plugin.data.settings.includeMediaOnlyNotes ||
              !isMediaOnlyPreview(preview))
        );
      const nextBatch = selectBatch(
        candidates,
        this.plugin.data.history,
        INFINITE_SCROLL_CHUNK_SIZE,
        Date.now()
      );

      if (nextBatch.length === 0) {
        this.infiniteScrollExhausted = true;
        sentinel.textContent = 'No more notes';
        return;
      }

      this.currentBatch = [...this.currentBatch, ...nextBatch];
      if (
        this.batchHistoryCursor >= 0 &&
        this.batchHistoryCursor < this.batchHistory.length
      ) {
        this.batchHistory[this.batchHistoryCursor] = this.currentBatch;
      }

      const reshuffleSection = container.querySelector(
        '.doomscroll-reshuffle-section'
      );
      for (const preview of nextBatch) {
        const card = this.renderCard(container, preview);
        if (reshuffleSection) {
          reshuffleSection.before(card);
        } else {
          sentinel.before(card);
        }
        this.cardObserver?.observe(card);
      }

      if (nextBatch.length < INFINITE_SCROLL_CHUNK_SIZE) {
        this.infiniteScrollExhausted = true;
        sentinel.textContent = 'No more notes';
      } else {
        sentinel.textContent = '';
      }
    } finally {
      this.infiniteScrollLoading = false;
    }
  }

  private async showNewBatch(): Promise<void> {
    if (this.isRefreshing) return;

    const previousOrder = this.currentBatch.map((preview) => preview.path);
    this.setRefreshing(true);

    try {
      let indexRefreshed = await this.plugin.indexer.refreshIfStale();
      // Settings may have changed while the first rebuild was in progress.
      // Run the indexer again for the final settings before selecting a batch.
      if (this.batchSettingsKey !== this.getBatchSettingsKey()) {
        indexRefreshed =
          (await this.plugin.indexer.refreshIfStale()) || indexRefreshed;
      }

      const settingsChanged =
        this.batchSettingsKey !== this.getBatchSettingsKey();
      this.currentBatch = [];

      if (settingsChanged) {
        this.batchHistory = [];
        this.batchHistoryCursor = -1;
      } else if (indexRefreshed) {
        this.revalidateBatchHistory();
      }

      this.renderBatch(
        settingsChanged || indexRefreshed ? undefined : previousOrder
      );
      this.containerEl.querySelector('.doomscroll-body')?.scrollTo({ top: 0 });
    } catch (error) {
      console.error('Error refreshing vault index:', error);
    } finally {
      this.setRefreshing(false);
      if (this.pendingSettingsRefresh) {
        this.pendingSettingsRefresh = false;
        await this.refreshForCurrentSettings();
      }
    }
  }

  private async showPreviousBatch(): Promise<void> {
    if (this.batchSettingsKey !== this.getBatchSettingsKey()) {
      await this.refreshForCurrentSettings();
      return;
    }

    const previousCursor = this.batchHistoryCursor + 1;
    const previousBatch = this.batchHistory[previousCursor];
    if (!previousBatch) return;

    this.batchHistoryCursor = previousCursor;
    this.currentBatch = previousBatch;
    this.renderBatch();
    this.containerEl.querySelector('.doomscroll-body')?.scrollTo({ top: 0 });
  }

  private updateBackButton(): void {
    if (this.backButton) {
      this.backButton.disabled =
        this.batchHistoryCursor < 0 ||
        this.batchHistoryCursor >= this.batchHistory.length - 1;
    }
  }

  private renderBatch(previousOrder?: readonly string[]): void {
    const body = this.containerEl.querySelector('.doomscroll-body');
    if (body) {
      this.renderBatchIntoContainer(body as HTMLElement, previousOrder);
    }
  }

  private revalidateBatchHistory(): void {
    const previousCursor = this.batchHistoryCursor;
    const retained: Array<{ oldIndex: number; batch: NotePreview[] }> = [];

    this.batchHistory.forEach((batch, oldIndex) => {
      const nextBatch = this.resolvePreviewPaths(
        batch.map((preview) => preview.path)
      );
      if (nextBatch.length > 0) {
        retained.push({ oldIndex, batch: nextBatch });
      }
    });

    this.batchHistory = retained.map(({ batch }) => batch);
    const retainedCursor = retained.findIndex(
      ({ oldIndex }) => oldIndex === previousCursor
    );
    this.batchHistoryCursor =
      retainedCursor >= 0
        ? retainedCursor
        : Math.min(previousCursor, this.batchHistory.length - 1);
  }

  private setRefreshing(refreshing: boolean): void {
    this.isRefreshing = refreshing;
    if (this.refreshStatusEl) {
      this.refreshStatusEl.textContent = refreshing ? 'Indexing…' : '';
    }

    const buttons = this.containerEl.querySelectorAll<HTMLButtonElement>(
      '.doomscroll-reshuffle-btn, .doomscroll-reshuffle-end-btn'
    );
    buttons.forEach((button) => {
      button.disabled = refreshing;
      if (button.classList.contains('doomscroll-reshuffle-end-btn')) {
        const defaultLabel = button.dataset.defaultLabel ?? 'Reshuffle';
        button.textContent = refreshing ? 'Indexing…' : defaultLabel;
      }
    });
  }

  private getBatchSettingsKey(): string {
    const {
      simplifiedView: _simplifiedView,
      previewSize: _previewSize,
      frontmatterBeforeProps: _frontmatterBeforeProps,
      frontmatterAfterProps: _frontmatterAfterProps,
      ...batchSettings
    } = this.plugin.data.settings;
    return JSON.stringify(batchSettings);
  }

  private getFrontmatterPropertiesKey(): string {
    return JSON.stringify({
      before: this.plugin.data.settings.frontmatterBeforeProps ?? [],
      after: this.plugin.data.settings.frontmatterAfterProps ?? [],
    });
  }

  private isSimplifiedView(): boolean {
    // Treat missing values from pre-setting data.json files as the default.
    return this.plugin.data.settings.simplifiedView !== false;
  }

  private getPreviewSize(): PreviewSize {
    return isPreviewSize(this.plugin.data.settings.previewSize)
      ? this.plugin.data.settings.previewSize
      : 'medium';
  }

  private setSnippetPreviewSize(snippetEl: HTMLElement): void {
    snippetEl.classList.remove(
      'doomscroll-card-snippet-size-small',
      'doomscroll-card-snippet-size-medium',
      'doomscroll-card-snippet-size-large'
    );
    snippetEl.classList.add(
      `doomscroll-card-snippet-size-${this.getPreviewSize()}`
    );
  }

  private setSnippetContent(
    snippetEl: HTMLElement,
    renderedRoot: HTMLElement,
    simplified: boolean
  ): void {
    snippetEl.classList.toggle('doomscroll-card-snippet-simple', simplified);
    snippetEl.classList.toggle('doomscroll-card-snippet-markdown', !simplified);
    snippetEl.classList.toggle('markdown-rendered', !simplified);
    this.setSnippetPreviewSize(snippetEl);

    const clone = renderedRoot.cloneNode(true) as HTMLElement;
    if (clone.childNodes.length === 0) {
      snippetEl.textContent = '(no preview text)';
      return;
    }
    snippetEl.replaceChildren(...Array.from(clone.childNodes));

    if (clone.querySelector('.dataview, .bases-view, .bases-embed')) {
      const interactionShield = snippetEl.createDiv(
        'doomscroll-card-snippet-interaction-shield'
      );
      interactionShield.setAttribute('aria-hidden', 'true');
    }
  }

  private cacheRenderedSnippet(key: string, renderedRoot: HTMLElement): void {
    // Map insertion order gives us a small LRU cache without retaining every
    // file ever visited during a long-lived Doomscroll session.
    this.renderedSnippetCache.delete(key);
    this.renderedSnippetCache.set(key, renderedRoot);
    while (this.renderedSnippetCache.size > MAX_RENDERED_SNIPPET_CACHE_ENTRIES) {
      const oldestKey = this.renderedSnippetCache.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      this.renderedSnippetCache.delete(oldestKey);
    }
  }

  private renderCard(
    container: HTMLElement,
    preview: NotePreview
  ): HTMLElement {
    const card = container.createDiv('doomscroll-card');
    card.dataset.path = preview.path;
    applyCachedCardSize(card, this.isSimplifiedView(), this.getPreviewSize());

    // Title + date row
    const titleRow = card.createDiv('doomscroll-card-titlerow');

    const titleEl = titleRow.createEl('h3');
    titleEl.className = 'doomscroll-card-title';
    titleEl.textContent = preview.title;

    const dateEl = titleRow.createDiv('doomscroll-card-date');
    const date = new Date(preview.mtime);
    dateEl.textContent = date.toLocaleDateString();

    // Image (lazy loaded)
    if (preview.imagePath) {
      const imageContainer = card.createDiv(
        'doomscroll-card-image-container'
      );

      const img = imageContainer.createEl('img');
      img.className = 'doomscroll-card-image';
      img.dataset.src = preview.imagePath;
      img.dataset.notePath = preview.path;
      img.alt = preview.title;

      const imageDimensions = imageDimensionCache.get(
        getImageDimensionCacheKey(preview)
      );
      if (imageDimensions) {
        applyImageDimensions(img, imageDimensions);
      }

      // Setup lazy loading via IntersectionObserver
      this.setupImageLazyLoad(
        img,
        getImageDimensionCacheKey(preview)
      );
    }

    // Snippet is rendered on demand from a bounded Markdown fragment.
    const snippetEl = card.createDiv('doomscroll-card-snippet');
    this.setSnippetPreviewSize(snippetEl);
    snippetEl.textContent = 'Loading preview…';
    this.renderCardFrontmatter(card, preview, 'before');
    this.renderCardFrontmatter(card, preview, 'after');

    // Click handler
    card.addEventListener('click', () => {
      void this.renderSnippet(preview, snippetEl);
      void this.openPreview(preview);
    });

    return card;
  }

  private renderFrontmatterProperties(
    preview: NotePreview,
    container: HTMLElement,
    properties: string[]
  ): void {
    if (properties.length === 0) return;

    const file = this.plugin.app.vault.getAbstractFileByPath(preview.path);
    if (!(file instanceof TFile)) return;

    const frontmatter = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!isRecord(frontmatter)) return;

    for (const property of properties) {
      if (!Object.prototype.hasOwnProperty.call(frontmatter, property)) continue;

      const value = formatFrontmatterValue(frontmatter[property]);
      if (!value) continue;

      const row = container.createDiv('doomscroll-card-frontmatter-row');
      row.createSpan({
        text: `${property}:`,
        cls: 'doomscroll-card-frontmatter-property',
      });
      row.createSpan({
        text: value,
        cls: 'doomscroll-card-frontmatter-value',
      });
    }
  }

  private async renderSnippet(
    preview: NotePreview,
    snippetEl: HTMLElement
  ): Promise<void> {
    if (this.isClosed || !snippetEl.isConnected) return;

    const generation =
      (this.snippetRenderGenerations.get(snippetEl) ?? 0) + 1;
    this.snippetRenderGenerations.set(snippetEl, generation);
    const isCurrent = (): boolean =>
      !this.isClosed &&
      snippetEl.isConnected &&
      this.snippetRenderGenerations.get(snippetEl) === generation;
    const isCancelled = (): boolean => !isCurrent();

    const file = this.plugin.app.vault.getAbstractFileByPath(preview.path);
    if (!(file instanceof TFile)) {
      if (isCurrent()) snippetEl.textContent = '(no preview text)';
      return;
    }

    const simplified = this.isSimplifiedView();

    try {
      await this.waitForDataviewIndex(isCancelled);
      if (!isCurrent()) return;

      const cacheKey = this.getRenderedSnippetCacheKey(file, simplified);
      const cached = this.renderedSnippetCache.get(cacheKey);
      if (cached !== undefined) {
        this.cacheRenderedSnippet(cacheKey, cached);
        if (!isCurrent()) return;
        this.setSnippetContent(snippetEl, cached, simplified);
        this.cacheCardSize(snippetEl.closest('.doomscroll-card'));
        return;
      }

      const content = await this.plugin.app.vault.cachedRead(file);
      if (!isCurrent()) return;
      const markdown = preparePreviewMarkdown(content);
      snippetEl.replaceChildren();
      const rendered = snippetEl.createDiv();
      // Keep the staging tree attached while Obsidian and third-party
      // post-processors finish. Plugins such as Dataview use shown/inserted
      // lifecycle checks when scheduling their initial render.
      const renderComponent = new Component();
      renderComponent.load();
      let prepared: HTMLElement;
      try {
        await MarkdownRenderer.render(
          this.plugin.app,
          markdown,
          rendered,
          file.path,
          renderComponent
        );

        // MarkdownRenderer does not await every plugin-owned child render.
        // Wait for the staging tree to become quiet before taking the cached
        // snapshot, then use the Bases loading marker as a stronger signal for
        // its asynchronous query.
        await waitForPluginRenderToSettle(rendered, isCancelled);
        await waitForBasesViewsToSettle(rendered, isCancelled);
        if (!isCurrent()) return;

        prepared = prepareRenderedPreview(rendered, simplified);
      } finally {
        renderComponent.unload();
      }
      if (!isCurrent()) return;
      this.cacheRenderedSnippet(cacheKey, prepared);
      if (isCurrent()) {
        this.setSnippetContent(snippetEl, prepared, simplified);
        this.cacheCardSize(snippetEl.closest('.doomscroll-card'));
      }
    } catch (error) {
      console.error(`Error rendering preview for ${file.path}:`, error);
      if (isCurrent()) {
        snippetEl.textContent = preview.snippet ?? '(no preview text)';
      }
    }
  }

  private getRenderedSnippetCacheKey(
    file: TFile,
    simplified: boolean
  ): string {
    const dataviewApi = (window as WindowWithDataviewApi).DataviewAPI;
    const dataviewRevision = dataviewApi?.index?.revision ?? 'none';
    return `${simplified ? 'simplified' : 'markdown'}:${file.path}:${file.stat.mtime}:${dataviewRevision}`;
  }

  /**
   * Dataview registers its Markdown renderer immediately, but builds its
   * page index asynchronously. Rendering a query before that index is ready
   * produces a valid-looking empty result which is then captured in the
   * preview cache. Wait for Dataview when it is present, while keeping the
   * renderer usable with other plugins or with Dataview disabled.
   */
  private async waitForDataviewIndex(
    isCancelled: () => boolean
  ): Promise<void> {
    const dataviewApi = (window as WindowWithDataviewApi).DataviewAPI;
    if (isCancelled() || dataviewApi?.index?.initialized !== false) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      let timeoutId: number | null = null;
      let cancelPollId: number | null = null;
      let eventRef: EventRef | null = null;
      const metadataCacheEvents =
        this.plugin.app.metadataCache as unknown as Events;

      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timeoutId !== null) window.clearTimeout(timeoutId);
        if (cancelPollId !== null) window.clearInterval(cancelPollId);
        if (eventRef) metadataCacheEvents.offref(eventRef);
        resolve();
      };

      eventRef = metadataCacheEvents.on(
        'dataview:index-ready',
        finish
      );
      timeoutId = window.setTimeout(finish, PLUGIN_INDEX_READY_TIMEOUT_MS);
      cancelPollId = window.setInterval(() => {
        if (isCancelled()) finish();
      }, 100);
    });
  }

  private schedulePluginPreviewRefresh(excludePath?: string): void {
    if (this.isClosed) return;

    if (excludePath) {
      this.pluginRefreshExcludePaths.add(excludePath);
    } else {
      this.pluginRefreshExcludePaths.clear();
    }

    if (this.pluginRefreshTimer !== null) {
      window.clearTimeout(this.pluginRefreshTimer);
    }
    this.pluginRefreshTimer = window.setTimeout(() => {
      this.pluginRefreshTimer = null;
      const excludedPaths = this.pluginRefreshExcludePaths;
      this.pluginRefreshExcludePaths = new Set();
      void this.refreshPluginPreviews(excludedPaths);
    }, 150);
  }

  private async refreshPluginPreviews(
    excludedPaths: ReadonlySet<string> = new Set()
  ): Promise<void> {
    if (this.isClosed) return;

    const renders: Promise<void>[] = [];
    this.containerEl
      .querySelectorAll<HTMLElement>('.doomscroll-card')
      .forEach((card) => {
        const path = card.dataset.path;
        const snippetEl = card.querySelector('.doomscroll-card-snippet');
        if (
          !path ||
          excludedPaths.has(path) ||
          !(snippetEl instanceof HTMLElement) ||
          !snippetEl.querySelector('.dataview, .bases-view, .bases-embed')
        ) {
          return;
        }

        const preview = this.currentBatch.find(
          (candidate) => candidate.path === path
        );
        if (!preview) return;

        invalidateRenderedSnippetCache(this.renderedSnippetCache, path);
        renders.push(this.renderSnippet(preview, snippetEl));
      });

    await Promise.all(renders);
  }

  private async refreshModifiedCard(file: TFile): Promise<void> {
    if (this.isClosed) return;

    const preview = this.currentBatch.find(
      (candidate) => candidate.path === file.path
    );
    if (!preview) return;

    const card = Array.from(
      this.containerEl.querySelectorAll<HTMLElement>('.doomscroll-card')
    ).find((candidate) => candidate.dataset.path === file.path);
    if (!card) return;

    preview.mtime = file.stat.mtime;
    const dateEl = card.querySelector('.doomscroll-card-date');
    if (dateEl instanceof HTMLElement) {
      dateEl.textContent = new Date(file.stat.mtime).toLocaleDateString();
    }

    const snippetEl = card.querySelector('.doomscroll-card-snippet');
    if (!(snippetEl instanceof HTMLElement)) return;

    invalidateCardSizeCache(file.path);
    card.style.removeProperty('min-height');

    invalidateRenderedSnippetCache(this.renderedSnippetCache, file.path);

    await this.renderSnippet(preview, snippetEl);
    if (this.isClosed || !card.isConnected) return;
    this.renderCardFrontmatter(card, preview, 'before');
    this.renderCardFrontmatter(card, preview, 'after');
    this.cacheCardSize(card);
  }

  private async removeDeletedNote(path: string): Promise<void> {
    const card = Array.from(
      this.containerEl.querySelectorAll<HTMLElement>('.doomscroll-card')
    ).find((candidate) => candidate.dataset.path === path);

    const hadPreview = path in this.plugin.data.previews;
    const hadHistory = this.plugin.data.history.some(
      (entry) => entry.path === path
    );
    if (!card && !hadPreview && !hadHistory) return;

    if (card) {
      this.cardObserver?.unobserve(card);
      card.querySelectorAll<HTMLImageElement>('img').forEach((image) => {
        this.imageObserver?.unobserve(image);
      });
      card.remove();
    }

    const nextBatches = removePathFromBatches(
      this.currentBatch,
      this.batchHistory,
      this.batchHistoryCursor,
      path
    );
    this.currentBatch = nextBatches.currentBatch;
    this.batchHistory = nextBatches.batchHistory;
    this.batchHistoryCursor = nextBatches.batchHistoryCursor;
    this.viewedPathsInBatch.delete(path);

    delete this.plugin.data.previews[path];
    this.plugin.data.history = this.plugin.data.history.filter(
      (entry) => entry.path !== path
    );
    invalidateNoteCaches(path);

    for (const key of this.renderedSnippetCache.keys()) {
      if (key.includes(`:${path}:`)) {
        this.renderedSnippetCache.delete(key);
      }
    }

    this.updateBackButton();
    await this.plugin.saveSettings();
  }

  private async openPreview(preview: NotePreview): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(preview.path);

    if (file instanceof TFile) {
      // A very quick tap can happen before IntersectionObserver fires.
      if (!this.viewedPathsInBatch.has(preview.path)) {
        this.viewedPathsInBatch.add(preview.path);
        this.plugin.data.history = recordView(
          this.plugin.data.history,
          preview.path,
          Date.now()
        );
        this.scheduleHistorySave();
      }

      const behavior = this.plugin.data.settings.openNoteBehavior;
      const leaf =
        behavior === 'reuse'
          ? this.leaf
          : this.plugin.app.workspace.getLeaf(behavior);
      await leaf.openFile(file);
    }
  }

  private setupImageLazyLoad(
    img: HTMLImageElement,
    imageDimensionCacheKey: string
  ): void {
    img.addEventListener('load', () => {
      if (img.naturalWidth <= 0 || img.naturalHeight <= 0) return;

      const dimensions = {
        width: img.naturalWidth,
        height: img.naturalHeight,
      };
      imageDimensionCache.delete(imageDimensionCacheKey);
      imageDimensionCache.set(imageDimensionCacheKey, dimensions);
      while (imageDimensionCache.size > MAX_IMAGE_DIMENSION_CACHE_ENTRIES) {
        const oldestKey = imageDimensionCache.keys().next().value;
        if (typeof oldestKey !== 'string') break;
        imageDimensionCache.delete(oldestKey);
      }
      applyImageDimensions(img, dimensions);
      this.cacheCardSize(img.closest('.doomscroll-card'));
    });

    if (!this.imageObserver) {
      this.imageObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              const imgEl = entry.target as HTMLImageElement;
              const src = imgEl.dataset.src;
              const notePath = imgEl.dataset.notePath;

              if (src && notePath) {
                const file = this.plugin.app.vault.getAbstractFileByPath(
                  notePath
                );

                let resolvedSrc: string | null = null;
                if (file instanceof TFile) {
                  resolvedSrc = this.plugin.indexer.resolveImageSrc(
                    src,
                    file
                  );
                }

                if (resolvedSrc) {
                  imgEl.src = resolvedSrc;
                } else {
                  // Couldn't resolve — hide the container instead of showing a broken icon
                  imgEl.closest('.doomscroll-card-image-container')?.remove();
                }
              }

              if (this.imageObserver) {
                this.imageObserver.unobserve(imgEl);
              }
            }
          });
        },
        { rootMargin: '100px' }
      );
    }

    this.imageObserver.observe(img);
  }

  private scheduleHistorySave(): void {
    this.historySavePending = true;
    if (this.historySaveTimer !== null) {
      window.clearTimeout(this.historySaveTimer);
    }
    this.historySaveTimer = window.setTimeout(() => {
      this.historySaveTimer = null;
      void this.flushHistorySave();
    }, HISTORY_SAVE_DELAY_MS);
  }

  private async flushHistorySave(): Promise<void> {
    if (!this.historySavePending) return;
    this.historySavePending = false;
    await this.plugin.saveSettings();
  }

  async onClose(): Promise<void> {
    this.isClosed = true;
    this.snippetRenderGenerations = new WeakMap();
    this.pluginRefreshExcludePaths.clear();
    if (this.pluginRefreshTimer !== null) {
      window.clearTimeout(this.pluginRefreshTimer);
      this.pluginRefreshTimer = null;
    }
    if (this.cardObserver) {
      this.cardObserver.disconnect();
      this.cardObserver = null;
    }
    if (this.imageObserver) {
      this.imageObserver.disconnect();
      this.imageObserver = null;
    }
    if (this.infiniteScrollObserver) {
      this.infiniteScrollObserver.disconnect();
      this.infiniteScrollObserver = null;
    }
    this.renderedSnippetCache.clear();
    if (this.historySaveTimer !== null) {
      window.clearTimeout(this.historySaveTimer);
      this.historySaveTimer = null;
    }
    await this.flushHistorySave();
  }

  private cacheCardSize(card: Element | null): void {
    if (!(card instanceof HTMLElement)) return;

    rememberCardSize(card, this.isSimplifiedView(), this.getPreviewSize());
  }

  private renderCardFrontmatter(
    card: HTMLElement,
    preview: NotePreview,
    position: 'before' | 'after'
  ): void {
    card.querySelector(`.doomscroll-card-frontmatter-${position}`)?.remove();

    const frontmatterEl = card.createDiv('doomscroll-card-frontmatter');
    frontmatterEl.classList.add(`doomscroll-card-frontmatter-${position}`);
    const properties =
      position === 'before'
        ? this.plugin.data.settings.frontmatterBeforeProps ?? []
        : this.plugin.data.settings.frontmatterAfterProps ?? [];
    this.renderFrontmatterProperties(preview, frontmatterEl, properties);
    if (frontmatterEl.childElementCount === 0) {
      frontmatterEl.remove();
      return;
    }

    const snippetEl = card.querySelector('.doomscroll-card-snippet');
    if (position === 'before' && snippetEl) {
      card.insertBefore(frontmatterEl, snippetEl);
    } else {
      card.appendChild(frontmatterEl);
    }
  }
}

function getImageDimensionCacheKey(preview: NotePreview): string {
  return `${preview.path}\u0000${preview.imagePath ?? ''}`;
}

function formatFrontmatterValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value.map(formatFrontmatterValue).filter(Boolean).join(', ');
  }
  if (isRecord(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function applyImageDimensions(
  img: HTMLImageElement,
  dimensions: ImageDimensions
): void {
  img.width = dimensions.width;
  img.height = dimensions.height;
  img.parentElement?.style.setProperty(
    'aspect-ratio',
    `${dimensions.width} / ${dimensions.height}`
  );
}

function getCardSizeCacheKey(
  path: string,
  simplified: boolean,
  previewSize: PreviewSize,
  width: number
): string {
  return `${path}\u0000${simplified ? 'simplified' : 'markdown'}\u0000${previewSize}\u0000${width}`;
}

function applyCachedCardSize(
  card: HTMLElement,
  simplified: boolean,
  previewSize: PreviewSize
): void {
  const width = Math.round(card.getBoundingClientRect().width);
  if (width <= 0) return;

  const cached = cardSizeCache.get(
    getCardSizeCacheKey(
      card.dataset.path ?? '',
      simplified,
      previewSize,
      width
    )
  );
  if (cached) {
    card.style.minHeight = `${cached.height}px`;
  }
}

function rememberCardSize(
  card: HTMLElement,
  simplified: boolean,
  previewSize: PreviewSize
): void {
  window.requestAnimationFrame(() => {
    if (!card.isConnected) return;

    // Remove the reservation while measuring so a changed note can shrink as
    // well as grow after its new preview has rendered.
    const previousMinHeight = card.style.minHeight;
    card.style.removeProperty('min-height');
    const rect = card.getBoundingClientRect();
    card.style.minHeight = previousMinHeight;

    const path = card.dataset.path;
    const width = Math.round(rect.width);
    if (!path || width <= 0 || rect.height <= 0) return;

    const key = getCardSizeCacheKey(path, simplified, previewSize, width);
    cardSizeCache.delete(key);
    cardSizeCache.set(key, { height: rect.height });
    while (cardSizeCache.size > MAX_CARD_SIZE_CACHE_ENTRIES) {
      const oldestKey = cardSizeCache.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      cardSizeCache.delete(oldestKey);
    }
    card.style.minHeight = `${rect.height}px`;
  });
}

function invalidateCardSizeCache(path: string): void {
  const prefix = `${path}\u0000`;
  for (const key of cardSizeCache.keys()) {
    if (key.startsWith(prefix)) {
      cardSizeCache.delete(key);
    }
  }
}

function invalidateNoteCaches(path: string): void {
  const imagePrefix = `${path}\u0000`;
  for (const key of imageDimensionCache.keys()) {
    if (key.startsWith(imagePrefix)) {
      imageDimensionCache.delete(key);
    }
  }
  invalidateCardSizeCache(path);
}

function invalidateImageCaches(): void {
  imageDimensionCache.clear();
  cardSizeCache.clear();
}

function clearCardSizeCache(): void {
  cardSizeCache.clear();
}

function invalidateRenderedSnippetCache(
  cache: Map<string, HTMLElement>,
  path: string
): void {
  for (const key of cache.keys()) {
    if (key.includes(`:${path}:`)) {
      cache.delete(key);
    }
  }
}

function waitForPluginRenderToSettle(
  container: HTMLElement,
  isCancelled: () => boolean
): Promise<void> {
  if (
    isCancelled() ||
    !container.querySelector('.dataview, .bases-view, .bases-embed')
  ) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    let quietTimerId: number | null = null;
    let timeoutId: number | null = null;
    let cancelPollId: number | null = null;
    const observer = new MutationObserver(() => {
      scheduleQuietCheck();
    });

    const finish = (): void => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      if (quietTimerId !== null) window.clearTimeout(quietTimerId);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (cancelPollId !== null) window.clearInterval(cancelPollId);
      resolve();
    };

    const scheduleQuietCheck = (): void => {
      if (isCancelled()) {
        finish();
        return;
      }
      if (quietTimerId !== null) window.clearTimeout(quietTimerId);
      quietTimerId = window.setTimeout(finish, PLUGIN_RENDER_QUIET_MS);
    };

    observer.observe(container, {
      attributes: true,
      attributeFilter: ['class', 'style'],
      characterData: true,
      childList: true,
      subtree: true,
    });
    timeoutId = window.setTimeout(finish, PLUGIN_RENDER_TIMEOUT_MS);
    cancelPollId = window.setInterval(() => {
      if (isCancelled()) finish();
    }, 100);
    scheduleQuietCheck();
  });
}

function waitForBasesViewsToSettle(
  container: HTMLElement,
  isCancelled: () => boolean
): Promise<void> {
  const hasLoadingView = (): boolean =>
    container.querySelector('.bases-view .is-loading') !== null;

  if (isCancelled() || !hasLoadingView()) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: number | null = null;
    let cancelPollId: number | null = null;
    const observer = new MutationObserver(() => {
      if (isCancelled() || !hasLoadingView()) finish();
    });

    const finish = (): void => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (cancelPollId !== null) window.clearInterval(cancelPollId);
      resolve();
    };

    observer.observe(container, {
      attributes: true,
      attributeFilter: ['class', 'style'],
      childList: true,
      subtree: true,
    });
    timeoutId = window.setTimeout(finish, BASES_RENDER_TIMEOUT_MS);
    cancelPollId = window.setInterval(() => {
      if (isCancelled()) finish();
    }, 100);
  });
}

function hasSameOrder(
  batch: readonly NotePreview[],
  paths: readonly string[]
): boolean {
  return (
    batch.length === paths.length &&
    batch.every((preview, index) => preview.path === paths[index])
  );
}

function isMediaOnlyPreview(preview: NotePreview): boolean {
  if (preview.mediaOnly) return true;

  // Older cached previews predate the explicit mediaOnly flag.
  return (
    (Boolean(preview.imagePath) && preview.snippet === '(no preview text)') ||
    /^📎 .+ attached$/.test(preview.snippet ?? '')
  );
}

function parseViewState(state: unknown): DoomscrollViewState | null {
  if (!isRecord(state)) return null;

  const batchPaths = stringArray(state.batchPaths);
  const rawHistory = state.batchHistoryPaths;
  if (!batchPaths || !Array.isArray(rawHistory)) return null;

  const batchHistoryPaths: string[][] = [];
  for (const paths of rawHistory) {
    const parsed = stringArray(paths);
    if (!parsed) return null;
    batchHistoryPaths.push(parsed);
  }

  const cursor = state.batchHistoryCursor;
  const scrollTop = state.scrollTop;
  return {
    batchPaths,
    batchHistoryPaths,
    batchHistoryCursor:
      typeof cursor === 'number' && Number.isInteger(cursor) ? cursor : 0,
    scrollTop:
      typeof scrollTop === 'number' && Number.isFinite(scrollTop)
        ? Math.max(0, scrollTop)
        : 0,
  };
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
