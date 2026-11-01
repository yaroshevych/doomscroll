import {
  AbstractInputSuggest,
  App,
  Notice,
  normalizePath,
  PluginSettingTab,
  requireApiVersion,
  Setting,
  type SettingDefinitionItem,
  type SettingGroupItem,
} from 'obsidian';
import DoomscrollPlugin from './main';
import { FeedFilters, isPreviewSize, PluginSettings } from './types';

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
  name: 'Default feed',
  batchSize: 20,
  infiniteScroll: false,
  headerScrollsWithFeed: false,
  includeMediaOnlyNotes: true,
  showNonMarkdownFiles: true,
  simplifiedView: true,
  reduceAnimations: false,
  previewSize: 'medium',
  openNoteBehavior: 'tab',
  excludeFolders: [],
  excludeTags: [],
  excludeGlobs: [],
  searchQuery: '',
  frontmatterImageProps: ['cover', 'image', 'banner'],
  frontmatterBeforeProps: [],
  frontmatterAfterProps: [],
  additionalFeeds: [],
};

export class DoomscrollSettingTab extends PluginSettingTab {
  plugin: DoomscrollPlugin;
  private legacyFeed: FeedFilters | null = null;

  constructor(app: App, plugin: DoomscrollPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const definitions: SettingDefinitionItem[] = [
      {
        name: 'Doomscroll settings',
        render: (setting) => configureHeader(setting),
      },
      {
        name: 'Infinite scrolling',
        desc: 'Automatically load more notes as you reach the end of the feed',
        control: { type: 'toggle', key: 'infiniteScroll' },
      },
      {
        name: 'Batch size',
        desc: 'Number of cards to show per reshuffle. Does not apply while infinite scrolling is enabled.',
        control: {
          type: 'dropdown',
          key: 'batchSize',
          options: { '10': '10', '20': '20', '50': '50', '100': '100' },
          disabled: () => this.plugin.data.settings.infiniteScroll,
        },
      },
      {
        name: 'Header scrolls with feed',
        desc: 'The header will scroll away from view',
        control: { type: 'toggle', key: 'headerScrollsWithFeed' },
      },
      {
        name: 'Include media-only notes',
        desc: 'Show Markdown notes containing only images or other attachments',
        control: { type: 'toggle', key: 'includeMediaOnlyNotes' },
      },
      {
        name: 'Show non-Markdown files',
        desc: 'Show standalone vault files such as images, PDFs, and other attachments',
        control: { type: 'toggle', key: 'showNonMarkdownFiles' },
      },
      {
        name: 'Simplified view',
        desc: 'Show concise previews with readable tables, links, and code; turn off for full Markdown formatting.',
        control: { type: 'toggle', key: 'simplifiedView' },
      },
      {
        name: 'Reduce animation',
        desc: 'Disable card and scrolling animations during keyboard navigation',
        control: { type: 'toggle', key: 'reduceAnimations' },
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
        name: 'Open notes in',
        desc: 'Choose where a card opens',
        control: {
          type: 'dropdown',
          key: 'openNoteBehavior',
          options: { tab: 'New tab', reuse: 'Reuse current tab', window: 'New window' },
        },
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
    ];

    const feedItems: SettingGroupItem[] = [
      { name: 'About feeds', render: (setting) => {
        setting.setName(FEEDS_DESCRIPTION).setClass('doomscroll-feeds-description');
      } },
    ];
    const usedNames = new Set<string>();
    const addFeedPage = (fallback: string, feed: FeedFilters) => {
      const base = feed.name.trim() || fallback;
      let name = base;
      let suffix = 2;
      while (usedNames.has(name)) name = `${base} (${suffix++})`;
      usedNames.add(name);
      const group = this.createFeedDefinition(fallback, feed);
      feedItems.push({ type: 'page', name, items: [group, ...(feed === this.plugin.data.settings ? [] : [{
        name: 'Delete feed',
        render: (setting: Setting) => { setting.setName('Delete feed').addButton((button) =>
          button.setButtonText('Delete feed').setWarning().onClick(() => { void this.deleteFeed(feed); })
        ); },
      }])] });
    };
    addFeedPage('Default feed', this.plugin.data.settings);
    this.plugin.data.settings.additionalFeeds.forEach((feed, index) => {
      addFeedPage(`Feed ${index + 1}`, feed);
    });
    feedItems.push({
      name: 'Add Feed',
      render: (setting) => {
        setting.setClass('doomscroll-add-feed').addButton((button) =>
          button.setButtonText('Add Feed').onClick(() => {
            void this.addFeed();
          })
        );
      },
    });
    definitions.push({ type: 'group', heading: 'Feeds', cls: 'doomscroll-feeds-group', items: feedItems });

    return definitions;
  }

  private createFeedDefinition(
    heading: string,
    filters: FeedFilters
  ): SettingDefinitionItem {
    return {
      type: 'group',
      heading: filters.name.trim() || heading,
      cls: 'doomscroll-feed-filters',
      items: [
        {
          name: 'Name',
          render: (setting) => {
            setting
              .setName('Name')
              .addText((text) =>
                text
                  .setValue(filters.name)
                  .onChange(async (value) => {
                    filters.name = value;
                    await this.plugin.saveSettings();
                  })
              );
            setting.settingEl
              .querySelector('input')
              ?.addEventListener('blur', () => {
                this.plugin.refreshFeedCommands();
                this.refreshDeclarativeSettings();
              });
          },
        },
        {
          name: 'Search query',
          render: (setting) => {
            setting
              .setName('Search query')
              .setDesc('Filter notes using Obsidian-style search syntax, such as tag:#work or [status:Draft]')
              .addText((text) =>
                text
                  .setPlaceholder('tag:#work [status:Draft]')
                  .setValue(filters.searchQuery)
                  .onChange(async (value) => {
                    filters.searchQuery = value;
                    await this.saveFeedSettings(filters);
                  })
              );
          },
        },
        {
          name: 'Exclude tags',
          render: (setting) => {
            setting
              .setName('Exclude tags')
              .setDesc('Tags to skip without # (one per line)')
              .addTextArea((text) =>
                text
                  .setValue(filters.excludeTags.join('\n'))
                  .onChange(async (value) => {
                    filters.excludeTags = parseLines(value);
                    await this.saveFeedSettings(filters);
                  })
              );
          },
        },
        {
          name: 'Exclude filename patterns',
          render: (setting) => {
            setting
              .setName('Exclude filename patterns')
              .setDesc('Filename patterns to skip (one per line, e.g., _*)')
              .addTextArea((text) =>
                text
                  .setValue(filters.excludeGlobs.join('\n'))
                  .onChange(async (value) => {
                    filters.excludeGlobs = parseLines(value);
                    await this.saveFeedSettings(filters);
                  })
              );
          },
        },
        {
          name: 'Excluded folders',
          render: (setting) => {
            setting.setName('Excluded folders').setHeading();
            const list = setting.settingEl.createDiv(
              'doomscroll-excluded-folders-list'
            );
            this.renderExcludedFolders(list, filters);
          },
        },
        {
          name: 'Add excluded folder',
          render: (setting) => {
            setting
              .setName('Add excluded folder')
              .setDesc('Folders to exclude from this feed');
            let inputEl: HTMLInputElement | null = null;
            setting.addText((text) => {
              text.setPlaceholder('4. Archive');
              inputEl = text.inputEl;
              new FolderSuggest(this.app, inputEl);
            });
            setting.addButton((button) =>
              button.setButtonText('Add').onClick(() => {
                const folder = normalizeFolderPath(inputEl?.value ?? '');
                if (!folder || folder === '.') {
                  new Notice('Excluded folder path cannot be empty or the vault root');
                  return;
                }
                if (filters.excludeFolders.includes(folder)) {
                  new Notice('That folder is already excluded');
                  return;
                }
                filters.excludeFolders.push(folder);
                void this.saveFeedSettings(filters).then(() => {
                  if (inputEl) inputEl.value = '';
                  this.refreshDeclarativeSettings();
                });
              })
            );
          },
        },
      ],
    };
  }

  private async saveFeedSettings(filters: FeedFilters): Promise<void> {
    if (filters === this.plugin.data.settings) {
      await this.plugin.saveSettingsAndRefreshViews();
    } else {
      await this.plugin.saveSettings();
    }
  }

  private async addFeed(): Promise<void> {
    const defaults = this.plugin.data.settings;
    this.plugin.data.settings.additionalFeeds.push({
      name: `Feed ${this.plugin.data.settings.additionalFeeds.length + 1}`,
      searchQuery: defaults.searchQuery,
      excludeTags: [...defaults.excludeTags],
      excludeGlobs: [...defaults.excludeGlobs],
      excludeFolders: [...defaults.excludeFolders],
    });
    await this.plugin.saveSettings();
    this.plugin.refreshFeedCommands();
    this.refreshDeclarativeSettings();
  }

  private async deleteFeed(feed: FeedFilters): Promise<void> {
    const index = this.plugin.data.settings.additionalFeeds.indexOf(feed);
    if (index < 0) return;
    this.legacyFeed = null;
    await this.plugin.removeAdditionalFeed(index);
    this.refreshDeclarativeSettings();
  }

  getControlValue(key: string): unknown {
    const settings = this.plugin.data.settings;
    switch (key) {
      case 'batchSize':
        return String(settings.batchSize);
      case 'infiniteScroll':
        return settings.infiniteScroll;
      case 'headerScrollsWithFeed':
        return settings.headerScrollsWithFeed;
      case 'includeMediaOnlyNotes':
        return settings.includeMediaOnlyNotes;
      case 'showNonMarkdownFiles':
        return settings.showNonMarkdownFiles;
      case 'simplifiedView':
        return settings.simplifiedView;
      case 'reduceAnimations':
        return settings.reduceAnimations;
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
      case 'headerScrollsWithFeed':
        if (typeof value !== 'boolean') return;
        settings.headerScrollsWithFeed = value;
        break;
      case 'includeMediaOnlyNotes':
        if (typeof value !== 'boolean') return;
        settings.includeMediaOnlyNotes = value;
        break;
      case 'showNonMarkdownFiles':
        if (typeof value !== 'boolean') return;
        settings.showNonMarkdownFiles = value;
        break;
      case 'simplifiedView':
        if (typeof value !== 'boolean') return;
        settings.simplifiedView = value;
        break;
      case 'reduceAnimations':
        if (typeof value !== 'boolean') return;
        settings.reduceAnimations = value;
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
    inputEl: HTMLInputElement | null,
    filters: FeedFilters
  ): Promise<void> {
    filters.excludeFolders.push(folder);
    await this.saveFeedSettings(filters);
    if (inputEl) inputEl.value = '';
    this.refreshDeclarativeSettings();
  }

  private refreshDeclarativeSettings(): void {
    if (requireApiVersion('1.13.0')) {
      this.update();
    } else {
      this.display();
    }
  }

  private async removeExcludedFolder(
    folder: string,
    container: HTMLElement,
    filters: FeedFilters
  ): Promise<void> {
    const index = filters.excludeFolders.indexOf(folder);
    if (index === -1) return;
    filters.excludeFolders.splice(index, 1);
    await this.saveFeedSettings(filters);
    this.renderExcludedFolders(container, filters);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    if (this.legacyFeed) {
      this.displayLegacyFeedsPage();
      return;
    }

    configureHeader(new Setting(containerEl));

    let batchSizeSetting: Setting | null = null;
    new Setting(containerEl)
      .setName('Infinite scrolling')
      .setDesc('Automatically load more notes as you reach the end of the feed')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.data.settings.infiniteScroll)
          .onChange(async (value) => {
            this.plugin.data.settings.infiniteScroll = value;
            batchSizeSetting?.setDisabled(value);
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    batchSizeSetting = new Setting(containerEl)
      .setName('Batch size')
      .setDesc('Number of cards to show per reshuffle. Does not apply while infinite scrolling is enabled.')
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
      .setName('Header scrolls with feed')
      .setDesc('The header will scroll away from view')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.data.settings.headerScrollsWithFeed)
          .onChange(async (value) => {
            this.plugin.data.settings.headerScrollsWithFeed = value;
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Include media-only notes')
      .setDesc('Show Markdown notes containing only images or other attachments')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.data.settings.includeMediaOnlyNotes)
          .onChange(async (value) => {
            this.plugin.data.settings.includeMediaOnlyNotes = value;
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Show non-Markdown files')
      .setDesc('Show standalone vault files such as images, PDFs, and other attachments')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.data.settings.showNonMarkdownFiles)
          .onChange(async (value) => {
            this.plugin.data.settings.showNonMarkdownFiles = value;
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
      .setName('Reduce animation')
      .setDesc('Disable card and scrolling animations during keyboard navigation')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.data.settings.reduceAnimations)
          .onChange(async (value) => {
            this.plugin.data.settings.reduceAnimations = value;
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

    const feedsGroup = containerEl.createDiv('doomscroll-feeds-group');
    new Setting(feedsGroup).setName('Feeds').setDesc(FEEDS_DESCRIPTION).setHeading();
    const addFeedLink = (feed: FeedFilters, fallback: string) => {
      new Setting(feedsGroup).setName(feed.name.trim() || fallback)
        .addButton((button) => button.setButtonText('Configure').onClick(() => {
          this.legacyFeed = feed;
          this.display();
        }));
    };
    addFeedLink(this.plugin.data.settings, 'Default feed');
    this.plugin.data.settings.additionalFeeds.forEach((feed, index) => addFeedLink(feed, `Feed ${index + 1}`));
    new Setting(feedsGroup).setClass('doomscroll-add-feed').addButton((button) =>
      button.setButtonText('Add Feed').onClick(() => { void this.addFeed(); })
    );
  }

  private displayLegacyFeedsPage(): void {
    const { containerEl } = this;
    const feed = this.legacyFeed;
    if (!feed) return;
    new Setting(containerEl)
      .setName(feed.name.trim() || 'Feed')
      .setHeading()
      .addButton((button) => button.setButtonText('Back').onClick(() => {
        this.legacyFeed = null;
        this.display();
      }));
    this.renderFeedFilters(containerEl, feed.name.trim() || 'Feed', feed);
    if (feed !== this.plugin.data.settings) {
      new Setting(containerEl).setName('Delete feed').addButton((button) =>
        button.setButtonText('Delete feed').setWarning().onClick(() => { void this.deleteFeed(feed); })
      );
    }
  }

  private renderFeedFilters(
    containerEl: HTMLElement,
    heading: string,
    filters: FeedFilters
  ): void {
    const feedGroup = containerEl.createDiv('doomscroll-feed-filters');
    new Setting(feedGroup).setName(heading).setHeading();

    const nameSetting = new Setting(feedGroup)
      .setName('Name')
      .addText((text) =>
        text.setValue(filters.name).onChange(async (value) => {
          filters.name = value;
          await this.plugin.saveSettings();
        })
      );
    nameSetting.controlEl.querySelector('input')?.addEventListener('blur', () => {
      this.plugin.refreshFeedCommands();
      this.refreshDeclarativeSettings();
    });

    new Setting(feedGroup)
      .setName('Search query')
      .setDesc(
        'Filter notes using Obsidian-style search syntax, such as tag:#work or [status:Draft]'
      )
      .addText((text) =>
        text
          .setPlaceholder('tag:#work [status:Draft]')
          .setValue(filters.searchQuery)
          .onChange(async (value) => {
            filters.searchQuery = value;
            await this.saveFeedSettings(filters);
          })
      );

    new Setting(feedGroup)
      .setName('Exclude tags')
      .setDesc('Tags to skip without # (one per line)')
      .addTextArea((text) =>
        text
          .setValue(filters.excludeTags.join('\n'))
          .onChange(async (value) => {
            filters.excludeTags = parseLines(value);
            await this.saveFeedSettings(filters);
          })
      );

    new Setting(feedGroup)
      .setName('Exclude filename patterns')
      .setDesc('Filename patterns to skip (one per line, e.g., _*)')
      .addTextArea((text) =>
        text
          .setValue(filters.excludeGlobs.join('\n'))
          .onChange(async (value) => {
            filters.excludeGlobs = parseLines(value);
            await this.saveFeedSettings(filters);
          })
      );

    new Setting(feedGroup).setName('Excluded folders').setHeading();
    const excludedFoldersList = feedGroup.createDiv(
      'doomscroll-excluded-folders-list'
    );
    this.renderExcludedFolders(excludedFoldersList, filters);

    let folderInputEl: HTMLInputElement;
    new Setting(feedGroup)
      .setName('Add excluded folder')
      .setDesc('Folders to exclude from this feed')
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
          if (filters.excludeFolders.includes(folder)) {
            new Notice('That folder is already excluded');
            return;
          }
          await this.addExcludedFolder(folder, folderInputEl, filters);
        })
      );
  }

  private renderExcludedFolders(
    container: HTMLElement,
    filters: FeedFilters
  ): void {
    container.empty();

    if (filters.excludeFolders.length === 0) {
      container.createDiv({ text: 'No excluded folders' });
      return;
    }

    for (const folder of filters.excludeFolders) {
      const row = container.createDiv('doomscroll-excluded-folder-item');
      row.createSpan({ text: folder });
      row
        .createEl('button', {
          text: '×',
          cls: 'doomscroll-excluded-folder-remove',
          attr: { 'aria-label': `Remove excluded folder ${folder}` },
        })
        .addEventListener('click', () => {
          void this.removeExcludedFolder(folder, container, filters);
        });
    }
  }

}

const FEEDS_DESCRIPTION = 'You start with one default feed, which you can rename and configure. You can also add more feeds.';

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
