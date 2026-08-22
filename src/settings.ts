import { App, PluginSettingTab, Setting } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import DoomscrollPlugin from './main';
import { PluginSettings } from './types';

const GITHUB_URL = 'https://github.com/yaroshevych/doomscroll';
const ISSUES_URL = `${GITHUB_URL}/issues`;

export const DEFAULT_SETTINGS: PluginSettings = {
  batchSize: 20,
  includeMediaOnlyNotes: true,
  openNoteBehavior: 'tab',
  excludeFolders: [],
  excludeTags: [],
  excludeGlobs: [],
  frontmatterImageProps: ['cover', 'image', 'banner'],
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
        searchable: false,
        render: (setting) => {
          configureHeader(setting);
        },
      },
      {
        name: 'Batch size',
        desc: 'Number of cards to show per reshuffle',
        control: {
          type: 'dropdown',
          key: 'batchSize',
          options: { '10': '10', '20': '20', '50': '50', '100': '100' },
        },
      },
      {
        name: 'Include media-only notes',
        desc: 'Show notes that contain only images, PDFs, or other attachments',
        control: { type: 'toggle', key: 'includeMediaOnlyNotes' },
      },
      {
        name: 'Open notes in',
        desc: 'Choose where a card opens',
        control: {
          type: 'dropdown',
          key: 'openNoteBehavior',
          options: {
            tab: 'New tab',
            reuse: 'Reuse current tab',
            window: 'New window',
          },
        },
      },
      {
        name: 'Exclude folders',
        desc: 'Folder paths to skip (one per line)',
        control: { type: 'textarea', key: 'excludeFolders', rows: 4 },
      },
      {
        name: 'Exclude tags',
        desc: 'Tags to skip without # (one per line)',
        control: { type: 'textarea', key: 'excludeTags', rows: 4 },
      },
      {
        name: 'Exclude filename globs',
        desc: 'Glob patterns to skip (one per line, e.g., _*)',
        control: { type: 'textarea', key: 'excludeGlobs', rows: 4 },
      },
      {
        name: 'Frontmatter image properties',
        desc: 'Property names to check for images in frontmatter (one per line)',
        control: {
          type: 'textarea',
          key: 'frontmatterImageProps',
          rows: 4,
        },
      },
    ];
  }

  getControlValue(key: string): unknown {
    const settings = this.plugin.data.settings;

    switch (key) {
      case 'batchSize':
        return String(settings.batchSize);
      case 'includeMediaOnlyNotes':
        return settings.includeMediaOnlyNotes;
      case 'openNoteBehavior':
        return settings.openNoteBehavior;
      case 'excludeFolders':
      case 'excludeTags':
      case 'excludeGlobs':
      case 'frontmatterImageProps':
        return settings[key].join('\n');
      default:
        return undefined;
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === 'includeMediaOnlyNotes' && typeof value === 'boolean') {
      this.plugin.data.settings.includeMediaOnlyNotes = value;
    } else if (key === 'batchSize' && typeof value === 'string') {
      this.plugin.data.settings.batchSize = Number(value);
    } else if (
      key === 'openNoteBehavior' &&
      (value === 'tab' || value === 'reuse' || value === 'window')
    ) {
      this.plugin.data.settings.openNoteBehavior = value;
    } else if (
      typeof value === 'string' &&
      (key === 'excludeFolders' ||
        key === 'excludeTags' ||
        key === 'excludeGlobs' ||
        key === 'frontmatterImageProps')
    ) {
      this.plugin.data.settings[key] = parseLines(value);
    } else {
      return;
    }

    await this.plugin.saveSettings();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    configureHeader(new Setting(containerEl));

    new Setting(containerEl)
      .setName('Batch size')
      .setDesc('Number of cards to show per reshuffle')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ '10': '10', '20': '20', '50': '50', '100': '100' })
          .setValue(String(this.plugin.data.settings.batchSize))
          .onChange(async (value) => {
            this.plugin.data.settings.batchSize = Number(value);
            await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Exclude folders')
      .setDesc('Folder paths to skip (one per line)')
      .addTextArea((text) =>
        text
          .setValue(this.plugin.data.settings.excludeFolders.join('\n'))
          .onChange(async (value) => {
            this.plugin.data.settings.excludeFolders = parseLines(value);
            await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Exclude filename globs')
      .setDesc('Glob patterns to skip (one per line, e.g., _*)')
      .addTextArea((text) =>
        text
          .setValue(this.plugin.data.settings.excludeGlobs.join('\n'))
          .onChange(async (value) => {
            this.plugin.data.settings.excludeGlobs = parseLines(value);
            await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
          })
      );
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
