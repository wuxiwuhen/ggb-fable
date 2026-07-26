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
