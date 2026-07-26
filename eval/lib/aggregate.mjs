// 把 caseRuns 聚合成 byDimension / byRule / bySplit / overallPassRate。
function dimOf(kind) {
  if (kind === 'parametric') return 'robustness';
  if (kind === 'object_exists' || kind === 'invariant') return 'correctness';
  return null;
}

// 单 split 内的聚合: 维度 + 规则 + 整体通过率。
// 抽出来用于全局 + bySplit(train/holdout)——同套指标在不同 case 子集上重复(spec §10)。
function aggregateSplit(caseRuns) {
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
      // I1: 视觉项也带 guards(spec §9 强制必填)——必须喂给 byRule, 否则 L1 归因漏掉所有视觉失败。
      for (const it of s.visual?.items || []) {
        dim.visual.total++;
        const ok = it.ok ?? it.b_ok;        // judgeSingle: {ok}; judgePaired: {a_ok,b_ok}, 取主版本 b_ok
        if (ok) dim.visual.pass++;
        for (const g of it.guards || []) {
          rule[g] = rule[g] || { pass: 0, total: 0 };
          rule[g].total++; if (ok) rule[g].pass++;
        }
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

export function aggregate(caseRuns) {
  const overall = aggregateSplit(caseRuns);
  // I2: spec §10 防 overfit 信号——train/holdout 分别报维度分, 让人肉眼察觉"train 涨但 holdout 跌"。
  const bySplit = {};
  for (const sp of ['train', 'holdout']) {
    const subset = caseRuns.filter((r) => r.split === sp);
    if (subset.length) bySplit[sp] = aggregateSplit(subset);
  }
  return { ...overall, bySplit };
}
