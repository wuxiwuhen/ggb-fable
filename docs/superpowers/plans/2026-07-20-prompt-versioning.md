# 提示词版本化 + 管理员热切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把写死在 `lib/agent.ts` 的系统提示词抽成 `public/knowledge/prompts/` 下可版本化的文件,支持本地切版本号 + 管理员"预览(仅自己,跨设备)/发布(全站)"热切换,迁移当天行为零变化。

**Architecture:** 客户端启动调 `/api/config/prompt-version`(edge,服务端解析:全局 active,admin 的 `profiles.prompt_preview_version` 覆盖)拿生效版本号 → fetch 对应 `vN.md` → 注入 `AgentEngine`。admin 在 `/admin` 页 POST `preview`/`publish` 写 `profiles`/`app_config`。回退链保证 endpoint 或文件挂掉时仍用 v1 不崩。

**Tech Stack:** Next.js 15 (App Router, TS) · Supabase (Postgres + SSR auth) · edge API routes · 无测试框架(仅 `pnpm typecheck` + `pnpm build` + 手动端到端 + 一次性 `.mjs` 诊断脚本)。

## Global Constraints

- **无测试框架**:不引入 jest/vitest。验证 = `pnpm typecheck` + `pnpm build` + 手动端到端;纯逻辑用一次性 `.mjs` 脚本断言(跑完删除,不入 git)。
- **分支与提交**:在 `main` 之上切 `feat/prompt-versioning` 执行;每个 Task 结束提交一次;commit message 末尾加 `Co-Authored-By: Claude <noreply@anthropic.com>`。
- **Supabase schema 由用户执行**:Claude 只产出 SQL 文本,用户在自己 Supabase 项目跑(见 CLAUDE.md Plan A,Claude 不碰生产 DB 凭证)。所有 DDL 用 `IF NOT EXISTS` / `ON CONFLICT` 保证可重复执行。
- **迁移零行为变化**:`public/knowledge/prompts/v1.md` 内容 = `lib/agent.ts` 当前 `SYSTEM_PROMPT` **逐字**;`app_config` seed `active="v1"`;迁移当天所有用户拿到的 prompt 与迁移前一致。
- **edge 鉴权**:复用 `lib/supabase.ts` 的 `getUserFromCookie(req)` + `getSupabaseAdmin()`,admin 判定查 `profiles.is_admin`(同 `app/api/admin/insights/route.ts` 的 `requireAdmin` 模式)。
- **单一事实源**:`v1.md` 是 v1 内容唯一源;`agent.ts` 不再持有 prompt 字符串;`app_config` 是 active 唯一源(manifest 不放 status 字段)。

---

## File Structure

**新增:**
- `public/knowledge/prompts/manifest.json` — 版本目录(id/label/description),admin 下拉与服务端校验的唯一来源。
- `public/knowledge/prompts/v1.md` — v1 提示词原文(从 agent.ts 逐字迁出)。
- `lib/prompt-loader.ts` — 解析生效版本 + 拉文件 + 回退链;导出 `DEFAULT_VERSION` / `EMERGENCY_PROMPT` / `getEffectivePrompt` / `resolvePrompt`。
- `app/api/config/prompt-version/route.ts` — 公开 GET,服务端解析生效版本。
- `app/api/admin/prompt-version/route.ts` — admin GET(查)/ POST(preview|publish,写)。

**改动:**
- `lib/agent.ts` — 删 `SYSTEM_PROMPT` 常量;`AgentDeps` 增必填 `systemPrompt`;`run()` 与 `getSystemPrompt()` 改用注入值。
- `components/ChatApp.tsx` — 构造引擎前调 `getEffectivePrompt()`,把 `text` 传入 `AgentEngine`。
- `app/admin/page.tsx` — TABS 加"提示词版本";新增状态/load/动作/渲染块。
- `supabase/schema.sql` — 追加 `app_config` 表 + `profiles.prompt_preview_version` 列 + seed。

**删除:**
- `public/knowledge/prompt.v1.txt` — 过时老版(用户确认无价值)。

---

## Task 1: 迁移提示词到 v1.md + manifest + 删除老文件

**Files:**
- Create: `public/knowledge/prompts/v1.md`
- Create: `public/knowledge/prompts/manifest.json`
- Delete: `public/knowledge/prompt.v1.txt`

**Interfaces:**
- Consumes: `lib/agent.ts` 里 `SYSTEM_PROMPT` 模板字面量(第 45–175 行)的文本内容。
- Produces: `v1.md`(后续 loader 读取)、`manifest.json`(后续 admin UI 与服务端校验读取)。

- [ ] **Step 1: 创建 v1.md(逐字拷贝)**

新建 `public/knowledge/prompts/v1.md`,内容 = `lib/agent.ts` 第 45–175 行 `SYSTEM_PROMPT` 模板字面量的**逐字内容**(去掉首尾的反引号定界符与缩进,保留内部所有 `#`/`-`/`\\` 字符与空行,原样不动)。

