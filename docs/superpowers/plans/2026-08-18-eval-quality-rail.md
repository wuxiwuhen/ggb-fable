# Eval 效果基线（10 条跑通 rail）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建 eval rail——10 条用例 × 每条 3 次取多数，Playwright 驱动真实 app，确定性断言（判分零 LLM），分桶报告落盘 `docs/eval-report-v1.md`。

**Architecture:** eval 是独立 Node ESM 代码（`eval/` 目录，`.mjs`），不被 app import、不进 Next bundle。纯逻辑模块（types/parse-canvas/selector/templates/aggregate/report）用**已有的 vitest** 做 TDD；浏览器模块（browser/runner/scripts）端到端验证。Runner 用 Playwright + 软件 WebGL 驱动本地 `pnpm dev`：拦截 `/api/config/prompt-text`（强制 prompt 版本）+ `/api/sessions`（收集轨迹事件 + 隔离服务端），`page.addInitScript` 注入 BYOK localStorage（key 从 `.env.local` 读，**永不写进任何文件**），DOM 喂题，`window.ggbApplet` 抓画布 XML。评分 = 10 个确定性断言原语（对象存在/度量容差/关系布尔/滑块/参数化依赖/视觉 inspect 结论/标签可见/过程无错/预算），**评判环节零 LLM**（与 2026-07-26 旧计划的 GLM vision judge 决定性不同）。

**Tech Stack:** Node ESM（`eval/**/*.mjs`）、Playwright（devDep，唯一新增依赖）、vitest（已有，单测）、`node --env-file=.env.local`（读 key）。

**上游规格:** `docs/superpowers/specs/2026-08-18-quality-first-design.md` §3 + §3.1（本计划实现其任务 1 的"先 10 条"阶段）。
**取代:** `docs/superpowers/plans/2026-07-26-eval-phase1.md`（未执行，判分设计已被规格否决；其 BYOK 注入/拦截/appletEval 工程手段被本计划继承）。

## Global Constraints

（每个 task 的需求都隐含以下约束，源自规格 §3/§3.1）

- **判分确定性原则（规格 §3.1①）**：全部断言由确定性代码判定（数值容差比较 / 对象存在性 / 事件计数）；评判环节零 LLM。不引入 GLM vision judge。
- **断言模板库 = 恰好 10 个原语（规格 §3.1②）**：`object_exists` / `measure_eq` / `measure_range` / `relation_bool` / `slider_exists` / `parametric_ref` / `visual_inspect_ok` / `label_visible` / `process_no_error` / `process_budget`。kind 名与语义全计划冻结，不得增改。
- **稳定性处理（规格 §3.1④）**：每条 3 次，case 级取多数（≥2/3 全断言通过 = case 通过），断言级全量记录；"3 次中 1 次过"记录为边界信号。
- **温度固定并写入报告（规格 §3.1④）**：variant 配置里的 temperature 进入报告头部。
- **分桶报告（规格 §3.1⑤）**：按 5 桶（`basics`/`functions`/`dynamic`/`multi`/`traps`）统计；只做桶级方向性结论；报告明写覆盖边界声明。
- **variant 框架（规格 §3.1⑥）**：一遍 eval = 一个 `{prompt_version, model, temperature}` 配置（tools 恒定：7 工具 + GLM vision/embedding + max_tool_rounds=30）；报告输出 variant × category 矩阵（对比两个 results.json）。
- **用例格式（改进计划 §3）**：`{id, prompt, category, assertions}`；prompt 用中文 K12 口吻。
- **断言初稿 AI 起草 + 领域专家审核（规格 §3.1③）**：Task 10 的 10 条用例断言为 AI 起草稿，**必须**呈现给用户裁决修正后才算定稿。
- **10→30 分批（规格 §3.1⑦）**：本计划只做 10 条（每桶 2 条）；扩 30 是后续复用模板的事，不在本计划。
- **eval 代码不被 app import**，不进 Next bundle；app 代码改动仅 1 行（`lib/ggb.ts` 暴露 `window.ggbApplet`）。
- **key 永不落文件**：variant JSON 只存环境变量**名**（如 `DEEPSEEK_API_KEY`）；`.env.local` 由 `node --env-file` 读；产物（reports/）整个 gitignore。
- **生产构建必须通过**：每个 task 后 `pnpm build` 仍 OK。
- **commit 粒度**：每个 task 一次 commit；中文 message，风格 `feat(eval): ...` / `chore(eval): ...` / `docs(eval): ...`。
- **单测框架用已有 vitest**（`pnpm test` 已存在）；不引入 node --test、不新增测试框架。eval 单测命令 `pnpm eval:unit` = `vitest run eval/`。

---

## File Structure

```
eval/
  cases/                  # 10 条用例 + 1 条自检用例(*.json, 入库)
  lib/
    types.mjs             # Case/Assertion/结果类型(JSDoc) + validateCase + loadCases; 纯逻辑, TDD
    parse-canvas.mjs      # 画布 XML → {elements, freeVars, corpus}; 纯逻辑, TDD
    selector.mjs          # %别名% → 真实 label 绑定(按 type); 纯逻辑, TDD
    templates.mjs         # 10 断言原语 evaluateAssertion; 纯逻辑, TDD(核心)
    aggregate.mjs         # 多数决 + 分桶 + 失败分类分布 + variant×category 矩阵; 纯逻辑, TDD
    report.mjs            # results.json + markdown 渲染; 纯逻辑, TDD
    browser.mjs           # Playwright 页面装配(注入/拦截/喂题/等完成/抓画布/appletEval); 浏览器层, 端到端验证
    runner.mjs            # 单 case 编排(3 次采样 + 断言评分); 浏览器层, 端到端验证
  variants/
    deepseek-v2.json      # 基线 variant(LLM=DeepSeek, vision/embedding=GLM, temp=0.2)
    glm-v2.json           # 对照 variant(全 GLM)
  scripts/
    run.mjs               # pnpm eval CLI 入口
  reports/                # 产物(results.json/md/xml/png), 整目录 .gitignore
  README.md               # 用法
docs/eval-report-v1.md    # Task 11 正式基线报告(入库)
```

类型约定（贯穿全部 task，JSDoc 注释维护，模块导出同名常量做运行时校验）：

```js
// 用例
Case        = { id: string, prompt: string, category: 'basics'|'functions'|'dynamic'|'multi'|'traps',
                notes?: string, assertions: Assertion[] }
select      = { [alias: string]: { type: string, min?: number } }        // alias 在 expr 里以 %alias% 出现
Assertion   = 十种之一:
  { kind:'object_exists',   type: string, min?: number }                  // 默认 min=1
  { kind:'measure_eq',      select: select, expr: string, expect: number, tol?: number }   // 默认 tol=0.01
  { kind:'measure_range',   select: select, expr: string, min: number, max: number }
  { kind:'relation_bool',   select: select, expr: string, expect?: boolean }               // 默认 expect=true
  { kind:'slider_exists',   min?: number }
  { kind:'parametric_ref' }
  { kind:'visual_inspect_ok' }
  { kind:'label_visible',   type: string, min_visible?: number }          // 默认 1
  { kind:'process_no_error' }
  { kind:'process_budget',  verify_max?: number, render_max?: number }    // 默认 3 / 2

// 画布上下文(parse-canvas 产出)
CanvasElement = { label: string, type: string, visible: boolean, definition: string }
CanvasCtx     = { elements: CanvasElement[], freeVars: {name: string, type: 'slider'|'point'}[],
                  corpus: string }        // corpus = 全部 expression exp + command 输入表达式拼起来的依赖语料

// 断言求值上下文(runner 组装)
AssertCtx  = { canvas: CanvasCtx, events: object[], appletEval: (expr) => Promise<{ok: boolean, value: string, numeric?: number}> }
AssertionResult = { kind: string, name: string, passed: boolean, failureClass: string|null, detail: string }

// 运行结果
SampleResult = { ok: boolean, error?: string, timedOut?: boolean,
                 assertions: AssertionResult[],
                 stats: { rounds: number, verifyCount: number, renderCount: number, failCmds: number,
                          stopped: boolean, errorCount: number, inspectPassed: boolean|null, finalText: string } }
CaseResult   = { id: string, category: string, samples: SampleResult[],
                 passVotes: number, majorityPassed: boolean }             // passVotes = 全断言通过的采样数
EvalResults  = { variant: object, date: string, cases: CaseResult[],
                 buckets: object, assertionStats: object, failureDist: object }
```

failureClass 全集（冻结）：`run_error` / `object_missing` / `selector_unmatched` / `eval_error` / `measure_mismatch` / `relation_false` / `slider_missing` / `parametric_fail` / `visual_fail` / `label_hidden` / `process_error` / `budget_exceeded`。

---

### Task 1: 脚手架 + 依赖 + applet 暴露 + 旧计划标记取代

**Files:**
- Modify: `package.json`（devDep + scripts）
- Modify: `lib/ggb.ts:152-156`（暴露 `window.ggbApplet`）
- Modify: `docs/superpowers/plans/2026-07-26-eval-phase1.md`（顶部加取代横幅）
- Create: `eval/.gitignore`, `eval/README.md`, 目录占位

**Interfaces:**
- Produces: `window.ggbApplet`（GeoGebra applet 全局句柄，browser.mjs 依赖）；`pnpm eval` / `pnpm eval:unit` 命令；playwright 依赖。

- [ ] **Step 1: 加依赖**

Run:
```bash
pnpm add -D playwright
pnpm exec playwright install chromium
```
Expected: `playwright` 出现在 devDependencies；chromium 装好（`~/Library/Caches/ms-playwright/`）。

- [ ] **Step 2: package.json scripts**

在 `scripts` 块（保留现有全部条目）追加：
```json
"eval": "node --env-file=.env.local eval/scripts/run.mjs",
"eval:unit": "vitest run eval/"
```

- [ ] **Step 3: 暴露 applet 到 window（app 侧唯一 1 行改动）**

`lib/ggb.ts` 的 `appletOnLoad` 回调内（约 152-153 行），找到锚点行：
```ts
          this.applet = api || (window as any).ggbApplet;
```
在其**下一行**插入（不改回调签名与其他任何逻辑）：
```ts
          if (this.applet) (window as any).ggbApplet = this.applet; // eval 抓画布用; GeoGebra 惯例全局句柄, 生产无害
```

- [ ] **Step 4: 目录 + .gitignore + README**

Run:
```bash
mkdir -p eval/cases eval/lib eval/variants eval/scripts eval/reports
```

Create `eval/.gitignore`：
```
reports/
```

