import { Plugin } from 'obsidian';
import { PluginData } from './types';
import { DEFAULT_SETTINGS, ObsidianScrollSettingTab } from './settings';
import { Indexer } from './indexer';
import { ScrollView, VIEW_TYPE_SCROLL } from './view';

export default class ObsidianScrollPlugin extends Plugin {
  data!: PluginData;
  indexer!: Indexer;

  async onload(): Promise<void> {
    // Load data
    const loadedData = (await this.loadData()) as PluginData | null;

    this.data = {
      settings: loadedData?.settings || DEFAULT_SETTINGS,
      previews: loadedData?.previews || {},
      history: loadedData?.history || [],
    };

    // Migrate: earlier versions stored path/title/ctime on each preview
    // (duplicating the map key and an unused field) and kept imagePath as
    // an explicit null. Strip them so old vaults' data.json shrinks without
    // a full reindex.
    let migrated = false;
    for (const preview of Object.values(this.data.previews) as any[]) {
      if (
        'path' in preview ||
        'title' in preview ||
        'ctime' in preview ||
        preview.imagePath === null
      ) {
        delete preview.path;
        delete preview.title;
        delete preview.ctime;
        if (preview.imagePath === null) {
          delete preview.imagePath;
        }
        migrated = true;
      }
    }
    if (migrated) {
      await this.saveSettings();
    }

    // Instantiate indexer
    this.indexer = new Indexer(this.app, this.data);

    // Register view
    this.registerView(VIEW_TYPE_SCROLL, (leaf) => new ScrollView(leaf, this));

    // Ribbon icon
    this.addRibbonIcon('gallery-vertical', 'Open PKM Feed', () => {
      this.activateView();
    });

    // Command to open scroll view
    this.addCommand({
      id: 'open-scroll-view',
      name: 'Open feed',
      callback: () => {
        this.activateView();
      },
    });

    // Settings tab
    this.addSettingTab(new ObsidianScrollSettingTab(this.app, this));
  }

  async activateView(): Promise<void> {
    // Try to reuse existing leaf
    const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_SCROLL)[0];

    if (existingLeaf) {
      this.app.workspace.revealLeaf(existingLeaf);
      return;
    }

    // Create new leaf in main workspace
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({
      type: VIEW_TYPE_SCROLL,
      active: true,
    });
    this.app.workspace.revealLeaf(leaf);
  }

  async saveSettings(): Promise<void> {
    await (this as any).saveData(this.data);
  }

  onunload(): void {
    // Nothing destructive needed
  }
}
