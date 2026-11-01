import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { uuidv7 } from '../src/uuid.ts';

test('generates unique UUIDv7 identifiers with a timestamp', () => {
  const before = Date.now();
  const ids = Array.from({ length: 1000 }, () => uuidv7());
  const after = Date.now();
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const timestamp = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
    assert.ok(timestamp >= before && timestamp <= after);
  }
});
