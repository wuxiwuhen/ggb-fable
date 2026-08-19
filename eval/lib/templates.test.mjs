import { describe, it, expect } from 'vitest';
import { evaluateAll, evaluateAssertion } from './templates.mjs';

const canvas = {
  elements: [
    { label: 'A', type: 'point', visible: true, definition: '' },
    { label: 'c', type: 'conic', visible: true, definition: 'c = Circle((0, 0), r)' },
    { label: 'l', type: 'line', visible: true, definition: '' },
    { label: 'p', type: 'polygon', visible: true, definition: '' },
    { label: 'P', type: 'point', visible: false, definition: '' },
    { label: 'f', type: 'function', visible: true, definition: 'f(x) = k x' },
  ],
  freeVars: [{ name: 'r', type: 'slider' }],
  corpus: 'c = Circle((0, 0), r)\nf(x) = k x',
};

const goodEvents = [
  { type: 'tool_call', name: 'search_command', round: 1 },
  { type: 'tool_call', name: 'verify_geometry', round: 2 },
  { type: 'tool_call', name: 'verify_geometry', round: 3 },
  { type: 'tool_call', name: 'inspect_render', round: 4, result: { ok: true, passed: true, issues: [] } },
  { type: 'turn_end', stopped: false },
];

const appletEvalOk = async (expr) => {
  if (expr === 'Radius(c)') return { ok: true, value: '3', numeric: 3 };
  if (expr === 'x(A)') return { ok: true, value: '6', numeric: 6 };
  if (expr === 'ArePerpendicular(c, l)') return { ok: true, value: 'true' };
  if (expr === 'Perimeter(p)') return { ok: true, value: '11.9', numeric: 11.9 };
  return { ok: false, value: '?', numeric: undefined };
};

const ctx = { canvas, events: goodEvents, appletEval: appletEvalOk };

