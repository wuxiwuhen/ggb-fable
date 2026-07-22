# 提示词版本化 + 管理员热切换 Design Spec

> **状态**: 设计已与用户对齐(2026-07-20),待写实现计划。
> **背景**: 当前系统提示词写死在 `lib/agent.ts` 的 `SYSTEM_PROMPT` 常量里(~175 行 / ~12KB)。本 spec 把它抽成可版本化的静态文件,并支持:① 本地切版本号;② 管理员账号上"预览候选版本(仅自己)+ 发布给所有用户"。为后续 prompt 实验(精简版 vs 当前版)铺基建。

---

## 1. 目标 / 非目标

### 目标
- 提示词从代码常量迁移为 `public/knowledge/prompts/` 下的版本化文件,由 manifest 登记。
- 客户端按"生效版本号"加载对应文件注入 `AgentEngine`,不再硬编码。
- 管理员可在 `/admin` 页:选候选版本"仅自己预览"(跨设备生效),满意后"发布给所有用户"(全站即时生效,免重新部署)。
- **迁移当天行为零变化**:所有用户拿到的提示词与迁移前逐字一致。

### 非目标
- 不在本轮撰写 v2 精简 prompt(那是下一轮实验,基建就绪后另起)。
- 不做多分支/灰度发布(只有"全局 active" + "admin 个人 preview"两层)。
- 不做版本内容 diff UI(只提供"查看某版本原文"链接,新标签页打开 .md)。
- 不引入测试框架;验证沿用现有 `pnpm typecheck` + `pnpm build` + 手动端到端。

---

## 2. 架构总览

提示词加载链路(客户端启动时执行一次):

```
GET /api/config/prompt-version        ← 公开 edge endpoint, 服务端解析生效版本
   │   1. 读 app_config.prompt_version (全局 active)
   │   2. 读 cookie 用户 → profiles(is_admin, prompt_preview_version)
   │   3. admin 且设了 preview → 返回 preview;否则返回全局
   ▼
{ version: "v1", source: "global"|"preview" }
   │
   ▼
fetch /knowledge/prompts/<version>.md  ← 静态文件, 内存缓存
   │   失败 → 回退 fetch v1.md → 再失败 → EMERGENCY_PROMPT(极小硬编码)
   ▼
{ version, text }
   │
   ▼
new AgentEngine({ ..., systemPrompt: text })
```

管理员控制链路(`/admin` 页):

```
GET  /api/admin/prompt-version            → { active, preview, manifest }
POST /api/admin/prompt-version
     { action:"preview",  version:"v2" }  → profiles.prompt_preview_version = "v2"
     { action:"publish",  version:"v2" }  → app_config.prompt_version.active = "v2"
```

**生效版本解析在服务端**(单一事实源),客户端不判断 admin / 不读 localStorage:
- 普通用户 / 未登录:拿到全局 active。
- 管理员:若自己设了 preview 则拿 preview,否则全局。
- 非管理员无法设 preview(admin endpoint 鉴权拦截),也拿不到别人 的 preview。

---

## 3. 版本文件布局与命名

抛弃旧的扁平 `public/knowledge/prompt.v1.txt`(且该文件内容已过时,本轮删除)。

新布局:

```
public/knowledge/prompts/
  manifest.json      # 单一事实源: 登记现有版本 + 人类标签
  v1.md              # 文件名 = 版本号; "切版本号" = 换 id
  v2.md              # (下一轮实验再写; 本轮可留空占位以便测试, 见 §9)
```

约定:
- **`.md` 非 `.txt`**:内容本就是 markdown,编辑器可渲染。
- **文件名只放版本号**(`v1.md`);人类标签/描述放 manifest,解耦——改标签不动文件。
- **manifest 是唯一目录**:admin 下拉、服务端 POST 校验、客户端发现版本都读它。

`manifest.json` 形状:

```json
{
  "versions": [
    { "id": "v1", "label": "当前线上版", "description": "从 agent.ts 迁移, 行为零变化" },
    { "id": "v2", "label": "精简实验版", "description": "砍 C 类固化约束, 保留 GGB 机械坑" }
  ]
}
```

**不设 `status:"active"` 字段**——active 与否以 DB 里 `app_config` 的值为准,避免两个事实源打架。manifest 只负责"有哪些版本"。

---

## 4. 数据模型(Supabase schema 变更)

加到 `supabase/schema.sql`(新部署)并作为增量迁移脚本(已部署库手动跑):

```sql
-- 全局应用配置: key/value
CREATE TABLE IF NOT EXISTS app_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
INSERT INTO app_config (key, value) VALUES
  ('prompt_version', '{"active":"v1"}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 管理员预览覆盖: per-admin, 跨设备
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS prompt_preview_version text;
```