> 注意:模板内含转义反斜杠(如 `\\frac`、`\\sqrt`)与 `\\(`、`\\[` 示例,必须原样保留——这些是 prompt 文本的一部分,不是 markdown 转义。

- [ ] **Step 2: 创建 manifest.json**

写入 `public/knowledge/prompts/manifest.json`:

```json
{
  "versions": [
    { "id": "v1", "label": "当前线上版", "description": "从 agent.ts 迁移, 行为零变化" }
  ]
}
```

- [ ] **Step 3: 验证 v1.md 与常量零漂移(去风险闸门)**

Run(在仓库根,临时提取常量内容对比):
```bash
node -e "const fs=require('fs');const s=fs.readFileSync('lib/agent.ts','utf8');const m=s.match(/const SYSTEM_PROMPT = \`([\s\S]*?)\`;$/m);fs.writeFileSync('/tmp/sysprompt.txt', m[1]);"
diff /tmp/sysprompt.txt public/knowledge/prompts/v1.md && echo "ZERO DIFF ✓" || echo "DIFF FOUND ✗"
```
Expected: 输出 `ZERO DIFF ✓`。若有差异,修 v1.md 到完全一致。验完 `rm /tmp/sysprompt.txt`。

- [ ] **Step 4: 删除老文件**

Run: `git rm public/knowledge/prompt.v1.txt`
Expected: 文件从仓库移除。

- [ ] **Step 5: 提交**

```bash
git add public/knowledge/prompts/v1.md public/knowledge/prompts/manifest.json public/knowledge/prompt.v1.txt
git commit -m "feat(prompt): 迁移系统提示词到 public/knowledge/prompts/v1.md + manifest

从 lib/agent.ts 的 SYSTEM_PROMPT 逐字迁出, 行为零变化。删除过时的 prompt.v1.txt。
后续按 manifest 版本号加载, 为版本热切换铺基建。

Co-Authored-By: Claude <noreply@anthropic.com>"
```
Expected: 仅上述 3 个文件入提交。

---

## Task 2: Supabase schema(app_config 表 + profiles 预览列)

**Files:**
- Modify: `supabase/schema.sql`(追加 DDL 到末尾)

**Interfaces:**
- Consumes: 无。
- Produces: `app_config(key, value jsonb)` 表(含 seed `prompt_version.active="v1"`)+ `profiles.prompt_preview_version` 列。后续两个 API route 依赖此 schema。

- [ ] **Step 1: 追加 DDL 到 schema.sql**

在 `supabase/schema.sql` 末尾追加:

```sql

-- ===== 提示词版本化(2026-07-20)=====
-- 全局应用配置 key/value(active 提示词版本等)
CREATE TABLE IF NOT EXISTS app_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
INSERT INTO app_config (key, value) VALUES
  ('prompt_version', '{"active":"v1"}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 管理员预览覆盖(跨设备): null = 走全局 active
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS prompt_preview_version text;
```

- [ ] **Step 2: 用户在 Supabase 项目执行**

> 这是用户侧动作(Plan A:Claude 不碰生产 DB)。告知用户:在 Supabase Dashboard 的 SQL Editor 跑上面那段追加的 DDL(幂等,可重复执行)。确认 `app_config` 有一行 `prompt_version`、`profiles` 多了 `prompt_preview_version` 列。

本地若无 Supabase 连接,此步不阻塞后续 Task(回退链保证 endpoint 读不到表时默认 v1)。但端到端验证(Task 8)需要它。

- [ ] **Step 3: 提交**

```bash
git add supabase/schema.sql
git commit -m "feat(db): app_config 表 + profiles.prompt_preview_version 列

支持提示词版本热切换: app_config 存全局 active, profiles 存 admin 个人预览。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: `lib/prompt-loader.ts`(生效版本解析 + 回退链)

**Files:**
- Create: `lib/prompt-loader.ts`
- Test(scratch, 不提交): `verify-loader.mjs`(仓库根, 跑完删)

**Interfaces:**
- Consumes: `fetch`(浏览器/edge 通用);`/api/config/prompt-version`(Task 5 建,此前回退到 DEFAULT);`/knowledge/prompts/<id>.md`、`/knowledge/prompts/manifest.json`(Task 1 建)。
- Produces:
  - `DEFAULT_VERSION = 'v1'`(常量,Task 5 的 route 也 import)
  - `EMERGENCY_PROMPT`(常量,极小兜底)
  - `getEffectivePrompt(): Promise<{version; text; source}>`(Task 4 的 ChatApp 调用)
  - `resolvePrompt(candidateVersion, candidateText, defaultText)`(纯函数,本任务自验)

- [ ] **Step 1: 写 prompt-loader.ts**

写入 `lib/prompt-loader.ts`:

```ts
// 提示词版本加载器: 按"生效版本"拉对应 .md 注入 AgentEngine
// 生效版本由服务端 /api/config/prompt-version 解析(全局 active; admin 预览覆盖)
// 回退链: endpoint 挂 → DEFAULT_VERSION; 文件 404 → DEFAULT 文件; 再失败 → EMERGENCY_PROMPT

