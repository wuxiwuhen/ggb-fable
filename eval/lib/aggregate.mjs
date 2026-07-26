// 把 caseRuns 聚合成 byDimension / byRule / overallPassRate。
function dimOf(kind) {
  if (kind === 'parametric') return 'robustness';
  if (kind === 'object_exists' || kind === 'invariant') return 'correctness';
  return null;
}

export function aggregate(caseRuns) {
  const dim = { correctness: { pass: 0, total: 0 }, robustness: { pass: 0, total: 0 }, visual: { pass: 0, total: 0 } };
  const rule = {};
  let overallPass = 0, overallTotal = 0;
  for (const run of caseRuns) {
    overallTotal++;
    if (run.passRate >= 1) overallPass++;
    for (const s of run.samples) {
      if (s.error) continue;
      for (const a of s.assertions || []) {
        const d = dimOf(a.kind);
        if (d) { dim[d].total++; if (a.passed) dim[d].pass++; }
        for (const g of a.guards || []) {
          rule[g] = rule[g] || { pass: 0, total: 0 };
          rule[g].total++; if (a.passed) rule[g].pass++;
        }
      }
      for (const it of s.visual?.items || []) {
        dim.visual.total++;
        const ok = it.ok ?? it.b_ok;        // judgeSingle: {ok}; judgePaired: {a_ok,b_ok}, 取主版本 b_ok
        if (ok) dim.visual.pass++;
      }
    }
  }
  const rate = (x) => (x.total ? x.pass / x.total : 1);
  return {
    byDimension: { correctness: rate(dim.correctness), robustness: rate(dim.robustness), visual: rate(dim.visual) },
    byRule: Object.fromEntries(Object.entries(rule).map(([k, v]) => [k, rate(v)])),
    overallPassRate: overallTotal ? overallPass / overallTotal : 0,
  };
}
