import { App, Modal } from 'obsidian';

const SHORTCUTS: Array<[string[], string]> = [
  [['j', '↓'], 'Next card'],
  [['k', '↑'], 'Previous card'],
  [['Home'], 'First card'],
  [['End'], 'Last card'],
  [['Space'], 'Quick look at the focused note'],
  [['Enter', 'o'], 'Open the focused card'],
  [['Esc'], 'Clear the focus'],
  [['r'], 'Reshuffle'],
  [['p'], 'Previous card set'],
  [['?'], 'Show this help'],
];

export class ShortcutsModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    this.setTitle('Doomscroll shortcuts');
    const list = this.contentEl.createEl('dl', { cls: 'doomscroll-help-list' });
    for (const [keys, description] of SHORTCUTS) {
      const dt = list.createEl('dt');
      keys.forEach((key) => dt.createEl('kbd', { text: key }));
      list.createEl('dd', { text: description });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
