import {
  App,
  Component,
  EventRef,
  MarkdownRenderer,
  Modal,
  TFile,
} from 'obsidian';
import { isImagePath, isPdfPath, isVideoPath } from './media';

/** A read-only note or attachment preview displayed over the feed. */
export class PeekModal extends Modal {
  private readonly renderComponent = new Component();
  private fileOpenRef: EventRef | null = null;
  private isClosed = false;

  constructor(
    app: App,
    private readonly file: TFile,
    private readonly openInTab: () => void
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.isClosed = false;
    this.modalEl.addClass('doomscroll-peek');
    this.setTitle(this.file.basename);
    this.renderComponent.load();
    this.scope.register([], ' ', () => {
      this.close();
      return false;
    });

    // Close the peek if a rendered link or another plugin opens a note behind it.
    this.fileOpenRef = this.app.workspace.on('file-open', () => this.close());

    const body = this.contentEl.createDiv('doomscroll-peek-body');
    body.addEventListener('click', (event) => this.handleLinkClick(event));
    if (isImagePath(this.file.path)) {
      body
        .createEl('img', { cls: 'doomscroll-peek-image' })
        .setAttribute('src', this.app.vault.getResourcePath(this.file));
    } else if (isPdfPath(this.file.path)) {
      const pdf = body.createEl('iframe', { cls: 'doomscroll-peek-pdf' });
      pdf.title = `${this.file.basename} preview`;
      pdf.src = `${this.app.vault.getResourcePath(this.file)}#page=1&view=FitH`;
    } else if (isVideoPath(this.file.path)) {
      const video = body.createEl('video', { cls: 'doomscroll-peek-video' });
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.src = this.app.vault.getResourcePath(this.file);
    } else {
      body.addClass('markdown-rendered');
      const markdown = await this.app.vault.cachedRead(this.file);
      if (this.isClosed) return;
      await MarkdownRenderer.render(
        this.app,
        markdown,
        body,
        this.file.path,
        this.renderComponent
      );
    }

    if (this.isClosed) return;
    const footer = this.contentEl.createDiv('doomscroll-peek-footer');
    footer
      .createEl('button', { text: 'Open in tab', cls: 'mod-cta' })
      .addEventListener('click', () => {
        this.close();
        this.openInTab();
      });
  }

  private handleLinkClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const link = target.closest('a');
    if (!link) return;

    if (link.classList.contains('internal-link')) {
      const destination =
        link.getAttribute('data-href') ?? link.getAttribute('href');
      if (!destination) return;
      event.preventDefault();
      event.stopPropagation();
      void this.app.workspace.openLinkText(destination, this.file.path, 'tab');
    } else if (link.classList.contains('external-link')) {
      const href = link.getAttribute('href');
      if (!href) return;
      event.preventDefault();
      event.stopPropagation();
      window.open(href, '_blank', 'noopener');
    }
  }

  onClose(): void {
    this.isClosed = true;
    if (this.fileOpenRef) {
      this.app.workspace.offref(this.fileOpenRef);
      this.fileOpenRef = null;
    }
    this.renderComponent.unload();
    this.contentEl.empty();
  }
}