- `app_config`:极小通用 key/value 表(将来可复用存别的全局开关)。`prompt_version` 的 value 形状固定 `{"active":"<id>"}`。
- `profiles.prompt_preview_version`:nullable;为空表示该 admin 未设预览,走全局。写入用 service-role(见 §5)。
- 无需额外 RLS:所有读写都经 endpoint 用 `getSupabaseAdmin()`(service role)完成,客户端不直连这两张表。

---

## 5. API 表面

### `app/api/config/prompt-version/route.ts`(公开, edge)

```
GET  → 200 { version: string, source: "global" | "preview" }
```

逻辑:
1. `getSupabaseAdmin()` 读 `app_config` 里 `key='prompt_version'` → `value.active`(读不到默认 `"v1"`)。
2. `getUserFromCookie(req)`:无用户 / 读失败 → 直接返回全局。
3. 有用户 → 查 `profiles` 取 `is_admin, prompt_preview_version`。
4. `is_admin && prompt_preview_version` 非空 → 返回 `{version: preview, source:"preview"}`;否则返回全局。

鉴权:无(公开)。仅返回版本号字符串,无敏感信息。

### `app/api/admin/prompt-version/route.ts`(admin, edge)

复用 `app/api/admin/insights/route.ts` 里的 `requireAdmin` 模式(`getUserFromCookie` + 查 `profiles.is_admin`)。

```
GET  → 200 { active: string|null, preview: string|null, manifest: {versions:[...]} }
POST body { action: "preview"|"publish", version: string } → 200 { ok:true, active?, preview? }
```

- GET:`active` = `app_config.prompt_version.active`;`preview` = 当前 admin 的 `profiles.prompt_preview_version`;`manifest` = 从本 origin `fetch('/knowledge/prompts/manifest.json')` 取(edge runtime 不能读盘,走自 origin 静态获取,与 insights 路由同模式)。
- POST:
  1. 校验 `version` 存在于 manifest(否则 400)。
  2. `action==="preview"` → `profiles.update({prompt_preview_version: version}).eq('user_id', adminUser.id)`。
  3. `action==="publish"` → `app_config.update({value:{active:version}, updated_at:now()}).eq('key','prompt_version')`,**并同事务清空当前 admin 自己的 `prompt_preview_version`(置 null)**——发布即对全员含自己生效,避免 admin 困在旧 preview 看不到刚发布的全局版本。
  4. 返回更新后的 `{active, preview:null}`。

---

## 6. 组件改动

### `lib/prompt-loader.ts`(新增)

```ts
export const DEFAULT_VERSION = "v1";
export const EMERGENCY_PROMPT = "...极小硬编码, 静态托管全崩时的最后兜底...";

// 拉 manifest 里的版本元信息(给 UI 用), 缓存
export async function fetchManifest(): Promise<{ versions: Array<{id;label;description}> }>;

// 拉某版本文件原文, Map<version, text> 内存缓存
export async function loadPromptText(version: string): Promise<string | null>;

// 主入口: 服务端解析生效版本 → 拉文件 → 失败回退链
export async function getEffectivePrompt(): Promise<{
  version: string;
  text: string;
  source: "global" | "preview" | "fallback";
}>;
```

`getEffectivePrompt` 回退链(单一 v1 内容源,不复制大字符串):
1. `GET /api/config/prompt-version` → `{version, source}`;endpoint 挂了 → `version = DEFAULT_VERSION`。
2. `loadPromptText(version)`;失败 → `loadPromptText(DEFAULT_VERSION)`(回退到已知好文件 v1.md)。
3. 再失败 → `EMERGENCY_PROMPT`,`source = "fallback"`。

### `lib/agent.ts`(改动)

- **删除** `SYSTEM_PROMPT` 常量(内容迁至 `public/knowledge/prompts/v1.md`,逐字)。
- `AgentDeps` 增加必填 `systemPrompt: string`。
- `run()` 里 `{ role:'system', content: SYSTEM_PROMPT }` → `content: this.deps.systemPrompt`。
- `getSystemPrompt()` 仍保留(返回注入的 prompt),供调试/UI 展示。
- **不在 agent.ts 内置任何兜底 prompt 字符串**——兜底责任在 loader,引擎只消费传入的字符串(职责单一)。

### `components/ChatApp.tsx`(改动)

- `agentRef` 创建前:调 `getEffectivePrompt()` 拿 `{version, text}`,传入 `new AgentEngine({ ggb, commandSearch, logger, systemPrompt: text })`。
- 提示词在引擎构造时绑定(存于实例)。**已知限制**:管理员会话中途发布新版本,当前用户要到下次刷新 / 新会话才生效。v1 可接受,不引入热监听。
- 加载期间(agent 未就绪)沿用现有"初始化中"态,不额外暴露版本信息给普通用户。

### `app/admin/page.tsx`(改动)

新增"提示词版本管理"区块:
- 挂载时 `GET /api/admin/prompt-version` → `{active, preview, manifest}`。
- 展示:**当前线上版本** = `active` 的 label;**我的预览版本** = `preview` 的 label 或"未设置"。
- manifest 渲染下拉选候选版本。
- 两个动作按钮:
  - **"仅自己预览此版本"** → `POST {action:"preview", version}`(写 profiles,跨设备)。
  - **"发布给所有用户"** → `POST {action:"publish", version}`(带 confirm 二次确认)。
