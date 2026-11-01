import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['src/view.ts'], bundle: true, write: false, platform: 'node', format: 'esm',
  define: { __DEBUG__: 'false' },
  plugins: [{ name: 'host', setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'host' }));
    build.onLoad({ filter: /.*/, namespace: 'host' }, () => ({ contents: `
      export class ItemView {} export class Modal {} export class Component {} export class TFile {}
      export class Menu {} export class Scope {} export class MarkdownRenderer {}
      export const Platform = {}; export function setIcon() {}
    ` }));
  } }],
});
const { DoomscrollView } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.contents).toString('base64')}`);

test('changing default feed options does not invalidate another feed batch', () => {
  const filters = {
    includeMediaOnlyNotes: true, showNonMarkdownFiles: true, frontmatterImageProps: ['cover'],
    searchQuery: '', excludeFolders: [], excludeTags: [], excludeGlobs: [],
  };
  const settings = {
    batchSize: 20, infiniteScroll: false, headerScrollsWithFeed: false,
    includeMediaOnlyNotes: true, showNonMarkdownFiles: true,
    frontmatterImageProps: ['cover'], openNoteBehavior: 'tab',
  };
  const view = Object.create(DoomscrollView.prototype);
  view.plugin = { data: { settings }, getFeedFilters: () => filters };
  const original = view.getBatchSettingsKey();
  settings.includeMediaOnlyNotes = false;
  settings.showNonMarkdownFiles = false;
  settings.frontmatterImageProps = ['image'];
  settings.openNoteBehavior = 'window';
  assert.equal(view.getBatchSettingsKey(), original);
  filters.excludeTags = ['private'];
  assert.notEqual(view.getBatchSettingsKey(), original);
});
