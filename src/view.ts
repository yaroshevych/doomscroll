import { ItemView, WorkspaceLeaf, TFile, setIcon } from 'obsidian';
import ObsidianScrollPlugin from './main';
import { NotePreview, toNotePreview } from './types';
import { selectBatch } from './selector';
import { recordView } from './history';

export const VIEW_TYPE_SCROLL = 'obsidian-scroll-view';

export class ScrollView extends ItemView {
  plugin: ObsidianScrollPlugin;
  containerEl: HTMLElement;
  hasRendered: boolean = false;
  currentBatch: NotePreview[] = [];
  imageObserver: IntersectionObserver | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ObsidianScrollPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.containerEl = this.contentEl;
  }

  getViewType(): string {
    return VIEW_TYPE_SCROLL;
  }

  getDisplayText(): string {
    return 'PKM Feed';
  }

  getIcon(): string {
    return 'gallery-vertical';
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  private async render(): Promise<void> {
    this.containerEl.empty();

    // Header row
    const header = this.containerEl.createDiv('scroll-header');
    header.className = 'scroll-header';

    const title = header.createEl('h2');
    title.textContent = 'PKM Feed';
    title.className = 'scroll-title';

    const controls = header.createDiv('scroll-controls');
    controls.className = 'scroll-controls';

    // Reshuffle button (refresh icon)
    const reshuffleBtn = controls.createEl('button');
    reshuffleBtn.className = 'scroll-reshuffle-btn';
    reshuffleBtn.setAttribute('aria-label', 'Reshuffle');
    setIcon(reshuffleBtn, 'refresh-cw');
    reshuffleBtn.addEventListener('click', () => {
      this.currentBatch = [];
      this.renderBatch();
      this.containerEl.querySelector('.scroll-body')?.scrollTo({ top: 0 });
    });

    // Settings button
    const settingsBtn = controls.createEl('button');
    settingsBtn.className = 'scroll-settings-btn';
    settingsBtn.setAttribute('aria-label', 'Settings');
    setIcon(settingsBtn, 'settings');
    settingsBtn.addEventListener('click', () => {
      (this.plugin.app as any).setting.open();
      (this.plugin.app as any).setting.openTabById('pkm-feed');
    });

    // Body - scrollable container
    const bodyContainer = this.containerEl.createDiv('scroll-body');
    bodyContainer.className = 'scroll-body';

    // Check if need to index
    if (Object.keys(this.plugin.data.previews).length === 0) {
      const loadingEl = bodyContainer.createDiv('scroll-loading');
      loadingEl.textContent = 'Indexing your vault…';

      try {
        await this.plugin.indexer.buildOrUpdateIndex((done, total) => {
          loadingEl.textContent = `Indexed ${done}/${total}`;
        });
        await this.plugin.saveSettings();
      } catch (error) {
        console.error('Error indexing vault:', error);
        loadingEl.textContent = 'Error indexing vault';
      }

      loadingEl.remove();
    }

    // Render batch
    this.hasRendered = true;
    this.renderBatchIntoContainer(bodyContainer);
  }

  private renderBatchIntoContainer(container: HTMLElement): void {
    // Get fresh batch if not already loaded
    if (this.currentBatch.length === 0) {
      const candidates = Object.entries(this.plugin.data.previews).map(
        ([path, stored]) => toNotePreview(path, stored)
      );
      this.currentBatch = selectBatch(
        candidates,
        this.plugin.data.history,
        this.plugin.data.settings.batchSize,
        Date.now()
      );
    }

    // Clear previous content
    container.empty();

    // Render cards
    for (const preview of this.currentBatch) {
      const card = this.renderCard(preview);
      container.appendChild(card);
    }

    // Reshuffle button at end
    const reshuffleSection = container.createDiv('scroll-reshuffle-section');
    const reshuffleBtn = reshuffleSection.createEl('button');
    reshuffleBtn.className = 'scroll-reshuffle-end-btn';
    reshuffleBtn.textContent = 'Reshuffle';
    reshuffleBtn.addEventListener('click', () => {
      this.currentBatch = [];
      this.renderBatchIntoContainer(container);
      container.scrollTo({ top: 0 });
    });
  }

  private renderBatch(): void {
    const body = this.containerEl.querySelector('.scroll-body');
    if (body) {
      this.renderBatchIntoContainer(body as HTMLElement);
    }
  }

  private renderCard(preview: NotePreview): HTMLElement {
    const card = document.createElement('div');
    card.className = 'scroll-card';

    // Title + date row
    const titleRow = card.createEl('div');
    titleRow.className = 'scroll-card-titlerow';

    const titleEl = titleRow.createEl('h3');
    titleEl.className = 'scroll-card-title';
    titleEl.textContent = preview.title;

    const dateEl = titleRow.createEl('div');
    dateEl.className = 'scroll-card-date';
    const date = new Date(preview.mtime);
    dateEl.textContent = date.toLocaleDateString();

    // Image (lazy loaded)
    if (preview.imagePath) {
      const imageContainer = card.createEl('div');
      imageContainer.className = 'scroll-card-image-container';

      const img = imageContainer.createEl('img');
      img.className = 'scroll-card-image';
      img.dataset.src = preview.imagePath;
      img.alt = preview.title;

      // Setup lazy loading via IntersectionObserver
      this.setupImageLazyLoad(img, preview);
    }

    // Snippet
    const snippetEl = card.createEl('p');
    snippetEl.className = 'scroll-card-snippet';
    snippetEl.textContent = preview.snippet;
    snippetEl.style.whiteSpace = 'pre-line';

    // Click handler
    card.addEventListener('click', async () => {
      const file = this.plugin.app.vault.getAbstractFileByPath(
        preview.path
      ) as TFile;

      if (file) {
        // Record view
        this.plugin.data.history = recordView(
          this.plugin.data.history,
          preview.path,
          Date.now()
        );
        await this.plugin.saveSettings();

        // Open in new leaf
        this.plugin.app.workspace.getLeaf(true).openFile(file);
      }
    });

    return card;
  }

  private setupImageLazyLoad(img: HTMLImageElement, preview: NotePreview): void {
    if (!this.imageObserver) {
      this.imageObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              const imgEl = entry.target as HTMLImageElement;
              const src = imgEl.dataset.src;

              if (src) {
                const file = this.plugin.app.vault.getAbstractFileByPath(
                  preview.path
                ) as TFile;

                let resolvedSrc: string | null = null;
                if (file) {
                  resolvedSrc = this.plugin.indexer.resolveImageSrc(
                    src,
                    file
                  );
                }

                if (resolvedSrc) {
                  imgEl.src = resolvedSrc;
                } else {
                  // Couldn't resolve — hide the container instead of showing a broken icon
                  imgEl.closest('.scroll-card-image-container')?.remove();
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

  onClose(): Promise<void> {
    if (this.imageObserver) {
      this.imageObserver.disconnect();
      this.imageObserver = null;
    }
    return Promise.resolve();
  }
}
