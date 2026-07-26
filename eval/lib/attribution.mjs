// L1 归因: 把失败断言 + 视觉项按 guards 聚合到 prompt 规则, 输出"哪条规则在多少题失效"。
// I1: 视觉项也带 guards(spec §9), 必须纳入归因; 否则"角弧默认不标 规则在 3/15 题失效"产不出来。
export function buildAttribution(caseRuns) {
  const byRule = {};
  for (const run of caseRuns) {
    for (const s of run.samples) {
      if (s.error) continue;
      // 确定性断言: passed=false 即失败
      for (const a of s.assertions || []) {
        for (const g of a.guards || []) {
          byRule[g] = byRule[g] || { failed: 0, total: 0, cases: new Set() };
          byRule[g].total++;
          if (!a.passed) { byRule[g].failed++; byRule[g].cases.add(run.id); }
        }
      }
      // 视觉项: ok=false(b_ok for paired)即失败, 与断言同口径喂 guards
      for (const it of s.visual?.items || []) {
        const ok = it.ok ?? it.b_ok;
        for (const g of it.guards || []) {
          byRule[g] = byRule[g] || { failed: 0, total: 0, cases: new Set() };
          byRule[g].total++;
          if (!ok) { byRule[g].failed++; byRule[g].cases.add(run.id); }
        }
      }
    }
  }
  return { byRule: Object.fromEntries(Object.entries(byRule).map(([k, v]) => [k, { failed: v.failed, total: v.total, cases: [...v.cases] }])) };
}