Create `eval/README.md`：
```markdown
# Eval

画布生成效果 eval（规格: docs/superpowers/specs/2026-08-18-quality-first-design.md §3/§3.1）。
判分零 LLM：全部断言为确定性代码。

## 用法
- `pnpm eval:unit`                          # eval 模块单测（vitest）
- `pnpm eval -- --list`                     # 列出用例与断言（不跑浏览器）
- `pnpm eval -- --case _selftest --runs 1`  # 单用例冒烟（需先 `pnpm dev`）
- `pnpm eval -- --variant eval/variants/deepseek-v2.json`           # 基线（10 条 × 3 次）
- `pnpm eval -- --variant ... --compare eval/reports/<旧>.results.json`  # 对比旧 results 出矩阵

## 约束
- key 从 `.env.local` 经 `node --env-file` 读，variant JSON 只存环境变量名
- 产物在 `eval/reports/`（gitignore）；正式报告落 `docs/eval-report-v1.md`
```

- [ ] **Step 5: 旧计划标记取代**

`docs/superpowers/plans/2026-07-26-eval-phase1.md` 顶部（标题之后）插入：
```markdown
> ⚠️ **2026-08-18 取代**：本计划未执行，其"视觉走 GLM vision judge"设计与
> 效果优先规格 §3.1①（判分零 LLM）冲突。生效计划见
> `2026-08-18-eval-quality-rail.md`（继承本计划的 BYOK 注入 / 拦截 / appletEval 工程手段）。
> 配套旧设计 `specs/2026-07-26-eval-design.md` 同步视为历史资料。
```

- [ ] **Step 6: 验证**

Run: `pnpm build`
Expected: 构建成功（eval 未被 app import）。

Run: `pnpm test`
Expected: 现有测试（retry.test.ts 等）PASS，无回归。

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml lib/ggb.ts eval/ docs/superpowers/plans/2026-07-26-eval-phase1.md
git commit -m "chore(eval): 脚手架 + playwright 依赖 + applet 全局暴露

