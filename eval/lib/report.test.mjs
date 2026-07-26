import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from './report.mjs';

test('renderMarkdown 含总览/归因/失败case 段', () => {
  const md = renderMarkdown({
    runMeta: { runId: 'r1', promptVersion: 'v2', samples: 1 },
    caseRuns: [{ id: 'a', split: 'train', passRate: 0, samples: [{ assertions: [{ kind: 'invariant', name: '半径⊥切线', passed: false, failureClass: 'invariant_violated', guards: ['约束闭环'] }], visual: { items: [], issues: ['角弧>180°'] }, process: { toolRounds: 5, failCmds: 1 } }] }],
    aggregate: { byDimension: { correctness: 0, robustness: 1, visual: 0.5 }, byRule: { '约束闭环': 0 }, overallPassRate: 0 },
    attribution: { byRule: { '约束闭环': { failed: 1, total: 1, cases: ['a'] } } },
    baseline: null,
  });
  assert.match(md, /总览/);
  assert.match(md, /归因/);
  assert.match(md, /约束闭环/);
  assert.match(md, /角弧/);
});
