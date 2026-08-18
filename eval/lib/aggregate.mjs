// 多数决(规格 §3.1④) + 分桶(⑤) + variant×category 矩阵(⑥)。
import { CATEGORIES } from './types.mjs';

export function buildCaseResult(c, samples) {
  const passVotes = samples.filter((sm) => sm.ok && sm.assertions.length > 0 && sm.assertions.every((a) => a.passed)).length;
  return { id: c.id, category: c.category, samples, passVotes, majorityPassed: passVotes > samples.length / 2 };
}

export function aggregate(caseResults) {
  const buckets = Object.fromEntries(CATEGORIES.map((cat) => [cat, { total: 0, passed: 0, rate: 0 }]));
  const assertionStats = {};
  const failureDist = {};
  let total = 0, passed = 0;

  for (const cr of caseResults) {
    total++;
    if (cr.majorityPassed) passed++;
    const b = buckets[cr.category] || (buckets[cr.category] = { total: 0, passed: 0, rate: 0 });
    b.total++;
    if (cr.majorityPassed) b.passed++;
    for (const sm of cr.samples) {
      if (!sm.ok) { failureDist.run_error = (failureDist.run_error || 0) + 1; continue; }
      for (const a of sm.assertions) {
        const st = assertionStats[a.kind] || (assertionStats[a.kind] = { pass: 0, total: 0 });
        st.total++;
        if (a.passed) st.pass++;
        else failureDist[a.failureClass || 'run_error'] = (failureDist[a.failureClass || 'run_error'] || 0) + 1;
      }
    }
  }
  for (const b of Object.values(buckets)) b.rate = b.total ? b.passed / b.total : 0;
  return { buckets, assertionStats, failureDist, overall: { total, passed, rate: total ? passed / total : 0 } };
}

export function variantMatrix(cur, base) {
  const rows = CATEGORIES.map((cat) => {
    const b = base?.buckets?.[cat]?.rate ?? null;
    const c = cur?.buckets?.[cat]?.rate ?? null;
    const delta = b != null && c != null ? Math.round((c - b) * 100) : null;
    return { category: cat, base: b, cur: c, delta };
  });
  return { rows };
}
