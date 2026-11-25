import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { preparePreviewMarkdown } from '../src/extract.ts';
import { isPreviewSize } from '../src/types.ts';

test('full is a valid preview size', () => {
  assert.equal(isPreviewSize('full'), true);
  assert.equal(isPreviewSize('unlimited'), false);
});

test('full preview uses up to 8,000 body characters, including partial lines', () => {
  const body = `First paragraph\n${'x'.repeat(9_000)}`;
  const preview = preparePreviewMarkdown(`---\ntitle: Example\n---\n${body}`, 8_000, true);
  assert.equal(preview, body.slice(0, 8_000));
});

test('full preview closes a code fence when the limit cuts through it', () => {
  const preview = preparePreviewMarkdown(`\`\`\`\n${'x'.repeat(9_000)}`, 8_000, true);
  assert.ok(preview.endsWith('\n```'));
});