export const DEFAULT_VERSION = 'v1';

// 静态托管全崩时的最后兜底(极小, 保证 agent 仍能跑)
export const EMERGENCY_PROMPT =
  '你是 GeoGebra 画布构造助手, 服务于 K12 数学教学场景。通过工具操作画布, ' +
  '将数学关系转化为动态课件。改画布前先 get_canvas_context 读真实状态; 命令用英文; ' +
  '拖动自由变量时依赖对象自动联动(用 Midpoint/Intersect 等约束命令, 不硬编码坐标)。';

const MANIFEST_URL = '/knowledge/prompts/manifest.json';
const promptUrl = (v: string) => `/knowledge/prompts/${v}.md`;

export interface PromptVersionInfo {
  id: string;
  label: string;
  description?: string;
}
interface Manifest { versions: PromptVersionInfo[] }

const textCache = new Map<string, string>();
let manifestCache: Manifest | null = null;

async function fetchText(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

export async function fetchManifest(): Promise<Manifest> {
  if (manifestCache) return manifestCache;
  const raw = await fetchText(MANIFEST_URL);
  manifestCache = raw ? (JSON.parse(raw) as Manifest) : { versions: [] };
  return manifestCache;
}

export async function loadPromptText(version: string): Promise<string | null> {
  if (textCache.has(version)) return textCache.get(version)!;
  const text = await fetchText(promptUrl(version));
  if (text != null) textCache.set(version, text);
  return text;
}

// 纯函数: 给定候选版本 + 已拉取文本(可能 null), 决策最终结果(便于离线断言)
export interface ResolvedPrompt {
  version: string;
  text: string;
  usedFallback: boolean;
}
export function resolvePrompt(
  candidateVersion: string,
  candidateText: string | null,
  defaultText: string | null,
): ResolvedPrompt {
  if (candidateText != null) {
    return { version: candidateVersion, text: candidateText, usedFallback: false };
  }
  if (defaultText != null) {
    return { version: DEFAULT_VERSION, text: defaultText, usedFallback: true };
  }
  return { version: DEFAULT_VERSION, text: EMERGENCY_PROMPT, usedFallback: true };
}

export interface EffectivePrompt {
  version: string;
  text: string;
  source: 'global' | 'preview' | 'fallback';
}

// 主入口: 服务端解析生效版本 → 拉文件 → 回退链
export async function getEffectivePrompt(): Promise<EffectivePrompt> {
  // 1. 服务端解析生效版本
  let version = DEFAULT_VERSION;
  let source: EffectivePrompt['source'] = 'global';
  try {
    const resp = await fetch('/api/config/prompt-version');
    if (resp.ok) {
      const data = await resp.json();
      if (data?.version) {
        version = String(data.version);
        source = data.source === 'preview' ? 'preview' : 'global';
      }
    }
  } catch {
    /* endpoint 挂 → 保持 DEFAULT_VERSION */
  }

  // 2. 拉文件, 回退链
  const candidateText = await loadPromptText(version);
  const resolved =
    version === DEFAULT_VERSION
      ? resolvePrompt(version, candidateText, null) // 候选即默认, 不二次回退
      : resolvePrompt(version, candidateText, await loadPromptText(DEFAULT_VERSION));

  if (resolved.usedFallback) {
    // 文件层回退发生: 若 endpoint 给的是 preview/global, 降级标记
    if (source !== 'fallback') source = 'fallback';
  }
  return { version: resolved.version, text: resolved.text, source };
}
```

- [ ] **Step 2: 写诊断脚本断言回退决策(离线, 不提交)**

写入仓库根 `verify-loader.mjs`(逐字内联 `resolvePrompt` 的纯逻辑 + 常量,与上面一致):

```js
// 一次性断言: resolvePrompt 的三种决策。不提交, 跑完删。
const DEFAULT_VERSION = 'v1';
const EMERGENCY_PROMPT = 'EMERGENCY';

function resolvePrompt(candidateVersion, candidateText, defaultText) {
  if (candidateText != null) return { version: candidateVersion, text: candidateText, usedFallback: false };
  if (defaultText != null) return { version: DEFAULT_VERSION, text: defaultText, usedFallback: true };
  return { version: DEFAULT_VERSION, text: EMERGENCY_PROMPT, usedFallback: true };
}

const cases = [
  { name: '候选文件存在 → 用候选, 不回退',
    args: ['v2', 'V2 BODY', 'V1 BODY'],
    want: { version: 'v2', text: 'V2 BODY', usedFallback: false } },
  { name: '候选 404, 默认存在 → 回退到默认',
    args: ['vX', null, 'V1 BODY'],
    want: { version: 'v1', text: 'V1 BODY', usedFallback: true } },
  { name: '候选与默认都缺失 → EMERGENCY',
    args: ['vX', null, null],
    want: { version: 'v1', text: EMERGENCY_PROMPT, usedFallback: true } },
];

let fail = 0;
for (const c of cases) {
  const got = resolvePrompt(...c.args);
  const ok = JSON.stringify(got) === JSON.stringify(c.want);
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${c.name}`);
  if (!ok) { console.log('  got:', got, '\n  want:', c.want); fail++; }
}
console.log(fail === 0 ? '\nALL PASS ✓' : `\n${fail} FAILED ✗`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 3: 跑诊断脚本**

Run: `node verify-loader.mjs`
Expected: 输出 `ALL PASS ✓`,exit 0。

- [ ] **Step 4: 类型检查**

Run: `pnpm typecheck`
Expected: 无错误退出。

- [ ] **Step 5: 删除诊断脚本 + 提交**

Run: `rm verify-loader.mjs`
```bash
git add lib/prompt-loader.ts
git commit -m "feat(prompt): lib/prompt-loader 生效版本解析 + 三级回退链

getEffectivePrompt() 服务端解析生效版本 → 拉 vN.md → 失败回退 DEFAULT 文件 → EMERGENCY。
resolvePrompt 纯函数 + 一次性 node 脚本离线断言三种回退决策。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: agent.ts 接受注入的 systemPrompt + ChatApp 接入 loader

**Files:**
- Modify: `lib/agent.ts`(删 `SYSTEM_PROMPT`;改 `AgentDeps` / `run()` / `getSystemPrompt()`)
- Modify: `components/ChatApp.tsx`(import loader;构造引擎前异步取 prompt)

**Interfaces:**
- Consumes: `getEffectivePrompt()` from `lib/prompt-loader`(Task 3)。
- Produces: `AgentEngine` 接受外部 prompt;`AgentDeps.systemPrompt: string` 必填。

- [ ] **Step 1: 改 agent.ts — 删常量**

删除 `lib/agent.ts` 第 45–175 行整段 `const SYSTEM_PROMPT = \`...\`;`(到闭合反引号 + 分号为止,含其上方两行注释 `// 系统提示词...` 如有)。

> 保留第 1–44 行(模块注释、imports、interfaces、`VERIFY_CAP`/`INSPECT_CAP` 常量)与第 176 行起的 `TOOLS`、`GGB_RESERVED`、`extractLabels` 等不变。

- [ ] **Step 2: 改 agent.ts — AgentDeps 增字段**

找到 `interface AgentDeps`(约 29–33 行),把:

```ts
interface AgentDeps {
  ggb: GGB;
  commandSearch: CommandSearch;
  logger: Logger;
}
```
改为:

```ts
interface AgentDeps {
  ggb: GGB;
  commandSearch: CommandSearch;
  logger: Logger;
  systemPrompt: string;   // 由 loader 按生效版本注入; 不再有内置默认
}
```

- [ ] **Step 3: 改 agent.ts — run() 用注入值**

在 `run()` 内(约 452 行),把:

```ts
    const messages: any[] = [
      { role: 'system', content: SYSTEM_PROMPT },
```
改为:

```ts
    const messages: any[] = [
      { role: 'system', content: this.deps.systemPrompt },
```

- [ ] **Step 4: 改 agent.ts — getSystemPrompt() 用注入值**

找到 `getSystemPrompt() { return SYSTEM_PROMPT; }`(约 299 行),改为:

```ts
  getSystemPrompt() { return this.deps.systemPrompt; }
```

- [ ] **Step 5: 改 ChatApp.tsx — import loader**

在 `components/ChatApp.tsx` 顶部 import 区(第 15–16 行附近 import agent 的地方)加一行:

```ts
import { getEffectivePrompt, EMERGENCY_PROMPT } from '@/lib/prompt-loader';
```

- [ ] **Step 6: 改 ChatApp.tsx — 构造引擎前异步取 prompt**

找到构造引擎的 `useEffect`(约 143–162 行,以 `if (!ggbReady || !ggbRef.current) return;` 开头)。把其中构造 `agentRef.current` 的分支(约 159–161 行):

```ts
    if (!agentRef.current) {
      agentRef.current = new AgentEngine({ ggb: ggbRef.current, commandSearch: csRef.current, logger: loggerRef.current });
    }
```
改为(异步取 prompt,带取消守卫):

```ts
    if (!agentRef.current) {
      let cancelled = false;
      getEffectivePrompt().then(({ text }) => {
        if (cancelled || !ggbRef.current || !csRef.current) return;
        agentRef.current = new AgentEngine({
          ggb: ggbRef.current,
          commandSearch: csRef.current,
          logger: loggerRef.current,
          systemPrompt: text,
        });
      }).catch(() => {
        // loader 已有内部回退, 此处理论不会到; 真到则用 EMERGENCY 兜底保证引擎仍可用
        if (cancelled || !ggbRef.current || !csRef.current) return;
        agentRef.current = new AgentEngine({
          ggb: ggbRef.current,
          commandSearch: csRef.current,
          logger: loggerRef.current,
          systemPrompt: EMERGENCY_PROMPT,
        });
      });
      return () => { cancelled = true; };
    }
```

> 注意:引擎构造从同步变异步,存在"prompt 未到、引擎未就绪"的窗口。**必须**确认发送路径在调 `agentRef.current.run(...)` 前有守卫:找到 send 处理函数,若开头没有 `if (!agentRef.current) { setError('画布初始化中,请稍候'); return; }`,则补上(避免对 null 引擎调用)。

- [ ] **Step 7: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 均无错误。若 `agent.ts` 报 `SYSTEM_PROMPT` 未定义残留引用,回到 Step 1 确认整段已删净。

- [ ] **Step 8: 提交**

```bash
git add lib/agent.ts components/ChatApp.tsx
git commit -m "refactor(agent): systemPrompt 改为注入, ChatApp 接入 prompt-loader

删除 agent.ts 内置 SYSTEM_PROMPT 常量(已迁 v1.md); AgentDeps.systemPrompt 必填。
ChatApp 构造引擎前调 getEffectivePrompt() 注入。迁移当天行为零变化(均加载 v1)。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: 公开 endpoint `/api/config/prompt-version`

**Files:**
- Create: `app/api/config/prompt-version/route.ts`

**Interfaces:**
- Consumes: `getUserFromCookie` / `getSupabaseAdmin` from `lib/supabase`;`DEFAULT_VERSION` from `lib/prompt-loader`;`app_config` + `profiles` 表(Task 2)。
- Produces: `GET → 200 { version: string, source: 'global'|'preview' }`。被 `getEffectivePrompt()`(Task 3)消费。

- [ ] **Step 1: 写 route.ts**

写入 `app/api/config/prompt-version/route.ts`:

```ts
// 公开: 解析当前请求者的生效提示词版本
// 全局 active(app_config.prompt_version); 若请求者是 admin 且设了 preview(profiles)则覆盖
import { getUserFromCookie, getSupabaseAdmin } from '@/lib/supabase';
import { DEFAULT_VERSION } from '@/lib/prompt-loader';

export const runtime = 'edge';

function json(status: number, payload: any): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function GET(req: Request) {
  const sb = getSupabaseAdmin();

  // 1. 全局 active
  let active = DEFAULT_VERSION;
  try {
    const { data } = await sb
      .from('app_config')
      .select('value')
      .eq('key', 'prompt_version')
      .maybeSingle();
    if (data?.value?.active) active = String(data.value.active);
  } catch {
    /* 读不到 → 默认 v1 */
  }

  // 2. admin 预览覆盖
  let version = active;
  let source: 'global' | 'preview' = 'global';
  try {
    const user = await getUserFromCookie(req);
    if (user) {
      const { data: prof } = await sb
        .from('profiles')
        .select('is_admin, prompt_preview_version')
        .eq('user_id', user.id)
        .maybeSingle();
      if (prof?.is_admin && prof.prompt_preview_version) {
        version = String(prof.prompt_preview_version);
        source = 'preview';
      }
    }
  } catch {
    /* 身份解析失败 → 全局 */
  }

  return json(200, { version, source });
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 3: 提交**

```bash
git add app/api/config/prompt-version/route.ts
git commit -m "feat(api): GET /api/config/prompt-version 服务端解析生效版本

公开 edge 路由: 读 app_config 全局 active, admin 的 profiles.prompt_preview_version 覆盖。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: admin endpoint `/api/admin/prompt-version`(GET + POST preview/publish)

**Files:**
- Create: `app/api/admin/prompt-version/route.ts`

**Interfaces:**
- Consumes: `getUserFromCookie` / `getSupabaseAdmin`;`app_config` + `profiles` 表;`/knowledge/prompts/manifest.json`(自 origin fetch,校验 version 合法性)。
- Produces:
  - `GET → 200 { active, preview, manifest:{versions[]} }`
  - `POST {action:'preview', version} → 200 {ok, preview}`(写 profiles)
  - `POST {action:'publish', version} → 200 {ok, active, preview:null}`(写 app_config + 清自己 preview)

- [ ] **Step 1: 写 route.ts**

写入 `app/api/admin/prompt-version/route.ts`:

```ts
// 管理员: 查看/切换提示词版本
// GET  → { active, preview, manifest }
// POST { action:"preview"|"publish", version } → 写 profiles 或 app_config
import { getUserFromCookie, getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'edge';

async function requireAdmin(req: Request) {
  const user = await getUserFromCookie(req);
  if (!user) return null;
  const sb = getSupabaseAdmin();
  const { data } = await sb.from('profiles').select('is_admin').eq('user_id', user.id).maybeSingle();
  return data?.is_admin ? user : null;
}

function json(status: number, payload: any): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readManifest(req: Request): Promise<{ versions: Array<{ id: string }> }> {
  try {
    const url = new URL('/knowledge/prompts/manifest.json', req.url);
    const resp = await fetch(url);
    if (!resp.ok) return { versions: [] };
    return await resp.json();
  } catch {
    return { versions: [] };
  }
}

export async function GET(req: Request) {
  const adminUser = await requireAdmin(req);
  if (!adminUser) return json(403, { error: '需要管理员权限' });
  const sb = getSupabaseAdmin();

  let active: string | null = null;
  const { data: cfg } = await sb.from('app_config').select('value').eq('key', 'prompt_version').maybeSingle();
  if (cfg?.value?.active) active = String(cfg.value.active);

  const { data: prof } = await sb
    .from('profiles')
    .select('prompt_preview_version')
    .eq('user_id', adminUser.id)
    .maybeSingle();
  const preview = prof?.prompt_preview_version || null;

  const manifest = await readManifest(req);
  return json(200, { active, preview, manifest });
}

export async function POST(req: Request) {
  const adminUser = await requireAdmin(req);
  if (!adminUser) return json(403, { error: '需要管理员权限' });
  const sb = getSupabaseAdmin();

  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  const version = String(body?.version || '').trim();
  if (!version) return json(400, { error: '缺少 version' });

  // 校验 version 在 manifest 内(防幽灵版本)
  const manifest = await readManifest(req);
  const known = (manifest.versions || []).some((v) => v.id === version);
  if (!known) return json(400, { error: '未知版本: ' + version });

  if (action === 'preview') {
    const { error } = await sb.from('profiles').update({ prompt_preview_version: version }).eq('user_id', adminUser.id);
    if (error) return json(500, { error: '写入失败: ' + error.message });
    return json(200, { ok: true, preview: version });
  }

  if (action === 'publish') {
    const { error: e1 } = await sb
      .from('app_config')
      .update({ value: { active: version }, updated_at: new Date().toISOString() })
      .eq('key', 'prompt_version');
    if (e1) return json(500, { error: '发布失败: ' + e1.message });
    // 发布即对全员含自己生效 → 清掉自己 preview
    await sb.from('profiles').update({ prompt_preview_version: null }).eq('user_id', adminUser.id);
    return json(200, { ok: true, active: version, preview: null });
  }

  return json(400, { error: '未知 action, 支持 preview / publish' });
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 3: 提交**

```bash
git add app/api/admin/prompt-version/route.ts
git commit -m "feat(api): /api/admin/prompt-version admin 查/切提示词版本

GET {active, preview, manifest}; POST preview(写 profiles, 跨设备)/publish(写 app_config + 清自己 preview)。
POST 校验 version 在 manifest 内, 复用 requireAdmin 鉴权。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: admin 页"提示词版本"tab

**Files:**
- Modify: `app/admin/page.tsx`(TABS + 状态 + load + 动作 + 渲染块 + labelOf helper)

**Interfaces:**
- Consumes: `GET/POST /api/admin/prompt-version`(Task 6);`useAuth()` 的 `isAdmin`(已有)。
- Produces: admin 可在 `/admin` 切换预览/发布版本。

- [ ] **Step 1: 扩展 TABS**

第 33 行:
```ts
const TABS = ['额度管理', '用户反馈', '用户指令'] as const;
```
改为:
```ts
const TABS = ['额度管理', '用户反馈', '用户指令', '提示词版本'] as const;
```

- [ ] **Step 2: 加接口 + 状态**

在文件顶部 `interface MessageRow {...}` 之后加:

```ts
interface PromptVersionInfo {
  id: string;
  label: string;
  description?: string;
}
```

在组件内既有 `useState` 区(约 40–45 行附近)追加:

```ts
  const [pvActive, setPvActive] = useState<string | null>(null);
  const [pvPreview, setPvPreview] = useState<string | null>(null);
  const [pvManifest, setPvManifest] = useState<PromptVersionInfo[]>([]);
  const [pvSelected, setPvSelected] = useState<string>('');
  const [pvBusy, setPvBusy] = useState(false);
  const [pvMsg, setPvMsg] = useState('');
```

- [ ] **Step 3: 加 load + 动作函数 + labelOf**

在 `loadMessages()` 函数之后追加:

```ts
  function labelOf(id: string | null): string {
    if (!id) return '—';
    return pvManifest.find((v) => v.id === id)?.label || id;
  }

  async function loadPromptVersions() {
    setError(''); setLoadingTab(true);
    const resp = await fetch('/api/admin/prompt-version');
    setLoadingTab(false);
    if (resp.status === 403) { setError('需要管理员权限'); return; }
    if (!resp.ok) { setError('加载失败'); return; }
    const data = await resp.json();
    setPvActive(data.active || null);
    setPvPreview(data.preview || null);
    setPvManifest(data.manifest?.versions || []);
    if (!pvSelected) setPvSelected(data.active || data.manifest?.versions?.[0]?.id || '');
  }

  async function pvPreviewAction() {
    if (!pvSelected) return;
    setPvBusy(true); setPvMsg('');
    try {
      const resp = await fetch('/api/admin/prompt-version', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'preview', version: pvSelected }),
      });
      const data = await resp.json();
      if (!resp.ok) { setPvMsg('失败: ' + (data.error || resp.status)); return; }
      setPvPreview(pvSelected);
      setPvMsg(`已设为仅自己预览「${pvSelected}」(跨设备生效, 刷新 /app 后生效)`);
    } finally { setPvBusy(false); }
  }

  async function pvPublishAction() {
    if (!pvSelected) return;
    if (!confirm(`确认把「${pvSelected}」发布给所有用户? 所有人下一条消息起生效。`)) return;
    setPvBusy(true); setPvMsg('');
    try {
      const resp = await fetch('/api/admin/prompt-version', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'publish', version: pvSelected }),
      });
      const data = await resp.json();
      if (!resp.ok) { setPvMsg('失败: ' + (data.error || resp.status)); return; }
      setPvActive(pvSelected); setPvPreview(null);
      setPvMsg(`已发布「${pvSelected}」给所有用户(自己的预览已同步清除)`);
    } finally { setPvBusy(false); }
  }
