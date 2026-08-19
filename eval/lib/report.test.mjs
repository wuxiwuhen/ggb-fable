import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './report.mjs';

const results = {
  variant: { name: 'deepseek-v2', prompt_version: 'v2', model: 'deepseek-chat', temperature: 0.2, max_tool_rounds: 30, runs_per_case: 3 },
  date: '2026-08-18T10:00:00.000Z',
  overall: { total: 2, passed: 1, rate: 0.5 },
  buckets: {
    basics: { total: 1, passed: 1, rate: 1 },
    functions: { total: 1, passed: 0, rate: 0 },
    dynamic: { total: 0, passed: 0, rate: 0 },
    multi: { total: 0, passed: 0, rate: 0 },
    traps: { total: 0, passed: 0, rate: 0 },
  },
  assertionStats: { object_exists: { pass: 3, total: 3 }, measure_eq: { pass: 2, total: 3 } },
  failureDist: { measure_mismatch: 1 },
  cases: [
    { id: 'a', category: 'basics', passVotes: 2, majorityPassed: true,
      samples: [{ ok: true, assertions: [{ kind: 'measure_eq', name: 'Radius(%c%)', passed: false, failureClass: 'measure_mismatch', detail: '→ 3.5' }], stats: null }] },
    { id: 'b', category: 'functions', passVotes: 1, majorityPassed: false,
      samples: [{ ok: true, assertions: [{ kind: 'object_exists', name: 'function', passed: false, failureClass: 'object_missing', detail: 'function×0' }], stats: null }] },
  ],
};

describe('renderMarkdown', () => {
  const md = renderMarkdown(results);
  it('含变体配置(温度入报告)、分桶表、断言统计、失败分布', () => {
    expect(md).toContain('temperature: **0.2**');
    expect(md).toContain('| basics');
    expect(md).toContain('measure_eq');
    expect(md).toContain('measure_mismatch');
  });
  it('含边界信号段(1 次通过的 b)与覆盖边界声明', () => {
    expect(md).toContain('边界信号');
    expect(md).toMatch(/这 10 条证明了什么|覆盖边界/);
  });
  it('matrix 段仅在有矩阵时出现', () => {
    expect(md).not.toContain('variant × category');
    const withMatrix = renderMarkdown(results, { matrix: { rows: [{ category: 'basics', base: 0.5, cur: 1, delta: 50 }] } });
    expect(withMatrix).toContain('variant × category');
    expect(withMatrix).toContain('+50pp');
  });
  it('延迟分布段渲染分桶 P50', () => {
    const withLatency = renderMarkdown({
      ...results,
      buckets: { ...results.buckets, basics: { total: 1, passed: 1, rate: 1, p50Ms: 12345 } },
    });
    expect(withLatency).toContain('延迟分布');
    expect(withLatency).toContain('12.3s');
  });
  it('边界信号/覆盖声明按 runs 与条数参数化(runs=2)', () => {
    const md2 = renderMarkdown({ ...results, variant: { ...results.variant, runs_per_case: 2 } });
    expect(md2).toContain('2 次中有 1 次通过');
    expect(md2).toContain(`这 ${results.cases.length} 条用例`);
  });
});