describe('画布断言', () => {
  it('object_exists 数 type', async () => {
    const r = await evaluateAll([
      { kind: 'object_exists', type: 'conic' },
      { kind: 'object_exists', type: 'segment' },
    ], ctx);
    expect(r[0].passed).toBe(true);
    expect(r[1]).toMatchObject({ passed: false, failureClass: 'object_missing' });
  });

  it('measure_eq 容差比较 + 别名插值', async () => {
    const r = await evaluateAssertion(
      { kind: 'measure_eq', select: { c: { type: 'conic' } }, expr: 'Radius(%c%)', expect: 3, tol: 0.001 }, ctx);
    expect(r.passed).toBe(true);
    const bad = await evaluateAssertion(
      { kind: 'measure_eq', select: { c: { type: 'conic' } }, expr: 'Radius(%c%)', expect: 5 }, ctx);
    expect(bad).toMatchObject({ passed: false, failureClass: 'measure_mismatch' });
  });

  it('measure_eq 超容差 0.01 默认: 11.9 vs 12 判败, vs 11.905 判过', async () => {
    const near = await evaluateAssertion(
      { kind: 'measure_eq', select: { p: { type: 'polygon' } }, expr: 'Perimeter(%p%)', expect: 11.905 }, ctx);
    expect(near.passed).toBe(true);
    const far = await evaluateAssertion(
      { kind: 'measure_eq', select: { p: { type: 'polygon' } }, expr: 'Perimeter(%p%)', expect: 12 }, ctx);
    expect(far.passed).toBe(false);
  });

  it('measure_range 区间判定', async () => {
    const r = await evaluateAssertion(
      { kind: 'measure_range', select: { c: { type: 'conic' } }, expr: 'Radius(%c%)', min: 1, max: 5 }, ctx);
    expect(r.passed).toBe(true);
  });

  it('measure_range 区间外失败; 端点包含', async () => {
    const out = await evaluateAssertion(
      { kind: 'measure_range', select: { c: { type: 'conic' } }, expr: 'Radius(%c%)', min: 5, max: 9 }, ctx);
    expect(out).toMatchObject({ passed: false, failureClass: 'measure_mismatch' });
    const edge = await evaluateAssertion(
      { kind: 'measure_range', select: { c: { type: 'conic' } }, expr: 'Radius(%c%)', min: 3, max: 9 }, ctx);
    expect(edge.passed).toBe(true);   // x >= min: 端点 3 包含在内
  });

  it('numeric=NaN/Infinity 归为 eval_error 而非 measure_mismatch', async () => {
    const nanCtx = { ...ctx, appletEval: async () => ({ ok: true, value: 'NaN', numeric: NaN }) };
    const r = await evaluateAssertion(
      { kind: 'measure_eq', select: { c: { type: 'conic' } }, expr: 'Radius(%c%)', expect: 3 }, nanCtx);
    expect(r).toMatchObject({ passed: false, failureClass: 'eval_error' });
    const infCtx = { ...ctx, appletEval: async () => ({ ok: true, value: 'Infinity', numeric: Infinity }) };
    const r2 = await evaluateAssertion(
      { kind: 'measure_eq', select: { c: { type: 'conic' } }, expr: 'Radius(%c%)', expect: 3 }, infCtx);
    expect(r2).toMatchObject({ passed: false, failureClass: 'eval_error' });
  });

  it('relation_bool 解析 true/false', async () => {
    const t = await evaluateAssertion(
      { kind: 'relation_bool', select: { a: { type: 'conic' }, b: { type: 'line' } }, expr: 'ArePerpendicular(%a%, %b%)' }, ctx);
    expect(t.passed).toBe(true);
    const f = await evaluateAssertion(
      { kind: 'relation_bool', select: { a: { type: 'conic' }, b: { type: 'line' } }, expr: 'ArePerpendicular(%a%, %b%)', expect: false }, ctx);
    expect(f).toMatchObject({ passed: false, failureClass: 'relation_false' });
  });

  it('选择器无候选 → selector_unmatched; 求值失败 → eval_error', async () => {
    const r = await evaluateAssertion(
      { kind: 'measure_eq', select: { z: { type: 'segment' } }, expr: 'Length(%z%)', expect: 1 }, ctx);
    expect(r).toMatchObject({ passed: false, failureClass: 'selector_unmatched' });
    const bad = await evaluateAssertion(
      { kind: 'measure_eq', select: { P: { type: 'point' } }, expr: 'Area(%P%)', expect: 1 }, ctx);
    expect(bad).toMatchObject({ passed: false, failureClass: 'eval_error' });
  });

  it('slider_exists / parametric_ref / label_visible', async () => {
    expect((await evaluateAssertion({ kind: 'slider_exists' }, ctx)).passed).toBe(true);
    expect((await evaluateAssertion({ kind: 'parametric_ref' }, ctx)).passed).toBe(true);
    // 2 个 point 里 1 个 visible=false → 可见数 1 ≥ 默认 min_visible=1 → 通过; 抬到 2 → 失败
    expect((await evaluateAssertion({ kind: 'label_visible', type: 'point' }, ctx)).passed).toBe(true);
    expect((await evaluateAssertion({ kind: 'label_visible', type: 'point', min_visible: 2 }, ctx)).passed).toBe(false);
  });

  it('slider_exists / parametric_ref 的失败路径', async () => {
    const noSlider = { canvas: { elements: [], freeVars: [], corpus: '' }, events: [], appletEval: ctx.appletEval };
    expect(await evaluateAssertion({ kind: 'slider_exists' }, noSlider))
      .toMatchObject({ passed: false, failureClass: 'slider_missing' });
    // 有自由变量但 corpus 不引用 → 非参数化
    const unref = {
      canvas: { elements: [{ label: 'r', type: 'numeric', visible: true, definition: '' }],
                freeVars: [{ name: 'r', type: 'slider' }], corpus: 'x + 1' },
      events: [], appletEval: ctx.appletEval,
    };
    expect(await evaluateAssertion({ kind: 'parametric_ref' }, unref))
      .toMatchObject({ passed: false, failureClass: 'parametric_fail' });
  });
});

