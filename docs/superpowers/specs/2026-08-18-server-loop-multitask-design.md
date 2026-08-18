# 服务端决策循环 + 多任务后台 + LiteLLM 多模型网关 —— 设计文档

> ⚠️ **状态：已归档（2026-08-18），作为架构知识储备，不实施。**
> 方向修订：本设计的全部内容（含 §10 否决记录、§8.1 并发专项）保留为面试可讲的架构
> 知识与取舍记录。生效的新方向见 `2026-08-18-quality-first-design.md`（效果优先）。
>
> ~~2026-08-18 ｜ 取代《改进计划_2026-08》中任务 3/4/5 的架构定义~~
> ~~目标体验对标：DeepSeek 网页端——任务在服务端跑，会话间自由切换流不断，并发上限 2。~~

---

## 1. 目标与非目标

**目标**
1. agent 决策循环跑在服务端（Render），前端只负责画布工具执行与展示
2. 多任务：任务 A 运行中可新建/切换到任务 B，A 在后台继续；切回 A 时——运行中则接上实时流，已结束则直接显示结果
3. 每用户并发上限 2（含等待执行器的任务），满员时提示「有任务正在生成中，请稍后重试」
4. LiteLLM Proxy 统一网关：平台模式多模型路由/fallback/花费日志；BYOK 模式 key 透传
5. agentist 式 BYOK：选厂商 + 贴 key（无 base_url 输入），key 加密落库、仅显末四位、跨设备可用
6. 免费档生存：run 全状态可从落库事件重建，runner 休眠/重启/重新部署不丢任务

**非目标（显式不做）**
- 无头 Chromium 服务端执行（v2 升级位，见 §10 否决记录）
- JVM 无头内核（否决，见 §10）
- LiteLLM virtual key 管理界面、自动恢复重跑（孤儿 run 只标记不重跑）
- UI 美化 / 计费 / 协作
- inspect_render 移除（保留 + 开关 + eval 消融数据裁决）

---

## 2. 关键决策记录（本次设计过程的结论）

| # | 决策 | 理由 |
|---|---|---|
| D1 | 执行器 v1 放浏览器（隐藏画布），不放服务端 | $0–7/月预算；DeepSeek 核心体验（应用内切换+流不断+刷新恢复）浏览器执行器 100% 覆盖；仅「关页面继续跑」需 $25 档，对 demo 边际价值低 |
| D2 | 页面关闭 = 任务暂停（awaiting_executor），重开自动恢复 | D1 的必然语义；执行器协议原生支持 |
| D3 | LiteLLM 从原计划 P2 提前为 runner 地基 | runner 的 LLM 层天生走网关，避免先写 provider 分支再返工 |
| D4 | BYOK 与平台流量都走 LiteLLM | `forward_llm_provider_auth_headers: true` 官方支持 key 透传；单客户端、统一花费日志 |
| D5 | BYOK v1 就做加密存储 | 对齐 agentist；跨设备、last4 展示 |
| D6 | 部署三层分离：Vercel(Next) + Render(runner) + Render(LiteLLM) | 接入层/计算层/网关分离的叙事 + 各自免费额度 |
| D7 | runner 付费 Starter $7/月，LiteLLM 免费档不保活 | $7 买 demo 不冷启动（面试官首次点击秒开）；LiteLLM 冷启动仅影响闲置后首次调用，实测烦了再升 |
| D8 | inspect_render 保留 + 配置开关 + eval 消融裁决 | 它在 v1 架构里是普通工具调用，砍掉不省任何成本；且是多模态自验证的差异化亮点 |
| D9 | run 状态设计为可从 run_steps 完整重建 | 免费档休眠、重新部署、崩溃三种场景统一由恢复逻辑兜底 |

---

## 3. 架构总览

```
浏览器（前端）
 ├─ 可见画布：当前任务页面，实时渲染事件流（assistant_delta / tool_call / tool_result）
 ├─ 隐藏画布池（≤2）：后台任务的执行器，offscreen 绝对定位（禁止 display:none，保渲染/截图）
 └─ 直连 runner（SSE 订阅 + POST 回传）——不经 Vercel 代理
     （SSE 走 Vercel 函数会撞 serverless 时长上限 → 必须直连 + CORS + JWT）

Vercel $0     Next.js：UI / 登录 / settings / 会话 CRUD / 模型列表接口
Render #1     agent-runner（Node 常驻，$7 Starter）：RunManager + agent-core loop + SSE Hub
Render #2     LiteLLM Proxy（Docker，免费档）：平台模型路由/fallback/花费 + BYOK 透传
Supabase      runs / run_steps / user_api_keys / sessions（已有）
```

