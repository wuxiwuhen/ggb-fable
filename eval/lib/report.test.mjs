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

// I2: train vs holdout 行(防 overfit 信号, spec §10)
test('I2: renderMarkdown 含 train vs holdout 行(当 bySplit 双分都存在)', () => {
  const md = renderMarkdown({
    runMeta: { runId: 'r2', promptVersion: 'v2', samples: 2 },
    caseRuns: [],
    aggregate: {
      byDimension: { correctness: 0.8, robustness: 0.7, visual: 0.6 },
      byRule: {},
      overallPassRate: 0.5,
      bySplit: {
        train: { byDimension: { correctness: 0.9, robustness: 0.8, visual: 0.7 }, byRule: {}, overallPassRate: 0.6 },
        holdout: { byDimension: { correctness: 0.5, robustness: 0.4, visual: 0.3 }, byRule: {}, overallPassRate: 0.2 },
      },
    },
    attribution: { byRule: {} },
    baseline: null,
  });
  assert.match(md, /train:/);
  assert.match(md, /holdout:/);
});

test('I2: 无 bySplit 时不报 train/holdout 行', () => {
  const md = renderMarkdown({
    runMeta: { runId: 'r3', promptVersion: 'v1', samples: 0 },
    caseRuns: [],
    aggregate: { byDimension: { correctness: 1, robustness: 1, visual: 1 }, byRule: {}, overallPassRate: 0 },
    attribution: { byRule: {} },
    baseline: null,
  });
  assert.doesNotMatch(md, /train:/);
});
