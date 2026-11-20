import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { globMatch } from '../src/glob.ts';

test('invalid character ranges are treated as literal text', () => {
  assert.equal(globMatch('notes/[z-a].md', 'notes/[z-a].md'), true);
  assert.equal(globMatch('notes/[z-a].md', 'notes/z.md'), false);
  assert.equal(globMatch('notes/[a-z].md', 'notes/z.md'), true);
});
