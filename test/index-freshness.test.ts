import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['src/main.ts'], bundle: true, write: false, platform: 'node', format: 'esm',
  define: { __DEBUG__: 'false' },
  plugins: [{ name: 'host', setup(build) {
    build.onResolve({ filter: /^(obsidian|\.\/view)$/ }, (args) => ({ path: args.path, namespace: 'host' }));
    build.onLoad({ filter: /.*/, namespace: 'host' }, ({ path }) => ({ contents: path === './view'
      ? "export class DoomscrollView {}; export const VIEW_TYPE_DOOMSCROLL = 'doomscroll-view'"
      : `export class Plugin {
           constructor(app) { this.app = app; }
           async loadData() { return null; } async saveData() {}
           registerView() {} registerEvent() {} addRibbonIcon() {} addSettingTab(tab) { this.settingTab = tab; }
           addCommand(command) { return command; } removeCommand() {}
         }
         export class PluginSettingTab { update() {} } export class AbstractInputSuggest {} export class Modal {}
         export class Notice {} export class Setting {} export class TFile {}
         export const Platform = {}; export function normalizePath(path) { return path; }`,
    }));
  } }],
});
const { default: Plugin } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.contents).toString('base64')}`);

test('reset clears folders added during a fresh installation', async () => {
  (globalThis as any).window = { setTimeout, clearTimeout };
  const app = {
    workspace: { getLeavesOfType: () => [] },
    vault: { on: () => {} }, metadataCache: { on: () => {} },
  };
  const plugin = new Plugin(app);
  await plugin.onload();
  plugin.data.settings.excludeFolders.push('Archive');
  plugin.data.settings.additionalFeeds.push({ id: 'feed', name: 'Feed' });
  await plugin.settingTab.resetDefaultFeed();
  assert.deepEqual(plugin.data.settings.excludeFolders, []);
  const fresh = new Plugin(app);
  await fresh.onload();
  assert.deepEqual(fresh.data.settings.excludeFolders, []);
  assert.deepEqual(fresh.data.settings.additionalFeeds, []);
  clearTimeout(plugin.settingsRefreshTimer);
});

test('resetting the default feed rebuilds cached images using default properties', async () => {
  (globalThis as any).window = { setTimeout, clearTimeout };
  const file = { path: 'Note.md', extension: 'md', stat: { mtime: 1 } };
  const app = {
    workspace: { getLeavesOfType: () => [] },
    vault: { on: () => {}, getFiles: () => [file], cachedRead: async () => 'note' },
    metadataCache: {
      on: () => {},
      getFileCache: () => ({ frontmatter: { custom: 'old.png', cover: 'new.png' } }),
    },
  };
  const plugin = new Plugin(app);
  await plugin.onload();
  plugin.data.settings.showNonMarkdownFiles = false;
  plugin.data.settings.frontmatterImageProps = ['custom'];
  await plugin.indexer.refreshIfStale();
  assert.equal(plugin.data.previews['Note.md'].imagePath, 'old.png');

  await plugin.settingTab.resetDefaultFeed();
  // Avoid attachment link lookup in the host stub; it does not affect image extraction.
  plugin.data.settings.showNonMarkdownFiles = false;
  await plugin.indexer.refreshIfStale();
  assert.equal(plugin.data.previews['Note.md'].imagePath, 'new.png');
  clearTimeout(plugin.settingsRefreshTimer);
});
test('a metadata change causes the next refresh to update feed membership', async () => {
  (globalThis as any).window = { setTimeout };
  const file = { path: 'Note.md', extension: 'md', stat: { mtime: 1 } };
  const cache: { tags: { tag: string }[] } = { tags: [] };
  const listeners: Record<string, () => void> = {};
  const app = {
    workspace: { getLeavesOfType: () => [] },
    vault: {
      on: (event: string, callback: () => void) => { listeners[event] = callback; },
      getFiles: () => [file], cachedRead: async () => 'note',
    },
    metadataCache: {
      on: (event: string, callback: () => void) => { listeners[event] = callback; },
      getFileCache: () => cache,
    },
  };
  const plugin = new Plugin(app);
  await plugin.onload();
  plugin.data.settings.showNonMarkdownFiles = false;
  plugin.data.settings.excludeTags = ['private'];
  await plugin.indexer.refreshIfStale();
  assert.ok(plugin.data.previews['Note.md']);

  cache.tags = [{ tag: '#private' }];
  file.stat.mtime++;
  listeners.changed!();
  await plugin.indexer.refreshIfStale();
  assert.equal(plugin.data.previews['Note.md'], undefined);
});

test('renaming a file invalidates its old path and keeps its reading history', async () => {
  (globalThis as any).window = { setTimeout };
  const file = { path: 'Notes/Old.md', extension: 'md', stat: { mtime: 1 } };
  const listeners: Record<string, (...args: any[]) => void> = {};
  const app = {
    workspace: { getLeavesOfType: () => [] },
    vault: {
      on: (event: string, callback: (...args: any[]) => void) => { listeners[event] = callback; },
      getFiles: () => [file], cachedRead: async () => 'note',
    },
    metadataCache: { on: () => {}, getFileCache: () => ({}) },
  };
  const plugin = new Plugin(app);
  await plugin.onload();
  plugin.data.settings.showNonMarkdownFiles = false;
  plugin.data.history = [{ path: file.path, viewedAt: 123 }];
  await plugin.indexer.refreshIfStale();
  file.path = 'Notes/New.md';
  listeners.rename!(file, 'Notes/Old.md');
  await plugin.indexer.refreshIfStale();
  assert.equal(plugin.data.previews['Notes/Old.md'], undefined);
  assert.ok(plugin.data.previews['Notes/New.md']);
  assert.deepEqual(plugin.data.history, [{ path: 'Notes/New.md', viewedAt: 123 }]);

  file.path = 'Moved';
  listeners.rename!(file, 'Notes');
  assert.equal(plugin.data.history[0].path, 'Moved/New.md');
});