```

- [ ] **Step 4: tab 懒加载接入 + 修 search 副作用**

把 tab 切换懒加载 effect(约 94–100 行):
```ts
    if (tab === '额度管理' && usageRows.length === 0) loadUsage();
    else if (tab === '用户反馈' && feedbackRows.length === 0) loadFeedback();
    else if (tab === '用户指令' && messageRows.length === 0) loadMessages();
```
改为(加提示词版本分支):
```ts
    if (tab === '额度管理' && usageRows.length === 0) loadUsage();
    else if (tab === '用户反馈' && feedbackRows.length === 0) loadFeedback();
    else if (tab === '用户指令' && messageRows.length === 0) loadMessages();
    else if (tab === '提示词版本' && pvManifest.length === 0) loadPromptVersions();
```

把 search 副作用(约 85–91 行)的兜底分支:
```ts
    else loadMessages();
```
改为(避免在提示词 tab 输入搜索时误触发 messages 加载):
```ts
    else if (tab === '用户指令') loadMessages();
```

- [ ] **Step 5: 加渲染块**

在"用户指令"tab 渲染块(约 256–295 行 `{tab === '用户指令' && (...)}`)之后、`<Link href="/app"...>` 之前,插入:

```tsx
        {/* Tab: 提示词版本 */}
        {tab === '提示词版本' && (
          <>
            <p style={S.sub}>
              当前线上版本：<b>{pvActive ? labelOf(pvActive) : '—'}</b>
              ｜我的预览版本：<b>{pvPreview ? labelOf(pvPreview) : '未设置'}</b>
              <button style={{ ...S.btn, marginLeft: 12 }} onClick={loadPromptVersions} disabled={loadingTab}>刷新</button>
            </p>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '12px 0', flexWrap: 'wrap' }}>
              <select
                value={pvSelected}
                onChange={(e) => setPvSelected(e.target.value)}
                style={{ padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}
              >
                {pvManifest.map((v) => (
                  <option key={v.id} value={v.id}>{v.id} · {v.label}</option>
                ))}
              </select>
              <button style={S.btn} disabled={pvBusy || !pvSelected} onClick={pvPreviewAction}>仅自己预览</button>
              <button
                style={{ ...S.btn, background: '#4f46e5', color: '#fff', borderColor: '#4f46e5' }}
                disabled={pvBusy || !pvSelected}
                onClick={pvPublishAction}
              >发布给所有用户</button>
              {pvSelected && (
                <a href={`/knowledge/prompts/${pvSelected}.md`} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: '#4f46e5' }}>查看内容 ↗</a>
              )}
            </div>
            {pvMsg && (
              <div style={{ background: '#f0f9ff', color: '#0369a1', padding: '10px 14px', borderRadius: 6, marginBottom: 16, fontSize: 13 }}>{pvMsg}</div>
            )}
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>版本</th>
                  <th style={S.th}>标签</th>
                  <th style={S.th}>说明</th>
                  <th style={S.th}>状态</th>
                </tr>
              </thead>
              <tbody>
                {pvManifest.map((v) => (
                  <tr key={v.id}>
                    <td style={S.td}>{v.id}</td>
                    <td style={S.td}>{v.label}</td>
                    <td style={S.td}>{v.description || '-'}</td>
                    <td style={S.td}>{v.id === pvActive ? '线上' : v.id === pvPreview ? '我的预览' : '-'}</td>
                  </tr>
                ))}
                {pvManifest.length === 0 && !loadingTab && (
                  <tr><td colSpan={4} style={{ ...S.td, textAlign: 'center', color: '#999' }}>暂无版本</td></tr>
                )}
              </tbody>
            </table>
          </>
        )}
