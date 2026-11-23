import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentReferences } from '../src/excerpts.js';
import { parseDiagram } from '../src/diagrams.js';
import { groupRecords, recordSections } from '../src/records.js';

test('grouping preserves book identity for duplicate titles and resolves older records', () => {
  const first = { bookId: '1', references: [] };
  const second = { bookId: '2', bookTitle: '同名书', references: [] };
  const archived = { bookId: '3', references: [{ book: '旧课本' }] };
  const recent = { bookId: '1', references: [] };
  const groups = groupRecords([first, second, archived, recent], new Map([['1', '同名书']]));
  assert.deepEqual(groups.map(({ title }) => title), ['同名书', '同名书', '旧课本']);
  assert.deepEqual(groups.map(({ records }) => records), [[first, recent], [second], [archived]]);
});

test('diagram export keeps a caption and accepts only bounded coordinate data', () => {
  const structure = { type: 'structure', title: '晶胞', nodes: [
    { id: 'a', x: 0, y: 0, z: 0, label: '顶点' },
    { id: 'b', x: 1, y: 2, z: 3 }, { id: 'bad', x: 'alert(1)', y: 3 },
  ], edges: [['a', 'b'], ['a', 'bad']] };
  const parsed = parseDiagram(JSON.stringify(structure));
  assert.equal(parsed.nodes.size, 2);
  assert.deepEqual(parsed.edges, [['a', 'b']]);
  assert.equal(parseDiagram('{"type":"plot","series":[{"points":[[1,1e100]]}]}'), null);
  const [section] = recordSections([{
    date: '2026-01-01T00:00:00Z', question: '这是什么？', references: [],
    answer: '先看下图。\n\n```diagram\n' + JSON.stringify(structure) + '\n```',
  }]);
  assert.deepEqual(section.answer, ['先看下图。', '晶胞 · 顶点']);
  assert.equal(section.figures[0].index, 1);
});

test('renamed books update both historical text labels and screenshot labels without merging books', () => {
  const refs = [{ book: '旧名', page: 1, text: '旧摘录' },
    { bookId: 'other', book: '另一册旧名', page: 2, image: '截图' }];
  const renamed = currentReferences(refs, 'active', new Map([['active', '新名'], ['other', '另一册新名']]));
  assert.deepEqual(renamed.map((ref) => ref.book), ['新名', '另一册新名']);
  assert.equal(renamed[0].text, '旧摘录');
  assert.equal(renamed[1].image, '截图');
  assert.equal(refs[0].book, '旧名');
});
