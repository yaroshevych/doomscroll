import {
  AbstractInputSuggest,
  App,
  Modal,
  Notice,
  normalizePath,
  PluginSettingTab,
  Platform,
  requireApiVersion,
  Setting,
  type SettingDefinitionList,
  type SettingDefinitionItem,
  type SettingGroupItem,
} from 'obsidian';
import DoomscrollPlugin from './main';
import { ShortcutsModal } from './help';
import { uuidv7 } from './uuid';
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
    this.setValue(path);
    this.close();
  }
}

class DeleteFeedModal extends Modal {
  constructor(app: App, private feedName: string, private onConfirm: () => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('Delete feed?');
    this.contentEl.createEl('p', {
      text: `Delete “${this.feedName}”? Your notes will not be deleted.`,
    });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) => button.setButtonText('Delete feed').setWarning().onClick(() => {
        this.close();
        this.onConfirm();
      }));
  }
}

class AddExcludedFolderModal extends Modal {
  constructor(app: App, private tab: DoomscrollSettingTab, private filters: FeedFilters) { super(app); }
  onOpen(): void {
    this.titleEl.setText('Add excluded folder');
    let inputEl: HTMLInputElement;
    new Setting(this.contentEl).setName('').setDesc('Select a folder from suggestions, or type or paste its path')
      .setClass('doomscroll-folder-picker-input doomscroll-folder-picker-field').addText((text) => {
      text.setPlaceholder('4. Archive');
      inputEl = text.inputEl;
      new FolderSuggest(this.app, inputEl);
    });
    new Setting(this.contentEl).addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) => button.setButtonText('Add').setCta().onClick(async () => {
        const folder = normalizeFolderPath(inputEl.value);
        if (!folder || folder === '.') { new Notice('Excluded folder path cannot be empty or the vault root'); return; }
        if (this.filters.excludeFolders.includes(folder)) { new Notice('That folder is already excluded'); return; }
        this.filters.excludeFolders.push(folder);
        await this.tab.saveExcludedFolders(this.filters);
        this.close();
      }));
  }
}

