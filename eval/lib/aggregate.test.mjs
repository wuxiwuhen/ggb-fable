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
      visual: { items: [{ name: '辅助线是否虚线', ok: false, guards: ['视觉规范·线型'] }, { name: '整体是否看得懂', ok: true, guards: ['视觉规范'] }] },
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
    samples: [{ assertions: [], visual: { items: [{ name: 'x', guards: ['视觉规范'], a_ok: false, b_ok: true }, { name: 'y', guards: ['视觉规范'], a_ok: true, b_ok: false }], preference: 'B' } }],
  }];
  const r = aggregate(runs);
  assert.equal(r.byDimension.visual, 0.5);   // b_ok: 1/2
});

// I1: 视觉项失败必须喂 byRule(L1 归因 spec §15 旗舰特性), 否则漏掉所有视觉失败
test('I1: 视觉失败贡献到 byRule(按 guards)', () => {
  const runs = [{
    id: 'v', split: 'train', passRate: 1,
    samples: [{
      assertions: [],
      visual: { items: [
        { name: '角弧是否 >180° 异常', ok: false, guards: ['视觉规范·角弧默认不标'], failureClass: 'visual_angle_arc' },
        { name: '辅助线是否虚线', ok: false, guards: ['视觉规范·线型'], failureClass: 'visual_aux_solid' },
        { name: '颜色', ok: true, guards: ['视觉规范·配色'] },
      ] },
    }],
  }];
  const r = aggregate(runs);
  assert.equal(r.byRule['视觉规范·角弧默认不标'], 0, '角弧失败 → 该规则 0%');
  assert.equal(r.byRule['视觉规范·线型'], 0, '线型失败 → 该规则 0%');
  assert.equal(r.byRule['视觉规范·配色'], 1, '配色通过 → 100%');
});

// I2: bySplit 报 train/holdout 分(spec §10 防 overfit 信号)
test('I2: bySplit 分别报 train/holdout 维度分', () => {
  const runs = [
    { id: 't1', split: 'train', passRate: 1, samples: [{ assertions: [{ kind: 'object_exists', passed: true, guards: ['约束闭环'] }], visual: { items: [] } }] },
    { id: 't2', split: 'train', passRate: 0, samples: [{ assertions: [{ kind: 'object_exists', passed: false, guards: ['约束闭环'] }], visual: { items: [] } }] },
    { id: 'h1', split: 'holdout', passRate: 1, samples: [{ assertions: [{ kind: 'object_exists', passed: true, guards: ['约束闭环'] }], visual: { items: [] } }] },
  ];
  const r = aggregate(runs);
  assert.ok(r.bySplit.train, 'train 子集存在');
  assert.ok(r.bySplit.holdout, 'holdout 子集存在');
  // train: 2 case 整体通过率 1/2; holdout: 1 case 整体通过率 1/1
  assert.equal(r.bySplit.train.overallPassRate, 0.5);
  assert.equal(r.bySplit.holdout.overallPassRate, 1);
  // train correctness: 1/2 通过
  assert.equal(r.bySplit.train.byDimension.correctness, 0.5);
  assert.equal(r.bySplit.holdout.byDimension.correctness, 1);
});

test('bySplit 缺失 split 时 graceful(只有 train)', () => {
  const runs = [{ id: 't1', split: 'train', passRate: 1, samples: [{ assertions: [], visual: { items: [] } }] }];
  const r = aggregate(runs);
  assert.ok(r.bySplit.train);
  assert.equal(r.bySplit.holdout, undefined);
});
