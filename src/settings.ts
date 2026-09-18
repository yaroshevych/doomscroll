import {
  AbstractInputSuggest,
  App,
  Notice,
  normalizePath,
  PluginSettingTab,
  requireApiVersion,
  Setting,
  type SettingDefinitionItem,
} from 'obsidian';
import DoomscrollPlugin from './main';
import { isPreviewSize, PluginSettings } from './types';

const GITHUB_URL = 'https://github.com/yaroshevych/doomscroll';
const ISSUES_URL = `${GITHUB_URL}/issues`;

class FolderSuggest extends AbstractInputSuggest<string> {
  inputEl: HTMLInputElement;
  private cachedFolders: string[] | null = null;

  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
    this.inputEl = inputEl;
  }

  private getFolders(): string[] {
    if (this.cachedFolders) return this.cachedFolders;

    this.cachedFolders = this.app.vault
      .getAllFolders()
      .map((folder) => folder.path)
      .filter((path) => path.length > 0);
    return this.cachedFolders;
  }

  getSuggestions(inputStr: string): string[] {
    const lowerInput = inputStr.toLowerCase();
    return this.getFolders().filter((path) =>
      path.toLowerCase().includes(lowerInput)
    );
  }

  renderSuggestion(path: string, el: HTMLElement): void {
    el.setText(path);
  }

  selectSuggestion(path: string): void {
    this.inputEl.value = path;
    this.close();
  }
}

export const DEFAULT_SETTINGS: PluginSettings = {
  batchSize: 20,
  infiniteScroll: false,
  includeMediaOnlyNotes: true,
  simplifiedView: true,
  previewSize: 'medium',
  openNoteBehavior: 'tab',
  excludeFolders: [],
  excludeTags: [],
  excludeGlobs: [],
  searchQuery: '',
  frontmatterImageProps: ['cover', 'image', 'banner'],
  frontmatterBeforeProps: [],
  frontmatterAfterProps: [],
};

export class DoomscrollSettingTab extends PluginSettingTab {
  plugin: DoomscrollPlugin;

