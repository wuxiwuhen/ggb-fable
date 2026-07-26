import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate } from './aggregate.mjs';

test('aggregate 按 dimension + rule 聚合', () => {
  const runs = [{
    id: 'a', split: 'train', passRate: 0,
    samples: [{
      assertions: [
        { kind: 'object_exists', passed: true, guards: ['约束闭环'] },
        { kind: 'invariant', passed: false, guards: ['约束闭环'] },
        { kind: 'parametric', passed: false, guards: ['约束闭环·派生量写成自由变量函数'] },
      ],
      visual: { items: [{ name: '辅助线是否虚线', ok: false }, { name: '整体是否看得懂', ok: true }] },
    }],
  }];
  const r = aggregate(runs);
  assert.ok(r.byDimension.correctness < 1);   // invariant 挂了
  assert.ok(r.byDimension.robustness === 0);  // parametric 挂
  assert.ok(r.byDimension.visual === 0.5);    // 1/2
  assert.ok(r.byRule['约束闭环'] < 1);
});

test('aggregate 视觉兼容配对形态(judgePaired b_ok)', () => {
  const runs = [{
    id: 'p', split: 'train', passRate: 1,
    samples: [{ assertions: [], visual: { items: [{ name: 'x', a_ok: false, b_ok: true }, { name: 'y', a_ok: true, b_ok: false }], preference: 'B' } }],
  }];
  const r = aggregate(runs);
  assert.equal(r.byDimension.visual, 0.5);   // b_ok: 1/2
});
