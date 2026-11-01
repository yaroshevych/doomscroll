import {
  AbstractInputSuggest,
  App,
  Modal,
  Notice,
  normalizePath,
  PluginSettingTab,
  Platform,
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
      .addButton((button) => button.setButtonText('Delete feed').setDestructive().onClick(() => {
        this.close();
        this.onConfirm();
      }));
  }
}

class ResetFeedModal extends Modal {
  constructor(app: App, private onConfirm: () => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText('Reset feed to defaults?');
    this.contentEl.createEl('p', { text: 'This will reset the feed’s name, filters, and display settings.' });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) => button.setButtonText('Reset to defaults').setDestructive().onClick(() => {
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
    new Setting(this.contentEl).setName('').setDesc('Choose a suggested folder, or type or paste its path')
      .setClass('doomscroll-folder-picker-input doomscroll-folder-picker-field').addText((text) => {
      text.setPlaceholder('4. Archive');
      inputEl = text.inputEl;
      new FolderSuggest(this.app, inputEl);
    });
    new Setting(this.contentEl).addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) => button.setButtonText('Add').setCta().onClick(async () => {
        const folder = normalizeFolderPath(inputEl.value);
        if (!folder || folder === '.') { new Notice('Enter a folder path inside your vault'); return; }
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
  private legacyFrontmatter: string | null = null;
  private openPageNames = new Map<string, string>();
  private renameObservers = new Map<string, MutationObserver>();

  constructor(app: App, plugin: DoomscrollPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const definitions: SettingDefinitionItem[] = [
      {
        name: 'Infinite scrolling',
        desc: 'Load more notes when you reach the end of the feed',
        control: { type: 'toggle', key: 'infiniteScroll' },
      },
      {
        name: 'Notes per reshuffle',
        desc: 'Choose how many cards to show when you reshuffle. This setting does not apply when infinite scrolling is on.',
        control: {
          type: 'dropdown',
          key: 'batchSize',
          options: { '10': '10', '20': '20', '50': '50', '100': '100' },
          disabled: () => this.plugin.data.settings.infiniteScroll,
        },
      },
      {
        name: 'Header scrolls with feed',
        desc: 'Hide the header as you scroll',
        control: { type: 'toggle', key: 'headerScrollsWithFeed' },
      },
      {
        name: 'Reduce animation',
        desc: 'Turn off animations when using keyboard shortcuts',
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
      const pageActions: SettingGroupItem[] = feed === this.plugin.data.settings
        ? [{ name: 'Reset action', render: (setting: Setting) => {
            setting.setName('').addButton((button) => button
              .setButtonText('Reset to defaults').setDestructive()
              .onClick(() => new ResetFeedModal(this.app, () => { void this.resetDefaultFeed(); }).open()));
          } }]
        : [{ name: 'Delete action', render: (setting: Setting) => {
            setting.setName('').addButton((button) => button
              .setButtonText('Delete feed').setDestructive()
              .onClick(() => this.confirmDeleteFeed(feed, setting.settingEl.closest('.setting-page'))));
          } }];
      feedItems.push({ type: 'page', name, items: [group, ...pageActions] });
    };
    addFeedPage('Default feed', this.plugin.data.settings);
    this.plugin.data.settings.additionalFeeds.forEach((feed, index) => {
      addFeedPage(`Feed ${index + 1}`, feed);
    });
    feedItems.push({
      name: 'Add feed',
      render: (setting) => {
        setting.setClass('doomscroll-add-feed').addButton((button) =>
          button.setButtonText('Add feed').onClick(() => {
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
              .setDesc('Choose notes using an Obsidian search, such as tag:#work or [status:Draft]. You can build your search in Obsidian’s Search sidebar and copy it here.')
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
          name: 'Note properties',
          desc: 'Choose which note properties to show in previews',
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
              .setDesc('Enter tags to leave out, one per line, without #.')
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
              .setDesc('Enter one pattern per line. For example, _* excludes filenames starting with _.')
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

  private async resetDefaultFeed(): Promise<void> {
    const feed = this.plugin.data.settings;
    const id = feed.id;
    Object.assign(feed, {
      name: 'Doomscroll',
      includeMediaOnlyNotes: DEFAULT_SETTINGS.includeMediaOnlyNotes,
      showNonMarkdownFiles: DEFAULT_SETTINGS.showNonMarkdownFiles,
      simplifiedView: DEFAULT_SETTINGS.simplifiedView,
      previewSize: DEFAULT_SETTINGS.previewSize,
      openNoteBehavior: DEFAULT_SETTINGS.openNoteBehavior,
      frontmatterImageProps: [...DEFAULT_SETTINGS.frontmatterImageProps],
      frontmatterBeforeProps: [...DEFAULT_SETTINGS.frontmatterBeforeProps],
      frontmatterAfterProps: [...DEFAULT_SETTINGS.frontmatterAfterProps],
      searchQuery: DEFAULT_SETTINGS.searchQuery,
      excludeTags: [...DEFAULT_SETTINGS.excludeTags],
      excludeGlobs: [...DEFAULT_SETTINGS.excludeGlobs],
      excludeFolders: [...DEFAULT_SETTINGS.excludeFolders],
      id,
    });
    for (const preview of Object.values(this.plugin.getFeedPreviews('default'))) {
      preview.mtime = 0;
    }
    await this.saveFeedSettings(feed);
    this.plugin.refreshFeedCommands();
    this.update();
  }

  async saveExcludedFolders(filters: FeedFilters): Promise<void> {
    await this.saveFeedSettings(filters);
    this.update();
  }

  private createExcludedFoldersGroup(filters: FeedFilters): SettingDefinitionList {
    return {
      type: 'list',
      heading: 'Excluded folders',
      emptyState: 'No excluded folders',
      items: filters.excludeFolders.map((folder) => ({ name: folder })),
      addItem: {
        name: 'Add folder',
        action: () => { new AddExcludedFolderModal(this.app, this, filters).open(); },
      },
      onDelete: (index) => {
        filters.excludeFolders.splice(index, 1);
        void this.saveExcludedFolders(filters);
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
    page?.querySelector<HTMLElement>('.setting-page-back-button')?.click();
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

  private refreshDeclarativeSettings(): void { this.update(); }

  private createFeedOptions(filters: FeedFilters): Array<{ name: string; render: (setting: Setting) => void }> {
    return [
      {
        name: 'Include notes with only attachments',
        render: (setting) => {
          setting
      .setName('Include notes with only attachments')
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
        name: 'Show unlinked attachments',
        render: (setting) => {
          setting
      .setName('Show unlinked attachments')
      .setDesc('Show files such as images and PDFs that are not linked from a note')
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
        'Show simpler previews with less formatting'
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
        name: 'Image properties',
        render: (setting) => {
          setting
      .setName('Image properties')
      .setDesc(
        'Enter the names of image properties, one per line. Images from these properties appear in previews.'
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
        name: 'Properties above preview',
        render: (setting) => {
          setting
      .setName('Properties above preview')
      .setDesc(
        'Enter property names to show before the note text, one per line.'
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
        name: 'Properties below preview',
        render: (setting) => {
          setting
      .setName('Properties below preview')
      .setDesc(
        'Enter property names to show after the note text, one per line.'
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


}

const FEEDS_DESCRIPTION = 'Doomscroll starts with one feed. Rename it or change its settings, and add more feeds for different notes, such as your journal or books.';

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