describe('过程断言', () => {
  it('visual_inspect_ok: 最后一次 inspect_render passed', async () => {
    expect((await evaluateAssertion({ kind: 'visual_inspect_ok' }, ctx)).passed).toBe(true);
    const badCtx = { ...ctx, events: [
      { type: 'tool_call', name: 'inspect_render', round: 1, result: { ok: true, passed: false, issues: ['x'] } },
      { type: 'turn_end', stopped: false },
    ] };
    const r = await evaluateAssertion({ kind: 'visual_inspect_ok' }, badCtx);
    expect(r).toMatchObject({ passed: false, failureClass: 'visual_fail' });
    const noneCtx = { ...ctx, events: [{ type: 'turn_end', stopped: false }] };
    expect((await evaluateAssertion({ kind: 'visual_inspect_ok' }, noneCtx)).passed).toBe(false);
  });

  it('process_no_error: turn_end 未中止且无 error 事件', async () => {
    expect((await evaluateAssertion({ kind: 'process_no_error' }, ctx)).passed).toBe(true);
    const stopped = { ...ctx, events: [{ type: 'turn_end', stopped: true }] };
    expect((await evaluateAssertion({ kind: 'process_no_error' }, stopped)).passed).toBe(false);
    const errored = { ...ctx, events: [...goodEvents, { type: 'error', where: 'x' }] };
    expect((await evaluateAssertion({ kind: 'process_no_error' }, errored)).passed).toBe(false);
  });

  it('process_budget: verify/render 计数(verify_geometry=2 ≤ 3, inspect_render=1 ≤ 2)', async () => {
    expect((await evaluateAssertion({ kind: 'process_budget' }, ctx)).passed).toBe(true);
    const over = { ...ctx, events: [
      ...[1, 2, 3, 4].map((round) => ({ type: 'tool_call', name: 'verify_geometry', round })),
      { type: 'turn_end', stopped: false },
    ] };
    const r = await evaluateAssertion({ kind: 'process_budget' }, over);
    expect(r).toMatchObject({ passed: false, failureClass: 'budget_exceeded' });
  });

  it('process_budget: render 溢出(3 > 2)也判败', async () => {
    const overRender = { ...ctx, events: [
      ...[1, 2, 3].map((round) => ({ type: 'tool_call', name: 'inspect_render', round, result: { ok: true, passed: true, issues: [] } })),
      { type: 'turn_end', stopped: false },
    ] };
    const r = await evaluateAssertion({ kind: 'process_budget' }, overRender);
    expect(r).toMatchObject({ passed: false, failureClass: 'budget_exceeded' });
  });

  it('evaluateAll 异常兜底为 run_error', async () => {
    const boom = { ...ctx, appletEval: async () => { throw new Error('boom'); } };
    const r = await evaluateAll([{ kind: 'measure_eq', select: { c: { type: 'conic' } }, expr: 'Radius(%c%)', expect: 3 }], boom);
    expect(r[0]).toMatchObject({ passed: false, failureClass: 'run_error' });
  });
});

describe('process_no_error 超时独立分类', () => {
  const ctx = (timedOut) => ({
    canvas: { elements: [], freeVars: [] },
    events: [{ type: 'error' }, { type: 'turn_end', stopped: true }],
    appletEval: async () => ({ ok: false, value: '?' }),
    timedOut,
  });
  it('timedOut 采样 → timeout_incomplete(不判 process_error)', async () => {
    const r = await evaluateAssertion({ kind: 'process_no_error' }, ctx(true));
    expect(r.passed).toBe(false);
    expect(r.failureClass).toBe('timeout_incomplete');
  });
  it('非超时路径不受影响(仍判 process_error)', async () => {
    const r = await evaluateAssertion({ kind: 'process_no_error' }, ctx(false));
    expect(r.failureClass).toBe('process_error');
  });
});