```

- [ ] **Step 6: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 均无错误。

- [ ] **Step 7: 提交**

```bash
git add app/admin/page.tsx
git commit -m "feat(admin): 提示词版本管理 tab(预览/发布/查看内容)

admin 可选版本: 仅自己预览(跨设备, 写 profiles) / 发布给所有用户(写 app_config + 清自己 preview)。
下拉来自 manifest, 每行可新标签页查看 .md 原文。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: 端到端验证(手动)

**Files:**
- Create(临时, 验完删): `public/knowledge/prompts/v2.md`
- Modify(临时, 验完还原): `public/knowledge/prompts/manifest.json`

**Interfaces:** 无(纯验证步骤)。

**前置**:Task 2 的 SQL 已由用户在 Supabase 项目执行;`.env.local` 有 DeepSeek key;`pnpm dev` 可起。

- [ ] **Step 1: 造测试用 v2(带可见标记)**

`public/knowledge/prompts/v2.md` = `v1.md` 全文,在**最顶部**加一行(强制输出指令,便于肉眼确认 agent 确实加载了 v2):
```
[强制指令-仅v2测试用] 在最终回复的最开头单独一行输出 v2-TEST-MARKER, 用于版本识别。
```
`public/knowledge/prompts/manifest.json` 加 v2 条目:
```json
{
  "versions": [
    { "id": "v1", "label": "当前线上版", "description": "从 agent.ts 迁移, 行为零变化" },
    { "id": "v2", "label": "测试版", "description": "带标记, 验证切换链路用, 验完删除" }
  ]
}
```