核心原理（DeepSeek 切换不断的本质）：**run 的全部状态持久化在服务端，前端只是订阅者**。
切走 = 取消订阅（执行器连接保留）；切回 = 从库重放已发生事件（?since=seq）+ 重新订阅实时流。

---

## 4. 数据模型（Supabase 新增）

```sql
runs:
  id uuid pk, session_id uuid, user_id uuid,
  status text,        -- running | awaiting_executor | done | error | cancelled
  mode text,          -- platform | byok
  model text, provider_id text null,
  prompt_version text,
  canvas_xml text,    -- 最新画布快照（执行器每次 execute_command 批次后上传）
  created_at, updated_at

run_steps:
  run_id uuid, seq bigint,     -- (run_id, seq) 唯一，seq 按 run 递增
  type text,                   -- llm_message | tool_call | tool_result |
                               -- canvas_snapshot | round_end | error | user_cancel
  payload jsonb, created_at

user_api_keys:
  id uuid pk, user_id uuid, provider_id text,
  key_ciphertext text,         -- AES-256-GCM
  key_last4 text, key_fingerprint text,   -- 指纹用于去重/防重复录入
  created_at
```

关键性质：**run 的完整状态可从 run_steps 推导**——messages 数组、轮次计数、verify/inspect
预算计数（现有 agent.ts 的预算本来就是数 messages 算的，天然兼容）。canvas 状态以
`canvas_xml` 快照为准，恢复时不重放命令。

---

## 5. Runner 服务设计

### 5.1 agent-core 抽取
- `lib/agent.ts` 的 `AgentDeps` 已是依赖注入结构，抽为 isomorphic 模块 `lib/agent-core.ts`
- 第一步先在前端原地复用（零行为变化，跑 eval 基线确认无回归），再上 runner
- 预算常量、文本清洗、工具定义、prompt 组装逐字保留（几十轮验证的资产）

### 5.2 ToolExecutor 接口
```ts
interface ToolExecutor {
  execute(name: string, args: any): Promise<any>;   // 返回工具结果（已序列化前的对象）
}
```
- `search_command`：runner 本地执行（预计算 commandEmbeddings.json 随 runner 部署，query
  embedding 走 LiteLLM；BYOK 用户也走平台 embedding——写进隐私说明）
- 其余 6 个画布工具：经执行器协议下发浏览器
- **inspect_render 两跳**：① executor 执行截图回传 `{ image: dataURL }` → ② runner 调
  vision（LiteLLM）、解析 issues、组装最终 `{ passed, issues, advisory }` 作为 LLM 看到的
  tool_result
- v2 无头升级位：HeadlessExecutor 新实现类，loop 与协议不动

### 5.3 执行器协议
- 下行（run 的 SSE 流内）：`{type:'tool_call', callId, name, args}`
- 上行：`POST /runs/:id/tool-results` `{callId, result}`
- 执行器存活检测（双信号）：① SSE 连接关闭事件（快速路径）；② 未决 tool_call 60s 未回
  结果 → run 转 awaiting_executor（兜底路径，兼作慢工具的超时上限）。SSE 侧每 15s 发
  comment ping 维持中间层不断连
- 执行器 attach：`GET /runs/:id/stream?since=seq`（带执行器标记）；未决 tool_call 重发
- 画布快照：executor 每次 execute_command 批次成功后上传 canvas_xml（增量覆盖 runs 行）

### 5.4 RunManager
- 内存 `Map<runId, ActiveRun>`（loop promise、事件序号、订阅者列表）
- 每用户并发 ≤2（status ∈ {running, awaiting_executor} 计数），超出 POST /runs 返回 409
- 事件双写：先 insert run_steps（失败重试，内存队列兜底）再广播 SSE
- 唤醒/重启孤儿清理：扫 status=running 但不在内存 → 标 awaiting_executor；执行器 attach
  后从 run_steps 重建 messages、从 canvas_xml 恢复画布、loop 从断点继续；被杀的半轮 LLM
  调用整轮重跑（按轮 at-least-once）