- 每行版本一个 **"查看内容"** 链接 → 新标签页打开 `/knowledge/prompts/<id>.md`(便于肉眼 diff)。
- POST 成功后重新 GET 刷新展示。

---

## 7. 迁移:零行为变化保证

1. 创建 `public/knowledge/prompts/v1.md`,内容 = `lib/agent.ts` 当前 `SYSTEM_PROMPT` **逐字拷贝**(迁移后用 `diff` 确认零差异)。
2. 创建 `public/knowledge/prompts/manifest.json`,只登 `v1`(v2 占位见 §9)。
3. DB seed `app_config.prompt_version.active = "v1"`。
4. 删除 `public/knowledge/prompt.v1.txt`(用户确认过时)。
5. 改 `lib/agent.ts`(删常量、deps 加 systemPrompt)、`components/ChatApp.tsx`(注入 loader 结果)。
6. 验证:迁移后任意用户 agent 行为与迁移前一致(同一道题,工具轨迹/最终回复可比对)。

**v1.md 是 v1 内容的唯一源**——agent.ts 不再持有,loader 直接读文件;`DEFAULT_VERSION="v1"` 仅作"回退到哪个版本"的指针,不复制内容。

---

## 8. 错误处理与边界

| 场景 | 行为 |
|---|---|
| `/api/config/prompt-version` 网络失败/500 | loader 用 `DEFAULT_VERSION="v1"` 继续拉文件,`source` 标记回退 |
| 某版本 `.md` 404(版本被删但 DB/preview 还指向它) | 回退拉 `v1.md`;再失败用 `EMERGENCY_PROMPT`;console 告警 |
| admin POST 不在 manifest 的 version | 400 `{error:"未知版本"}` |
| admin POST `publish` 时 manifest 拉取失败 | 500,不写入(宁可不切也不切到幽灵版本) |
| 未登录用户调 admin endpoint | 403(复用 `requireAdmin`) |
| `app_config` 表为空(迁移漏 seed) | endpoint 读不到 → 默认 `"v1"`;loader 仍能拉 v1.md 兜住 |
| 管理员会话中途发布新版本 | 当前用户下次刷新/新会话才生效(已知限制,见 §6) |

---

## 9. 验证策略(无测试框架)

`pnpm typecheck` + `pnpm build` 通过为硬门槛。手动端到端:

1. **迁移正确性**:迁移前后跑同一道题(如"画抛物线 y=x²-4x+3,标顶点"),最终回复 + 工具轨迹一致 → 证明 v1 内容零变化。
2. **切换链路真的通**:本轮临时建一个 `v2.md`(在 v1 末尾加一行可见标记,如 `<!-- TEST MARKER -->` 或一句明显不同的指令),登记进 manifest。管理员:
   - 选 v2 → "仅自己预览" → 该 admin 下条消息的 agent 行为/回复出现 v2 标记;**另一普通账号同时段仍为 v1**(证明 preview 仅自己)。
   - 选 v2 → "发布给所有用户" → 普通账号刷新后也变 v2(证明 publish 全局)。
   - 选回 v1 → 发布 → 全站回归 v1。
   - 验证完删除测试用 v2.md + manifest 条目(或保留作下轮实验起点,由用户定)。
3. **回退链路**:临时把 `app_config.prompt_version.active` 改成不存在的 `"vX"` → 客户端应回退到 v1.md 不崩。

---

## 10. 文件清单

**新增:**
- `public/knowledge/prompts/manifest.json`
- `public/knowledge/prompts/v1.md`
- `public/knowledge/prompts/v2.md`(测试用,验证后删或留)
- `lib/prompt-loader.ts`
- `app/api/config/prompt-version/route.ts`
- `app/api/admin/prompt-version/route.ts`
- schema 迁移 SQL(加进 `supabase/schema.sql` + 单独增量脚本)

**改动:**
- `lib/agent.ts`(删 SYSTEM_PROMPT 常量;`AgentDeps.systemPrompt` 必填;`run()` 用注入值)
- `components/ChatApp.tsx`(挂载调 `getEffectivePrompt()`,注入引擎)
- `app/admin/page.tsx`(新增"提示词版本管理"区块)
- `supabase/schema.sql`(追加 `app_config` 表 + `profiles` 列)

**删除:**
- `public/knowledge/prompt.v1.txt`(过时老版)

---

## 11. 未决 / 后续

- v2 精简 prompt 的实际内容:下一轮单独做(对应此前讨论的"砍 C 类固化约束、保留 A 类 GGB 机械坑")。
- 是否需要"版本发布历史/审计":目前不做,YAGNI。
- 是否需要让普通用户感知当前版本:不需要(对用户透明)。