- [ ] **Step 2: 验证迁移零行为变化**

`pnpm dev` → 用普通账号(非 admin)在 `/app` 发一道经典题(如"画抛物线 y=x^2-4x+3,标顶点")。
Expected: 行为/最终回复与迁移前一致(展开"工具轨迹"无异常;LaTeX 正常)。

- [ ] **Step 3: 验证 admin 预览(仅自己)**

admin 账号 `/admin` → "提示词版本" tab:
- 下拉选 v2 → 点"仅自己预览" → 出现"已设为仅自己预览"提示;表格里 v2 标"我的预览"。
- admin 回 `/app` 刷新 → 发任意题 → **最终回复开头出现 `v2-TEST-MARKER`**(agent 按强制指令输出,证明加载的是 v2);DevTools Network 应看到 `v2.md` 被请求(非 `v1.md`)。
- 同时另一普通账号(或隐身窗口非 admin)发题 → **回复开头没有 `v2-TEST-MARKER`,DevTools 拉的是 `v1.md`**。

> 主证据用网络层 + endpoint(确定性):admin 带 cookie `curl /api/config/prompt-version` → `{version:"v2",source:"preview"}`;非 admin/匿名 → `{version:"v1",source:"global"}`。输出标记是辅助肉眼确认。

- [ ] **Step 4: 验证发布(全站)**

