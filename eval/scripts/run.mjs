// pnpm eval 入口: 解析参数 → 起 chromium → 跑 cases → 聚合 → 写报告 → (可选)baseline diff。
import { chromium } from 'playwright';
import { loadCases } from '../lib/case-loader.mjs';
import { runOneCase } from '../lib/runner.mjs';
import { aggregate } from '../lib/aggregate.mjs';
import { buildAttribution } from '../lib/attribution.mjs';
import { writeRun } from '../lib/report.mjs';
import { readBaseline, writeBaseline, diffVsBaseline } from '../lib/baseline.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) { const k = a.slice(2); const v = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true; if (v !== true) acc.push([k, v]); else acc.push([k, true]); }
  return acc;
}, []));

const version = args.version || 'v1';
const rigorous = parseInt(args.rigorous || '1', 10);
const split = args.split || 'all';
const caseId = args.case;
const baselinePath = args.baseline || new URL('../../eval/baseline.json', import.meta.url).pathname;
const setBaseline = args['set-baseline'] === true;

const glm = { api_key: process.env.GLM_API_KEY, base_url: process.env.GLM_BASE_URL, model: process.env.GLM_VISION_MODEL };
if (!glm.api_key || !glm.base_url || !glm.model) {
  console.error('缺少 GLM_API_KEY / GLM_BASE_URL / GLM_VISION_MODEL(.env.local)'); process.exit(1);
}

const cases = await loadCases({ split, id: caseId });
if (!cases.length) { console.error(`无 case(eval/cases/, split=${split}${caseId ? ' id=' + caseId : ''})`); process.exit(1); }
console.log(`eval: version=${version} samples=${rigorous} split=${split} cases=${cases.length}`);

const compareVersion = args.compare || null;   // 配对偏好(spec §5.2): --compare v1 时先跑 v1 存每题 png, 主版本配对比较
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--use-gl=swiftshader'] });

// (可选) 先跑对照版本, 收每 case 代表 png(首样本), 供主版本 judgePaired
let basePngs = null;
if (compareVersion) {
  basePngs = new Map();
  console.log(`配对: 先跑对照版本 ${compareVersion}(单样本) …`);
  for (const c of cases) {
    const baseRun = await runOneCase(browser, c, { promptVersion: compareVersion, glm, rigorous: 1 });
    const png = baseRun.samples.find((s) => s._png)?._png;
    if (png) basePngs.set(c.id, png);
  }
}

const caseRuns = [];
for (const c of cases) {
  process.stdout.write(`  [${c.id}] …\n`);
  caseRuns.push(await runOneCase(browser, c, { promptVersion: version, glm, rigorous, comparePng: basePngs?.get(c.id) }));
}
await browser.close();

const agg = aggregate(caseRuns);
const attrib = buildAttribution(caseRuns);
const runMeta = { runId: `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}-${version}`, promptVersion: version, samples: rigorous, split };

const reportsDir = new URL('../../eval/reports/', import.meta.url).pathname;
const { resultsPath, mdPath } = await writeRun(caseRuns, agg, attrib, runMeta, reportsDir);
console.log(`报告: ${mdPath}\n结果: ${resultsPath}`);

if (setBaseline) {
  writeBaseline({ aggregate: agg, cases: caseRuns }, baselinePath);
  console.log(`已写 baseline: ${baselinePath}`);
} else {
  const baseline = readBaseline(baselinePath);
  if (baseline) {
    const diff = diffVsBaseline({ aggregate: agg, cases: caseRuns }, baseline);
    if (diff.regressions.length) console.warn(`⚠ 回归退化(超阈值): ${diff.regressions.join(', ')}`);
    else console.log('✓ 无回归退化');
  }
}
console.log(`整体通过率: ${(agg.overallPassRate * 100).toFixed(0)}% | 维度: 正确 ${(agg.byDimension.correctness * 100).toFixed(0)}% / 健壮 ${(agg.byDimension.robustness * 100).toFixed(0)}% / 视觉 ${(agg.byDimension.visual * 100).toFixed(0)}%`);