  constructor(app: App, plugin: DoomscrollPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: 'Doomscroll settings',
        render: (setting) => configureHeader(setting),
      },
      {
        name: 'Batch size',
        desc: 'Number of cards to show per reshuffle',
        control: {
          type: 'dropdown',
          key: 'batchSize',
          options: { '10': '10', '20': '20', '50': '50', '100': '100' },
          disabled: () => this.plugin.data.settings.infiniteScroll,
        },
      },
      {
        name: 'Infinite scrolling',
        desc: 'Automatically load more notes as you reach the end of the feed',
        control: { type: 'toggle', key: 'infiniteScroll' },
      },
      {
        name: 'Include media-only notes',
        desc: 'Show notes that contain only images, PDFs, or other attachments',
        control: { type: 'toggle', key: 'includeMediaOnlyNotes' },
      },
      {
        name: 'Simplified view',
        desc: 'Show concise previews with readable tables, links, and code; turn off for full Markdown formatting.',
        control: { type: 'toggle', key: 'simplifiedView' },
      },
      {
        name: 'Preview size',
        desc: 'How many lines of note text to show on each card',
        control: {
          type: 'dropdown',
          key: 'previewSize',
          options: { small: 'Small', medium: 'Medium', large: 'Large' },
        },
      },
      {
        name: 'Search query',
        desc: 'Filter notes using Obsidian-style search syntax, such as tag:#work or [status:Draft]',
        control: {
          type: 'text',
          key: 'searchQuery',
          placeholder: 'tag:#work [status:Draft]',
        },
      },
      {
        name: 'Open notes in',
        desc: 'Choose where a card opens',
        control: {
          type: 'dropdown',
          key: 'openNoteBehavior',
          options: { tab: 'New tab', reuse: 'Reuse current tab', window: 'New window' },
        },
      },
      {
        name: 'Exclude tags',
        desc: 'Tags to skip without # (one per line)',
        control: { type: 'textarea', key: 'excludeTags' },
      },
      {
        name: 'Exclude filename patterns',
        desc: 'Filename patterns to skip (one per line, e.g., _*)',
        control: { type: 'textarea', key: 'excludeGlobs' },
      },
      {
        name: 'Frontmatter image properties',
        desc: 'Property names to check for images in frontmatter (one per line)',
        control: { type: 'textarea', key: 'frontmatterImageProps' },
      },
      {
        name: 'Frontmatter properties before preview',
        desc: 'Property names to render before the note body (one per line)',
        control: { type: 'textarea', key: 'frontmatterBeforeProps' },
      },
      {
        name: 'Frontmatter properties after preview',
        desc: 'Property names to render after the note body (one per line)',
        control: { type: 'textarea', key: 'frontmatterAfterProps' },
      },
      {
        name: 'Excluded folders',
        render: (setting) => {
          setting.setName('Excluded folders').setHeading();
          const list = setting.settingEl.createDiv(
            'doomscroll-excluded-folders-list'
          );
          this.renderExcludedFolders(list);
        },
      },
      {
        name: 'Add excluded folder',
        desc: 'Folders to skip (type or choose a folder)',
        render: (setting) => {
          setting.setName('Add excluded folder').setDesc('Folders to skip (type or choose a folder)');
          let folderInputEl: HTMLInputElement | null = null;
          setting.addText((text) => {
            text.setPlaceholder('4. Archive');
            folderInputEl = text.inputEl;
            new FolderSuggest(this.app, text.inputEl);
          });
          setting.addButton((button) =>
            button.setButtonText('Add').onClick(() => {
              const folder = normalizeFolderPath(folderInputEl?.value ?? '');
              if (!folder || folder === '.') {
                new Notice('Excluded folder path cannot be empty or the vault root');
                return;
              }
              if (this.plugin.data.settings.excludeFolders.includes(folder)) {
                new Notice('That folder is already excluded');
                return;
              }
              void this.addExcludedFolder(folder, folderInputEl);
            })
          );
        },
      },
    ];
  }

  getControlValue(key: string): unknown {
    const settings = this.plugin.data.settings;
    switch (key) {
      case 'batchSize':
        return String(settings.batchSize);
      case 'infiniteScroll':
        return settings.infiniteScroll;
      case 'includeMediaOnlyNotes':
        return settings.includeMediaOnlyNotes;
      case 'simplifiedView':
        return settings.simplifiedView;
      case 'previewSize':
        return settings.previewSize;
      case 'searchQuery':
        return settings.searchQuery;
      case 'openNoteBehavior':
        return settings.openNoteBehavior;
      case 'excludeTags':
        return settings.excludeTags.join('\n');
      case 'excludeGlobs':
        return settings.excludeGlobs.join('\n');
      case 'frontmatterImageProps':
        return settings.frontmatterImageProps.join('\n');
      case 'frontmatterBeforeProps':
        return settings.frontmatterBeforeProps.join('\n');
      case 'frontmatterAfterProps':
        return settings.frontmatterAfterProps.join('\n');
      default:
        return undefined;
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.data.settings;
    switch (key) {
      case 'batchSize': {
        const batchSize = Number(value);
        if (![10, 20, 50, 100].includes(batchSize)) return;
        settings.batchSize = batchSize;
        break;
      }
      case 'infiniteScroll':
        if (typeof value !== 'boolean') return;
        settings.infiniteScroll = value;
        break;
      case 'includeMediaOnlyNotes':
        if (typeof value !== 'boolean') return;
        settings.includeMediaOnlyNotes = value;
        break;
      case 'simplifiedView':
        if (typeof value !== 'boolean') return;
        settings.simplifiedView = value;
        break;
      case 'previewSize':
        if (!isPreviewSize(value)) return;
        settings.previewSize = value;
        break;
      case 'searchQuery':
        if (typeof value !== 'string') return;
        settings.searchQuery = value;
        break;
      case 'openNoteBehavior':
        if (value !== 'tab' && value !== 'reuse' && value !== 'window') return;
        settings.openNoteBehavior = value;
        break;
      case 'excludeTags':
        if (typeof value !== 'string') return;
        settings.excludeTags = parseLines(value);
        break;
      case 'excludeGlobs':
        if (typeof value !== 'string') return;
        settings.excludeGlobs = parseLines(value);
        break;
      case 'frontmatterImageProps':
        if (typeof value !== 'string') return;
        settings.frontmatterImageProps = parseLines(value);
        break;
      case 'frontmatterBeforeProps':
        if (typeof value !== 'string') return;
        settings.frontmatterBeforeProps = parseLines(value);
        break;
      case 'frontmatterAfterProps':
        if (typeof value !== 'string') return;
        settings.frontmatterAfterProps = parseLines(value);
        break;
      default:
        return;
    }

    await this.plugin.saveSettingsAndRefreshViews();
    this.refreshDeclarativeSettings();
  }

  private async addExcludedFolder(
    folder: string,
    inputEl: HTMLInputElement | null
  ): Promise<void> {
    this.plugin.data.settings.excludeFolders.push(folder);
    await this.plugin.saveSettingsAndRefreshViews();
    if (inputEl) inputEl.value = '';
    this.refreshDeclarativeSettings();
  }

  private refreshDeclarativeSettings(): void {
    if (requireApiVersion('1.13.0')) {
      this.update();
    }
  }

  private async removeExcludedFolder(
    folder: string,
    container: HTMLElement
  ): Promise<void> {
    const index = this.plugin.data.settings.excludeFolders.indexOf(folder);
    if (index === -1) return;
    this.plugin.data.settings.excludeFolders.splice(index, 1);
    await this.plugin.saveSettingsAndRefreshViews();
    this.renderExcludedFolders(container);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    configureHeader(new Setting(containerEl));

    const batchSizeSetting = new Setting(containerEl)
      .setName('Batch size')
      .setDesc('Number of cards to show per reshuffle')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ '10': '10', '20': '20', '50': '50', '100': '100' })
          .setValue(String(this.plugin.data.settings.batchSize))
          .onChange(async (value) => {
            this.plugin.data.settings.batchSize = Number(value);
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );
    batchSizeSetting.setDisabled(this.plugin.data.settings.infiniteScroll);

    new Setting(containerEl)
      .setName('Infinite scrolling')
      .setDesc('Automatically load more notes as you reach the end of the feed')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.data.settings.infiniteScroll)
          .onChange(async (value) => {
            this.plugin.data.settings.infiniteScroll = value;
            batchSizeSetting.setDisabled(value);
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Include media-only notes')
      .setDesc('Show notes that contain only images, PDFs, or other attachments')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.data.settings.includeMediaOnlyNotes)
          .onChange(async (value) => {
            this.plugin.data.settings.includeMediaOnlyNotes = value;
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Simplified view')
      .setDesc(
        'Show concise previews with readable tables, links, and code; turn off for full Markdown formatting.'
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.data.settings.simplifiedView !== false)
          .onChange(async (value) => {
            this.plugin.data.settings.simplifiedView = value;
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Preview size')
      .setDesc('How many lines of note text to show on each card')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            small: 'Small',
            medium: 'Medium',
            large: 'Large',
          })
          .setValue(this.plugin.data.settings.previewSize)
          .onChange(async (value) => {
            if (!isPreviewSize(value)) return;
            this.plugin.data.settings.previewSize = value;
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Search query')
      .setDesc(
        'Filter notes using Obsidian-style search syntax, such as tag:#work or [status:Draft]'
      )
      .addText((text) =>
        text
          .setPlaceholder('tag:#work [status:Draft]')
          .setValue(this.plugin.data.settings.searchQuery)
          .onChange(async (value) => {
            this.plugin.data.settings.searchQuery = value;
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Open notes in')
      .setDesc('Choose where a card opens')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            tab: 'New tab',
            reuse: 'Reuse current tab',
            window: 'New window',
          })
          .setValue(this.plugin.data.settings.openNoteBehavior)
          .onChange(async (value) => {
            if (value !== 'tab' && value !== 'reuse' && value !== 'window') {
              return;
            }
            this.plugin.data.settings.openNoteBehavior = value;
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Exclude tags')
      .setDesc('Tags to skip without # (one per line)')
      .addTextArea((text) =>
        text
          .setValue(this.plugin.data.settings.excludeTags.join('\n'))
          .onChange(async (value) => {
            this.plugin.data.settings.excludeTags = parseLines(value);
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Exclude filename patterns')
      .setDesc('Filename patterns to skip (one per line, e.g., _*)')
      .addTextArea((text) =>
        text
          .setValue(this.plugin.data.settings.excludeGlobs.join('\n'))
          .onChange(async (value) => {
            this.plugin.data.settings.excludeGlobs = parseLines(value);
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Frontmatter image properties')
      .setDesc(
        'Property names to check for images in frontmatter (one per line)'
      )
      .addTextArea((text) =>
        text
          .setValue(this.plugin.data.settings.frontmatterImageProps.join('\n'))
          .onChange(async (value) => {
            this.plugin.data.settings.frontmatterImageProps = parseLines(value);
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Frontmatter properties before preview')
      .setDesc(
        'Property names to render before the note body (one per line)'
      )
      .addTextArea((text) =>
        text
          .setPlaceholder('title\nsource\nauthor')
          .setValue(
            this.plugin.data.settings.frontmatterBeforeProps.join('\n')
          )
          .onChange(async (value) => {
            this.plugin.data.settings.frontmatterBeforeProps = parseLines(value);
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Frontmatter properties after preview')
      .setDesc(
        'Property names to render after the note body (one per line)'
      )
      .addTextArea((text) =>
        text
          .setPlaceholder('source\nauthor\npublished')
          .setValue(
            this.plugin.data.settings.frontmatterAfterProps.join('\n')
          )
          .onChange(async (value) => {
            this.plugin.data.settings.frontmatterAfterProps = parseLines(value);
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl).setName('Excluded folders').setHeading();

    const excludedFoldersList = containerEl.createDiv(
      'doomscroll-excluded-folders-list'
    );
    this.renderExcludedFolders(excludedFoldersList);

    let folderInputEl: HTMLInputElement;
    new Setting(containerEl)
      .setName('Add excluded folder')
      .setDesc('Folders to exclude from the feed')
      .addText((text) => {
        text.setPlaceholder('4. Archive');
        folderInputEl = text.inputEl;
        new FolderSuggest(this.app, folderInputEl);
      })
      .addButton((button) =>
        button.setButtonText('Add').onClick(async () => {
          const folder = normalizeFolderPath(folderInputEl.value);
          if (!folder || folder === '.') {
            new Notice('Excluded folder path cannot be empty or the vault root');
            return;
          }
          if (this.plugin.data.settings.excludeFolders.includes(folder)) {
            new Notice('That folder is already excluded');
            return;
          }

          this.plugin.data.settings.excludeFolders.push(folder);
          await this.plugin.saveSettingsAndRefreshViews();
          folderInputEl.value = '';
          this.renderExcludedFolders(excludedFoldersList);
        })
      );
  }

  private renderExcludedFolders(container: HTMLElement): void {
    container.empty();

    if (this.plugin.data.settings.excludeFolders.length === 0) {
      container.createDiv({ text: 'No excluded folders' });
      return;
    }

    for (const folder of this.plugin.data.settings.excludeFolders) {
      const row = container.createDiv('doomscroll-excluded-folder-item');
      row.createSpan({ text: folder });
      row
        .createEl('button', {
          text: '×',
          cls: 'doomscroll-excluded-folder-remove',
          attr: { 'aria-label': `Remove excluded folder ${folder}` },
        })
        .addEventListener('click', () => {
          void this.removeExcludedFolder(folder, container);
        });
    }
  }

}

function configureHeader(setting: Setting): void {
  setting
    .setClass('doomscroll-settings-header')
    .setName('Doomscroll settings')
    .setHeading()
    .addButton((button) =>
      button.setButtonText('GitHub').onClick(() => {
        window.open(GITHUB_URL, '_blank');
      })
    )
    .addButton((button) =>
      button.setButtonText('Report issue').onClick(() => {
        window.open(ISSUES_URL, '_blank');
      })
    );
}

function parseLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function normalizeFolderPath(value: string): string {
  return normalizePath(value.trim()).replace(/\/+$/, '');
}
