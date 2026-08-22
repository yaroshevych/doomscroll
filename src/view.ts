import { ItemView, WorkspaceLeaf, TFile, setIcon } from 'obsidian';
import DoomscrollPlugin from './main';
import { NotePreview, toNotePreview } from './types';
import { selectBatch } from './selector';
import { recordView } from './history';

export const VIEW_TYPE_DOOMSCROLL = 'doomscroll-view';
const HISTORY_SAVE_DELAY_MS = 2_000;
const MAX_BATCH_HISTORY = 20;

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

export class DoomscrollView extends ItemView {
  plugin: DoomscrollPlugin;
  containerEl: HTMLElement;
  hasRendered: boolean = false;
  currentBatch: NotePreview[] = [];
  imageObserver: IntersectionObserver | null = null;
  cardObserver: IntersectionObserver | null = null;
  viewedPathsInBatch: Set<string> = new Set();
  batchHistory: NotePreview[][] = [];
  batchHistoryCursor: number = -1;
  backButton: HTMLButtonElement | null = null;
  private historySaveTimer: number | null = null;
  private historySavePending = false;
  private restoredScrollTop = 0;

  constructor(leaf: WorkspaceLeaf, plugin: DoomscrollPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.containerEl = this.contentEl;
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

    if (this.hasRendered) {
      this.renderBatch();
      this.restoreScrollPosition();
    }
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  private async render(): Promise<void> {
    this.containerEl.empty();
    this.containerEl.addClass('doomscroll-view-container');

    // Header row
    const header = this.containerEl.createDiv('doomscroll-header');

    const title = header.createEl('h2');
    title.textContent = 'Doomscroll';
    title.className = 'doomscroll-title';

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
    this.backButton.addEventListener('click', () => this.showPreviousBatch());
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

    // The first run must build an index before there is anything to display.
    // Existing indexes are refreshed only after an explicit reshuffle.
    const needsInitialIndex = Object.keys(this.plugin.data.previews).length === 0;
    const loadingEl = needsInitialIndex
      ? bodyContainer.createDiv('doomscroll-loading')
      : null;
    if (loadingEl) {
      loadingEl.textContent = 'Indexing your vault…';
    }

    if (needsInitialIndex) {
      try {
        await this.plugin.indexer.refreshIfStale(
          (done, total) => {
            if (loadingEl) {
              loadingEl.textContent = `Indexed ${done}/${total}`;
            }
          },
          true
        );
        await this.plugin.saveSettings();
      } catch (error) {
        console.error('Error indexing vault:', error);
        if (loadingEl) {
          loadingEl.textContent = 'Error indexing vault';
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
        this.plugin.data.settings.batchSize,
        Date.now()
      );
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

    this.updateBackButton();

    // Stop observing cards from the previous batch before replacing them.
    this.cardObserver?.disconnect();
    this.viewedPathsInBatch.clear();

    this.cardObserver = new IntersectionObserver(
      (entries) => {
        let historyChanged = false;

        for (const entry of entries) {
          if (!entry.isIntersecting) continue;

          const card = entry.target as HTMLElement;
          const path = card.dataset.path;
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
    reshuffleBtn.addEventListener('click', () => {
      void this.showNewBatch();
    });
  }

  private showNewBatch(): void {
    const previousOrder = this.currentBatch.map((preview) => preview.path);
    this.currentBatch = [];
    this.renderBatch(previousOrder);
    this.containerEl.querySelector('.doomscroll-body')?.scrollTo({ top: 0 });

    // Let the cached reshuffle paint first. Vault enumeration still runs on
    // the UI thread because Obsidian's API is unavailable inside Web Workers.
    window.setTimeout(() => {
      void this.refreshIndexInBackground();
    }, 0);
  }

  private async refreshIndexInBackground(): Promise<void> {
    try {
      const refreshed = await this.plugin.indexer.refreshIfStale();
      if (refreshed) {
        await this.plugin.saveSettings();
      }
    } catch (error) {
      console.error('Error refreshing vault index:', error);
    }
  }

  private showPreviousBatch(): void {
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

  private renderCard(
    container: HTMLElement,
    preview: NotePreview
  ): HTMLElement {
    const card = container.createDiv('doomscroll-card');
    card.dataset.path = preview.path;

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

      // Setup lazy loading via IntersectionObserver
      this.setupImageLazyLoad(img);
    }

    // Snippet
    const snippetEl = card.createEl('p');
    snippetEl.className = 'doomscroll-card-snippet';
    snippetEl.textContent = preview.snippet;

    // Click handler
    card.addEventListener('click', () => {
      void this.openPreview(preview);
    });

    return card;
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

  private setupImageLazyLoad(img: HTMLImageElement): void {
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
    if (this.cardObserver) {
      this.cardObserver.disconnect();
      this.cardObserver = null;
    }
    if (this.imageObserver) {
      this.imageObserver.disconnect();
      this.imageObserver = null;
    }
    if (this.historySaveTimer !== null) {
      window.clearTimeout(this.historySaveTimer);
      this.historySaveTimer = null;
    }
    await this.flushHistorySave();
  }
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
    /^📎 .+ attached$/.test(preview.snippet)
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
