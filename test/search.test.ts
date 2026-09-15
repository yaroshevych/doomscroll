import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesSearchQuery } from '../src/search.ts';
import type { SearchDocument } from '../src/search.ts';

const document: SearchDocument = {
  path: 'Projects/Meetings/weekly.md',
  content: 'Weekly meeting notes about planning and follow-up work.',
  frontmatter: {},
};

test('matches every ordinary search term in a document', () => {
  assert.equal(matchesSearchQuery('meeting planning', document), true);
  assert.equal(matchesSearchQuery('meeting missing', document), false);
});

test('supports exact phrases and OR expressions', () => {
  assert.equal(matchesSearchQuery('"weekly meeting"', document), true);
  assert.equal(matchesSearchQuery('"meeting planning"', document), false);
  assert.equal(matchesSearchQuery('missing OR planning', document), true);
  assert.equal(matchesSearchQuery('missing OR absent', document), false);
});

test('supports parentheses and negated expressions', () => {
  assert.equal(matchesSearchQuery('meeting (planning OR absent)', document), true);
  assert.equal(matchesSearchQuery('meeting -(planning absent)', document), true);
  assert.equal(matchesSearchQuery('meeting -planning', document), false);
});

test('matches paths, filenames, tags, and frontmatter properties', () => {
  const metadataDocument: SearchDocument = {
    path: '3. Resources/SWE/weekly.md',
    content: `---
status: Draft
score: 3
aliases:
  - Weekly review
tags:
  - clippings
empty:
---
This note has #work in the prose.
~~~text
#ignored
~~~`,
    frontmatter: {
      status: 'Draft',
      score: 3,
      aliases: ['Weekly review'],
      tags: ['clippings'],
      empty: '',
    },
  };

  assert.equal(matchesSearchQuery('path:"Resources/SWE"', metadataDocument), true);
  assert.equal(matchesSearchQuery('file:weekly.md', metadataDocument), true);
  assert.equal(matchesSearchQuery('tag:#work', metadataDocument), true);
  assert.equal(matchesSearchQuery('tag:#ignored', metadataDocument), false);
  assert.equal(matchesSearchQuery('[status]', metadataDocument), true);
  assert.equal(matchesSearchQuery('[status:Draft]', metadataDocument), true);
  assert.equal(
    matchesSearchQuery('[status:Draft OR Published]', metadataDocument),
    true
  );
  assert.equal(matchesSearchQuery('[status:Published]', metadataDocument), false);
  assert.equal(matchesSearchQuery('[score:<5]', metadataDocument), true);
  assert.equal(matchesSearchQuery('[score:>5]', metadataDocument), false);
  assert.equal(matchesSearchQuery('[score:/[23]/]', metadataDocument), true);
  assert.equal(matchesSearchQuery('[aliases:"Weekly review"]', metadataDocument), true);
  assert.equal(matchesSearchQuery('[empty:null]', metadataDocument), true);
});

test('supports structural operators, task state, case, and regex matching', () => {
  const structuredDocument: SearchDocument = {
    path: 'Projects/weekly.md',
    content: `Weekly overview

# First
mix flour

# Second
mix sugar

- [ ] call email
- [x] ship release`,
  };

  assert.equal(matchesSearchQuery('line:(mix flour)', structuredDocument), true);
  assert.equal(matchesSearchQuery('line:(flour sugar)', structuredDocument), false);
  assert.equal(matchesSearchQuery('block:(mix flour)', structuredDocument), true);
  assert.equal(matchesSearchQuery('section:(flour sugar)', structuredDocument), false);
  assert.equal(matchesSearchQuery('task-todo:email', structuredDocument), true);
  assert.equal(matchesSearchQuery('task-done:ship', structuredDocument), true);
  assert.equal(matchesSearchQuery('task-done:email', structuredDocument), false);
  assert.equal(matchesSearchQuery('match-case:Weekly', structuredDocument), true);
  assert.equal(matchesSearchQuery('match-case:weekly', structuredDocument), false);
  assert.equal(matchesSearchQuery('ignore-case:WEEKLY', structuredDocument), true);
  assert.equal(matchesSearchQuery('path:/weekly\\.md$/', structuredDocument), true);
});

test('treats an empty query as unfiltered and malformed queries as no match', () => {
  assert.equal(matchesSearchQuery('', document), true);
  assert.equal(matchesSearchQuery('   ', document), true);
  assert.equal(matchesSearchQuery('(meeting planning', document), false);
  assert.equal(matchesSearchQuery('[status:Draft', document), false);
});
