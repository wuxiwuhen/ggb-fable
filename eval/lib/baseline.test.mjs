import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBaseline, writeBaseline, diffVsBaseline } from './baseline.mjs';

const d = mkdtempSync(join(tmpdir(), 'eval-'));
test.after(() => rmSync(d, { recursive: true, force: true }));

test('writeBaseline + readBaseline 往返', () => {
  const results = { aggregate: { byDimension: { correctness: 0.8, robustness: 0.9, visual: 0.7 }, byRule: {}, overallPassRate: 0.5 }, cases: [{ id: 'a', passRate: 1 }, { id: 'b', passRate: 0 }] };
  writeBaseline(results, join(d, 'baseline.json'));
  const back = readBaseline(join(d, 'baseline.json'));
  assert.equal(back.byDimension.correctness, 0.8);
});

test('diffVsBaseline 标退化 case', () => {
  const baseline = { cases: [{ id: 'a', passRate: 1 }, { id: 'b', passRate: 0.5 }] };
  const results = { cases: [{ id: 'a', passRate: 0.5 }, { id: 'b', passRate: 0.5 }] };
  const diff = diffVsBaseline(results, baseline, { threshold: 0.34 });
  assert.deepEqual(diff.regressions, ['a']);
});
