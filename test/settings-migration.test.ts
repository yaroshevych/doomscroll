import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { build } from 'esbuild';

// Load the real plugin startup code with a small Obsidian host stub. The
// released plugin relies on Obsidian to provide these APIs at runtime.
const bundle = await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  define: { __DEBUG__: 'false' },
  plugins: [{
    name: 'obsidian-host',
    setup(build) {
      build.onResolve({ filter: /^(obsidian|\.\/indexer|\.\/view)$/ }, (args) => ({
        path: args.path,
        namespace: 'host-stub',
      }));
      build.onLoad({ filter: /.*/, namespace: 'host-stub' }, (args) => {
        if (args.path === './indexer') return { contents: 'export class Indexer { dirty = 0; markDirty() { this.dirty++; } }' };
        if (args.path === './view') return { contents: "export class DoomscrollView {} ; export const VIEW_TYPE_DOOMSCROLL = 'doomscroll-view'" };
        return { contents: `
          export class Plugin {
            constructor(app) { this.app = app; this.commands = []; this.saved = []; }
            async loadData() { return structuredClone(this.loaded); }
            async saveData(data) { this.saved.push(structuredClone(data)); }
            registerView() {}
            registerEvent() {}
            addRibbonIcon() {}
            addCommand(command) { this.commands.push(command); return command; }
            addSettingTab(tab) { this.settingTab = tab; }
          }
          export class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
          export class AbstractInputSuggest {}
          export class Modal {}
          export class Notice {}
          export class Setting {}
          export const Platform = {};
          export function normalizePath(path) { return path.replace(/\\\\/g, '/').replace(/\\/+/g, '/').replace(/^\\/|\\/$/g, '') || '.'; }
        ` };
      });
    },
  }],
});
const { default: DoomscrollPlugin } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.contents).toString('base64')}`);

async function start(loaded: unknown) {
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  const plugin = new DoomscrollPlugin({
    workspace: { getLeavesOfType: () => [] },
    vault: { on: (event: string, callback: (...args: unknown[]) => void) => { listeners[event] = callback; } },
    metadataCache: { on: (event: string, callback: (...args: unknown[]) => void) => { listeners[event] = callback; } },
  });
  plugin.listeners = listeners;
  plugin.loaded = loaded;
  await plugin.onload();
  return plugin;
}

test('note metadata changes invalidate feed indexes even when no feed is open', async () => {
  const plugin = await start(null);
  plugin.listeners.changed();
  assert.equal(plugin.indexer.dirty, 1);
});

test('migrates 0.2.0 single-feed settings and preserves them after restart', async () => {
  // All fields correspond to the single-feed settings shipped in 0.2.0.
  const settings = {
    batchSize: 50, infiniteScroll: true, headerScrollsWithFeed: true,
    includeMediaOnlyNotes: false, showNonMarkdownFiles: false,
    simplifiedView: false, reduceAnimations: true, previewSize: 'large',
    openNoteBehavior: 'reuse', searchQuery: 'tag:#work [status:Draft]',
    excludeFolders: ['Archive', 'Private/Notes'], excludeTags: ['private', 'draft'],
    excludeGlobs: ['_*', 'MOC*'], frontmatterImageProps: ['thumbnail', 'cover'],
    frontmatterBeforeProps: ['author'], frontmatterAfterProps: ['source', 'published'],
  };
  const previews = { 'Work.md': { mtime: 123, mediaOnly: false } };
  const history = [{ path: 'Work.md', timestamp: 456 }];
  const plugin = await start({ settings, previews, history, indexFormatVersion: 3 });

  assert.deepEqual(plugin.getFeedFilters('default'), {
    ...settings, id: plugin.data.settings.id, name: 'Default feed',
    additionalFeeds: [], legacyFeedIds: {},
  });
  assert.match(plugin.data.settings.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(plugin.getFeedPreviews('default'), { 'Work.md': { ...previews['Work.md'], mtime: 0 } });
  assert.deepEqual(plugin.data.feedPreviews, {});
  assert.deepEqual(plugin.data.history, history);
  assert.equal(plugin.saved.length, 1);
  assert.deepEqual(plugin.saved[0], plugin.data);
  assert.ok(plugin.commands.some((command: { id: string; name: string }) => command.id === 'open-default' && command.name === 'Open Default feed'));

  const restarted = await start(plugin.saved[0]);
  assert.deepEqual(restarted.data, plugin.data);
  assert.equal(restarted.saved.length, 0);
});

test('migrates older frontmatter settings without losing selected properties', async () => {
  const plugin = await start({
    settings: { frontmatterDisplayProps: ['author', 123, 'source'] },
    previews: {}, history: [], indexFormatVersion: 3,
  });
  assert.deepEqual(plugin.data.settings.frontmatterBeforeProps, []);
  assert.deepEqual(plugin.data.settings.frontmatterAfterProps, ['author', 'source']);
  assert.equal('frontmatterDisplayProps' in plugin.data.settings, false);
  assert.deepEqual(plugin.data.settings.additionalFeeds, []);
  assert.equal(plugin.saved.length, 1);
});

test('creates one default feed for a fresh installation', async () => {
  const plugin = await start(null);
  assert.equal(plugin.data.settings.name, 'Default feed');
  assert.deepEqual(plugin.data.settings.additionalFeeds, []);
  assert.equal(plugin.getFeedFilters('default'), plugin.data.settings);
  assert.equal(plugin.saved.length, 1);
});
