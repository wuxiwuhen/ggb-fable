import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAssertions } from './deterministic.mjs';

const els = [
  { label: 'A', type: 'point', definition: '' },
  { label: 'c', type: 'circle', definition: '' },
  { label: 'l', type: 'line', definition: 'l = Tangent(A, c)' },
];
const freeVars = [{ name: 'A', type: 'point' }];
const ctx = { elements: els, freeVars };

test('object_exists 数 type', async () => {
  const appletEval = async () => ({ ok: true });
  const r = await runAssertions(ctx, [
    { kind: 'object_exists', find: { type: 'circle', min: 1 }, guards: ['约束闭环'] },
    { kind: 'object_exists', find: { type: 'polygon', min: 1 }, guards: ['约束闭环'] },
  ], appletEval);
  assert.equal(r[0].passed, true);
  assert.equal(r[0].guards[0], '约束闭环');
  assert.equal(r[1].passed, false);
  assert.equal(r[1].failureClass, 'object_missing');
});

test('invariant 用选择器别名替换 expr 后求值', async () => {
  const seen = [];
  const appletEval = async (expr) => { seen.push(expr); return { ok: true, numeric: 1 }; };
  const r = await runAssertions(ctx, [{
    kind: 'invariant', name: '半径⊥切线',
    select: { O: { type: 'point' }, l: { type: 'line' } },
    expr: 'ArePerpendicular(Line(O,l), c)', expect: true,
    guards: ['约束闭环'],
  }], appletEval);
  assert.equal(r[0].passed, true);
  assert.ok(seen[0].includes('A') && seen[0].includes('l') && seen[0].includes('c'), '别名应替换为真实标签');
});

test('invariant 选择器匹配失败 → object_missing', async () => {
  const r = await runAssertions(ctx, [{
    kind: 'invariant', name: 'x',
    select: { z: { type: 'polygon' } }, expr: 'z', expect: true, guards: [],
  }], async () => ({ ok: true }));
  assert.equal(r[0].passed, false);
  assert.equal(r[0].failureClass, 'object_missing');
});

test('parametric 存在自由变量且派生对象引用它 → 通过', async () => {
  // Fix 2: 画布有自由点 A, 派生 line l 的 definition = 'l = Tangent(A, c)' 引用 A → parametric 通过。
  // (brief 原 comment 误写成"不引用 A", 与 fixture 矛盾, 已纠正)
  const r = await runAssertions(ctx, [
    { kind: 'parametric', message: 'm', guards: ['约束闭环·派生量写成自由变量函数'] },
  ], async () => ({ ok: true }));
  assert.equal(r[0].passed, true);
  assert.equal(r[0].failureClass, null);
});

test('parametric 无自由变量 → 失败', async () => {
  // Fix 2 负向: 画布无自由变量 → parametric 视退化
  const noFreeCtx = { elements: els, freeVars: [] };
  const r = await runAssertions(noFreeCtx, [
    { kind: 'parametric', message: 'm', guards: ['约束闭环·派生量写成自由变量函数'] },
  ], async () => ({ ok: true }));
  assert.equal(r[0].passed, false);
  assert.equal(r[0].failureClass, 'parametric_fail');
});
