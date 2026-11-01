import { App, Modal } from 'obsidian';

const SHORTCUTS: Array<[string[], string]> = [
  [['j', '↓'], 'Next card'],
  [['k', '↑'], 'Previous card'],
  [['Home'], 'First card'],
  [['End'], 'Last card'],
  [['Space'], 'Preview the selected card'],
  [['Enter', 'o'], 'Open the selected card'],
  [['Esc'], 'Clear selection'],
  [['r'], 'Reshuffle'],
  [['p'], 'Back to previous notes'],
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