admin `/admin` → 选 v2 → 点"发布给所有用户" → confirm → 提示"已发布…自己的预览已同步清除";表格里 v2 标"线上",v2 的"我的预览"消失(因 publish 清了 preview)。
- 普通账号刷新 `/app` → 发题 → **回复开头出现 `v2-TEST-MARKER`**(全站已切)。
- `curl /api/config/prompt-version`(匿名)→ `{version:"v2",source:"global"}`。

- [ ] **Step 5: 验证回滚 + 回退链**

- admin 选 v1 → 发布 → 全站回归 v1(普通账号刷新后回复开头不再有 `v2-TEST-MARKER`)。
- 回退链:在 Supabase 把 `app_config` 的 `prompt_version.active` 改成不存在的 `"vX"` → 普通账号刷新 `/app` 发题 → **不崩**,loader 回退到 v1.md,console 有告警(`source:"fallback"`)。改回 `"v1"`。

- [ ] **Step 6: 清理测试 v2**

```bash
rm public/knowledge/prompts/v2.md
```
把 `manifest.json` 还原为只含 v1:
```json
{
  "versions": [
    { "id": "v1", "label": "当前线上版", "description": "从 agent.ts 迁移, 行为零变化" }
  ]
}
```

- [ ] **Step 7: 提交清理**

