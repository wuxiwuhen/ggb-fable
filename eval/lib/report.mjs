// 机器层 results.json + 人读 markdown(分桶报告, 规格 §3.1⑤)。
import { writeFileSync, mkdirSync } from 'node:fs';

const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const CATEGORY_LABELS = {
  basics: '基础构造', functions: '函数图像', dynamic: '动态可拖动', multi: '多步组合', traps: '陷阱与预算边界',
};

export function renderMarkdown(results, { matrix } = {}) {
  const { variant: v, overall, buckets, assertionStats, failureDist, cases } = results;
  const L = [];
  L.push(`# Eval 报告 · ${v.name}`, '');
  L.push(`- 日期: ${results.date.slice(0, 10)} ｜ model: **${v.model}** ｜ prompt_version: **${v.prompt_version}**`);
  L.push(`- temperature: **${v.temperature}** ｜ max_tool_rounds: ${v.max_tool_rounds} ｜ 每条采样: ${v.runs_per_case} 次(多数决)`);
  L.push(`- 总成功率: **${pct(overall.rate)}**（${overall.passed}/${overall.total} 条）`, '');

  L.push('## 分桶成功率', '');
  L.push('| 桶 | 用例数 | 通过 | 成功率 |');
  L.push('|---|---|---|---|');
  for (const [cat, b] of Object.entries(buckets)) {
    L.push(`| ${cat} ${CATEGORY_LABELS[cat] || ''} | ${b.total} | ${b.passed} | ${pct(b.rate)} |`);
  }
  L.push('');

  L.push('## 延迟分布（分桶采样 P50）', '');
  L.push('| 桶 | P50 |');
  L.push('|---|---|');
  for (const [cat, b] of Object.entries(buckets)) {
    L.push(`| ${cat} ${CATEGORY_LABELS[cat] || ''} | ${b.p50Ms == null ? '—' : (Math.round(b.p50Ms / 100) / 10) + 's'} |`);
  }
  L.push('');

  L.push('## 断言级统计（全部采样全量记录）', '');
  L.push('| 断言原语 | 通过/总数 |');
  L.push('|---|---|');
  for (const [kind, st] of Object.entries(assertionStats)) L.push(`| ${kind} | ${st.pass}/${st.total} |`);
  L.push('');

  L.push('## 失败分类分布', '');
  const fails = Object.entries(failureDist).sort((a, b) => b[1] - a[1]);
  L.push(fails.length ? fails.map(([k, n]) => `- **${k}**: ${n}`).join('\n') : '- （无失败）');
  L.push('');

  if (matrix) {
    L.push('## variant × category 矩阵（vs 对比 run）', '');
    L.push('| 桶 | 基线 | 本次 | 差 |');
    L.push('|---|---|---|---|');
    for (const r of matrix.rows) L.push(`| ${r.category} ${CATEGORY_LABELS[r.category] || ''} | ${pct(r.base)} | ${pct(r.cur)} | ${r.delta == null ? '—' : (r.delta > 0 ? '+' : '') + r.delta + 'pp'} |`);
    L.push('');
  }

  // runs=2 时区间退化成 "1 次通过"(不写难看的 "1–1")
  const edgeRange = v.runs_per_case > 2 ? `1–${v.runs_per_case - 1}` : '1';
  L.push(`## 边界信号（${v.runs_per_case} 次中有 ${edgeRange} 次通过：不稳定而非全坏）`, '');
  const edge = cases.filter((c) => c.passVotes > 0 && !c.majorityPassed);
  L.push(edge.length ? edge.map((c) => `- \`${c.id}\`: ${c.passVotes}/${v.runs_per_case}`).join('\n') : '- （无）');
  L.push('');

  L.push('## 失败明细', '');
  const failed = cases.filter((c) => !c.majorityPassed);
  if (!failed.length) L.push('- （全部通过）');
  else for (const c of failed) {
    L.push(`### ${c.id}（${CATEGORY_LABELS[c.category] || c.category}, ${c.passVotes}/${c.samples.length}）`);
    c.samples.forEach((sm, i) => {
      if (!sm.ok) { L.push(`- s${i}: RUN_ERROR ${sm.error || ''}`); return; }
      for (const a of sm.assertions) if (!a.passed) L.push(`- s${i}: ✗ ${a.kind} ${a.name} [${a.failureClass}] ${a.detail}`);
    });
    L.push('');
  }

  L.push('## 覆盖边界声明', '');
  L.push(`- 本报告只证明：这 ${cases.length} 条用例在该 variant 配置下的多数决成功率与失败分类。`);
  L.push('- 不证明：全体 K12 题型覆盖、视觉美观度（视觉仅采信被评系统自报的 inspect_render 结论）、跨模型一般性。');
  L.push('- 桶级数字只做方向性结论（规格 §3.1⑤），不做显著性声明；扩到 30 条后结论边界同步更新。');
  return L.join('\n');
}

export function writeResults(results, reportsDir) {
  mkdirSync(reportsDir, { recursive: true });
  const runId = `${results.date.slice(0, 10).replace(/-/g, '')}-${results.variant.name}`;
  const resultsPath = `${reportsDir}/${runId}.results.json`;
  const mdPath = `${reportsDir}/${runId}.md`;
  writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  writeFileSync(mdPath, renderMarkdown(results));
  return { resultsPath, mdPath };
}
