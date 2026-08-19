// pnpm eval CLI: --list | (--variant ... [--case id] [--runs n] [--out path] [--compare results.json] [--base-url url] [--serial])
import { readFileSync, copyFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { loadCases, validateCase, ASSERTION_KINDS, CATEGORIES } from '../lib/types.mjs';
import { runOneCase } from '../lib/runner.mjs';
import { aggregate, variantMatrix } from '../lib/aggregate.mjs';
import { writeResults, renderMarkdown } from '../lib/report.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = (process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) ? process.argv[++i] : true;
}

const ROOT = new URL('../../', import.meta.url).pathname;
const REPORTS_DIR = `${ROOT}eval/reports/`;

const cases = loadCases({ id: args.case });
const invalid = cases.filter((c) => !validateCase(c).ok);
if (invalid.length) {
  for (const c of invalid) console.error(`用例 ${c.id} 不合法:\n  ${validateCase(c).errors.join('\n  ')}`);
  process.exit(1);
}

if (args.list === true) {
  for (const c of cases) {
    console.log(`[${c.category}] ${c.id}: ${c.prompt}`);
    for (const a of c.assertions) console.log(`    - ${a.kind} ${a.expr || a.type || ''}`);
  }
  console.log(`\n共 ${cases.length} 条; 桶: ${CATEGORIES.join('/')}, 断言原语: ${ASSERTION_KINDS.length} 个`);
  process.exit(0);
}

const variantPath = args.variant || `${ROOT}eval/variants/deepseek-v2.json`;
const v = JSON.parse(readFileSync(variantPath, 'utf8'));

// env 名 → 值(只在此处发生; 缺失只报名不报值)
const need = (envName) => {
  const val = process.env[envName];
  if (!val) { console.error(`variant 缺环境变量 ${envName}(.env.local)`); process.exit(1); }
  return val;
};
// resolve 后字段名固定为 {api_key, base_url, model_name}——browser.mjs 的 buildByokPayload 依赖 model_name
const resolve = (spec) => ({
  api_key: need(spec.api_key_env), base_url: need(spec.base_url_env), model_name: need(spec.model_env),
});
const resolved = {
  name: v.name,
  prompt_version: v.prompt_version,
  temperature: v.temperature,
  max_tool_rounds: v.max_tool_rounds,
  runs_per_case: parseInt(String(args.runs || v.runs_per_case || 3), 10),
  model: process.env[v.llm.model_env],
  llm: resolve(v.llm), vision: resolve(v.vision), embedding: resolve(v.embedding),
};

const promptText = readFileSync(`${ROOT}prompts/${v.prompt_version}.md`, 'utf8');
const baseUrl = args['base-url'] || 'http://localhost:3000/app';
const runs = resolved.runs_per_case;

console.log(`eval: variant=${resolved.name} model=${resolved.model} prompt=${v.prompt_version} temp=${v.temperature} runs=${runs} cases=${cases.length}`);
console.log('（请确保 pnpm dev 已在跑且 .env.local 齐全）');

if (cases.length === 0) {
  console.error(`[eval] 未匹配到用例(${args.case ? `--case ${args.case}` : 'cases/ 目录为空'})——检查 id 拼写; 拒绝产出空报告`);
  process.exit(1);
}

const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--use-gl=swiftshader'] });
const caseResults = [];
for (const c of cases) {
  process.stdout.write(`  [${c.id}] `);
  const r = await runOneCase(browser, c, {
    baseUrl, promptVersion: v.prompt_version, promptText,
    variant: resolved, temperature: v.temperature, maxToolRounds: v.max_tool_rounds,
    runs,
    timeoutMs: c.timeoutMs || 180000,   // 每用例可覆盖(spec §3.4; 默认 180s)
    serial: args.serial === true,       // 429 限流时的降级开关(spec §6)
  });
  caseResults.push(r);
  console.log(`${r.passVotes}/${runs}${r.majorityPassed ? ' ✓' : ' ✗'}`);
}
await browser.close();

const agg = aggregate(caseResults);
const results = { variant: { name: resolved.name, prompt_version: v.prompt_version, model: resolved.model, temperature: v.temperature, max_tool_rounds: v.max_tool_rounds, runs_per_case: runs }, date: new Date().toISOString(), cases: caseResults, ...agg };

const { resultsPath, mdPath } = writeResults(results, REPORTS_DIR);
console.log(`\n总成功率: ${Math.round(agg.overall.rate * 100)}%（${agg.overall.passed}/${agg.overall.total}）`);
console.log(`报告: ${mdPath}\n结果: ${resultsPath}`);

if (args.compare) {
  const base = JSON.parse(readFileSync(args.compare, 'utf8'));
  const matrix = variantMatrix(results, base);
  console.log('\n' + renderMarkdown(results, { matrix }));
}

if (typeof args.out === 'string') { copyFileSync(mdPath, args.out); console.log(`已复制到 ${args.out}`); }