export const DEFAULT_SETTINGS: PluginSettings = {
  id: '',
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
  private legacyFrontmatter: string | null = null;
  private openPageNames = new Map<string, string>();
  private renameObservers = new Map<string, MutationObserver>();

  constructor(app: App, plugin: DoomscrollPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  openDebugFeedPage(feedId: string): boolean {
    if (!this.containerEl.isConnected || !this.containerEl.isShown()) return false;
    const feed = this.plugin.getFeedFilters(feedId);
    if (!requireApiVersion('1.13.0')) {
      this.legacyFeed = feed;
      this.display();
      return true;
    }
    const feeds = [this.plugin.data.settings, ...this.plugin.data.settings.additionalFeeds];
    const index = feeds.indexOf(feed);
    const group = this.getSettingDefinitions().find((item) =>
      'type' in item && item.type === 'group' && item.items?.some((entry) => 'type' in entry && entry.type === 'page')
    );
    if (!group || !('items' in group) || !group.items || index < 0) return false;
    const pages = group.items.filter((entry) => 'type' in entry && entry.type === 'page');
    const page = pages[index];
    if (!page || !('name' in page)) return false;
    const setting = (this.app as unknown as { setting: { openPagePath?: (tab: string, path: string[]) => void } }).setting;
    if (!setting.openPagePath) return false;
    setting.openPagePath('doomscroll', [page.name]);
    return true;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const definitions: SettingDefinitionItem[] = [
      {
        name: 'Infinite scrolling',
        desc: 'Automatically load more notes as you reach the end of the feed',
        control: { type: 'toggle', key: 'infiniteScroll' },
      },
      {
        name: 'Page size',
        desc: 'Number of cards to show per reshuffle. Does not apply when infinite scrolling is enabled',
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
        name: 'Reduce animation',
        desc: 'Disable animations when navigating with keyboard',
        control: { type: 'toggle', key: 'reduceAnimations' },
      },
    ];

    const feedItems: SettingGroupItem[] = [
      { name: 'Feeds', desc: FEEDS_DESCRIPTION },
    ];
    const usedNames = new Set<string>();
    const addFeedPage = (fallback: string, feed: FeedFilters) => {
      const base = this.openPageNames.get(feed.id) ?? (feed.name.trim() || fallback);
      let name = base;
      let suffix = 2;
      while (usedNames.has(name)) name = `${base} (${suffix++})`;
      usedNames.add(name);
      const group = this.createFeedDefinition(fallback, feed, name);
      feedItems.push({ type: 'page', name, items: [group, ...(feed === this.plugin.data.settings ? [] : [{
        name: 'Delete feed',
        render: (setting: Setting) => { setting.setName('Delete feed').addButton((button) =>
          button.setButtonText('Delete feed').setWarning().onClick(() => {
            const page = setting.settingEl.closest('.setting-page');
            this.confirmDeleteFeed(feed, page);
          })
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
    definitions.push({ type: 'group', items: feedItems });
    definitions.push({
      type: 'group',
      items: [
        { name: 'Help & support', render: (setting) => configureGitHubLinks(setting, this.app) },
      ],
    });

    return definitions;
  }

  private createFeedDefinition(
    heading: string,
    filters: FeedFilters,
    pageName: string
  ): SettingDefinitionItem {
    return {
      type: 'group',
      cls: 'doomscroll-feed-filters',
      items: [
        {
          name: 'Name',
          render: (setting) => {
            this.openPageNames.set(filters.id, pageName);
            setting
              .setName('Name')
              .addText((text) =>
                text
                  .setValue(filters.name)
                  .onChange(async (value) => {
                    filters.name = value;
                    this.refreshFeedNameAfterLeavingPage(setting.settingEl, filters.id);
                    await this.plugin.saveSettings();
                    this.plugin.refreshFeedCommands();
                  })
              );
          },
        },
        {
          name: 'Search query',
          render: (setting) => {
            setting
              .setClass('doomscroll-search-query')
              .setName('Search query')
              .setDesc('Use Obsidian search syntax, such as tag:#work or [status:Draft]. Refine your query in Search sidebar, then copy it here')
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
        ...this.createFeedOptions(filters),
        {
          type: 'page',
          name: 'Frontmatter',
          desc: 'Choose which note properties to render in previews',
          items: [{
            type: 'group',
            items: this.createFrontmatterOptions(filters).map((option) => ({
              name: option.name,
              render: (setting: Setting) => {
                setting.setClass('doomscroll-large-text-editor');
                option.render(setting);
              },
            })),
          }],
        },
        {
          type: 'page',
          name: 'Exclusions',
          desc: 'Exclude notes by tag, filename pattern, or folder',
          items: [{ type: 'group', cls: 'doomscroll-feed-filters', items: [
        {
          name: 'Exclude tags',
          render: (setting) => {
            setting
              .setClass('doomscroll-large-text-editor')
              .setName('Exclude tags')
              .setDesc('Tags to skip without # (one per line)')
              .addTextArea((text) =>
                text
                  .setPlaceholder('archive\nprivate\nignore')
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
              .setClass('doomscroll-large-text-editor')
              .setName('Exclude filename patterns')
              .setDesc('Filename patterns to skip (one per line, e.g., _*)')
              .addTextArea((text) =>
                text
                  .setPlaceholder('_*\nDraft*\nMOC*')
                  .setValue(filters.excludeGlobs.join('\n'))
                  .onChange(async (value) => {
                    filters.excludeGlobs = parseLines(value);
                    await this.saveFeedSettings(filters);
                  })
              );
          },
        },
          ] }, this.createExcludedFoldersGroup(filters)],
        },
      ],
    };
  }

  private async saveFeedSettings(filters: FeedFilters): Promise<void> {
    await this.plugin.saveSettingsAndRefreshViews();
  }

  async saveExcludedFolders(filters: FeedFilters): Promise<void> {
    await this.saveFeedSettings(filters);
    this.update();
  }

  private createExcludedFoldersGroup(filters: FeedFilters): SettingGroupItem {
    return {
      type: 'list',
      heading: 'Excluded folders',
      emptyState: 'No excluded folders',
      searchable: false,
      items: filters.excludeFolders.map((folder) => ({ name: folder, searchable: false })),
      addItem: {
        name: 'Add folder',
        action: () => { new AddExcludedFolderModal(this.app, this, filters).open(); },
      },
      onDelete: async (index) => {
        filters.excludeFolders.splice(index, 1);
        await this.saveFeedSettings(filters);
        this.update();
      },
    } satisfies SettingDefinitionList;
  }

  private refreshFeedNameAfterLeavingPage(settingEl: HTMLElement, feedId: string): void {
    if (this.renameObservers.has(feedId)) return;
    const page = settingEl.closest('.setting-page');
    if (!page) return;
    const observer = new MutationObserver(() => {
      if (page.isConnected) return;
      observer.disconnect();
      this.renameObservers.delete(feedId);
      this.openPageNames.delete(feedId);
      this.update();
    });
    this.renameObservers.set(feedId, observer);
    observer.observe(page.ownerDocument.body, { childList: true, subtree: true });
  }

  private async addFeed(): Promise<void> {
    const defaults = this.plugin.data.settings;
    this.plugin.data.settings.additionalFeeds.push({
      id: uuidv7(),
      name: `Feed ${this.plugin.data.settings.additionalFeeds.length + 1}`,
      includeMediaOnlyNotes: defaults.includeMediaOnlyNotes,
      showNonMarkdownFiles: defaults.showNonMarkdownFiles,
      simplifiedView: defaults.simplifiedView,
      previewSize: defaults.previewSize,
      openNoteBehavior: defaults.openNoteBehavior,
      frontmatterImageProps: [...defaults.frontmatterImageProps],
      frontmatterBeforeProps: [...defaults.frontmatterBeforeProps],
      frontmatterAfterProps: [...defaults.frontmatterAfterProps],
      searchQuery: defaults.searchQuery,
      excludeTags: [...defaults.excludeTags],
      excludeGlobs: [...defaults.excludeGlobs],
      excludeFolders: [...defaults.excludeFolders],
    });
    await this.plugin.saveSettings();
    this.plugin.refreshFeedCommands();
    this.refreshDeclarativeSettings();
  }

  private confirmDeleteFeed(feed: FeedFilters, page: Element | null): void {
    new DeleteFeedModal(this.app, feed.name.trim() || 'Untitled feed', () => {
      void this.deleteFeed(feed, page);
    }).open();
  }

  private async deleteFeed(feed: FeedFilters, page: Element | null): Promise<void> {
    const index = this.plugin.data.settings.additionalFeeds.indexOf(feed);
    if (index < 0) return;
    this.legacyFeed = null;
    if (requireApiVersion('1.13.0')) {
      page?.querySelector<HTMLElement>('.setting-page-back-button')?.click();
    }
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

    const feedsGroup = containerEl.createDiv('doomscroll-feeds-group');
    new Setting(feedsGroup).setName('Feeds').setDesc(FEEDS_DESCRIPTION);
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
    configureGitHubLinks(new Setting(containerEl), this.app);
  }

  private displayLegacyFeedsPage(): void {
    const { containerEl } = this;
    const feed = this.legacyFeed;
    if (!feed) return;
    new Setting(containerEl)
      .setName(this.legacyFrontmatter || feed.name.trim() || 'Feed')
      .setHeading()
      .addButton((button) => button.setButtonText('Back').onClick(() => {
        if (this.legacyFrontmatter) this.legacyFrontmatter = null;
        else this.legacyFeed = null;
        this.display();
      }));
    if (this.legacyFrontmatter === 'Exclusions') {
      this.renderLegacyExclusions(containerEl, feed);
      return;
    }
    if (this.legacyFrontmatter) {
      for (const option of this.createFrontmatterOptions(feed)) {
        option.render(new Setting(containerEl).setClass('doomscroll-large-text-editor'));
      }
      return;
    }
    this.renderFeedFilters(containerEl, feed.name.trim() || 'Feed', feed);
    for (const option of this.createFeedOptions(feed)) {
      option.render(new Setting(containerEl).setClass('doomscroll-feed-option'));
    }
    new Setting(containerEl)
      .setName('Frontmatter')
      .setDesc('Choose which frontmatter properties provide images and appear before or after note previews.')
      .addButton((button) =>
        button.setButtonText('Configure').onClick(() => {
          this.legacyFrontmatter = 'Frontmatter';
          this.display();
        })
      );
    new Setting(containerEl).setName('Exclusions')
      .setDesc('Exclude notes by tag, filename pattern, or folder.')
      .addButton((button) => button.setButtonText('Configure').onClick(() => {
        this.legacyFrontmatter = 'Exclusions';
        this.display();
      }));
    if (feed !== this.plugin.data.settings) {
      new Setting(containerEl).setName('Delete feed').addButton((button) =>
        button.setButtonText('Delete feed').setWarning().onClick(() => { this.confirmDeleteFeed(feed, null); })
      );
    }
  }

  private createFeedOptions(filters: FeedFilters): Array<{ name: string; render: (setting: Setting) => void }> {
    return [
      {
        name: 'Include media-only notes',
        render: (setting) => {
          setting
      .setName('Include media-only notes')
      .setDesc('Show Markdown notes containing only images or other attachments')
      .addToggle((toggle) =>
        toggle
          .setValue(filters.includeMediaOnlyNotes)
          .onChange(async (value) => {
            filters.includeMediaOnlyNotes = value;
            await this.saveFeedSettings(filters);
          })
      );
        },
      },
      {
        name: 'Show non-Markdown files',
        render: (setting) => {
          setting
      .setName('Show non-Markdown files')
      .setDesc('Show standalone files such as images or PDFs, which are not referenced in any note')
      .addToggle((toggle) =>
        toggle
          .setValue(filters.showNonMarkdownFiles)
          .onChange(async (value) => {
            filters.showNonMarkdownFiles = value;
            await this.saveFeedSettings(filters);
          })
      );
        },
      },
      {
        name: 'Simplified view',
        render: (setting) => {
          setting
      .setName('Simplified view')
      .setDesc(
        'Show concise previews without full Markdown formatting'
      )
      .addToggle((toggle) =>
        toggle
          .setValue(filters.simplifiedView !== false)
          .onChange(async (value) => {
            filters.simplifiedView = value;
            await this.saveFeedSettings(filters);
          })
      );
        },
      },
      {
        name: 'Preview size',
        render: (setting) => {
          setting
      .setName('Preview size')
      .setDesc('How many lines of note text to show')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            small: 'Small',
            medium: 'Medium',
            large: 'Large',
          })
          .setValue(filters.previewSize)
          .onChange(async (value) => {
            if (!isPreviewSize(value)) return;
            filters.previewSize = value;
            await this.saveFeedSettings(filters);
          })
      );
        },
      },
      {
        name: 'Open notes in',
        render: (setting) => {
          setting
      .setName('Open notes in')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            tab: 'New tab',
            reuse: 'Reuse current tab',
            window: 'New window',
          })
          .setValue(filters.openNoteBehavior)
          .onChange(async (value) => {
            if (value !== 'tab' && value !== 'reuse' && value !== 'window') {
              return;
            }
            filters.openNoteBehavior = value;
            await this.saveFeedSettings(filters);
          })
      );
        },
      },
    ];
  }

  private createFrontmatterOptions(filters: FeedFilters): Array<{ name: string; render: (setting: Setting) => void }> {
    return [
      {
        name: 'Frontmatter image properties',
        render: (setting) => {
          setting
      .setName('Frontmatter image properties')
      .setDesc(
        'Property names to check for images in frontmatter (one per line). These images will be rendered in previews'
      )
      .addTextArea((text) =>
        text
          .setValue(filters.frontmatterImageProps.join('\n'))
          .onChange(async (value) => {
            filters.frontmatterImageProps = parseLines(value);
            const feedId = filters === this.plugin.data.settings ? 'default' : filters.id;
            for (const preview of Object.values(this.plugin.getFeedPreviews(feedId))) {
              preview.mtime = 0;
            }
            await this.saveFeedSettings(filters);
          })
      );
        },
      },
      {
        name: 'Frontmatter properties before preview',
        render: (setting) => {
          setting
      .setName('Frontmatter properties before preview')
      .setDesc(
        'Property names to render before the note body (one per line)'
      )
      .addTextArea((text) =>
        text
          .setPlaceholder('title\nsource\nauthor')
          .setValue(
            filters.frontmatterBeforeProps.join('\n')
          )
          .onChange(async (value) => {
            filters.frontmatterBeforeProps = parseLines(value);
            await this.saveFeedSettings(filters);
          })
      );
        },
      },
      {
        name: 'Frontmatter properties after preview',
        render: (setting) => {
          setting
      .setName('Frontmatter properties after preview')
      .setDesc(
        'Property names to render after the note body (one per line)'
      )
      .addTextArea((text) =>
        text
          .setPlaceholder('source\nauthor\npublished')
          .setValue(
            filters.frontmatterAfterProps.join('\n')
          )
          .onChange(async (value) => {
            filters.frontmatterAfterProps = parseLines(value);
            await this.saveFeedSettings(filters);
          })
      );
        },
      },
    ];
  }

  private renderFeedFilters(
    containerEl: HTMLElement,
    heading: string,
    filters: FeedFilters
  ): void {
    const feedGroup = containerEl.createDiv('doomscroll-feed-filters');

    const nameSetting = new Setting(feedGroup)
      .setName('Feed name')
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
      .setClass('doomscroll-search-query')
      .setName('Search query')
      .setDesc(
        'Use Obsidian search syntax, such as tag:#work or [status:Draft]'
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

  }

  private renderLegacyExclusions(containerEl: HTMLElement, filters: FeedFilters): void {
    const feedGroup = containerEl.createDiv('doomscroll-feed-filters');
    new Setting(feedGroup)
      .setClass('doomscroll-large-text-editor')
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
      .setClass('doomscroll-large-text-editor')
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

    const folderSetting = new Setting(feedGroup)
      .setName('Excluded folders')
      .setDesc('Folders excluded from this feed');
    const panel = folderSetting.settingEl.createDiv('doomscroll-excluded-folders-panel');
    const excludedFoldersList = panel.createDiv('doomscroll-excluded-folders-list');
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
      new Setting(container)
        .setName(folder)
        .addButton((button) => button
          .setIcon('trash-2')
          .setTooltip(`Remove excluded folder ${folder}`)
          .setWarning()
          .onClick(() => { void this.removeExcludedFolder(folder, container, filters); })
        );
    }
  }

}

const FEEDS_DESCRIPTION = 'Doomscroll start with one default feed, which you can rename and configure. Add more feeds with custom content filters and preview settings. For example: custom feeds for journal and books notes.';

function configureGitHubLinks(setting: Setting, app: App): void {
  setting
    .setClass('doomscroll-github-links')
    .setName('Help & support')
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
  if (!Platform.isMobile || Platform.isTablet) {
    setting.addButton((button) => button.setButtonText('Keyboard shortcuts').onClick(() => {
      new ShortcutsModal(app).open();
    }));
  }
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