- 挂 pnpm eval / eval:unit; 建 eval/ 目录骨架
- ggb.ts 暴露 window.ggbApplet(eval 抓画布用, 生产无害)
- 2026-07-26 旧 eval 计划标记取代(判分零 LLM 冲突)"
```

---

### Task 2: types.mjs（用例 schema + 加载）

**Files:**
- Create: `eval/lib/types.mjs`
- Create: `eval/lib/types.test.mjs`

**Interfaces:**
- Produces: `CATEGORIES`（5 桶常量）、`ASSERTION_KINDS`（10 原语常量）、`validateCase(c): {ok: boolean, errors: string[]}`、`loadCases({ casesDir?, id? }): Case[]`（同步读 `eval/cases/*.json`，按文件名排序；`casesDir` 默认 `../cases/`，测试用临时目录注入）。

- [ ] **Step 1: 写失败测试**

Create `eval/lib/types.test.mjs`：
```js
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { CATEGORIES, ASSERTION_KINDS, validateCase, loadCases } from './types.mjs';

const dir = new URL('../cases/__tmp__/', import.meta.url);

describe('validateCase', () => {
  const base = {
    id: 'a', prompt: '画一个圆', category: 'basics',
    assertions: [
      { kind: 'object_exists', type: 'conic' },
      { kind: 'measure_eq', select: { c: { type: 'conic' } }, expr: 'Radius(%c%)', expect: 3 },
    ],
  };

  it('合法用例通过', () => {
    expect(validateCase(base)).toEqual({ ok: true, errors: [] });
  });

  it('缺字段 / 坏分类 / 坏断言 kind 报错', () => {
    expect(validateCase({ ...base, prompt: '' }).ok).toBe(false);
    expect(validateCase({ ...base, category: 'nope' }).ok).toBe(false);
    expect(validateCase({ ...base, assertions: [{ kind: 'nope' }] }).ok).toBe(false);
    expect(validateCase({ ...base, assertions: [{ kind: 'measure_eq', expr: 'x' }] }).ok).toBe(false);
  });

  it('measure_eq 缺 select/expr/expect 报错; object_exists 缺 type 报错', () => {
    expect(validateCase({ ...base, assertions: [{ kind: 'measure_eq', expect: 1 }] }).ok).toBe(false);
    expect(validateCase({ ...base, assertions: [{ kind: 'object_exists' }] }).ok).toBe(false);
  });

  it('恰 5 桶 10 原语', () => {
    expect(CATEGORIES).toEqual(['basics', 'functions', 'dynamic', 'multi', 'traps']);
    expect(ASSERTION_KINDS).toHaveLength(10);
  });
});

describe('loadCases', () => {
  it('读 json 按文件名排序 + id 筛选', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL('b.json', dir), JSON.stringify({ ...base2('b'), id: 'b' }));
    writeFileSync(new URL('a.json', dir), JSON.stringify({ ...base2('a'), id: 'a' }));
    const all = loadCases({ casesDir: dir.pathname });
    expect(all.map((c) => c.id)).toEqual(['a', 'b']);
    expect(loadCases({ casesDir: dir.pathname, id: 'b' }).map((c) => c.id)).toEqual(['b']);
    rmSync(dir, { recursive: true, force: true });
  });
});

function base2(id) {
  return { id, prompt: 'p', category: 'basics', assertions: [{ kind: 'process_no_error' }] };
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm eval:unit`
Expected: FAIL（`Cannot find module './types.mjs'`）。

- [ ] **Step 3: 实现 types.mjs**

Create `eval/lib/types.mjs`：
```js
// 用例类型与校验。类型约定见计划 File Structure 的 JSDoc; 本模块导出运行时校验 + 加载器。
import { readdirSync, readFileSync } from 'node:fs';

export const CATEGORIES = ['basics', 'functions', 'dynamic', 'multi', 'traps'];

export const ASSERTION_KINDS = [
  'object_exists', 'measure_eq', 'measure_range', 'relation_bool', 'slider_exists',
  'parametric_ref', 'visual_inspect_ok', 'label_visible', 'process_no_error', 'process_budget',
];

// 每种 kind 的必填字段(除 kind 外)
const REQUIRED = {
  object_exists: ['type'],
  measure_eq: ['select', 'expr', 'expect'],
  measure_range: ['select', 'expr', 'min', 'max'],
  relation_bool: ['select', 'expr'],
  slider_exists: [],
  parametric_ref: [],
  visual_inspect_ok: [],
  label_visible: ['type'],
  process_no_error: [],
  process_budget: [],
};

function checkSelect(select, errors) {
  if (!select || typeof select !== 'object' || Array.isArray(select)) { errors.push('select 必须是对象'); return; }
  for (const [alias, spec] of Object.entries(select)) {
    if (!/^[a-zA-Z_]\w*$/.test(alias)) errors.push(`别名 ${alias} 不合法(须是标识符, expr 里以 %alias% 引用)`);
    if (!spec || typeof spec.type !== 'string') errors.push(`select.${alias} 缺 type`);
  }
}

export function validateCase(c) {
  const errors = [];
  if (!c || typeof c !== 'object') return { ok: false, errors: ['用例必须是对象'] };
  if (typeof c.id !== 'string' || !c.id.trim()) errors.push('缺 id');
  if (typeof c.prompt !== 'string' || !c.prompt.trim()) errors.push('缺 prompt');
  if (!CATEGORIES.includes(c.category)) errors.push(`category 必须是 ${CATEGORIES.join('/')} 之一`);
  if (!Array.isArray(c.assertions) || !c.assertions.length) { errors.push('assertions 必须是非空数组'); return { ok: false, errors }; }
  for (const [i, a] of c.assertions.entries()) {
    if (!ASSERTION_KINDS.includes(a?.kind)) { errors.push(`assertions[${i}].kind 必须是 ${ASSERTION_KINDS.join('/')} 之一`); continue; }
    for (const f of REQUIRED[a.kind]) {
      if (a[f] === undefined || a[f] === null) errors.push(`assertions[${i}] (${a.kind}) 缺 ${f}`);
    }
    if (a.kind === 'measure_eq' && typeof a.expect !== 'number') errors.push(`assertions[${i}] expect 必须是数字`);
    if (a.select) checkSelect(a.select, errors);
  }
  return { ok: errors.length === 0, errors };
}

const DEFAULT_DIR = new URL('../cases/', import.meta.url).pathname;

export function loadCases({ casesDir = DEFAULT_DIR, id } = {}) {
  let files = [];
  try { files = readdirSync(casesDir).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
  let cases = files.map((f) => JSON.parse(readFileSync(`${casesDir}/${f}`, 'utf8')));
  if (id) cases = cases.filter((c) => c.id === id);
  return cases;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm eval:unit`
Expected: types 测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add eval/lib/types.mjs eval/lib/types.test.mjs
git commit -m "feat(eval): 用例 schema(10 断言原语/5 桶) + 校验 + 加载器"
```

---

### Task 3: parse-canvas.mjs（画布 XML → 结构）

**Files:**
- Create: `eval/lib/parse-canvas.mjs`
- Create: `eval/lib/parse-canvas.test.mjs`
- Create: `eval/fixtures/sample.xml`（测试 fixture）

**Interfaces:**
- Consumes: `window.ggbApplet.getXML()` 返回的 XML 文本（browser.mjs 抓取）。
- Produces: `parseCanvasXml(xml): CanvasCtx`，即 `{ elements: CanvasElement[], freeVars, corpus }`。`visible` 由 `<showObject bool="false"/>` 判 false，无该标记默认 true；`definition` 取 `<expression exp="...">`；`corpus` = 全部 expression 的 exp + 全部 `<command>` 块的输入表达式（去标签文本）拼接，供 `parametric_ref` 做自由变量引用检测。

- [ ] **Step 1: 写 fixture**

Create `eval/fixtures/sample.xml`：
```xml
<?xml version="1.0"?>
<geogebra format="5.0">
<construction title="" author="">
  <element type="point" label="A">
    <coords x="1" y="2" z="1"/>
    <isIndependent bool="true"/>
  </element>
  <element type="numeric" label="r">
    <slider min="1" max="5" inc="0.1"/>
    <value val="2"/>
  </element>
  <element type="conic" label="c"/>
  <element type="point" label="P">
    <showObject bool="false"/>
  </element>
  <expression label="c" exp="c = Circle((0, 0), r)"/>
  <command name="Circle"><input a0="(0, 0)" a1="r"/><output a0="c"/></command>
</construction>
</geogebra>
```

- [ ] **Step 2: 写失败测试**

Create `eval/lib/parse-canvas.test.mjs`：
```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCanvasXml } from './parse-canvas.mjs';

const xml = readFileSync(new URL('../fixtures/sample.xml', import.meta.url), 'utf8');

describe('parseCanvasXml', () => {
  const r = parseCanvasXml(xml);

  it('elements 带 label/type/visible/definition', () => {
    const c = r.elements.find((e) => e.label === 'c');
    expect(c?.type).toBe('conic');
    expect(c?.definition).toContain('Circle');
    expect(r.elements.find((e) => e.label === 'A')?.visible).toBe(true);
    expect(r.elements.find((e) => e.label === 'P')?.visible).toBe(false);
  });

  it('freeVars: slider r + 独立点 A', () => {
    expect(r.freeVars.find((v) => v.name === 'r')?.type).toBe('slider');
    expect(r.freeVars.find((v) => v.name === 'A')?.type).toBe('point');
    expect(r.freeVars.find((v) => v.name === 'P')).toBeUndefined();   // showObject=false 的非独立点不在此例, 独立性才是判据
  });

  it('corpus 含 expression 与 command 输入, 可检出对自由变量 r 的引用', () => {
    expect(r.corpus).toContain('Circle((0, 0), r)');
    expect(/\br\b/.test(r.corpus)).toBe(true);
  });

  it('空/坏 xml 不抛异常', () => {
    expect(() => parseCanvasXml('')).not.toThrow();
    expect(parseCanvasXml('').elements).toEqual([]);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm eval:unit`
Expected: FAIL（module not found）。

- [ ] **Step 4: 实现 parse-canvas.mjs**

Create `eval/lib/parse-canvas.mjs`：
```js
// GeoGebra 画布 XML → CanvasCtx。结构规整, 正则提取足够(GeoGebra XML 无嵌套 element)。
// .ggb zip 解析是 v2(社区材料)的事, v1 只吃 getXML() 文本。

function attr(head, name) {
  const m = head.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

export function parseCanvasXml(xml) {
  const elements = [];
  const freeVars = [];
  const exps = [];
  const cmdBlocks = [];
  if (typeof xml !== 'string' || !xml) return { elements, freeVars, corpus: '' };

  let m;
  // body 用 tempered 模式(不得跨越下一个 <element 开标签): 否则自闭合标签的 '/' 落进 head,
  // 惰性 body 会一直吃到后面某个成对元素的 </element>, 把那个元素整个吞掉
  const elemRe = /<element\s+([^>]*?)>((?:(?!<element\b)[\s\S])*?)<\/element>/g;
  while ((m = elemRe.exec(xml)) !== null) {
    const head = m[1], body = m[2];
    const type = attr(head, 'type');
    const label = attr(head, 'label');
    if (!type || !label) continue;
    const visible = !/<showObject\s+[^>]*bool="false"/.test(body);
    elements.push({ label, type, visible, definition: '' });

    if (type === 'numeric' && /<slider/.test(body)) {
      freeVars.push({ name: label, type: 'slider' });
    }
    if ((type === 'point' || type === 'numeric') && /isIndependent bool="true"/.test(body)) {
      if (!freeVars.some((v) => v.name === label)) freeVars.push({ name: label, type: type === 'point' ? 'point' : 'slider' });
    }
  }

  // 自闭合 <element .../>(无子节点的派生对象, 如被命令创建的圆)——tempered 成对正则不吃这种
  const elemSelfRe = /<element\s+([^>]*?)\/>/g;
  while ((m = elemSelfRe.exec(xml)) !== null) {
    const type = attr(m[1], 'type'), label = attr(m[1], 'label');
    if (!type || !label || elements.some((e) => e.label === label)) continue;
    elements.push({ label, type, visible: true, definition: '' });
  }

  const exprRe = /<expression\s+([^>]*?)\/>/g;
  while ((m = exprRe.exec(xml)) !== null) {
    const label = attr(m[1], 'label');
    const exp = attr(m[1], 'exp') || '';
    exps.push(exp);
    const existing = elements.find((e) => e.label === label);
    if (existing) existing.definition = exp;
    else elements.push({ label, type: 'expression', visible: true, definition: exp });
  }

  const cmdRe = /<command\s+([^>]*?)>([\s\S]*?)<\/command>/g;
  const inRe = /<input\s+([^>]*?)\/>/g;
  while ((m = cmdRe.exec(xml)) !== null) {
    // 只取 <input/> 属性值作依赖语料(<output/> 是 label, 不构成表达式——避免自由变量名撞输出 label 误报)
    let im; const inputs = [];
    while ((im = inRe.exec(m[2])) !== null) inputs.push(...(im[1].match(/"[^"]*"/g) || []).map((s) => s.slice(1, -1)));
    cmdBlocks.push(inputs.join(' '));
  }

  return { elements, freeVars, corpus: [...exps, ...cmdBlocks].join('\n') };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm eval:unit`
Expected: parse-canvas 测试 PASS。

- [ ] **Step 6: Commit**

```bash
git add eval/lib/parse-canvas.mjs eval/lib/parse-canvas.test.mjs eval/fixtures/sample.xml
git commit -m "feat(eval): parse-canvas 画布 XML→elements/freeVars/corpus"
```

---

### Task 4: selector.mjs（%别名% → 真实 label 绑定）

**Files:**
- Create: `eval/lib/selector.mjs`
- Create: `eval/lib/selector.test.mjs`

**Interfaces:**
- Consumes: `CanvasElement[]`（Task 3 产出）。
- Produces: `bindSelectors(elements, select): Record<alias, label> | null`。按 select 声明顺序，把每个别名绑定到**未被占用**的该 type 第一个元素；任一别名无候选 → 返回 `null`。以及 `interpolate(expr, binding): string`，把 `%alias%` 替换为绑定的 label。

- [ ] **Step 1: 写失败测试**

Create `eval/lib/selector.test.mjs`：
```js
import { describe, it, expect } from 'vitest';
import { bindSelectors, interpolate } from './selector.mjs';

const els = [
  { label: 'A', type: 'point', visible: true, definition: '' },
  { label: 'B', type: 'point', visible: true, definition: '' },
  { label: 'c', type: 'conic', visible: true, definition: '' },
  { label: 'l1', type: 'line', visible: true, definition: '' },
  { label: 'l2', type: 'line', visible: true, definition: '' },
];

describe('bindSelectors', () => {
  it('按 type 顺序绑定且不重复占用', () => {
    expect(bindSelectors(els, { P: { type: 'point' }, Q: { type: 'point' } })).toEqual({ P: 'A', Q: 'B' });
    expect(bindSelectors(els, { L: { type: 'line' } })).toEqual({ L: 'l1' });
  });

  it('缺候选返回 null; 空 select 返回 {}', () => {
    expect(bindSelectors(els, { X: { type: 'polygon' } })).toBeNull();
    expect(bindSelectors(els, {})).toEqual({});
  });
});

describe('interpolate', () => {
  it('%alias% 定界替换(不影响同名子串)', () => {
    expect(interpolate('Radius(%c%) + %l1%', { c: 'c1', l1: 't1' })).toBe('Radius(c1) + t1');
    expect(interpolate('ArePerpendicular(%l%, Line(O, A))', { l: 'l9' })).toBe('ArePerpendicular(l9, Line(O, A))');
  });

  it('未声明的 %x% 原样保留(将触发 eval_error 而非静默)', () => {
    expect(interpolate('x(%P%)', {})).toBe('x(%P%)');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm eval:unit` → FAIL（module not found）。

- [ ] **Step 3: 实现 selector.mjs**

Create `eval/lib/selector.mjs`：
```js
// 断言与画布标签解耦: select 按 type 把别名绑到真实 label, expr 里以 %alias% 引用。
// 定界符 %..% 是对旧方案 replaceAll(alias, label) 的修正——后者会把 'l' 替换进 'Radius' 里。
export function bindSelectors(elements, select) {
  const binding = {};
  const used = new Set();
  for (const [alias, spec] of Object.entries(select || {})) {
    const cand = elements.find((e) => e.type === spec.type && !used.has(e.label));
    if (!cand) return null;
    binding[alias] = cand.label;
    used.add(cand.label);
  }
  return binding;
}

export function interpolate(expr, binding) {
  return String(expr).replace(/%([a-zA-Z_]\w*)%/g, (whole, alias) =>
    Object.prototype.hasOwnProperty.call(binding, alias) ? binding[alias] : whole);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm eval:unit` → selector 测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add eval/lib/selector.mjs eval/lib/selector.test.mjs
git commit -m "feat(eval): selector %别名%→label 绑定 + 定界插值"
```

---

### Task 5: templates.mjs（10 断言原语——判分核心）

**Files:**
- Create: `eval/lib/templates.mjs`
- Create: `eval/lib/templates.test.mjs`

**Interfaces:**
- Consumes: `bindSelectors`/`interpolate`（Task 4）；`CanvasCtx`（Task 3）；`appletEval`（browser.mjs 注入，测试 mock）；事件数组（browser.mjs 收集的 `/api/sessions` events，元素形如 `{type:'tool_call', name, round, result}` / `{type:'ggb_exec', ok}` / `{type:'error'}` / `{type:'turn_end', stopped}`，见 lib/logger.ts）。
- Produces: `evaluateAssertion(assertion, ctx: AssertCtx): Promise<AssertionResult>`；`evaluateAll(assertions, ctx): Promise<AssertionResult[]>`（异常兜底为 `run_error`）。

- [ ] **Step 1: 写失败测试**

Create `eval/lib/templates.test.mjs`：
```js
import { describe, it, expect } from 'vitest';
import { evaluateAll, evaluateAssertion } from './templates.mjs';

const canvas = {
  elements: [
    { label: 'A', type: 'point', visible: true, definition: '' },
    { label: 'c', type: 'conic', visible: true, definition: 'c = Circle((0, 0), r)' },
    { label: 'l', type: 'line', visible: true, definition: '' },
    { label: 'p', type: 'polygon', visible: true, definition: '' },
    { label: 'P', type: 'point', visible: false, definition: '' },
    { label: 'f', type: 'function', visible: true, definition: 'f(x) = k x' },
  ],
  freeVars: [{ name: 'r', type: 'slider' }],
  corpus: 'c = Circle((0, 0), r)\nf(x) = k x',
};

const goodEvents = [
  { type: 'tool_call', name: 'search_command', round: 1 },
  { type: 'tool_call', name: 'verify_geometry', round: 2 },
  { type: 'tool_call', name: 'verify_geometry', round: 3 },
  { type: 'tool_call', name: 'inspect_render', round: 4, result: { ok: true, passed: true, issues: [] } },
  { type: 'turn_end', stopped: false },
];

const appletEvalOk = async (expr) => {
  if (expr === 'Radius(c)') return { ok: true, value: '3', numeric: 3 };
  if (expr === 'x(A)') return { ok: true, value: '6', numeric: 6 };
  if (expr === 'ArePerpendicular(c, l)') return { ok: true, value: 'true' };
  if (expr === 'Perimeter(p)') return { ok: true, value: '11.9', numeric: 11.9 };
  return { ok: false, value: '?', numeric: undefined };
};

const ctx = { canvas, events: goodEvents, appletEval: appletEvalOk };

describe('画布断言', () => {
  it('object_exists 数 type', async () => {
    const r = await evaluateAll([
      { kind: 'object_exists', type: 'conic' },
      { kind: 'object_exists', type: 'segment' },
    ], ctx);
    expect(r[0].passed).toBe(true);
    expect(r[1]).toMatchObject({ passed: false, failureClass: 'object_missing' });
  });

  it('measure_eq 容差比较 + 别名插值', async () => {
    const r = await evaluateAssertion(
      { kind: 'measure_eq', select: { c: { type: 'conic' } }, expr: 'Radius(%c%)', expect: 3, tol: 0.001 }, ctx);
    expect(r.passed).toBe(true);
    const bad = await evaluateAssertion(
      { kind: 'measure_eq', select: { c: { type: 'conic' } }, expr: 'Radius(%c%)', expect: 5 }, ctx);
    expect(bad).toMatchObject({ passed: false, failureClass: 'measure_mismatch' });
  });

  it('measure_eq 超容差 0.01 默认: 11.9 vs 12 判败, vs 11.905 判过', async () => {
    const near = await evaluateAssertion(
      { kind: 'measure_eq', select: { p: { type: 'polygon' } }, expr: 'Perimeter(%p%)', expect: 11.905 }, ctx);
    expect(near.passed).toBe(true);
    const far = await evaluateAssertion(
      { kind: 'measure_eq', select: { p: { type: 'polygon' } }, expr: 'Perimeter(%p%)', expect: 12 }, ctx);
    expect(far.passed).toBe(false);
  });

  it('measure_range 区间判定', async () => {
    const r = await evaluateAssertion(
      { kind: 'measure_range', select: { c: { type: 'conic' } }, expr: 'Radius(%c%)', min: 1, max: 5 }, ctx);
    expect(r.passed).toBe(true);
  });

  it('measure_range 区间外失败; 端点包含', async () => {
    const out = await evaluateAssertion(
      { kind: 'measure_range', select: { c: { type: 'conic' } }, expr: 'Radius(%c%)', min: 5, max: 9 }, ctx);
    expect(out).toMatchObject({ passed: false, failureClass: 'measure_mismatch' });
    const edge = await evaluateAssertion(
      { kind: 'measure_range', select: { c: { type: 'conic' } }, expr: 'Radius(%c%)', min: 3, max: 9 }, ctx);
    expect(edge.passed).toBe(true);   // x >= min: 端点 3 包含在内
  });

  it('numeric=NaN/Infinity 归为 eval_error 而非 measure_mismatch', async () => {
    const nanCtx = { ...ctx, appletEval: async () => ({ ok: true, value: 'NaN', numeric: NaN }) };
    const r = await evaluateAssertion(
      { kind: 'measure_eq', select: { c: { type: 'conic' } }, expr: 'Radius(%c%)', expect: 3 }, nanCtx);
    expect(r).toMatchObject({ passed: false, failureClass: 'eval_error' });
    const infCtx = { ...ctx, appletEval: async () => ({ ok: true, value: 'Infinity', numeric: Infinity }) };
    const r2 = await evaluateAssertion(
      { kind: 'measure_eq', select: { c: { type: 'conic' } }, expr: 'Radius(%c%)', expect: 3 }, infCtx);
    expect(r2).toMatchObject({ passed: false, failureClass: 'eval_error' });
  });

  it('relation_bool 解析 true/false', async () => {
    const t = await evaluateAssertion(
      { kind: 'relation_bool', select: { a: { type: 'conic' }, b: { type: 'line' } }, expr: 'ArePerpendicular(%a%, %b%)' }, ctx);
    expect(t.passed).toBe(true);
    const f = await evaluateAssertion(
      { kind: 'relation_bool', select: { a: { type: 'conic' }, b: { type: 'line' } }, expr: 'ArePerpendicular(%a%, %b%)', expect: false }, ctx);
    expect(f).toMatchObject({ passed: false, failureClass: 'relation_false' });
  });

  it('选择器无候选 → selector_unmatched; 求值失败 → eval_error', async () => {
    const r = await evaluateAssertion(
      { kind: 'measure_eq', select: { z: { type: 'segment' } }, expr: 'Length(%z%)', expect: 1 }, ctx);
    expect(r).toMatchObject({ passed: false, failureClass: 'selector_unmatched' });
    const bad = await evaluateAssertion(
      { kind: 'measure_eq', select: { P: { type: 'point' } }, expr: 'Area(%P%)', expect: 1 }, ctx);
    expect(bad).toMatchObject({ passed: false, failureClass: 'eval_error' });
  });

  it('slider_exists / parametric_ref / label_visible', async () => {
    expect((await evaluateAssertion({ kind: 'slider_exists' }, ctx)).passed).toBe(true);
    expect((await evaluateAssertion({ kind: 'parametric_ref' }, ctx)).passed).toBe(true);
    // 2 个 point 里 1 个 visible=false → 可见数 1 ≥ 默认 min_visible=1 → 通过; 抬到 2 → 失败
    expect((await evaluateAssertion({ kind: 'label_visible', type: 'point' }, ctx)).passed).toBe(true);
    expect((await evaluateAssertion({ kind: 'label_visible', type: 'point', min_visible: 2 }, ctx)).passed).toBe(false);
  });

  it('slider_exists / parametric_ref 的失败路径', async () => {
    const noSlider = { canvas: { elements: [], freeVars: [], corpus: '' }, events: [], appletEval: ctx.appletEval };
    expect(await evaluateAssertion({ kind: 'slider_exists' }, noSlider))
      .toMatchObject({ passed: false, failureClass: 'slider_missing' });
    // 有自由变量但 corpus 不引用 → 非参数化
    const unref = {
      canvas: { elements: [{ label: 'r', type: 'numeric', visible: true, definition: '' }],
                freeVars: [{ name: 'r', type: 'slider' }], corpus: 'x + 1' },
      events: [], appletEval: ctx.appletEval,
    };
    expect(await evaluateAssertion({ kind: 'parametric_ref' }, unref))
      .toMatchObject({ passed: false, failureClass: 'parametric_fail' });
  });
});

describe('过程断言', () => {
  it('visual_inspect_ok: 最后一次 inspect_render passed', async () => {
    expect((await evaluateAssertion({ kind: 'visual_inspect_ok' }, ctx)).passed).toBe(true);
    const badCtx = { ...ctx, events: [
      { type: 'tool_call', name: 'inspect_render', round: 1, result: { ok: true, passed: false, issues: ['x'] } },
      { type: 'turn_end', stopped: false },
    ] };
    const r = await evaluateAssertion({ kind: 'visual_inspect_ok' }, badCtx);
    expect(r).toMatchObject({ passed: false, failureClass: 'visual_fail' });
    const noneCtx = { ...ctx, events: [{ type: 'turn_end', stopped: false }] };
    expect((await evaluateAssertion({ kind: 'visual_inspect_ok' }, noneCtx)).passed).toBe(false);
  });

  it('process_no_error: turn_end 未中止且无 error 事件', async () => {
    expect((await evaluateAssertion({ kind: 'process_no_error' }, ctx)).passed).toBe(true);
    const stopped = { ...ctx, events: [{ type: 'turn_end', stopped: true }] };
    expect((await evaluateAssertion({ kind: 'process_no_error' }, stopped)).passed).toBe(false);
    const errored = { ...ctx, events: [...goodEvents, { type: 'error', where: 'x' }] };
    expect((await evaluateAssertion({ kind: 'process_no_error' }, errored)).passed).toBe(false);
  });

  it('process_budget: verify/render 计数(verify_geometry=2 ≤ 3, inspect_render=1 ≤ 2)', async () => {
    expect((await evaluateAssertion({ kind: 'process_budget' }, ctx)).passed).toBe(true);
    const over = { ...ctx, events: [
      ...[1, 2, 3, 4].map((round) => ({ type: 'tool_call', name: 'verify_geometry', round })),
      { type: 'turn_end', stopped: false },
    ] };
    const r = await evaluateAssertion({ kind: 'process_budget' }, over);
    expect(r).toMatchObject({ passed: false, failureClass: 'budget_exceeded' });
  });

  it('process_budget: render 溢出(3 > 2)也判败', async () => {
    const overRender = { ...ctx, events: [
      ...[1, 2, 3].map((round) => ({ type: 'tool_call', name: 'inspect_render', round, result: { ok: true, passed: true, issues: [] } })),
      { type: 'turn_end', stopped: false },
    ] };
    const r = await evaluateAssertion({ kind: 'process_budget' }, overRender);
    expect(r).toMatchObject({ passed: false, failureClass: 'budget_exceeded' });
  });

  it('evaluateAll 异常兜底为 run_error', async () => {
    const boom = { ...ctx, appletEval: async () => { throw new Error('boom'); } };
    const r = await evaluateAll([{ kind: 'measure_eq', select: { c: { type: 'conic' } }, expr: 'Radius(%c%)', expect: 3 }], boom);
    expect(r[0]).toMatchObject({ passed: false, failureClass: 'run_error' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm eval:unit` → FAIL（module not found）。

- [ ] **Step 3: 实现 templates.mjs**

Create `eval/lib/templates.mjs`：
```js
// 10 个确定性断言原语(规格 §3.1②)。求值三源: canvas(结构) / events(过程轨迹) / appletEval(数值)。
// 评判零 LLM: appletEval 是在画布内核上临时建对象求值, 不是模型。
import { bindSelectors, interpolate } from './selector.mjs';

function result(a, passed, failureClass, detail) {
  return { kind: a.kind, name: a.expr || a.type || a.kind, passed, failureClass: passed ? null : failureClass, detail };
}

function num(v) {
  // NaN 与 ±Infinity 都不是有效度量(NaN 本身是 number 类型; 1/0、垂直斜率等产生 Infinity)——一律 undefined → eval_error
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
  return undefined;
}

// events 助手: 过滤/计数
const toolCalls = (events) => (events || []).filter((e) => e.type === 'tool_call' && e.name);
const byName = (events, name) => toolCalls(events).filter((e) => e.name === name);

export async function evaluateAssertion(a, ctx) {
  const { canvas, events, appletEval } = ctx;

  switch (a.kind) {
    case 'object_exists': {
      const cnt = canvas.elements.filter((e) => e.type === a.type).length;
      const min = a.min ?? 1;
      const passed = cnt >= min;
      return result(a, passed, 'object_missing', `${a.type}×${cnt} < ${min}`);
    }

    case 'label_visible': {
      const cnt = canvas.elements.filter((e) => e.type === a.type && e.visible).length;
      const min = a.min_visible ?? 1;
      const passed = cnt >= min;
      return result(a, passed, 'label_hidden', `可见 ${a.type}×${cnt} < ${min}`);
    }

    case 'slider_exists': {
      const cnt = canvas.freeVars.filter((v) => v.type === 'slider').length;
      const passed = cnt >= (a.min ?? 1);
      return result(a, passed, 'slider_missing', `slider×${cnt}`);
    }

    case 'parametric_ref': {
      // 自由变量被派生对象的定义/命令输入引用(corpus) → 画布是"参数化"的而非静态硬编码
      const free = canvas.freeVars.map((v) => v.name);
      const hit = free.filter((n) => new RegExp(`\\b${n}\\b`).test(canvas.corpus));
      const passed = free.length > 0 && hit.length > 0;
      return result(a, passed, 'parametric_fail', `自由变量 [${free.join(',')}] 引用: [${hit.join(',')}]`);
    }

    case 'measure_eq':
    case 'measure_range':
    case 'relation_bool': {
      const binding = bindSelectors(canvas.elements, a.select);
      if (!binding) return result(a, false, 'selector_unmatched', `select 无候选: ${JSON.stringify(a.select)}`);
      const expr = interpolate(a.expr, binding);
      // appletEval 返回 {ok:false} = 几何求值失败(eval_error); 抛异常 = 基础设施故障, 上抛给 evaluateAll 兜底为 run_error
      const v = await appletEval(expr);
      if (!v?.ok) return result(a, false, 'eval_error', `${expr} → ${v?.value ?? '?'}`);

      if (a.kind === 'relation_bool') {
        const want = a.expect ?? true;
        const got = v.value === 'true' ? true : v.value === 'false' ? false : num(v.numeric) === 1;
        const passed = got === want;
        return result(a, passed, 'relation_false', `${expr} → ${v.value}`);
      }
      const x = num(v.numeric ?? v.value);
      if (x === undefined) return result(a, false, 'eval_error', `${expr} → 非数值 ${v.value}`);
      if (a.kind === 'measure_eq') {
        const tol = a.tol ?? 0.01;
        const passed = Math.abs(x - a.expect) <= tol;
        return result(a, passed, 'measure_mismatch', `${expr} → ${x}, 期望 ${a.expect}±${tol}`);
      }
      const passed = x >= a.min && x <= a.max;
      return result(a, passed, 'measure_mismatch', `${expr} → ${x}, 区间 [${a.min}, ${a.max}]`);
    }

    case 'visual_inspect_ok': {
      // 最后一次 inspect_render 的结论(结构化 issues 空即通过)——被评系统自己的视觉工具, 非外部 LLM judge
      const insp = byName(events, 'inspect_render').filter((e) => e.result?.ok).pop();
      if (!insp) return result(a, false, 'visual_fail', 'inspect_render 未被调用或未成功');
      const passed = insp.result.passed === true;
      return result(a, passed, 'visual_fail', passed ? 'issues 空' : `issues: ${(insp.result.issues || []).join('; ').slice(0, 120)}`);
    }

    case 'process_no_error': {
      const turnEnd = (events || []).filter((e) => e.type === 'turn_end').pop();
      const errors = (events || []).filter((e) => e.type === 'error').length;
      const reasons = [];
      if (!turnEnd) reasons.push('无 turn_end(未正常完成)');
      if (turnEnd?.stopped) reasons.push('被中止');
      if (errors > 0) reasons.push(`error 事件 ×${errors}`);
      const passed = reasons.length === 0;
      return result(a, passed, 'process_error', reasons.join('; ') || '正常完成');
    }

    case 'process_budget': {
      const v = byName(events, 'verify_geometry').length;
      const r = byName(events, 'inspect_render').length;
      const vm = a.verify_max ?? 3, rm = a.render_max ?? 2;
      const over = [];
      if (v > vm) over.push(`verify ${v}>${vm}`);
      if (r > rm) over.push(`render ${r}>${rm}`);
      const passed = over.length === 0;
      return result(a, passed, 'budget_exceeded', `verify=${v}/${vm} render=${r}/${rm}${over.length ? ' 超限: ' + over.join(',') : ''}`);
    }

    default:
      return result(a, false, 'run_error', `未知 kind: ${a.kind}`);
  }
}

export async function evaluateAll(assertions, ctx) {
  const out = [];
  for (const a of assertions || []) {
    try { out.push(await evaluateAssertion(a, ctx)); }
    catch (e) { out.push({ kind: a?.kind || '?', name: a?.expr || '?', passed: false, failureClass: 'run_error', detail: String(e?.message || e) }); }
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm eval:unit`
Expected: templates 全部 PASS（含 `label_visible` 的 min_visible=1/2 两档语义）。

- [ ] **Step 5: Commit**

```bash
git add eval/lib/templates.mjs eval/lib/templates.test.mjs
git commit -m "feat(eval): 10 个确定性断言原语(存在/度量/关系/滑块/参数化/视觉结论/可见/过程/预算)"
```

---

### Task 6: aggregate.mjs（多数决 + 分桶 + 失败分布 + 矩阵）

**Files:**
- Create: `eval/lib/aggregate.mjs`
- Create: `eval/lib/aggregate.test.mjs`

**Interfaces:**
- Consumes: `SampleResult[]`（runner 产出）。
- Produces:
  - `buildCaseResult(c, samples): CaseResult`（`passVotes` = `sample.ok && assertions 全 passed` 的采样数；`majorityPassed` = `passVotes > samples.length / 2`）。
  - `aggregate(cases: CaseResult[]): { buckets, assertionStats, failureDist, overall }`：
    - `buckets`: `{ [category]: { total, passed, rate } }`（majority 层）
    - `assertionStats`: `{ [kind]: { pass, total } }`（断言级全量，仅统计 `sample.ok` 的采样）
    - `failureDist`: `{ [failureClass]: count }`（全部失败断言 + run_error 样本）
    - `overall`: `{ total, passed, rate }`
  - `variantMatrix(cur: EvalResults, base: EvalResults): { rows: [{category, base, cur, delta}] }`（bucket rate 差，单位 pp）。

- [ ] **Step 1: 写失败测试**

Create `eval/lib/aggregate.test.mjs`：
```js
import { describe, it, expect } from 'vitest';
import { buildCaseResult, aggregate, variantMatrix } from './aggregate.mjs';

const s = (ok, kindResults) => ({ ok, assertions: kindResults.map(([kind, passed, failureClass]) => ({ kind, name: kind, passed, failureClass: passed ? null : failureClass, detail: '' })) });

describe('buildCaseResult', () => {
  it('passVotes = 全断言通过的采样数; 2/3 多数决', () => {
    const pass = s(true, [['object_exists', true]]);
    const fail = s(true, [['object_exists', false, 'object_missing']]);
    const r = buildCaseResult({ id: 'a', category: 'basics' }, [pass, fail, pass]);
    expect(r.passVotes).toBe(2);
    expect(r.majorityPassed).toBe(true);
  });

  it('run_error 采样(ok=false)不计 passVotes', () => {
    const r = buildCaseResult({ id: 'b', category: 'basics' }, [{ ok: false, error: 'x', assertions: [], stats: null }]);
    expect(r.passVotes).toBe(0);
    expect(r.majorityPassed).toBe(false);
  });
});

describe('aggregate', () => {
  it('分桶 + 断言级 + 失败分布 + 总览', () => {
    const cases = [
      { id: 'a', category: 'basics', passVotes: 2, majorityPassed: true, samples: [s(true, [['object_exists', true], ['measure_eq', false, 'measure_mismatch']]), s(true, [['object_exists', true], ['measure_eq', true]]), s(true, [['object_exists', true], ['measure_eq', true]])] },
      { id: 'b', category: 'traps', passVotes: 0, majorityPassed: false, samples: [s(true, [['process_no_error', false, 'process_error']]), { ok: false, error: 'crash', assertions: [], stats: null }, s(true, [['process_budget', true]])] },
    ];
    const r = aggregate(cases);
    expect(r.buckets.basics).toEqual({ total: 1, passed: 1, rate: 1 });
    expect(r.buckets.traps).toEqual({ total: 1, passed: 0, rate: 0 });
    expect(r.assertionStats.object_exists).toEqual({ pass: 3, total: 3 });
    expect(r.failureDist).toMatchObject({ measure_mismatch: 1, process_error: 1, run_error: 1 });
    expect(r.overall).toEqual({ total: 2, passed: 1, rate: 0.5 });
  });
});

describe('variantMatrix', () => {
  it('桶级 rate 差(pp)', () => {
    const mk = (rate) => ({ buckets: { basics: { rate }, traps: { rate: 1 } } });
    const m = variantMatrix(mk(0.8), mk(0.5));
    const basics = m.rows.find((r) => r.category === 'basics');
    expect(basics).toEqual({ category: 'basics', base: 0.5, cur: 0.8, delta: 30 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm eval:unit` → FAIL（module not found）。

- [ ] **Step 3: 实现 aggregate.mjs**

Create `eval/lib/aggregate.mjs`：
```js
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm eval:unit` → aggregate 测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add eval/lib/aggregate.mjs eval/lib/aggregate.test.mjs
git commit -m "feat(eval): 多数决聚合 + 5 桶统计 + 失败分类分布 + variant×category 矩阵"
```

---

### Task 7: report.mjs（results.json + 分桶 markdown 报告）

**Files:**
- Create: `eval/lib/report.mjs`
- Create: `eval/lib/report.test.mjs`

**Interfaces:**
- Consumes: `EvalResults`（run.mjs 组装：`{variant, date, cases, buckets, assertionStats, failureDist, overall}`，variant 含 `{name, prompt_version, model, temperature, max_tool_rounds, runs_per_case}`）。
- Produces:
  - `renderMarkdown(results, { matrix }?): string`（含变体配置/总览/分桶表/断言统计/失败分布/边界信号/失败明细/**覆盖边界声明**）
  - `writeResults(results, reportsDir): { resultsPath, mdPath }`（写 `<runId>.results.json` + `<runId>.md`；runId = `日期-variant名`）

- [ ] **Step 1: 写失败测试**

Create `eval/lib/report.test.mjs`：
```js
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './report.mjs';

const results = {
  variant: { name: 'deepseek-v2', prompt_version: 'v2', model: 'deepseek-chat', temperature: 0.2, max_tool_rounds: 30, runs_per_case: 3 },
  date: '2026-08-18T10:00:00.000Z',
  overall: { total: 2, passed: 1, rate: 0.5 },
  buckets: {
    basics: { total: 1, passed: 1, rate: 1 },
    functions: { total: 1, passed: 0, rate: 0 },
    dynamic: { total: 0, passed: 0, rate: 0 },
    multi: { total: 0, passed: 0, rate: 0 },
    traps: { total: 0, passed: 0, rate: 0 },
  },
  assertionStats: { object_exists: { pass: 3, total: 3 }, measure_eq: { pass: 2, total: 3 } },
  failureDist: { measure_mismatch: 1 },
  cases: [
    { id: 'a', category: 'basics', passVotes: 2, majorityPassed: true,
      samples: [{ ok: true, assertions: [{ kind: 'measure_eq', name: 'Radius(%c%)', passed: false, failureClass: 'measure_mismatch', detail: '→ 3.5' }], stats: null }] },
    { id: 'b', category: 'functions', passVotes: 1, majorityPassed: false,
      samples: [{ ok: true, assertions: [{ kind: 'object_exists', name: 'function', passed: false, failureClass: 'object_missing', detail: 'function×0' }], stats: null }] },
  ],
};

describe('renderMarkdown', () => {
  const md = renderMarkdown(results);
  it('含变体配置(温度入报告)、分桶表、断言统计、失败分布', () => {
    expect(md).toContain('temperature: **0.2**');
    expect(md).toContain('| basics');
    expect(md).toContain('measure_eq');
    expect(md).toContain('measure_mismatch');
  });
  it('含边界信号段(1 次通过的 b)与覆盖边界声明', () => {
    expect(md).toContain('边界信号');
    expect(md).toMatch(/这 10 条证明了什么|覆盖边界/);
  });
  it('matrix 段仅在有矩阵时出现', () => {
    expect(md).not.toContain('variant × category');
    const withMatrix = renderMarkdown(results, { matrix: { rows: [{ category: 'basics', base: 0.5, cur: 1, delta: 50 }] } });
    expect(withMatrix).toContain('variant × category');
    expect(withMatrix).toContain('+50pp');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm eval:unit` → FAIL（module not found）。

- [ ] **Step 3: 实现 report.mjs**

Create `eval/lib/report.mjs`：
```js
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

  L.push('## 边界信号（3 次中有 1–2 次通过：不稳定而非全坏）', '');
  const edge = cases.filter((c) => c.passVotes > 0 && !c.majorityPassed);
  L.push(edge.length ? edge.map((c) => `- \`${c.id}\`: ${c.passVotes}/3`).join('\n') : '- （无）');
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
  L.push('- 本报告只证明：这 10 条用例（每桶 2 条）在该 variant 配置下的多数决成功率与失败分类。');
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm eval:unit` → report 测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add eval/lib/report.mjs eval/lib/report.test.mjs
git commit -m "feat(eval): 分桶 markdown 报告 + results.json(温度入报告/边界信号/覆盖边界声明)"
```

---

### Task 8: browser.mjs（Playwright 页面装配：注入/拦截/喂题/等完成/抓画布/appletEval）

**Files:**
- Create: `eval/lib/browser.mjs`

**Interfaces:**
- Consumes: variant 解析后的 `{promptVersion, temperature, maxToolRounds, llm: {api_key, base_url, model_name}, vision: {...}, embedding: {...}}`（scripts/run.mjs 从 env 解析后传入，**这里只见值不见 env 名**）；prompts 文本（`eval/scripts/run.mjs` 用 `fs.readFileSync('prompts/<v>.md')` 读后传入）。
- Produces:
  - `openPage(browser, { baseUrl, promptVersion, promptText, variant }): Promise<{ page, events: object[] }>`——装配全部拦截与注入。
  - `feedAndWait(page, prompt, { timeoutMs }): Promise<'done'|'timeout'>`——DOM 喂题 + 等 `button.send-btn.stop` 消失 + 等轨迹 `turn_end`（≤5s 排水）。
  - `captureCanvas(page): Promise<string>`——`window.ggbApplet.getXML()`。
  - `makeAppletEval(page): (expr) => Promise<{ok, value, numeric?}>`——临时对象求值（复用 lib/ggb.ts measure 的套路：`ggbTmpEval = (expr)` → getValueString/getValue → 删除）。

- [ ] **Step 1: 实现 browser.mjs**

Create `eval/lib/browser.mjs`：
```js
// Playwright 页面装配。所有对 app 的外部干预集中在此:
//   1) addInitScript 注入 BYOK localStorage(zustand persist key 'ggb-fable-config', 与 lib/config-store.ts 对齐)
//   2) 拦截 /api/config/prompt-text → 强制 prompt 版本(匿名 401 也不影响)
//   3) 拦截 /api/sessions → 隔离服务端 + 收集轨迹事件(action:'append' 的 body.events, 与 lib/logger.ts 对齐)
//   4) 喂题(textarea + button.send-btn), 等完成(button.send-btn.stop 消失)
import { setTimeout as sleep } from 'node:timers/promises';

// 注入的 localStorage 形状 = zustand persist({state, version}); mode='byok' 绕开 trial 配额与登录
export function buildByokPayload({ variant, temperature, maxToolRounds }) {
  return { state: {
    mode: 'byok',
    byokProfiles: [{
      name: 'eval', api_key: variant.llm.api_key, base_url: variant.llm.base_url,
      model_name: variant.llm.model_name, temperature,
    }],
    activeProfileName: 'eval',
    vision: { api_key: variant.vision.api_key, base_url: variant.vision.base_url, model_name: variant.vision.model_name },
    embedding: { api_key: variant.embedding.api_key, base_url: variant.embedding.base_url, model_name: variant.embedding.model_name, dimensions: 1024 },
    maxToolRounds,
  }, version: 0 };
}

export async function openPage(browser, { baseUrl, promptVersion, promptText, variant, temperature, maxToolRounds }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const events = [];

  await page.route('**/api/config/prompt-text', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ version: promptVersion, text: promptText, source: 'preview' }),
  }));

  await page.route('**/api/sessions', async (route) => {
    const req = route.request();
    try {
      if (req.method() === 'POST') {
        const body = JSON.parse(req.postData() || '{}');
        if (Array.isArray(body.events)) events.push(...body.events);   // logger.flush 的轨迹(含 tool_call/ggb_exec/turn_end/error)
      }
    } catch {}
    const body = req.method() === 'GET' && !req.url().includes('?id=')
      ? JSON.stringify({ sessions: [] })       // 会话列表(侧栏): 空列表, loadState ready
      : '{}';
    await route.fulfill({ status: 200, contentType: 'application/json', body });
  });

  await page.addInitScript(
    (payload) => { try { localStorage.setItem('ggb-fable-config', JSON.stringify(payload)); } catch {} },
    buildByokPayload({ variant, temperature, maxToolRounds }),
  );

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#ggb-container', { timeout: 60000 });
  await page.waitForFunction(() => !!(window.ggbApplet && window.ggbApplet.getXML), null, { timeout: 60000 });
  return { page, events };
}

