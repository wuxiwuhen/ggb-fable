// L1 归因: 把失败断言按 guards 聚合到 prompt 规则, 输出"哪条规则在多少题失效"。
export function buildAttribution(caseRuns) {
  const byRule = {};
  for (const run of caseRuns) {
    for (const s of run.samples) {
      if (s.error) continue;
      for (const a of s.assertions || []) {
        for (const g of a.guards || []) {
          byRule[g] = byRule[g] || { failed: 0, total: 0, cases: new Set() };
          byRule[g].total++;
          if (!a.passed) { byRule[g].failed++; byRule[g].cases.add(run.id); }
        }
      }
    }
  }
  return { byRule: Object.fromEntries(Object.entries(byRule).map(([k, v]) => [k, { failed: v.failed, total: v.total, cases: [...v.cases] }])) };
}