```bash
git add public/knowledge/prompts/manifest.json public/knowledge/prompts/v2.md
git commit -m "chore(prompt): 移除端到端验证用的测试 v2

版本热切换链路(预览仅自己/发布全站/回滚/回退)已验证通过。v2 待下轮精简 prompt 实验时再正式加。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 完成定义（DoD）

1. `lib/agent.ts` 不再含 `SYSTEM_PROMPT` 常量;`AgentDeps.systemPrompt` 必填;`run()` 用注入值。
2. `public/knowledge/prompts/{manifest.json, v1.md}` 存在;v1.md 与迁移前常量零漂移(Step Task1.3 验过)。
3. `lib/prompt-loader.ts` 的 `resolvePrompt` 三种回退决策经 `verify-loader.mjs` 断言通过。
4. `/api/config/prompt-version`(公开)与 `/api/admin/prompt-version`(admin)按契约返回;POST 校验 version ∈ manifest。
5. `app/admin/page.tsx` "提示词版本" tab 可预览/发布/查看内容;publish 清自己 preview。
6. Task 8 五个验证场景(零变化 / 预览仅自己 / 发布全站 / 回滚 / 回退链)全部通过,测试 v2 已清理。
7. `pnpm typecheck && pnpm build` 通过;所有提交在 `feat/prompt-versioning` 分支。
8. 老文件 `public/knowledge/prompt.v1.txt` 已删;无 scratch 脚本残留。
