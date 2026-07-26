import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAttribution } from './attribution.mjs';

test('buildAttribution 把失败归到 guards 规则', () => {
  const runs = [{
    id: 'a', samples: [{
      assertions: [
        { kind: 'invariant', passed: false, failureClass: 'invariant_violated', guards: ['约束闭环'] },
        { kind: 'parametric', passed: false, failureClass: 'parametric_fail', guards: ['约束闭环·派生量写成自由变量函数'] },
        { kind: 'object_exists', passed: true, guards: ['约束闭环'] },
      ],
    }],
  }, {
    id: 'b', samples: [{
      assertions: [{ kind: 'invariant', passed: false, failureClass: 'invariant_violated', guards: ['约束闭环'] }],
    }],
  }];
  const r = buildAttribution(runs);
  assert.equal(r.byRule['约束闭环'].failed, 2);
  assert.deepEqual(r.byRule['约束闭环'].cases.sort(), ['a', 'b']);
});

// I1: 视觉项失败也按 guards 归因(spec §9 视觉项必填 guards; §15 L1 归因旗舰特性)
test('I1: 视觉失败归到 guards 上的 视觉规范 规则', () => {
  const runs = [{
    id: 'v', samples: [{
      assertions: [],
      visual: { items: [
        { name: '角弧', ok: false, guards: ['视觉规范·角弧默认不标'], failureClass: 'visual_angle_arc' },
        { name: '辅助线', ok: true, guards: ['视觉规范·线型'] },
      ] },
    }],
  }];
  const r = buildAttribution(runs);
  assert.equal(r.byRule['视觉规范·角弧默认不标'].failed, 1, '角弧失败 → 该规则 1 失败');
  assert.deepEqual(r.byRule['视觉规范·角弧默认不标'].cases, ['v']);
  assert.equal(r.byRule['视觉规范·线型'].failed, 0, '辅助线通过 → 0 失败');
  assert.equal(r.byRule['视觉规范·线型'].total, 1);
});

test('I1: 视觉项 ok=b_ok(judgePaired) 也参与归因', () => {
  const runs = [{
    id: 'p', samples: [{
      assertions: [],
      visual: { items: [
        { name: '辅助线', a_ok: true, b_ok: false, guards: ['视觉规范·线型'] },
      ] },
    }],
  }];
  const r = buildAttribution(runs);
  assert.equal(r.byRule['视觉规范·线型'].failed, 1, 'b_ok=false → 失败计 1');
  assert.deepEqual(r.byRule['视觉规范·线型'].cases, ['p']);
});
