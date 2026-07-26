// results.json(机器层, L2/L3 消费) + markdown(给人看)。
import { writeFileSync, mkdirSync } from 'node:fs';

export function buildResults({ runMeta, caseRuns, aggregate, attribution }) {
  return { ...runMeta, cases: caseRuns, aggregate, attribution };
}

export function renderMarkdown({ runMeta, caseRuns, aggregate, attribution, baseline }) {
  const L = [];
  L.push(`# Eval 报告 ${runMeta.runId}`, '');
  L.push(`- prompt 版本: **${runMeta.promptVersion}** | 样本数: ${runMeta.samples} | 整体通过率: ${(aggregate.overallPassRate * 100).toFixed(0)}%`, '');
  L.push('## 总览(维度)');
  L.push(`- 正确性: ${(aggregate.byDimension.correctness * 100).toFixed(0)}% | 健壮性: ${(aggregate.byDimension.robustness * 100).toFixed(0)}% | 视觉: ${(aggregate.byDimension.visual * 100).toFixed(0)}%`, '');
  // I2: spec §10 防 overfit 信号——train vs holdout 分项分, 让人肉眼察觉"train 涨但 holdout 跌"。
  if (aggregate.bySplit && aggregate.bySplit.train && aggregate.bySplit.holdout) {
    const fmt = (s) => `正确 ${(s.byDimension.correctness * 100).toFixed(0)}% / 健壮 ${(s.byDimension.robustness * 100).toFixed(0)}% / 视觉 ${(s.byDimension.visual * 100).toFixed(0)}% (整体 ${(s.overallPassRate * 100).toFixed(0)}%)`;
    L.push(`- train: ${fmt(aggregate.bySplit.train)} | holdout: ${fmt(aggregate.bySplit.holdout)}`, '');
  }
  // 配对偏好(judgePaired, spec §5.2): A=对照版, B=本版
  const paired = caseRuns.flatMap((c) => c.samples.map((s) => s.visual?.preference).filter(Boolean));
  if (paired.length) {
    const a = paired.filter((p) => p === 'A').length, b = paired.filter((p) => p === 'B').length;
    L.push(`## 配对偏好(A=对照版, B=${runMeta.promptVersion})`);
    L.push(`- A 更好: ${a} | B 更好: ${b} | 平: ${paired.length - a - b}`, '');
  }
  if (baseline) {
    L.push('## 版本 diff(vs baseline)');
    for (const d of ['correctness', 'robustness', 'visual']) {
      const delta = aggregate.byDimension[d] - (baseline.byDimension?.[d] ?? aggregate.byDimension[d]);
      const sign = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
      L.push(`- ${d}: ${sign} ${(delta * 100).toFixed(0)}pp`);
    }
    L.push('');
  }
  L.push('## L1 归因(失败按 prompt 规则聚合)');
  const failedRules = Object.entries(attribution.byRule).filter(([, v]) => v.failed > 0).sort((a, b) => b[1].failed - a[1].failed);
  if (!failedRules.length) L.push('- (无规则级失败)', '');
  else { for (const [rule, v] of failedRules) L.push(`- **${rule}**: ${v.failed}/${v.total} 失败, 涉及 ${v.cases.join(', ')}`); L.push(''); }
  L.push('## 失败 case');
  const failed = caseRuns.filter((c) => c.passRate < 1);
  if (!failed.length) L.push('- (全部通过)', '');
  else for (const c of failed) {
    L.push(`### ${c.id} (split=${c.split}, passRate=${(c.passRate * 100).toFixed(0)}%)`);
    for (const s of c.samples) {
      if (s.error) { L.push(`- RUN_ERROR: ${s.error}`); continue; }
      for (const a of s.assertions || []) if (!a.passed) L.push(`- ✗ ${a.kind}${a.name ? ':' + a.name : ''} [${a.failureClass}] ← ${(a.guards || []).join('/')}`);
      for (const iss of s.visual?.issues || []) L.push(`- 视觉: ${iss}`);
    }
    L.push('');
  }
  return L.join('\n');
}

export async function writeRun(caseRuns, aggregateObj, attribution, runMeta, reportsDir) {
  mkdirSync(reportsDir, { recursive: true });
  const results = buildResults({ runMeta, caseRuns, aggregate: aggregateObj, attribution });
  const resultsPath = `${reportsDir}/${runMeta.runId}.results.json`;
  writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  const mdPath = `${reportsDir}/${runMeta.runId}.md`;
  writeFileSync(mdPath, renderMarkdown({ runMeta, caseRuns, aggregate: aggregateObj, attribution, baseline: null }));
  // 每样本产物落盘(供 debug; .gitignore)
  caseRuns.forEach((c) => c.samples.forEach((s, i) => {
    if (s._xml) writeFileSync(`${reportsDir}/${runMeta.runId}.${c.id}.s${i}.xml`, s._xml);
    if (s._png) writeFileSync(`${reportsDir}/${runMeta.runId}.${c.id}.s${i}.png`, Buffer.from(s._png.split(',')[1] || '', 'base64'));
  }));
  return { resultsPath, mdPath };
}