export async function feedAndWait(page, prompt, { timeoutMs = 180000 } = {}) {
  await page.fill('textarea', prompt);
  await page.click('button.send-btn:not(.stop)');
  // 先等回合真正开始(停止键挂载)再轮询结束——首条消息的 setSending(true) 在 await newSession() 之后,
  // 不等的话 t≈0 首轮轮询会把"未开始"误判为"已结束"而瞬间返回 done(空轨迹)。
  // 静默早退的 send 等不到停止键: catch 后落回原失败模式(空事件), 不掩盖问题。
  await page.waitForSelector('button.send-btn.stop', { timeout: 15000 }).catch(() => {});
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const done = await page.evaluate(() => !document.querySelector('button.send-btn.stop'));
    if (done) return 'done';   // stop 消失=send() 收尾; turn_end 排水职责在 drainEvents
    await sleep(500);
  }
  return 'timeout';
}

export async function drainEvents(page, events, { waitMs = 5000 } = {}) {
  // 等 events 里出现 turn_end(或超时)——消化 flush 与 DOM 完成信号之间的竞态
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    if (events.some((e) => e.type === 'turn_end')) return;
    await sleep(300);
  }
}

export async function captureCanvas(page) {
  return page.evaluate(() => window.ggbApplet.getXML());
}

