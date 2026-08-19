import { describe, it, expect } from 'vitest';
import { buildCaseResult, aggregate, variantMatrix, median } from './aggregate.mjs';

const s = (ok, kindResults) => ({ ok, assertions: kindResults.map(([kind, passed, failureClass]) => ({ kind, name: kind, passed, failureClass: passed ? null : failureClass, detail: '' })) });

describe('buildCaseResult', () => {
  it('passVotes = 全断言通过的采样数; 2/3 多数决', () => {
    const pass = s(true, [['object_exists', true]]);
    const fail = s(true, [['object_exists', false, 'object_missing']]);
    const r = buildCaseResult({ id: 'a', category: 'basics' }, [pass, fail, pass]);
    expect(r.passVotes).toBe(2);
    expect(r.majorityPassed).toBe(true);
  });

  it('run_error 采样(ok=false)不计 passVotes', () => {
    const r = buildCaseResult({ id: 'b', category: 'basics' }, [{ ok: false, error: 'x', assertions: [], stats: null }]);
    expect(r.passVotes).toBe(0);
    expect(r.majorityPassed).toBe(false);
  });
});

describe('aggregate', () => {
  it('分桶 + 断言级 + 失败分布 + 总览', () => {
    const cases = [
      { id: 'a', category: 'basics', passVotes: 2, majorityPassed: true, samples: [s(true, [['object_exists', true], ['measure_eq', false, 'measure_mismatch']]), s(true, [['object_exists', true], ['measure_eq', true]]), s(true, [['object_exists', true], ['measure_eq', true]])] },
      { id: 'b', category: 'traps', passVotes: 0, majorityPassed: false, samples: [s(true, [['process_no_error', false, 'process_error']]), { ok: false, error: 'crash', assertions: [], stats: null }, s(true, [['process_budget', true]])] },
    ];
    const r = aggregate(cases);
    expect(r.buckets.basics).toEqual({ total: 1, passed: 1, rate: 1, p50Ms: null });
    expect(r.buckets.traps).toEqual({ total: 1, passed: 0, rate: 0, p50Ms: null });
    expect(r.assertionStats.object_exists).toEqual({ pass: 3, total: 3 });
    expect(r.failureDist).toMatchObject({ measure_mismatch: 1, process_error: 1, run_error: 1 });
    expect(r.overall).toEqual({ total: 2, passed: 1, rate: 0.5 });
  });
});

describe('variantMatrix', () => {
  it('桶级 rate 差(pp)', () => {
    const mk = (rate) => ({ buckets: { basics: { rate }, traps: { rate: 1 } } });
    const m = variantMatrix(mk(0.8), mk(0.5));
    const basics = m.rows.find((r) => r.category === 'basics');
    expect(basics).toEqual({ category: 'basics', base: 0.5, cur: 0.8, delta: 30 });
  });
});

describe('median 与分桶 p50', () => {
  // 带延迟的采样: 复用文件头部 s() 辅助, 补 durationMs 字段
  const sd = (ok, dur, kindResults) => ({ ...s(ok, kindResults), durationMs: dur });
  it('median: 奇数取中 / 偶数取均值 / 空为 null', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
  it('p50 只统计 ok 采样的 durationMs; run_error 采样不计入', () => {
    const r = aggregate([{ id: 'a', category: 'basics', majorityPassed: true, samples: [
      sd(true, 9000, [['object_exists', true]]),
      sd(true, 10000, [['object_exists', true]]),
      sd(true, 30000, [['object_exists', true]]),
      { ok: false, error: 'x', assertions: [], stats: null, durationMs: 99000 },
    ] }]);
    expect(r.buckets.basics.p50Ms).toBe(10000);
  });
  it('timeout_incomplete 独立成类, 不并入 process_error', () => {
    const r = aggregate([{ id: 't', category: 'traps', majorityPassed: false, samples: [s(true, [['process_no_error', false, 'timeout_incomplete']])] }]);
    expect(r.failureDist).toEqual({ timeout_incomplete: 1 });
  });
});