- 幂等边界：恢复只重发「未回结果的那一个 tool_call」；画布以快照为准不重放命令

### 5.5 API
```
POST /runs                     建 run（鉴权+并发+配额校验）
GET  /runs/:id/stream?since=   SSE（事件重放 + 实时）
POST /runs/:id/tool-results    执行器回传
POST /runs/:id/cancel          用户终止/接管
GET  /runs?session_id=         会话的 run 列表（切回任务时判断状态）
```

### 5.6 鉴权与安全
- Supabase JWT 验签（jose + SUPABASE_JWT_SECRET），service-role 写库
- CORS 白名单：Vercel 域名 + localhost（开发）
- 配额服务端化：trial_token 按调用计数机制**退役**，改为按 run 计数——语义沿用现有
  TRIAL_DEFAULT_LIMIT（每用户**总额度**，默认 5，管理员可针对单用户覆盖），仅计数单位
  从"次发送"变为"个 run"

---

## 6. 前端改造

1. **画布生命周期**：画布按 sessionId 键控。运行中任务的画布常驻 offscreen 容器（绝对定
   位移出视口）；空闲/完成任务的画布卸载，切回时聊天/轨迹从 run_steps 重建，画布仅从
   runs.canvas_xml 恢复（不向画布重放命令）
2. **发送流程**：`POST /runs` → 订阅 SSE → 渲染事件。可见任务与后台任务**无两套逻辑**：
   前端画布就是执行器，tool_call 来了执行 lib/ggb.ts 现有工具、结果 POST 回 runner；可见
   时顺便把过程展示出来
3. **并发与状态 UI**：满 2 时 toast 提示；侧栏任务项状态徽标（运行中/已完成/待恢复/出错）
4. **settings 页**：厂商下拉（内置注册表，无 base_url）+ 贴 key（加密落库、last4、可删
   除）+「高级：自定义 OpenAI 兼容端点」折叠项（保留旧 ByokProfile 能力）；检测到
   sessionStorage 旧配置 → 一键迁移提示
5. **模型选择器**：发送框旁；平台模式列 LiteLLM /v1/models；BYOK 模式列已配厂商模型
6. **轨迹面板**：改读 run_steps（服务端轨迹，解决轨迹只在内存的问题）
7. **多标签页/多设备**：同一 run 仅一个标签页担任执行器（§8.1 C1 认领制），其余自动降
   级为观看端（订阅不带执行器标记）

---

## 7. LiteLLM 配置

```yaml
model_list:
  - model_name: deepseek-chat            # 平台模式
    litellm_params: { model: deepseek/deepseek-chat, api_key: env:DEEPSEEK_API_KEY }
  - model_name: glm-4.6                  # 平台 + fallback 目标
    litellm_params: { model: openai/glm-4.6, api_base: env:GLM_BASE_URL, api_key: env:GLM_API_KEY }
  - model_name: glm-4.6v                 # 视觉
    litellm_params: { model: openai/glm-4.6v, api_base: env:GLM_BASE_URL, api_key: env:GLM_API_KEY }
  - model_name: byok/deepseek            # BYOK：不带 key，靠透传
    litellm_params: { model: deepseek/deepseek-chat }
  - model_name: byok/glm
    litellm_params: { model: openai/glm-4.6, api_base: env:GLM_BASE_URL }

router_settings:
  fallbacks: [{ "deepseek-chat": ["glm-4.6"] }]

general_settings:
  master_key: env:LITELLM_MASTER_KEY
  forward_llm_provider_auth_headers: true   # BYOK key 透传

litellm_settings:
  drop_params: true
```

- runner 单一 OpenAI 兼容客户端指向 LiteLLM：平台模式 `Authorization: Bearer LITELLM_MASTER_KEY`；
  BYOK 模式 model=`byok/<厂商>` + 厂商鉴权头携带解密后的用户 key（仅内存）
- vision 按厂商映射（GLM→glm-4.6v；无视觉模型的厂商如 DeepSeek→平台 glm-4.6v 兜底）
- 花费日志（可选）：LiteLLM 连 Supabase PG（pooler 连接串），admin 页加花费查询
- BYOK 厂商注册表只收录按量付费官方端点（coding plan 类不支持，写进 UI 提示文案）

---

## 8. 错误处理