// 临时对象求值: ggbTmpEval = (expr) → 读值 → 删。布尔返回 value 'true'/'false'; 数值返回 numeric。
export function makeAppletEval(page) {
  return async (expr) => page.evaluate(async (e) => {
    const a = window.ggbApplet;
    const tmp = 'ggbTmpEval';
    try { if (a.exists(tmp)) a.deleteObject(tmp); } catch {}
    let labels = '';
    try {
      labels = typeof a.evalCommandGetLabels === 'function'
        ? a.evalCommandGetLabels(`${tmp} = (${e})`)
        : await a.asyncEvalCommandGetLabels(`${tmp} = (${e})`);
    } catch {}
    if (!labels || !String(labels).trim()) return { ok: false, value: '?' };
    const value = a.getValueString(tmp);
    const numeric = a.getValue(tmp);
    try { a.deleteObject(tmp); } catch {}
    if (!value || value === '?' || value === 'NaN' || value === 'undefined') return { ok: false, value: value || '?' };
    return { ok: true, value, numeric };
  }, expr);
}
```

- [ ] **Step 2: 模块可加载验证**

Run: `node -e "import('./eval/lib/browser.mjs').then(() => console.log('ok'))"`
Expected: 输出 `ok`。

- [ ] **Step 3: Commit**

```bash
git add eval/lib/browser.mjs
git commit -m "feat(eval): browser 页面装配(BYOK注入/prompt拦截/轨迹收集/喂题等完成/appletEval)"
```

---

### Task 9: runner.mjs + variants + CLI + 自检 case + 端到端冒烟

**Files:**
- Create: `eval/lib/runner.mjs`
- Create: `eval/variants/deepseek-v2.json`
- Create: `eval/variants/glm-v2.json`
- Create: `eval/scripts/run.mjs`
- Create: `eval/cases/_selftest.json`

**Interfaces:**
- runner.mjs Consumes: `openPage`/`feedAndWait`/`drainEvents`/`captureCanvas`/`makeAppletEval`（Task 8）、`parseCanvasXml`（Task 3）、`evaluateAll`（Task 5）。
- runner.mjs Produces: `runOneCase(browser, case_, opts): Promise<CaseResult>`，`opts = { baseUrl, promptVersion, promptText, variant, temperature, maxToolRounds, runs = 3, timeoutMs = 180000 }`。内部每个采样开新页跑一遍；run_error 采样照记（`{ok:false, error, assertions:[], stats:null}`）。
- run.mjs CLI：`pnpm eval -- --variant eval/variants/deepseek-v2.json [--case id] [--runs 3] [--list] [--out <path>] [--compare <results.json>] [--base-url http://localhost:3000]`。variant JSON 里的 `*_env` 字段在 CLI 解析为 `process.env[...]` 的值；缺任一 env → 打印缺哪些变量名并退出（**不打印值**）。

- [ ] **Step 1: 写 variant 配置（只有 env 变量名，无秘密）**

Create `eval/variants/deepseek-v2.json`：
```json
{
  "name": "deepseek-v2",
  "prompt_version": "v2",
  "temperature": 0.2,
  "max_tool_rounds": 30,
  "runs_per_case": 3,
  "llm": { "api_key_env": "DEEPSEEK_API_KEY", "base_url_env": "DEEPSEEK_BASE_URL", "model_env": "DEEPSEEK_MODEL" },
  "vision": { "api_key_env": "GLM_API_KEY", "base_url_env": "GLM_BASE_URL", "model_env": "GLM_VISION_MODEL" },
  "embedding": { "api_key_env": "GLM_API_KEY", "base_url_env": "GLM_BASE_URL", "model_env": "GLM_EMBEDDING_MODEL" }
}
```

Create `eval/variants/glm-v2.json`：
```json
{
  "name": "glm-v2",
  "prompt_version": "v2",
  "temperature": 0.2,
  "max_tool_rounds": 30,
  "runs_per_case": 3,
  "llm": { "api_key_env": "GLM_API_KEY", "base_url_env": "GLM_BASE_URL", "model_env": "GLM_MODEL" },
  "vision": { "api_key_env": "GLM_API_KEY", "base_url_env": "GLM_BASE_URL", "model_env": "GLM_VISION_MODEL" },
  "embedding": { "api_key_env": "GLM_API_KEY", "base_url_env": "GLM_BASE_URL", "model_env": "GLM_EMBEDDING_MODEL" }
}
```

- [ ] **Step 2: 写自检 case**

Create `eval/cases/_selftest.json`：
```json
{
  "id": "_selftest",
  "prompt": "画二次函数 y = x^2 - 4x + 3 的图像",
  "category": "functions",
  "notes": "管线自检用, 非真实评测数据",
  "assertions": [
    { "kind": "object_exists", "type": "function" },
    { "kind": "measure_eq", "select": { "f": { "type": "function" } }, "expr": "%f%(2)", "expect": -1, "tol": 0.001 }
  ]
}
```

- [ ] **Step 3: 实现 runner.mjs**

Create `eval/lib/runner.mjs`：
```js
// 单 case 编排: 每采样一页(干净会话/画布), 跑完抓画布 + 断言评分, 组装 SampleResult。
import { openPage, feedAndWait, drainEvents, captureCanvas, makeAppletEval } from './browser.mjs';
import { parseCanvasXml } from './parse-canvas.mjs';
import { evaluateAll } from './templates.mjs';
import { buildCaseResult } from './aggregate.mjs';

function statsFromEvents(events) {
  const calls = events.filter((e) => e.type === 'tool_call' && e.name);
  const turnEnd = events.filter((e) => e.type === 'turn_end').pop();
  const insp = calls.filter((e) => e.name === 'inspect_render' && e.result?.ok).pop();
  return {
    rounds: new Set(calls.map((e) => e.round)).size,
    verifyCount: calls.filter((e) => e.name === 'verify_geometry').length,
    renderCount: calls.filter((e) => e.name === 'inspect_render').length,
    failCmds: events.filter((e) => e.type === 'ggb_exec' && e.ok === false).length,
    stopped: !!turnEnd?.stopped,
    errorCount: events.filter((e) => e.type === 'error').length,
    inspectPassed: insp ? insp.result.passed === true : null,
    finalText: String(turnEnd?.finalText || '').slice(0, 200),
  };
}

async function runSample(browser, case_, opts) {
  const { page, events } = await openPage(browser, opts);
  try {
    const feed = await feedAndWait(page, case_.prompt, { timeoutMs: opts.timeoutMs });
    if (feed === 'timeout') {
      await page.click('button.send-btn.stop').catch(() => {});
      await drainEvents(page, events, { waitMs: 2000 });
    } else {
      await drainEvents(page, events);
    }
    const xml = await captureCanvas(page);
    const canvas = parseCanvasXml(xml);
    const assertions = await evaluateAll(case_.assertions, { canvas, events, appletEval: makeAppletEval(page) });
    return { ok: true, timedOut: feed === 'timeout', assertions, stats: statsFromEvents(events) };
  } finally {
    await page.close();
  }
}

export async function runOneCase(browser, case_, opts) {
  const samples = [];
  for (let i = 0; i < opts.runs; i++) {
    try {
      samples.push(await runSample(browser, case_, opts));
    } catch (e) {
      samples.push({ ok: false, error: String(e?.message || e), assertions: [], stats: null });
    }
  }
  return buildCaseResult(case_, samples);
}
```

- [ ] **Step 4: 实现 scripts/run.mjs**

Create `eval/scripts/run.mjs`：
```js
// pnpm eval CLI: --list | (--variant ... [--case id] [--runs n] [--out path] [--compare results.json] [--base-url url])
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
const baseUrl = args['base-url'] || 'http://localhost:3000';
const runs = resolved.runs_per_case;

console.log(`eval: variant=${resolved.name} model=${resolved.model} prompt=${v.prompt_version} temp=${v.temperature} runs=${runs} cases=${cases.length}`);
console.log('（请确保 pnpm dev 已在跑且 .env.local 齐全）');

const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--use-gl=swiftshader'] });
const caseResults = [];
for (const c of cases) {
  process.stdout.write(`  [${c.id}] `);
  const r = await runOneCase(browser, c, {
    baseUrl, promptVersion: v.prompt_version, promptText,
    variant: resolved, temperature: v.temperature, maxToolRounds: v.max_tool_rounds,
    runs, timeoutMs: 180000,
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
```

- [ ] **Step 5: 无浏览器验证**

Run: `pnpm eval -- --list`
Expected: 打印 `_selftest` 用例与断言、总数 1 条（此时 cases/ 只有自检 case）。

Run: `pnpm eval:unit && pnpm build`
Expected: 全绿。

- [ ] **Step 6: 端到端冒烟（需另开终端 `pnpm dev` 等就绪）**

Run:
```bash
pnpm eval -- --case _selftest --runs 1
```
Expected:
- Playwright 起 chromium，跑通 1 条 × 1 次，打印 `[_selftest] 1/1` 或 `0/1`（能否画对不重要，**跑通管线**才重要）。
- `eval/reports/` 生成 `*-deepseek-v2.results.json` + `.md`，md 里能看到断言明细与 stats。

失败排查（按命中频率）：
- `window.ggbApplet` 未就绪 → 确认 chromium args 含 `--use-gl=swiftshader`（软件 WebGL）；重试一次。
- BYOK 未生效（报"请先在设置页配置 BYOK"）→ 检查注入的 localStorage key 必须是 `ggb-fable-config`、形状 `{state:{...}, version:0}`（与 lib/config-store.ts persist 对齐）。
- app 首屏卡在别处 → 看 headless 截图：临时在 run.mjs `chromium.launch` 改 `headless: false` 观察；确认 baseUrl 端口与 dev 一致。
- 断言全 `eval_error` → appletEval 临时对象求值被画布 perspective 拒绝，看 results.json 里 detail 的具体报错。

- [ ] **Step 7: Commit**

```bash
git add eval/lib/runner.mjs eval/scripts/run.mjs eval/variants/ eval/cases/_selftest.json
git commit -m "feat(eval): runner 单case编排 + variant配置(env间接) + CLI + 自检case端到端跑通"
```

---

### Task 10: 10 条用例集（AI 起草断言 → 用户审核）

**Files:**
- Create: `eval/cases/basics-equilateral-triangle.json` 等 10 个文件（内容如下）

**Interfaces:**
- Consumes: Task 2 的 schema（全部文件必须过 `validateCase`）。
- Produces: 10 条定稿用例（每桶 2 条）+ 自检 case 共 11 个文件。**定稿前置条件：用户（领域专家）裁决过断言初稿（规格 §3.1③）——呈现清单并记录用户修正。**

- [ ] **Step 1: 落盘 10 条用例（AI 起草稿）**

Create `eval/cases/basics-equilateral-triangle.json`：
```json
{
  "id": "basics-equilateral-triangle",
  "prompt": "画一个边长为 4 的等边三角形 ABC",
  "category": "basics",
  "notes": "等边 ⇔ 周长 12 且面积 4√3≈6.9282(两度量共同钉死形状)",
  "assertions": [
    { "kind": "object_exists", "type": "polygon" },
    { "kind": "measure_eq", "select": { "p": { "type": "polygon" } }, "expr": "Perimeter(%p%)", "expect": 12, "tol": 0.01 },
    { "kind": "measure_eq", "select": { "p": { "type": "polygon" } }, "expr": "Area(%p%)", "expect": 6.9282, "tol": 0.01 }
  ]
}
```

Create `eval/cases/basics-circle-tangent.json`：
```json
{
  "id": "basics-circle-tangent",
  "prompt": "画一个圆心在原点、半径为 3 的圆，并过点 A(6, 0) 作该圆的一条切线",
  "category": "basics",
  "notes": "切线判定: 圆心到线距离=半径=3, 且线过 A(6,0)——两条度量合起来即相切",
  "assertions": [
    { "kind": "object_exists", "type": "conic" },
    { "kind": "object_exists", "type": "line" },
    { "kind": "measure_eq", "select": { "c": { "type": "conic" } }, "expr": "Radius(%c%)", "expect": 3, "tol": 0.001 },
    { "kind": "measure_eq", "select": { "l": { "type": "line" } }, "expr": "Distance((0, 0), %l%)", "expect": 3, "tol": 0.001 },
    { "kind": "measure_eq", "select": { "l": { "type": "line" } }, "expr": "Distance((6, 0), %l%)", "expect": 0, "tol": 0.001 }
  ]
}
```

Create `eval/cases/func-parabola-vertex.json`：
```json
{
  "id": "func-parabola-vertex",
  "prompt": "画出二次函数 y = x^2 - 4x + 3 的图像，标出顶点，并标出与 x 轴的交点",
  "category": "functions",
  "notes": "三点采样钉死抛物线: f(0)=3, f(2)=-1(顶点), f(5)=8",
  "assertions": [
    { "kind": "object_exists", "type": "function" },
    { "kind": "measure_eq", "select": { "f": { "type": "function" } }, "expr": "%f%(0)", "expect": 3, "tol": 0.001 },
    { "kind": "measure_eq", "select": { "f": { "type": "function" } }, "expr": "%f%(2)", "expect": -1, "tol": 0.001 },
    { "kind": "measure_eq", "select": { "f": { "type": "function" } }, "expr": "%f%(5)", "expect": 8, "tol": 0.001 },
    { "kind": "visual_inspect_ok" }
  ]
}
```

Create `eval/cases/func-two-lines-intersection.json`：
```json
{
  "id": "func-two-lines-intersection",
  "prompt": "在同一坐标系中画出 y = 2x + 1 与 y = -x + 4 的图像，并标出两条直线的交点",
  "category": "functions",
  "notes": "交点 (1,3); P 绑定第一个 point, 若 agent 先画轴上辅助点会误绑——用户审核重点",
  "assertions": [
    { "kind": "object_exists", "type": "function", "min": 2 },
    { "kind": "object_exists", "type": "point" },
    { "kind": "measure_eq", "select": { "P": { "type": "point" } }, "expr": "x(%P%)", "expect": 1, "tol": 0.01 },
    { "kind": "measure_eq", "select": { "P": { "type": "point" } }, "expr": "y(%P%)", "expect": 3, "tol": 0.01 }
  ]
}
```

Create `eval/cases/dyn-slider-circle-radius.json`：
```json
{
  "id": "dyn-slider-circle-radius",
  "prompt": "画一个圆心在原点的圆，它的半径 r 由一个范围 1 到 5 的滑动条控制，初始值取 2",
  "category": "dynamic",
  "notes": "参数化: 半径=滑块表达式而非硬编码; Radius 落在 [1,5]",
  "assertions": [
    { "kind": "slider_exists" },
    { "kind": "object_exists", "type": "conic" },
    { "kind": "measure_range", "select": { "c": { "type": "conic" } }, "expr": "Radius(%c%)", "min": 1, "max": 5 },
    { "kind": "parametric_ref" }
  ]
}
```

Create `eval/cases/dyn-slider-line-slope.json`：
```json
{
  "id": "dyn-slider-line-slope",
  "prompt": "画一次函数 y = kx 的图像，斜率 k 用一个范围 -3 到 3 的滑动条控制",
  "category": "dynamic",
  "notes": "f(1)∈[-3,3] + 定义引用 k",
  "assertions": [
    { "kind": "slider_exists" },
    { "kind": "object_exists", "type": "function" },
    { "kind": "measure_range", "select": { "f": { "type": "function" } }, "expr": "%f%(1)", "min": -3, "max": 3 },
    { "kind": "parametric_ref" }
  ]
}
```

Create `eval/cases/multi-triangle-incenter.json`：
```json
{
  "id": "multi-triangle-incenter",
  "prompt": "画三角形 ABC，三个顶点分别为 A(0,0)、B(6,0)、C(2,5)，作出它的内心，并画出内切圆",
  "category": "multi",
  "notes": "面积=15 钉死三角形; 内切圆半径 r=2·面积/周长=30/(6+√41+√29)≈1.6865",
  "assertions": [
    { "kind": "object_exists", "type": "polygon" },
    { "kind": "object_exists", "type": "conic" },
    { "kind": "object_exists", "type": "point" },
    { "kind": "measure_eq", "select": { "p": { "type": "polygon" } }, "expr": "Area(%p%)", "expect": 15, "tol": 0.01 },
    { "kind": "measure_eq", "select": { "c": { "type": "conic" } }, "expr": "Radius(%c%)", "expect": 1.6865, "tol": 0.01 }
  ]
}
```

Create `eval/cases/multi-inscribed-square.json`：
```json
{
  "id": "multi-inscribed-square",
  "prompt": "画一个半径为 2 的圆，并作出这个圆的内接正方形，标注正方形的边长",
  "category": "multi",
  "notes": "内接正方形: 边长 2√2≈2.8284, 面积 8, 周长 11.3137",
  "assertions": [
    { "kind": "object_exists", "type": "conic" },
    { "kind": "object_exists", "type": "polygon" },
    { "kind": "measure_eq", "select": { "c": { "type": "conic" } }, "expr": "Radius(%c%)", "expect": 2, "tol": 0.001 },
    { "kind": "measure_eq", "select": { "p": { "type": "polygon" } }, "expr": "Area(%p%)", "expect": 8, "tol": 0.01 },
    { "kind": "measure_eq", "select": { "p": { "type": "polygon" } }, "expr": "Perimeter(%p%)", "expect": 11.3137, "tol": 0.01 }
  ]
}
```

Create `eval/cases/trap-hallucinated-command.json`：
```json
{
  "id": "trap-hallucinated-command",
  "prompt": "用 PolylineDraft 命令画一个三角形 ABC，三个顶点任意取",
  "category": "traps",
  "notes": "PolylineDraft 不存在——考察幻觉命令自愈(search_command 归因→改用 Polygon); 断言只看结果与过程",
  "assertions": [
    { "kind": "object_exists", "type": "polygon" },
    { "kind": "process_no_error" },
    { "kind": "process_budget" }
  ]
}
```

Create `eval/cases/trap-budget-unit-circle.json`：
```json
{
  "id": "trap-budget-unit-circle",
  "prompt": "画一个单位圆，分别标出 30°、45°、60° 角的终边与单位圆的交点，并作出每个交点到 x 轴的垂线段",
  "category": "traps",
  "notes": "多对象长链路: 圆+3交点+3垂线段; 交点坐标 (cosθ,sinθ); 预算不超",
  "assertions": [
    { "kind": "object_exists", "type": "conic" },
    { "kind": "object_exists", "type": "point", "min": 3 },
    { "kind": "object_exists", "type": "segment", "min": 3 },
    { "kind": "process_no_error" },
    { "kind": "process_budget" }
  ]
}
```

- [ ] **Step 2: schema 校验 + 列表确认**

Run: `pnpm eval -- --list`
Expected: 11 条（10 + _selftest），每条打印断言；无校验错误。分桶计数：basics 2 / functions 2 / dynamic 2 / multi 2 / traps 2。

Run: `pnpm eval:unit`
Expected: PASS。

- [ ] **Step 3: 呈现给用户裁决（规格 §3.1③，不可跳过）**

向用户呈现 10 条用例的题目 + 断言设计（重点标出 notes 里的审核点：`func-two-lines-intersection` 的 P 绑定风险、`trap-budget-unit-circle` 的垂线段类型是否 `segment`）。记录用户修正并改文件。审核要点清单：
1. 题目是否覆盖"高频 K12 题型"且可判定（规格 §3.1⑧ 可判定性优先）？
2. 度量期望值算得对不对（尤其 multi-triangle-incenter 的 1.6865）？
3. GeoGebra 对象 type 名是否与实际画布一致（跑一条看 results.json 里 elements 的 type，必要时修正——如垂线段可能是 `segment` 或 `line`，抛物线可能是 `function` 或 `curve`）？

- [ ] **Step 4: Commit**

```bash
git add eval/cases/
git commit -m "feat(eval): 10 条用例(每桶2条, AI起草断言经领域专家审核)"
```

---

### Task 11: 基线报告 + 收尾

**Files:**
- Create: `docs/eval-report-v1.md`（CLI `--out` 产出后人工补一段"结论与归因"）
- Modify: `eval/README.md`（补真实工作流）

- [ ] **Step 1: 正式跑基线（10 条 × 3 次）**

前置：`pnpm dev` 在跑。

Run:
```bash
pnpm eval -- --variant eval/variants/deepseek-v2.json --out docs/eval-report-v1.md
```
Expected: 终端逐条打印 `passVotes/3`，最后总成功率；`docs/eval-report-v1.md` 落盘（分桶表 + 断言统计 + 失败分布 + 边界信号 + 失败明细 + 覆盖边界声明）。

耗时参考：每采样约 30–120s（LLM 多轮），10 条 × 3 次 ≈ 25–60 分钟。中断可 `--case <id>` 分批跑（分批时报告也分文件，最后人工合并或重跑一次全量）。

- [ ] **Step 2: 人工补"结论与归因"段**

在 `docs/eval-report-v1.md` 末尾追加（基于失败分布写，≤200 字）：哪个桶最弱、失败集中在哪些 failureClass、下一步归因→修复→复测的攻击点（对接规格任务 3 的迭代循环）。

- [ ] **Step 3: README 收尾**

`eval/README.md` 的用法区替换为已落地命令，并加标准工作流：
```markdown
## 标准工作流
1. `pnpm eval -- --list` 查用例
2. `pnpm dev` 起本地服务
3. `pnpm eval -- --variant eval/variants/deepseek-v2.json --out docs/eval-report-v1.md` 跑基线
4. 改 prompt/工具后重跑，`--compare eval/reports/<基线>.results.json` 出 variant×category 矩阵
5. 扩用例：往 eval/cases/ 加 json（过 validateCase），断言用 10 原语填表
```

- [ ] **Step 4: 全量验证**

Run: `pnpm eval:unit && pnpm build && pnpm test`
Expected: 全绿（eval 单测 + 生产构建 + app 测试无回归）。

- [ ] **Step 5: Commit**

```bash
git add docs/eval-report-v1.md eval/README.md
git commit -m "docs(eval): 基线报告 v1 落盘(10条×3次多数决/分桶/失败归因) + README 工作流"
```

---

## Done Definition（对应规格任务 1 的 10 条阶段）

- [ ] `pnpm eval:unit` 全绿（types/parse-canvas/selector/templates/aggregate/report 六模块 TDD）。
- [ ] `pnpm build` / `pnpm test` 通过，app 侧仅 `lib/ggb.ts` 改 1 行。
- [ ] `pnpm eval -- --case _selftest --runs 1` 端到端跑通（Playwright → 真 LLM → 真画布 → 断言 → 报告）。
- [ ] 10 条用例入库且经用户审核（规格 §3.1③）。
- [ ] `docs/eval-report-v1.md` 落盘：总成功率 + 5 桶分桶 + 断言级统计 + 失败分类分布 + 边界信号 + 覆盖边界声明 + 结论与归因段。
- [ ] 判分环节零 LLM（inspect_render 结论是唯一涉 LLM 项，且它是被评系统自报的结构化输出，规格 §3.1① 允许）。

## 后续（不在本计划）

- 扩 30 条（每桶补齐 5/5/5/8/7；复用 10 原语填表）。
- 裸 LLM 基线对比（规格任务 2：同用例单次调用无工具，四列对比表）。
- 归因→修复→复测迭代（规格任务 3，用 `--compare` 矩阵出提升曲线）。
- 社区 .ggb 断言挖掘（规格 §3.1⑨，v2）。
