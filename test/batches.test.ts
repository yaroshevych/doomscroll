import assert from 'node:assert/strict';
import test from 'node:test';
import { removePathFromBatches } from '../src/batches.ts';
import type { NotePreview } from '../src/types.ts';

function preview(path: string): NotePreview {
  return { path, title: path, mtime: 1 };
}

test('removes a deleted note without changing the remaining batch order', () => {
  const result = removePathFromBatches(
    [preview('a.md'), preview('b.md'), preview('c.md')],
    [
      [preview('a.md'), preview('b.md'), preview('c.md')],
      [preview('older.md')],
    ],
    0,
    'b.md'
  );

  assert.deepEqual(
    result.currentBatch.map((item) => item.path),
    ['a.md', 'c.md']
  );
  assert.deepEqual(
    result.batchHistory.map((batch) => batch.map((item) => item.path)),
    [['a.md', 'c.md'], ['older.md']]
  );
  assert.equal(result.batchHistoryCursor, 0);
});

test('keeps an empty current batch as a back-navigation anchor', () => {
  const result = removePathFromBatches(
    [preview('only.md')],
    [[preview('only.md')], [preview('older.md')]],
    0,
    'only.md'
  );

  assert.deepEqual(result.currentBatch, []);
  assert.deepEqual(
    result.batchHistory.map((batch) => batch.map((item) => item.path)),
    [[], ['older.md']]
  );
  assert.equal(result.batchHistoryCursor, 0);
});