| 场景 | 行为 |
|---|---|
| 执行器失联 | 心跳超时 → awaiting_executor，loop 挂在当前 tool_call；重连重发；awaiting 占并发名额防僵尸堆积；提供手动取消 |
| runner 休眠/重启/重部署 | 唤醒扫孤儿 → awaiting_executor；attach 后重建恢复（§5.4） |
| LLM 调用失败 | 现有 retry.ts 策略搬入 runner；LiteLLM fallback 链兜底 |
| 落库失败 | 内存队列重试；持续失败 → run 标 error 并经 SSE 告知 |
| 用户取消 | POST /cancel → 检查点终止 + 落库 + 前端可接管输入 |
| BYOK key 泄露面 | 解密仅限 runner 内存；logger 全链路脱敏；run_steps payload 与执行器回传禁止明文 key（写入时校验） |

### 8.1 并发与一致性（专项）

单实例单进程（Node 单线程）消除了大部分竞态温床，但以下边界必须显式处理。
设计原则：**宁重复投递（客户端按 seq/callId 幂等消化），不漏投递（漏 = 上下文损坏）**。

| # | 竞态场景 | 机制 |
|---|---|---|
| C1 | 同一 run 挂两个执行器（双标签页/双设备打开同一会话）——**高频真实场景**。GGB 命令不幂等（Circle(A,B) 执行两次产生 c1、c2），双执行 = 画布污染 | 执行器认领制：attach 带 executorId，每 run 仅一个执行者；后来者踢掉前者（下发 executor_evicted，被踢方降级纯观看端）；tool-results 拒收非持有者 |
| C2 | SSE 重放与直播接缝：?since=seq 重放完瞬间新事件已在广播——漏事件或重复投递。**INCIDENTS.md 预填第一条** | 三步拼接：先进内存广播缓冲 → 读库重放 → 按序号冲刷缓冲；客户端按 seq 去重 |
| C3 | 未决 tool_call 重投递重复执行（执行器活着但回传丢失，60s 超时重发） | 执行器端 callId 去重缓存（最近 N 个 callId→结果），重复 callId 直接重发缓存结果，不重执行 |
| C4 | 并发 POST /runs 绕过并发≤2 / 配额校验（TOCTOU） | 创建路径按 user 串行化（进程内 per-user promise 队列）+ DB 原子计数兜底 |
| C5 | Render 滚动部署窗口新旧实例并存，双 loop 同 run | 恢复前条件更新 run 行认领（CAS fence），认领失败不恢复；Starter 单实例为前提 |
| C6 | cancel 与在途调用赛跑：已下发 tool_call 在取消后仍被执行 | cancel 时下发 tool_call_cancelled 通知执行器丢弃；非 active run 的 tool-results 一律拒收 |
| C7 | seq 分配竞速（loop 追加与 canvas_snapshot 上传并发写 run_steps） | 单写者原则：全部 seq 由 runner 进程统一分配；恢复时从 MAX(seq) 初始化计数器 |
| C8 | 事件落库与广播顺序 | 先落库再广播（§5.4）+ 落库失败暂停 loop：保证重放流永远是直播流的前缀 |

---

## 9. 测试策略

- **eval 是回归安全网（P0 前置）**：30 用例先在现有架构跑基线；重构每阶段重跑，成功率不回退才进下一阶段
- **inspect_render 消融**：同一用例集带/不带视觉验收各跑一遍，报告对比成功率和视觉问题修复率——数据裁决去留（改进计划「先证据后叙事」纪律）
- **runner 单测**：run_steps→messages 重建纯函数、并发上限、心跳超时、预算计数推导
- **契约测试**：fake ToolExecutor（内存实现）跑完整 loop，不依赖浏览器；此 fake 即 v2 无头执行器的第一个参考实现
- **E2E 验收清单**（即面试故事）：双任务并行切换流不断；刷新页面任务继续；断网 30s 重连恢复；取消并接管；>5 分钟 run 完整跑完；轨迹全量落库可回放

---

## 10. 备选方案否决记录（面试素材）

