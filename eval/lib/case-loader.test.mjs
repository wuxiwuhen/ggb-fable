import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { loadCases } from './case-loader.mjs';

const dir = new URL('../cases/__tmp__/', import.meta.url);
mkdirSync(dir, { recursive: true });

test('loadCases 读 yaml 并按 split/id 筛选', async () => {
  writeFileSync(new URL('a.yaml', dir), `
id: a
meta: { title: t, problem: p1, dimension: 2D, difficulty: 1 }
reference: { objectInventory: [], freeVars: [] }
assertions: []
visual_rubric: inherit
split: train
provenance: { reviewed: true, version: 1 }
`);
  writeFileSync(new URL('b.yaml', dir), `
id: b
meta: { title: t, problem: p2, dimension: 3D, difficulty: 2 }
reference: { objectInventory: [], freeVars: [] }
assertions: []
visual_rubric: inherit
split: holdout
provenance: { reviewed: true, version: 1 }
`);
  const all = await loadCases({ casesDir: dir.pathname });
  assert.equal(all.length, 2);
  const train = await loadCases({ casesDir: dir.pathname, split: 'train' });
  assert.deepEqual(train.map((c) => c.id), ['a']);
  const one = await loadCases({ casesDir: dir.pathname, id: 'b' });
  assert.equal(one[0].meta.dimension, '3D');
});

test.after(() => { rmSync(dir, { recursive: true, force: true }); });
