// pnpm eval:intake <id>: 把 raw/<id>/ 标准化成 cases/<id>.yaml 草稿 + 打印核查报告。
// 断言半自动: object_exists 从 inventory 推; parametric 给模板; invariant 留占位(人工/LLM 补, 标"需确认")。
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { stringify } from 'yaml';
import { readGgbFile, parseGeogebraXml } from '../lib/parse-ggb.mjs';

const id = process.argv[2];
if (!id) { console.error('用法: pnpm eval:intake <id>'); process.exit(1); }

const ROOT = new URL('../../', import.meta.url).pathname;
const rawDir = `${ROOT}eval/raw/${id}/`;
if (!existsSync(rawDir)) { console.error(`找不到 ${rawDir}`); process.exit(1); }

const problem = readFileSync(`${rawDir}problem.txt`, 'utf8').trim();
const notes = existsSync(`${rawDir}notes.txt`) ? readFileSync(`${rawDir}notes.txt`, 'utf8').trim() : '';
const ggbSrc = `${rawDir}source.ggb`;

// reference 从 .ggb 解析(固化, 不每次重算)
const xml = existsSync(ggbSrc) ? readGgbFile(ggbSrc) : '';
const ref = xml ? parseGeogebraXml(xml) : { objectInventory: [], freeVars: [], elements: [] };

// 固化 reference + 拷贝 ggb
mkdirSync(`${ROOT}eval/fixtures/ggb/`, { recursive: true });
mkdirSync(`${ROOT}eval/fixtures/reference/`, { recursive: true });
if (existsSync(ggbSrc)) {
  copyFileSync(ggbSrc, `${ROOT}eval/fixtures/ggb/${id}.ggb`);
  writeFileSync(`${ROOT}eval/fixtures/reference/${id}.json`, JSON.stringify(ref, null, 2));
}

// 推断言骨架
const assertions = [];
for (const { type, count } of ref.objectInventory) {
  assertions.push({ kind: 'object_exists', find: { type, min: Math.min(count, 1) }, guards: ['约束闭环'] });
}
if (ref.freeVars.length) {
  assertions.push({ kind: 'parametric', message: '派生量依赖自由变量(请确认对象)', guards: ['约束闭环·派生量写成自由变量函数'] });
}
// invariant 占位(人工/LLM 补)
assertions.push({ kind: 'invariant', name: '(待补: 本题不变关系)', select: {}, expr: '', expect: true, guards: [], _TODO: '请填选择器+expr+guards' });

const hasAnim = ref.freeVars.some((v) => v.type === 'slider');
const slider = ref.freeVars.find((v) => v.type === 'slider');
const repFrame = hasAnim && slider ? { slider: slider.name, value: slider.min != null ? (slider.min + (slider.max || 0)) / 2 : 0.5 } : null;

const caseObj = {
  id,
  meta: {
    title: problem.slice(0, 20),
    problem,
    dimension: /球|圆柱|圆锥|棱柱|棱锥|立方体|四面体|立体|3D|三维/.test(problem) ? '3D' : '2D',
    topic: [],
    difficulty: null,          // 待人工标
    key_insight: notes || '(待补)',
    animation: { hasAnimation: hasAnim, slider: slider?.name, frames: slider ? [slider.min, (slider.min + (slider.max || 0)) / 2, slider.max] : [] },
    ...(repFrame ? { representativeFrame: repFrame } : {}),
    source: { url: '(待填社区链接)', ggb_file: `fixtures/ggb/${id}.ggb` },
  },
  reference: { objectInventory: ref.objectInventory, freeVars: ref.freeVars },
  assertions,
  visual_rubric: 'inherit',
  split: 'train',              // 待人工按 7/3 调
  provenance: { derived_from: `raw/${id}/`, author: 'claude+human', reviewed: false, version: 1 },
};

const yamlPath = `${ROOT}eval/cases/${id}.yaml`;
writeFileSync(yamlPath, stringify(caseObj));

// 核查报告
console.log(`✓ 生成 ${yamlPath}\n`);
console.log('── 核查清单(逐项确认)──');
console.log(`1. 题目(已从 problem.txt 提取):\n   ${problem}`);
console.log(`2. 维度推断: ${caseObj.meta.dimension} ${ref.objectInventory.length ? '对象: ' + ref.objectInventory.map((o) => `${o.type}×${o.count}`).join(', ') : '(ggb 未找到对象, 检查 source.ggb)'}`);
console.log(`3. 自由变量: ${ref.freeVars.map((v) => v.name).join(', ') || '(无)'}`);
console.log(`4. 推断的 object_exists 断言: ${assertions.filter((a) => a.kind === 'object_exists').length} 条`);
console.log(`5. ⚠ invariant 占位需补: 本题的"不变关系"(如垂直/相等/定值), 填 select+expr+guards`);
console.log(`6. ⚠ difficulty / topic / split(7train/3holdout)/ source.url 待人工标`);
console.log(`7. representativeFrame${repFrame ? `=${JSON.stringify(repFrame)}` : '(静态题, 无)'}`);
console.log('\n改完 cases/' + id + '.yaml 后, provenance.reviewed 置 true 即入库。');
