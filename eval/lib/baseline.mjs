// Baseline 回归保护: 写 slim 版 baseline.json(只保 aggregate + case passRate),
// 下次跑 eval 时 diffVsBaseline 比每 case passRate, 退化超阈值即标红。
//
// readBaseline  宽松读: 文件不存在/解析失败返回 null(无 baseline 视为首次跑, 不退化)。
// writeBaseline 写 slim: 仅 aggregate + {id, split, passRate}(减少 diff 噪声)。
// diffVsBaseline 逐 case 比较: base.passRate - cur.passRate > threshold 即退化。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export function readBaseline(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// 注: brief 原写 { aggregate, cases } 嵌套, 但 brief 的测试断言 `back.byDimension.correctness`
// (扁平访问) — 两者冲突, 测试为真(TDD)。这里把 aggregate 扁平展开到顶层, 同时保留 cases,
// 让 readBaseline 往返与 diffVsBaseline 的 baseline.cases 都能直接访问。
export function writeBaseline(results, path) {
  const slim = { ...(results.aggregate || {}), cases: results.cases.map((c) => ({ id: c.id, split: c.split, passRate: c.passRate })) };
  writeFileSync(path, JSON.stringify(slim, null, 2));
}

export function diffVsBaseline(results, baseline, { threshold = 0.34 } = {}) {
  const regressions = [];
  const baseById = Object.fromEntries((baseline.cases || []).map((c) => [c.id, c.passRate]));
  for (const c of results.cases || []) {
    const base = baseById[c.id];
    if (base != null && base - c.passRate > threshold) regressions.push(c.id);
  }
  return { regressions, byDimension: results.aggregate?.byDimension || {} };
}