| 方案 | 否决理由 |
|---|---|
| JVM 无头内核（geogebra.kernel 嵌入自建 Java 服务） | 1–2 周起步的独立工程；第 4 部署物 + 跨语言互操作；JVM 内存同样 0.5–1GB 省不了钱；headless JDK 下 Swing 渲染脆弱，截图依旧无解；上游更新漂移维护成本。净效果：花大量工期省 $50–75 机器钱，负收益 |
| 无头 Chromium（Render Standard $25/月） | 技术可行（node-geogebra 先例，含截图）；v1 否决因月成本 3 倍 + Chromium-in-Docker 运维（3D 软件渲染需验证）。**保留为 v2 升级路径**：ToolExecutor 新增 HeadlessExecutor 即可，loop/前端协议不动 |
| 双执行器混合（浏览器优先+无头兜底） | 双路径复杂度最高，工期 +1–2 天，v1 无必要 |
| 轻量无头内核包（"ggbjs"） | 查证不存在：npm 无成熟独立内核包；GeoGebra 内核只能活在 applet（浏览器或无头浏览器）里 |
| loop 放 Next.js API 路由（合体部署） | SSE 长连接与 serverless 路由模型冲突；重新部署清空内存态；后续拆分成本高 |
| 全迁 Render（放弃 Vercel） | 丢边缘缓存/预览部署便利；迁移本身有工作量 |
| 剔除 inspect_render | v1 中它是普通工具调用，不构成任何成本/架构瓶颈；剔除反而破坏已验证的行为契约，且失去多模态验证亮点。改为开关+数据裁决 |

---

## 11. 实施分期与优先级（对改进计划的修订）

| # | 任务 | 级 | 预估 | vs 原计划 |
|---|---|---|---|---|
| 1 | eval 用例集 + runner + 报告（含 inspect_render 消融） | P0 | 1.5–2d | 不变，理由加强：重构回归网 |
| 2 | 公开准备（保持私有，按公开标准） | P0 | 0.5–1d | 不变 |
| 3 | agent-core isomorphic 抽取（前端原地复用 + 回归） | P1 | 0.5d | 原任务 3 第 1 步 |
| 4 | runner 服务 + LiteLLM 本地 docker 打通 + runs/run_steps + SSE | P1 | 2d | **LiteLLM 从 P2 提前**（D3） |
| 5 | 执行器桥 + 刷新/断线恢复 + 孤儿清理 | P1 | 1d | 原任务 3 第 2–4 步 |
| 6 | 多任务切换：隐藏画布池 + 并发≤2 + 状态徽标 + 镜像执行 | P1 | 1–1.5d | 新增 |
| 7 | BYOK 加密存储 + 厂商注册表 + settings UI + 模型选择器 | P1 | 1.5d | 新增（agentist 式） |
| 8 | Render 部署（runner $7 + LiteLLM free）+ 保活决策 + 验收 | P2 | 0.5–1d | 原任务 5 溶解至此 |

合计约 9–11 天（原计划 6–8 天）。**砍序规则**：时间不够砍 8 保 6（多任务是本次核心诉求）。
**任务 6 开工前 spike（半天内）**：offscreen 画布渲染验证（截图 + 3D 视图）；失败则任务 6
采「后台任务暂缓 inspect_render、切回前台补验」兜底。

INCIDENTS.md 纪律沿用（改进计划 §8）：新架构必然翻车（SSE 重连边界、休眠恢复、fallback
触发路径），当场记录，就是面试答案库。

---

## 12. 环境变量与部署清单

**已有**（.env.local 18 项，无缺口）：DeepSeek/GLM/Supabase/试用配置。

**新增（实施到对应阶段再填）**：

| 变量 | 填在哪 | 获取方式 |
|---|---|---|
| SUPABASE_JWT_SECRET | runner/.env + Render | Supabase 后台 Settings→API→JWT Secret |
| ENCRYPTION_MASTER_KEY | runner/.env + Render | `openssl rand -hex 32`（本地生成直接写入文件，值不进对话/git） |
| LITELLM_MASTER_KEY | runner/.env + LiteLLM 服务 + Render | 同上 |
| Supabase PG pooler 连接串（可选） | LiteLLM 服务 | Supabase 后台 Connect；开花费日志才需要 |

**部署流程**：仓库加 `render.yaml`（Blueprint，密钥项 `sync: false`）+ 两个 Dockerfile；
Render 网页 New→Blueprint→选仓库→粘环境变量。全程密钥不经人手转交。
**休眠对策**：runner 付费档常驻；LiteLLM 免费档不保活（避免 750h/月账号池额度耗尽——该
口径部署时验证），冷启动仅影响闲置后首次调用。
