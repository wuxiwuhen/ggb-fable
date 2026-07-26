import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchSelectors } from './selector.mjs';

const els = [
  { label: 'A', type: 'point', definition: '' },
  { label: 'O', type: 'point', definition: '' },
  { label: 'c', type: 'circle', definition: '' },
  { label: 't1', type: 'line', definition: '' },
  { label: 't2', type: 'line', definition: '' },
];

test('matchSelectors 按 type 顺序绑定别名', () => {
  const r = matchSelectors(els, { O: { type: 'point' }, l: { type: 'line' } });
  assert.equal(r.O, 'A');      // 第1个 point
  assert.equal(r.l, 't1');     // 第1个 line
});

test('matchSelectors 缺候选返回 null', () => {
  const r = matchSelectors(els, { x: { type: 'polygon' } });
  assert.equal(r, null);
});

test('matchSelectors select 为空返回 {}', () => {
  const r = matchSelectors(els, {});
  assert.deepEqual(r, {});
});
