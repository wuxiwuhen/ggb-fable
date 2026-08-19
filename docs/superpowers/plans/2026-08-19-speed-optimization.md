# 速度优化专项（三段式思考策略）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec `docs/superpowers/specs/2026-08-19-speed-optimization-design.md` 实现三段式思考策略（PLAN 思考开 → EXECUTE 思考关 → RECOVER 触发式思考开）+ thinking 参数全链路透传 + 思考流/阶段状态 UI + eval 延迟度量与超时独立分类，并以三臂 A/B（always/auto/fast）验证双硬指标后决策默认档。

**Architecture:** 新增纯逻辑状态机 `lib/thinking.ts`（无 IO，单测覆盖），引擎 `lib/agent.ts` 的 run 循环逐轮查询它决定 thinking 参数并注入阶段 system 后缀（prompt v2 本体不动）；`lib/llm.ts` 的 chatByok/chatTrial 与 `/api/trial/llm` 路由透传 `thinking: {type}`，parseSSE 补收 `reasoning_content` 经 onThinking 透出到 ChatApp 折叠思考块；eval 侧记录 durationMs、分桶 P50、超时采样过程断言改记 `timeout_incomplete`、三采样并行、三臂 variants。

**Tech Stack:** Next.js 15 (TS) / zustand / vitest（根 `pnpm test` 跑 lib，`pnpm eval:unit` 跑 eval）/ Playwright（eval runner）/ deepseek-v4-flash（OpenAI 兼容 /v1/chat/completions，`thinking: {"type":"enabled"|"disabled"}`）。

## Global Constraints

- **双硬指标（验收判据，逐字来自 spec §4）**：总成功率 ≥80% 且 basics/func/dyn/multi 各 ≥2/2；trap-budget-unit-circle 在 420s 上限内完成 P50 ≤60s；basics 桶 P50 ≤15s；强停采样不再出现在 process_error 分布里。
- **thinking_mode**: `'auto' | 'always' | 'never'`，**默认 auto**；RECOVER 每 turn 最多 **2** 次。
- **prompt v2 文本冻结**：阶段指令只能以每轮 chat 的 system 消息**临时后缀**注入（浅拷贝 messages，不写入会话历史），不得改 `prompts/v2.md` 与 agent.ts 的 TOOLS 描述。
- **reasoning_content 只透出展示**：经 onThinking 流到 UI，不写入 messages 历史、不回传 API。
- **升级触发（逐字来自 spec §3.1）**：① 连续 2 轮 execute_command 批次含 failures；② verify_geometry 结果不达预期（实现口径：结果 `ok === false`，expect 是自由文本不做机器比对）；③ 因 inspect_render issues 修正后再次 inspect 仍有 issues（实现口径：本 turn 第 2 次 `passed === false` 的 inspect_render）；④ 连续 2 轮调用了 execute_command 但 createdLabels 均为空。
- **A/B 决策规则（spec §4，Task 7 逐字执行）**：auto 双达标 → 确认默认；fast 双达标且总分 ≥ auto → 上报用户讨论；auto 任一不达标 → **停下报告用户**（reasoning_effort: low 兜底是用户裁决后的后续任务，本计划不实现）。
- **未经用户明确许可不执行 git push**（GitHub main 关联 Vercel 生产自动部署）；**任何构建环境禁设 `NEXT_PUBLIC_EVAL_BYPASS_AUTH`**。
- API key **值**不入代码/测试/日志/报告/会话文本；variant JSON 只存 env 变量**名**。
- 本机裸 `diff` 命令被劫持（对差异静默返回 0）——一切文件比对用 `git diff --no-index`。
- 注释用中文、贴合所在文件既有风格；测试命令：`pnpm test`（根，含 lib/*.test.ts）、`pnpm eval:unit`、`pnpm typecheck`。
- 不换模型、不加 UI 思考档位开关、不做 30 条扩容、不做 prompt v3（spec §2 非目标）。

---

### Task 1: lib/thinking.ts 三段式状态机（纯逻辑）

**Files:**
- Create: `lib/thinking.ts`
- Test: `lib/thinking.test.ts`

**Interfaces:**
- Consumes: 无（零依赖纯模块）。
- Produces: `type ThinkingMode = 'auto' | 'always' | 'never'`；`type ThinkingDecision = 'enabled' | 'disabled'`；`type Stage = 'PLAN' | 'EXECUTE' | 'RECOVER'`；`interface RoundSignal { execRan: boolean; execFailed: boolean; createdLabels: number; verifyFailed: boolean; inspectFailed: boolean }`；`const EMPTY_SIGNAL: RoundSignal`；`class ThinkingController`（`constructor(mode?: ThinkingMode)`、`currentStage: Stage`、`recoveryCount: number`、`thinkingFor(): ThinkingDecision`、`systemSuffix(): string | null`、`observeRound(s: RoundSignal): void`）。Task 3 引擎、Task 4 config-store 消费这些类型。

- [ ] **Step 1: 写失败测试**

创建 `lib/thinking.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { ThinkingController, EMPTY_SIGNAL } from './thinking';

// 便捷构造: 部分覆盖 EMPTY_SIGNAL
const sig = (o: Partial<typeof EMPTY_SIGNAL> = {}) => ({ ...EMPTY_SIGNAL, ...o });

describe('ThinkingController — auto 默认三段式', () => {
  it('第 1 轮 PLAN 思考开; 观察后落 EXECUTE 思考关', () => {
    const c = new ThinkingController('auto');
    expect(c.currentStage).toBe('PLAN');
    expect(c.thinkingFor()).toBe('enabled');
    c.observeRound(sig());
    expect(c.currentStage).toBe('EXECUTE');
    expect(c.thinkingFor()).toBe('disabled');
  });

  it('触发①: 连续 2 轮批失败 → RECOVER 思考开; 恢复一轮后回 EXECUTE', () => {
    const c = new ThinkingController('auto');
    c.observeRound(sig());                                     // PLAN → EXECUTE
    c.observeRound(sig({ execRan: true, execFailed: true }));  // 第 1 次失败, 不触发
    expect(c.currentStage).toBe('EXECUTE');
    c.observeRound(sig({ execRan: true, execFailed: true }));  // 连续第 2 次 → RECOVER
    expect(c.currentStage).toBe('RECOVER');
    expect(c.thinkingFor()).toBe('enabled');
    expect(c.systemSuffix()).toMatch(/恢复阶段/);
    c.observeRound(sig());                                     // RECOVER 一轮后回 EXECUTE
    expect(c.currentStage).toBe('EXECUTE');
    expect(c.thinkingFor()).toBe('disabled');
  });

  it('触发②: verify 失败立即 RECOVER(无需连续)', () => {
    const c = new ThinkingController('auto');
    c.observeRound(sig({ verifyFailed: true }));
    expect(c.currentStage).toBe('RECOVER');
  });

  it('触发③: 第 2 次 inspect 未过 → RECOVER(第 1 次不触发)', () => {
    const c = new ThinkingController('auto');
    c.observeRound(sig({ inspectFailed: true }));
    expect(c.currentStage).toBe('EXECUTE');
    c.observeRound(sig({ inspectFailed: true }));
    expect(c.currentStage).toBe('RECOVER');
  });

  it('触发④: 连续 2 轮 execute 零新建空转 → RECOVER', () => {
    const c = new ThinkingController('auto');
    c.observeRound(sig());
    c.observeRound(sig({ execRan: true, createdLabels: 0 }));
    expect(c.currentStage).toBe('EXECUTE');
    c.observeRound(sig({ execRan: true, createdLabels: 0 }));
    expect(c.currentStage).toBe('RECOVER');
  });

  it('恢复上限 2 次: 达上限后触发不再进 RECOVER(best-effort 继续)', () => {
    const c = new ThinkingController('auto');
    c.observeRound(sig());                                     // → EXECUTE
    c.observeRound(sig({ verifyFailed: true }));               // RECOVER #1
    c.observeRound(sig());                                     // → EXECUTE
    c.observeRound(sig({ verifyFailed: true }));               // RECOVER #2
    expect(c.recoveryCount).toBe(2);
    c.observeRound(sig());                                     // → EXECUTE
    c.observeRound(sig({ verifyFailed: true }));               // 已达上限, 不再升级
    expect(c.currentStage).toBe('EXECUTE');
    expect(c.recoveryCount).toBe(2);
  });

  it('阶段后缀: EXECUTE 注入执行指令, PLAN 不注入', () => {
    const c = new ThinkingController('auto');
    expect(c.systemSuffix()).toBeNull();                       // PLAN 轮: v2 prompt 已含规划要求
    c.observeRound(sig());
    expect(c.systemSuffix()).toMatch(/执行阶段/);
    expect(c.systemSuffix()).toMatch(/批量提交/);
  });
});

describe('ThinkingController — always / never 覆盖', () => {
  it('always: 恒 enabled, 不注入阶段后缀, 不因信号改阶段', () => {
    const c = new ThinkingController('always');
    c.observeRound(sig({ verifyFailed: true, execFailed: true }));
    expect(c.thinkingFor()).toBe('enabled');
    expect(c.systemSuffix()).toBeNull();
    expect(c.currentStage).toBe('PLAN');                       // 状态机不推进(无意义)
  });

  it('never: 恒 disabled', () => {
    const c = new ThinkingController('never');
    expect(c.thinkingFor()).toBe('disabled');
    c.observeRound(sig({ verifyFailed: true }));
    expect(c.thinkingFor()).toBe('disabled');
  });

  it('缺省构造 = auto', () => {
    expect(new ThinkingController().thinkingFor()).toBe('enabled');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/zhangyufen/claudecode/first_try/ggbfable/ggb-fable && pnpm test`
Expected: FAIL —— `Cannot find module './thinking'`（或等价模块不存在错误）。

- [ ] **Step 3: 实现 lib/thinking.ts**

```ts
// 三段式思考策略状态机(spec: docs/superpowers/specs/2026-08-19-speed-optimization-design.md §3.1)
// 纯逻辑无 IO: 引擎每轮 chat 前调 thinkingFor()/systemSuffix(), 工具跑完后调 observeRound() 回报信号。
//   PLAN(第 1 轮, 思考开) → EXECUTE(思考关) --触发--> RECOVER(思考开, 上限 2) --一轮--> EXECUTE
// thinking_mode: auto=三段式(默认) / always=全程思考(v1 基线语义) / never=全程关(fast 臂)。

export type ThinkingMode = 'auto' | 'always' | 'never';
export type ThinkingDecision = 'enabled' | 'disabled';
export type Stage = 'PLAN' | 'EXECUTE' | 'RECOVER';

// 一轮工具执行后的信号(由引擎从工具结果汇总, 全部来自现有结果字段)
export interface RoundSignal {
  execRan: boolean;        // 本轮调用过 execute_command
  execFailed: boolean;     // 本轮 ≥1 批次 failedCount > 0
  createdLabels: number;   // 本轮 execute_command 新建标签总数
  verifyFailed: boolean;   // 本轮 ≥1 verify_geometry 结果 ok === false
  inspectFailed: boolean;  // 本轮 ≥1 inspect_render 结果 passed === false
}

export const EMPTY_SIGNAL: RoundSignal = {
  execRan: false, execFailed: false, createdLabels: 0, verifyFailed: false, inspectFailed: false,
};

export const EXECUTE_SUFFIX = '【执行阶段】按既定规划继续执行, 不要重新整体规划; 剩余构造优先批量提交(一次 execute_command 传多条)。';
export const RECOVER_SUFFIX = '【恢复阶段】刚才的执行出现失败或空转。先从 failures 与画布上下文定位根因, 只修正被点名的问题后继续按既定规划执行, 不要从零重画。';

const RECOVERY_CAP = 2;

export class ThinkingController {
  private stage: Stage = 'PLAN';
  private recoveries = 0;
  private lastSignal: RoundSignal | null = null;   // 上一轮信号(observeRound 时作为 prev)
  private inspectFails = 0;

  constructor(private mode: ThinkingMode = 'auto') {}

  get currentStage(): Stage { return this.stage; }
  get recoveryCount(): number { return this.recoveries; }

  // 本轮 chat 的 thinking 参数(每轮 backend.chat 之前调用)
  thinkingFor(): ThinkingDecision {
    if (this.mode === 'always') return 'enabled';
    if (this.mode === 'never') return 'disabled';
    return this.stage === 'PLAN' || this.stage === 'RECOVER' ? 'enabled' : 'disabled';
  }

  // 阶段指令(注入本轮 system 后缀; PLAN 轮与 v2 prompt 规划要求重复, 不注入)
  systemSuffix(): string | null {
    if (this.mode !== 'auto') return null;
    if (this.stage === 'EXECUTE') return EXECUTE_SUFFIX;
    if (this.stage === 'RECOVER') return RECOVER_SUFFIX;
    return null;
  }

  // 工具跑完后回报本轮信号, 推进状态机(每轮 dispatchTool 全部结束后调用)
  observeRound(s: RoundSignal): void {
    if (s.inspectFailed) this.inspectFails++;
    if (this.mode !== 'auto') return;                        // always/never: 状态机不推进
    const prev = this.lastSignal;                            // 上一轮信号(s = 刚结束的这轮)
    this.lastSignal = s;
    if (this.stage === 'RECOVER') { this.stage = 'EXECUTE'; return; }  // 恢复一轮即回执行
    if (this.shouldEscalate(s, prev)) this.escalate();
    else if (this.stage === 'PLAN') this.stage = 'EXECUTE';  // 第 1 轮观察后即进入执行段
  }

  // 升级判定(spec §3.1 四触发): s=刚结束的这轮, prev=上一轮
  private shouldEscalate(s: RoundSignal, prev: RoundSignal | null): boolean {
    if (s.verifyFailed) return true;                          // ② verify 不达预期(单轮即触发)
    if (this.inspectFails >= 2) return true;                  // ③ 二次 inspect 仍有 issues
    if (s.execFailed && prev?.execFailed) return true;        // ① 连续 2 轮批失败
    if (s.execRan && s.createdLabels === 0
        && prev?.execRan && prev.createdLabels === 0) return true;   // ④ 连续 2 轮零新建空转
    return false;
  }

  private escalate(): void {
    if (this.recoveries >= RECOVERY_CAP) return;             // 达上限: 按现状 best-effort 收尾
    this.recoveries++;
    this.stage = 'RECOVER';
  }
}
```

语义锚点：`observeRound(s)` 中 `s` 恒为**刚结束的这轮**、`prev` 为上一轮；②③ 看当轮/本 turn 累计即触发，①④ 需要 s 与 prev 连续两轮。第 1 次 `observeRound` 后必落 EXECUTE（无触发时）。Step 1 测试即按此语义写死，实现与之冲突时修实现。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test`
Expected: PASS（thinking.test.ts 全绿，其余既有测试不红）。

- [ ] **Step 5: 提交**

```bash
git add lib/thinking.ts lib/thinking.test.ts
git commit -m "feat: 三段式思考策略状态机(PLAN/EXECUTE/RECOVER, 纯逻辑+单测)"
```

---

### Task 2: llm.ts thinking 透传 + parseSSE 思考流 + trial 路由

**Files:**
- Modify: `lib/llm.ts`（ChatParams、chatByok、chatTrial、parseSSE；新增 `thinkingFromBody` 导出）
- Modify: `app/api/trial/llm/route.ts:107-117`（upstreamBody 转发 thinking）
- Test: `lib/llm.test.ts`（新建）

**Interfaces:**
- Consumes: 无新依赖（Task 1 类型此任务不需要）。
- Produces: `ChatParams` 增 `thinking?: 'enabled' | 'disabled'` 与 `onThinking?: (delta: string) => void`；`export function thinkingFromBody(body: any): { type: 'enabled' | 'disabled' } | null`（trial 路由消费）。Task 3 的 AgentBackend.chat 与 agent-backend.ts 透传同名参数；parseSSE 行为变更：`delta.reasoning_content` 经第三参 onThinking 透出、不进 content。

- [ ] **Step 1: 写失败测试**

创建 `lib/llm.test.ts`：

```ts
// llm thinking 透传 + SSE reasoning_content 捕获(不发真实请求, fetch 全部打桩)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chatByok, chatTrial, thinkingFromBody } from './llm';

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });

// SSE 响应: chunks 为 delta 对象数组, 逐个包成 data: 行
const sseResp = (deltas: any[], status = 200) => {
  const body = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}`).join('\n\n')
    + '\n\ndata: [DONE]\n\n';
  return new Response(body, { status });
};
const cfg = { api_key: 'test-key', base_url: 'https://api.example.com/v1', model_name: 'test-model' };
const bodyOf = (call: number) => JSON.parse(fetchMock.mock.calls[call][1].body);

describe('chatByok — thinking 字段', () => {
  it('显式传 thinking → 请求体携带 {type}; 未传 → 不携带(厂商默认, 兼容非 deepseek 端点)', async () => {
    fetchMock.mockResolvedValue(sseResp([{ content: 'ok' }]));
    await chatByok({ messages: [{ role: 'user', content: 'hi' }], config: cfg, thinking: 'disabled' });
    expect(bodyOf(0).thinking).toEqual({ type: 'disabled' });

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(sseResp([{ content: 'ok' }]));
    await chatByok({ messages: [{ role: 'user', content: 'hi' }], config: cfg });
    expect(bodyOf(0).thinking).toBeUndefined();
  });

  it('端点 400 且带了 thinking → 去掉该字段重试一次', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('unknown field: thinking', { status: 400 }))
      .mockResolvedValueOnce(sseResp([{ content: 'ok' }]));
    const r = await chatByok({ messages: [{ role: 'user', content: 'hi' }], config: cfg, thinking: 'disabled' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(0).thinking).toEqual({ type: 'disabled' });
    expect(bodyOf(1).thinking).toBeUndefined();
    expect(r.content).toBe('ok');
  });
});

describe('parseSSE — reasoning_content 捕获(经 chatByok 驱动)', () => {
  it('思考增量走 onThinking, 不混入 content', async () => {
    fetchMock.mockResolvedValue(sseResp([
      { reasoning_content: '先想' }, { reasoning_content: '清楚' }, { content: '答案' },
    ]));
    const thoughts: string[] = [];
    const r = await chatByok({
      messages: [{ role: 'user', content: 'hi' }], config: cfg,
      onThinking: (d) => thoughts.push(d),
    });
    expect(thoughts.join('')).toBe('先想清楚');
    expect(r.content).toBe('答案');          // reasoning 不进 content/历史
  });

  it('无 onThinking 回调时 reasoning_content 被安全丢弃', async () => {
    fetchMock.mockResolvedValue(sseResp([{ reasoning_content: 'x' }, { content: 'y' }]));
    const r = await chatByok({ messages: [{ role: 'user', content: 'hi' }], config: cfg });
    expect(r.content).toBe('y');
  });
});

describe('chatTrial — thinking 透传到代理请求体', () => {
  // trial 响应体须是合法 SSE(空 body 会让 parseSSE 拿不到终止信号); token 头按真实路由回传
  const trialResp = () => new Response('data: [DONE]\n\n', { status: 200, headers: { 'x-trial-token': 't1' } });
  it('携带 {type} 与 trial_token; 未传则无 thinking 键', async () => {
    fetchMock.mockResolvedValue(trialResp());
    await chatTrial({
      messages: [{ role: 'user', content: 'hi' }],
      trialCtx: { token: null, setToken: () => {} },
      thinking: 'enabled',
    });
    expect(bodyOf(0).thinking).toEqual({ type: 'enabled' });
    expect(bodyOf(0).trial_token).toBeNull();

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(trialResp());
    await chatTrial({ messages: [{ role: 'user', content: 'hi' }], trialCtx: { token: 't0', setToken: () => {} } });
    expect(bodyOf(0).thinking).toBeUndefined();
  });
});

describe('thinkingFromBody — 路由侧白名单', () => {
  it('仅 enabled/disabled 放行, 其余丢弃', () => {
    expect(thinkingFromBody({ thinking: { type: 'enabled' } })).toEqual({ type: 'enabled' });
    expect(thinkingFromBody({ thinking: { type: 'disabled' } })).toEqual({ type: 'disabled' });
    expect(thinkingFromBody({ thinking: { type: 'fast' } })).toBeNull();
    expect(thinkingFromBody({})).toBeNull();
    expect(thinkingFromBody(null)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test`
Expected: FAIL —— `thinkingFromBody` 未导出；thinking 断言 `undefined` 不等于期望对象。

- [ ] **Step 3: 实现 llm.ts 修改**

3a. `ChatParams`（lib/llm.ts:37-43）加两个字段：

```ts
interface ChatParams {
  messages: any[];
  tools?: ToolDef[];
  config: LLMConfig;
  onToken?: (delta: string) => void;
  onThinking?: (delta: string) => void;              // 思考流(reasoning_content)增量, 仅展示
  thinking?: 'enabled' | 'disabled';                 // deepseek 思考模式开关; 缺省不携带=厂商默认
  signal?: AbortSignal;
}
```

3b. `parseSSE`（lib/llm.ts:81-147）签名加第三参，delta 处理段（:112-115 之前）插入：

```ts
async function parseSSE(
  body: ReadableStream<Uint8Array>,
  onToken?: (delta: string) => void,
  onThinking?: (delta: string) => void,
): Promise<AssistantMessage> {
  ...
      // 思考增量: 只透出展示, 不累积进 content(不写入 messages 历史、不回传 API)
      if (delta.reasoning_content) onThinking?.(delta.reasoning_content);
      if (delta.content) {
        content += delta.content;
        onToken?.(delta.content);
      }
```

3c. `chatByok`（:153-187）签名解构加 `onThinking, thinking`；body 组装与 400 兜底：

```ts
export async function chatByok({ messages, tools, config, onToken, onThinking, thinking, signal }: ChatParams): Promise<AssistantMessage> {
  if (!config.api_key || !config.base_url || !config.model_name) {
    throw new Error('LLM 配置不完整: 请填写 api_key / base_url / model_name');
  }

  const url = joinUrl(config.base_url, '/chat/completions');
  const body: any = {
    model: config.model_name,
    messages,
    temperature: config.temperature ?? 0.2,
    stream: true,
  };
  if (tools && tools.length) {
    body.tools = tools.map(normalizeTool);
    body.tool_choice = 'auto';
  }
  if (thinking) body.thinking = { type: thinking };   // 仅显式传入时携带; 缺省=厂商默认(兼容非 deepseek)

  const doFetch = (b: any) => fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.api_key}`,
    },
    body: JSON.stringify(b),
    signal,
  });

  let resp = await doFetch(body);
  // 端点不认 thinking 字段(部分 OpenAI 兼容端点 400) → 去掉该字段原样重试一次, 降级为厂商默认行为
  if (resp.status === 400 && body.thinking) {
    const fallback = { ...body };
    delete fallback.thinking;
    resp = await doFetch(fallback);
  }

  if (!resp.ok) {
    const txt = await safeText(resp);
    throw new Error(`LLM 请求失败 ${resp.status}: ${txt.slice(0, 500)}`);
  }
  if (!resp.body) throw new Error('当前环境不支持流式读取响应体');

  return parseSSE(resp.body as any, onToken, onThinking);
}
```

3d. `chatTrial`（:204-247）签名加 `thinking`，body 组装（:207-213 后）加一行，parseSSE 调用（:246）加第三参：

```ts
export async function chatTrial({
  messages, tools, trialCtx, model, onToken, onThinking, thinking, signal,
}: TrialChatParams): Promise<AssistantMessage> {
  const body: any = {
    model: model || 'deepseek',
    messages,
    temperature: 0.2,
    stream: true,
    trial_token: trialCtx.token || null,
  };
  if (thinking) body.thinking = { type: thinking };
  ...
  return parseSSE(resp.body as any, onToken, onThinking);
```

（`TrialChatParams extends Omit<ChatParams, 'config'>`，自动获得 onThinking/thinking。）

3e. 文件末尾新增导出（路由侧用）：

```ts
// trial 路由用: 从客户端请求体提取白名单 thinking(非法值一律丢弃, 不透传到上游)
export function thinkingFromBody(body: any): { type: 'enabled' | 'disabled' } | null {
  const t = body?.thinking?.type;
  return t === 'enabled' || t === 'disabled' ? { type: t } : null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test`
Expected: PASS。

- [ ] **Step 5: trial 路由转发**

`app/api/trial/llm/route.ts` 顶部 import 加：

```ts
import { thinkingFromBody } from '@/lib/llm';
```

第 4 步转发段（:107-117，`upstreamBody` 组装处）在 tools 块后追加：

```ts
  const thinking = thinkingFromBody(body);
  if (thinking) upstreamBody.thinking = thinking;
```

- [ ] **Step 6: typecheck + 全量测试**

Run: `pnpm typecheck && pnpm test`
Expected: 均通过（路由无独立测试基建，由 typecheck + Task 7 真实冒烟覆盖）。

- [ ] **Step 7: 提交**

```bash
git add lib/llm.ts lib/llm.test.ts app/api/trial/llm/route.ts
git commit -m "feat: thinking 参数透传(byok+trial+路由)与 parseSSE 思考流捕获"
```

---

### Task 3: agent.ts 引擎接入状态机 + hooks/信号汇总

**Files:**
- Modify: `lib/agent.ts`（AgentBackend.chat 签名 :16、AgentHooks :21-27、dispatchTool 返回值 :180-309、run 循环 :311-368）
- Modify: `lib/agent-backend.ts`（两处 chat 透传）
- Test: `lib/agent.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `ThinkingController / RoundSignal / EMPTY_SIGNAL / ThinkingMode`（`import ... from './thinking'`）；Task 2 的 chat 新参数。
- Produces: `AgentBackend.chat` 参数对象增 `thinking?: 'enabled' | 'disabled'`、`onThinking?: (d: string) => void`；`AgentHooks` 增 `onThinking?: (t: string) => void` 与 `onStage?: (stage: 'PLAN' | 'EXECUTE' | 'RECOVER', round: number) => void`；`run()` 的 `config` 增 `thinking_mode?: ThinkingMode`。dispatchTool 契约变更：**返回原始结果对象**（调用方负责 JSON.stringify 入 messages）。Task 4 的 ChatApp 消费 onThinking/onStage/thinking_mode。

- [ ] **Step 1: 写失败测试**

创建 `lib/agent.test.ts`：

```ts
// 引擎三段式接入: 用脚本化假 backend + 假 deps 驱动 run(), 验证逐轮 thinking/后缀/信号升级
import { describe, it, expect } from 'vitest';
import { AgentEngine, type AgentBackend, type AssistantMessage } from './agent';

// —— 假 deps: 只实现 dispatchTool 会碰到的最小面 ——
const makeDeps = (over: { execOk?: boolean; labels?: string } = {}) => {
  const execRow = (line: string) => ({
    cmd: line,
    ok: over.execOk !== false,
    labels: over.execOk !== false ? (over.labels ?? 'A') : '',
    error: over.execOk !== false ? '' : '命令未定义',
  });
  return {
    ggb: {
      getCanvasContext: async () => ({ elementCount: 0, elements: [] }),
      execBatch: async (t: string) => t.split('\n').filter(Boolean).map(execRow),
      measure: async () => ({ ok: true, value: '1', numeric: 1 }),
      getPNGBase64: () => 'data:image/png;base64,AAA',
      clearAll: async () => {},
      getAPI: () => ({}),
    },
    commandSearch: { search: async () => [], format: () => '' },
    logger: { toolCall: () => {}, turnEnd: () => {} },
    systemPrompt: 'SYS',
  } as any;
};

// 脚本化 backend: 依次吐出预设 assistant 消息, 记录每次 chat 的入参
class ScriptBackend implements AgentBackend {
  calls: Array<{ messages: any[]; thinking?: string }> = [];
  constructor(private script: AssistantMessage[]) {}
  async chat(p: any) {
    this.calls.push(p);
    p.onThinking?.('思考增量');   // 模拟上游思考流, 验证引擎把它透传给 hooks
    const next = this.script.shift();
    return next ?? { role: 'assistant' as const, content: '完成', tool_calls: undefined };
  }
  async vision() { return '验收通过'; }
  visionReady() { return true; }
}

const toolCall = (name: string, args: object) => ({
  id: `c_${name}_${Math.random()}`, type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});
const execTurn = (cmd = 'A=(1,1)') => ({ role: 'assistant' as const, content: '', tool_calls: [toolCall('execute_command', { command: cmd })] });
const finalTurn = { role: 'assistant' as const, content: '做好了', tool_calls: undefined };

describe('AgentEngine — 三段式思考策略', () => {
  it('auto: 第 1 轮 enabled 无后缀; 第 2 轮 disabled 且 system 临时后缀, 历史不被污染', async () => {
    const backend = new ScriptBackend([execTurn(), finalTurn]);
    const engine = new AgentEngine(makeDeps());
    const r = await engine.run({
      userInput: '画个点', history: [],
      config: { max_tool_rounds: 5, thinking_mode: 'auto' }, backend: backend as any,
    });
    expect(backend.calls[0].thinking).toBe('enabled');
    expect(backend.calls[0].messages[0].content).toBe('SYS');            // PLAN 轮无后缀
    expect(backend.calls[1].thinking).toBe('disabled');
    expect(backend.calls[1].messages[0].content).toContain('执行阶段');   // EXECUTE 轮后缀
    expect(r.messages[0].content).toBe('SYS');                            // 会话历史不残留后缀
    expect(r.finalText).toBe('做好了');
  });

  it('触发①: 连续 2 轮批失败 → 第 3 轮 RECOVER(enabled + 恢复后缀)', async () => {
    const deps = makeDeps({ execOk: false });
    const backend = new ScriptBackend([execTurn('Bad1'), execTurn('Bad2'), finalTurn]);
    const engine = new AgentEngine(deps);
    await engine.run({
      userInput: 'x', history: [],
      config: { max_tool_rounds: 6, thinking_mode: 'auto' }, backend: backend as any,
    });
    expect(backend.calls[2].thinking).toBe('enabled');
    expect(backend.calls[2].messages[0].content).toContain('恢复阶段');
  });

  it('触发④: 连续 2 轮零新建 → RECOVER', async () => {
    const deps = makeDeps({ execOk: true, labels: '' });   // 执行 ok 但 createdLabels 空
    const backend = new ScriptBackend([execTurn(), execTurn(), finalTurn]);
    const engine = new AgentEngine(deps);
    await engine.run({
      userInput: 'x', history: [],
      config: { max_tool_rounds: 6, thinking_mode: 'auto' }, backend: backend as any,
    });
    expect(backend.calls[2].thinking).toBe('enabled');
  });

  it('thinking_mode always/never 全程覆盖状态机', async () => {
    const bAlways = new ScriptBackend([execTurn(), execTurn(), finalTurn]);
    await new AgentEngine(makeDeps()).run({
      userInput: 'x', history: [], config: { max_tool_rounds: 6, thinking_mode: 'always' }, backend: bAlways as any,
    });
    expect(bAlways.calls.every((c) => c.thinking === 'enabled')).toBe(true);

    const bNever = new ScriptBackend([execTurn(), finalTurn]);
    await new AgentEngine(makeDeps()).run({
      userInput: 'x', history: [], config: { max_tool_rounds: 6, thinking_mode: 'never' }, backend: bNever as any,
    });
    expect(bNever.calls.every((c) => c.thinking === 'disabled')).toBe(true);
  });

  it('onThinking/onStage hooks 透传; tool 结果仍以 JSON 字符串入 messages', async () => {
    const backend = new ScriptBackend([execTurn(), finalTurn]);
    const stages: string[] = [];
    const thoughts: string[] = [];
    const engine = new AgentEngine(makeDeps());
    const r = await engine.run({
      userInput: 'x', history: [],
      config: { max_tool_rounds: 5, thinking_mode: 'auto' }, backend: backend as any,
      hooks: {
        onThinking: (t) => thoughts.push(t),
        onStage: (s) => stages.push(s),
      },
    });
    expect(thoughts.length).toBe(2);          // 每轮 chat 各一次(脚本 backend 主动调用)
    expect(stages[0]).toBe('PLAN');
    expect(stages[1]).toBe('EXECUTE');
    const toolMsg = r.messages.find((m) => m.role === 'tool');
    expect(typeof toolMsg.content).toBe('string');
    expect(JSON.parse(toolMsg.content).ok).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test`
Expected: FAIL —— `thinking_mode` 不在 config 类型里 / calls[1].thinking 为 undefined / 后缀不存在。

- [ ] **Step 3: 实现 agent.ts**

3a. 顶部 import 与接口（:13 附近、:15-27）：

```ts
import { ThinkingController, EMPTY_SIGNAL, type RoundSignal, type ThinkingMode } from './thinking';

export interface AgentBackend {
  chat(p: { messages: any[]; tools?: ToolDef[]; onToken?: (d: string) => void; onThinking?: (d: string) => void; thinking?: 'enabled' | 'disabled'; signal?: AbortSignal }): Promise<AssistantMessage>;
  vision(image: string, prompt: string, signal?: AbortSignal): Promise<string>;
  visionReady(): boolean;
}

export interface AgentHooks {
  onToken?: (t: string) => void;
  onThinking?: (t: string) => void;                                  // 思考流增量(reasoning_content)
  onStage?: (stage: 'PLAN' | 'EXECUTE' | 'RECOVER', round: number) => void;  // 阶段状态(UI 状态行)
  onToolStart?: (name: string, args: any) => void;
  onToolEnd?: (name: string, args: any, result: any) => void;
  onExec?: (cmd: string, result: any) => void;
  onRound?: (n: number, stopped?: boolean) => void;
}
```

3b. `dispatchTool` 返回值改原始对象（:180 签名 `Promise<string>` → `Promise<any>`；:189 的 `return JSON.stringify(...)` → `return { error: ... }`；:308 `return JSON.stringify(result)` → `return result;`）。

3c. `run()` 循环整体替换（:311-368）：

```ts
  async run({
    userInput, history, config, backend, hooks = {}, signal,
  }: {
    userInput: string;
    history: any[];
    config: { max_tool_rounds?: number; thinking_mode?: ThinkingMode };
    backend: AgentBackend;
    hooks?: AgentHooks;
    signal?: AbortSignal;
  }): Promise<AgentRunResult> {
    const messages: any[] = [
      { role: 'system', content: this.deps.systemPrompt },
      ...history,
      { role: 'user', content: userInput },
    ];
    const maxRounds = config.max_tool_rounds || 50;
    const tc = new ThinkingController(config.thinking_mode || 'auto');

    for (let round = 0; round < maxRounds; round++) {
      hooks.onRound?.(round + 1);
      if (signal?.aborted) throw new Error('已中止');

      // 阶段指令以本轮 system 临时后缀注入(浅拷贝, 不写入 messages 历史) —— prompt v2 本体不动
      const suffix = tc.systemSuffix();
      const chatMessages = suffix
        ? [{ ...messages[0], content: `${messages[0].content}\n\n${suffix}` }, ...messages.slice(1)]
        : messages;
      this.safeHook(hooks, 'onStage', tc.currentStage, round + 1);

      const assistant = await backend.chat({
        messages: chatMessages, tools: TOOLS, onToken: hooks.onToken,
        onThinking: hooks.onThinking, thinking: tc.thinkingFor(), signal,
      });
      messages.push(assistant);

      if (!assistant.tool_calls || !assistant.tool_calls.length) {
        const r: AgentRunResult = {
          messages,
          finalText: cleanFinalText(assistant.content || ''),
          toolHistory: collectTools(messages),
          stopped: false,
        };
        this.deps.logger.turnEnd({ finalText: r.finalText, toolCount: r.toolHistory.length, stopped: false });
        return r;
      }

      // 汇总本轮工具信号喂状态机(全部来自现有结果字段, 无新检测机制)
      const roundSignal: RoundSignal = { ...EMPTY_SIGNAL };
      for (const call of assistant.tool_calls) {
        const fnName = (call.function || call).name;
        const result = await this.dispatchTool(call, hooks, round + 1, messages, signal, backend);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
          _toolName: fnName,
        });
        if (fnName === 'execute_command') {
          roundSignal.execRan = true;
          if ((result?.failedCount || 0) > 0) roundSignal.execFailed = true;
          roundSignal.createdLabels += (result?.createdLabels || []).length;
        } else if (fnName === 'verify_geometry') {
          // 预算超限的 ok:false 也计入②——模型在无益空转, 升级恢复一轮合理(spec §3.1②"不达预期")
          if (result?.ok === false) roundSignal.verifyFailed = true;
        } else if (fnName === 'inspect_render') {
          if (result?.passed === false) roundSignal.inspectFailed = true;
        }
      }
      tc.observeRound(roundSignal);
    }

    hooks.onRound?.(maxRounds, true);
    const r: AgentRunResult = {
      messages,
      finalText: '(达到工具调用轮数上限, 已停止)',
      toolHistory: collectTools(messages),
      stopped: true,
    };
    this.deps.logger.turnEnd({ finalText: r.finalText, toolCount: r.toolHistory.length, stopped: true });
    return r;
  }
```

3d. `lib/agent-backend.ts` 两处 chat 透传（:12-13、:35-36）：

```ts
    chat: ({ messages, tools, onToken, onThinking, thinking, signal }) =>
      chatTrial({ messages, tools, trialCtx, model, onToken, onThinking, thinking, signal }),
```

```ts
    chat: ({ messages, tools, onToken, onThinking, thinking, signal }) =>
      chatByok({ messages, tools, config, onToken, onThinking, thinking, signal }),
```

- [ ] **Step 4: 跑测试 + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿（ChatApp 尚未传新参数——全是可选参数，typecheck 不破）。

- [ ] **Step 5: 提交**

```bash
git add lib/agent.ts lib/agent.test.ts lib/agent-backend.ts
git commit -m "feat: 引擎接入三段式思考状态机(逐轮 thinking+阶段后缀+信号升级+onThinking/onStage)"
```

---

### Task 4: ChatApp 思考流 UI + 阶段状态行 + thinking_mode 管道

**Files:**
- Modify: `lib/config-store.ts:14-16`（ByokProfile 增 thinking_mode）
- Modify: `components/ChatApp.tsx`（状态/refs/hooks、AssistantProgress、渲染块、generateTitle）
- Modify: `app/globals.css:119` 附近（.thinking-block/.thinking-text）

**Interfaces:**
- Consumes: Task 1 `ThinkingMode` 类型；Task 3 的 hooks `onThinking`/`onStage` 与 run config `thinking_mode`；Task 2 chatByok 的 `thinking` 参数。
- Produces: BYOK profile JSON 可携带 `thinking_mode`（Task 6 的 eval `buildByokPayload` 依赖此字段名）。

本任务无 React 测试基建（repo 无 testing-library），验证 = typecheck + pnpm test 回归 + 手动冒烟清单。

- [ ] **Step 1: config-store 类型**

`lib/config-store.ts` 头部 import 区加：

```ts
import type { ThinkingMode } from './thinking';
```

`ByokProfile`（:14-16）改：

```ts
export interface ByokProfile extends LLMConfig {
  name: string;
  thinking_mode?: ThinkingMode;   // 缺省 auto(三段式); eval 注入与高级用户手改 localStorage 用, 无 UI 开关
}
```

- [ ] **Step 2: ChatApp 状态与缓冲**

`components/ChatApp.tsx` —— UI 状态区（:196 `const [trace, ...]` 附近）加：

```ts
  // ── 三段式思考策略的 UI 态(spec §3.3): 阶段状态行 + 思考流折叠块 ──
  const [stage, setStage] = useState<{ stage: 'PLAN' | 'EXECUTE' | 'RECOVER'; round: number } | null>(null);
  const [thinkingText, setThinkingText] = useState('');
  const [thinkMsgId, setThinkMsgId] = useState<number | null>(null);   // 思考块挂在哪个 assistant 气泡
  const [thinkOpen, setThinkOpen] = useState(false);
  const [thinkSecs, setThinkSecs] = useState<number | null>(null);     // 回合结束后的"已思考 Ns"
  const thinkBufRef = useRef('');
  const thinkRafRef = useRef<number | null>(null);
  const thinkStartRef = useRef<number | null>(null);

  // 思考流 rAF 批量 flush(与正文 streamBuf 同模式, 避免每个增量一次 setState)
  const flushThink = useCallback(() => {
    thinkRafRef.current = null;
    setThinkingText(thinkBufRef.current);
  }, []);
  const scheduleThinkFlush = useCallback(() => {
    if (thinkRafRef.current == null) thinkRafRef.current = requestAnimationFrame(flushThink);
  }, [flushThink]);
```

- [ ] **Step 3: send() 接线**

3a. `send()` 里 `setTrace([]); setExecLines([]);`（:686-687）后追加重置：

```ts
    setStage(null);
    thinkBufRef.current = '';
    thinkStartRef.current = null;
    setThinkingText('');
    setThinkSecs(null);
    setThinkOpen(false);
```

3b. `const assistantMsg: Msg = {...}` 创建后（:704 `setMessages` 之前或之后均可，但必须在 run 之前）加：

```ts
    setThinkMsgId(assistantMsg.id);
```

3c. run 调用处（:748-751）config 与 hooks 增补：

```ts
      const result = await agentRef.current.run({
        userInput: finalText,
        history,
        config: {
          max_tool_rounds: config.maxToolRounds,
          // 三段式只认 byok profile 的 thinking_mode; trial 走引擎默认 auto
          thinking_mode: config.mode === 'byok' ? config.getActiveByok()?.thinking_mode : undefined,
        },
        backend,
        signal: controller.signal,
        hooks: {
          ...原有 hooks 不动...,
          onThinking: (delta) => {
            if (thinkStartRef.current == null) { thinkStartRef.current = Date.now(); setThinkOpen(true); }
            thinkBufRef.current += delta;
            scheduleThinkFlush();
          },
          onStage: (s, round) => setStage({ stage: s, round }),
        },
      });
```

3d. 成功路径 `flushStream();`（:784）后与 `finally` 里 `setSending(false);`（:833）前各加收尾（放 finally 一处即可，catch 亦覆盖）：

```ts
      // 思考流收尾: 折叠为"已思考 Ns"
      if (thinkRafRef.current != null) { cancelAnimationFrame(thinkRafRef.current); thinkRafRef.current = null; }
      flushThink();
      if (thinkStartRef.current != null) setThinkSecs(Math.max(1, Math.round((Date.now() - thinkStartRef.current) / 1000)));
      setThinkOpen(false);
      setStage(null);
```

（放入 `finally` 块 `setSending(false)` 之前。）

- [ ] **Step 4: AssistantProgress 阶段状态行**

组件外 `PHASE_LABEL`（:54-61）后加：

```ts
const STAGE_LABEL: Record<'PLAN' | 'EXECUTE' | 'RECOVER', string> = {
  PLAN: '规划中', EXECUTE: '执行中', RECOVER: '恢复中',
};
```

`AssistantProgress`（:64-99）签名与判定链改（ocr > 进行中工具 > 阶段 > 全部完成 > 默认）：

```tsx
function AssistantProgress({ msg, trace, stage }: {
  msg: Msg; trace: TraceItem[];
  stage: { stage: 'PLAN' | 'EXECUTE' | 'RECOVER'; round: number } | null;
}) {
  const phases = trace.filter((t) => PHASE_LABEL[t.name]);
  const ocrLoading = msg.ocr?.state === 'loading';
  const activeIdx = phases.findIndex((t) => t.result == null);
  const hasPhases = phases.length > 0;
  const allDone = hasPhases && activeIdx < 0;

  let label: string;
  let showSpinner = true;
  if (ocrLoading) {
    label = '图片识别中';
  } else if (activeIdx >= 0) {
    label = PHASE_LABEL[phases[activeIdx].name] || phases[activeIdx].name;
  } else if (stage) {
    // 阶段状态行(工具间隙的 LLM 调用期): 规划中 / 执行第 N 步 / 恢复中
    label = stage.stage === 'EXECUTE' ? `执行第 ${Math.max(1, stage.round - 1)} 步` : STAGE_LABEL[stage.stage];
  } else if (allDone) {
    label = '正在组织回复';
  } else {
    label = '正在思考';
  }
  /* spinner/渲染 JSX 原样保留 */
```

调用处（:1089）改 `<AssistantProgress msg={m} trace={trace} stage={stage} />`。

- [ ] **Step 5: 思考流折叠块渲染**

assistant 气泡分支（:1077-1091）在 ocr-block 之后、`preText ?` 之前插入：

```tsx
                    {m.id === thinkMsgId && thinkingText && (
                      <div className="thinking-block">
                        <button type="button" className="ocr-toggle" onClick={() => setThinkOpen((v) => !v)}>
                          {m.streaming
                            ? `思考中…（点击${thinkOpen ? '收起' : '展开'}）`
                            : `已思考 ${thinkSecs ?? '—'}s ▾`}
                        </button>
                        {thinkOpen && <pre className="thinking-text">{thinkingText.slice(-2000)}</pre>}
                      </div>
                    )}
```

- [ ] **Step 6: generateTitle 关思考**

byok 分支 chatByok 调用（:852-858）参数加 `thinking: 'disabled'`（标题生成无需 CoT，省 10-30s 思考税）：

```ts
          const msg = await chatByok({
            messages: [...原样...],
            config: { api_key: prof.api_key, base_url: prof.base_url, model_name: prof.model_name },
            thinking: 'disabled',
          });
```

- [ ] **Step 7: globals.css**

`app/globals.css` 在 `.ocr-block` 附近（:119-124 区域后）加：

```css
/* 思考流折叠块(三段式思考策略 spec §3.3) */
.thinking-block { margin-bottom: 6px; min-width: 0; max-width: 100%; }
.thinking-text { margin: 6px 0 0; padding: 8px 10px; background: #f5f5f7; border-radius: 8px; font-size: 12px; color: #6b7280; white-space: pre-wrap; word-break: break-word; max-height: 180px; overflow-y: auto; font-family: inherit; }
```

- [ ] **Step 8: 机器验证**

Run: `pnpm typecheck && pnpm test`
Expected: 通过（可选参数接线，无破坏性签名变更）。

- [ ] **Step 9: 手动冒烟（dev 真实模型）**

Run: `pnpm dev`，浏览器开 `/app`，BYOK 配 deepseek（或登录用 trial）。发送示例「画一个圆，作出它的内接正六边形，用不同颜色区分圆和六边形」，核对清单：

1. 状态行依次出现「规划中…→ 构造图形（或 执行第 N 步）→ 视觉核验 → 正在组织回复」；
2. 第 1 轮出现「思考中…（点击收起/展开）」块且展开流式增长；执行阶段不再增长；回合结束折叠为「已思考 Ns ▾」；
3. 画布正确产出六边形（回归未破）；
4. 中止（点停止）不报错、空气泡清理逻辑不变。

Expected: 全部符合。不符合则回到 Step 2 修。

- [ ] **Step 10: 提交**

```bash
git add lib/config-store.ts components/ChatApp.tsx app/globals.css
git commit -m "feat: 思考流折叠块+阶段状态行+thinking_mode 管道(BYOK profile 透传)"
```

---

### Task 5: eval 延迟度量 + 超时独立分类 + 采样并行

**Files:**
- Modify: `eval/lib/types.mjs`（validateCase 加 timeoutMs 校验）
- Modify: `eval/lib/runner.mjs`（runSample 计时+timedOut 上下文；runOneCase 并行）
- Modify: `eval/lib/templates.mjs:87-96`（process_no_error 超时分支）
- Modify: `eval/lib/aggregate.mjs`（median 导出 + 分桶 p50Ms + timeout_incomplete 自然成类）
- Modify: `eval/lib/report.mjs`（延迟分布段 + runs/条数参数化）
- Modify: `eval/scripts/run.mjs:73-77`（timeoutMs 取 case 字段）
- Test: `eval/lib/templates.test.mjs`、`eval/lib/aggregate.test.mjs`、`eval/lib/types.test.mjs`、`eval/lib/report.test.mjs`（均增补）

**Interfaces:**
- Consumes: 无（纯 eval 内部）。
- Produces: SampleResult 增 `durationMs: number`（ok 采样必有）；断言 failureClass 新值 `timeout_incomplete`；聚合 buckets 各项增 `p50Ms: number | null`；`export function median(xs: number[]): number | null`；case schema 增可选 `timeoutMs: number`（正数毫秒）。Task 6/7 消费。

- [ ] **Step 1: 写失败测试（四个文件各增补，先全写完再跑）**

`eval/lib/types.test.mjs` 末尾追加：

```js
describe('timeoutMs 校验', () => {
  const base = { id: 'a', prompt: 'p', category: 'basics', assertions: [{ kind: 'process_no_error' }] };
  it('可选; 传了必须是正数(毫秒)', () => {
    expect(validateCase(base).ok).toBe(true);
    expect(validateCase({ ...base, timeoutMs: 420000 }).ok).toBe(true);
    expect(validateCase({ ...base, timeoutMs: '420000' }).errors).toContain('timeoutMs 必须是正数(毫秒)');
    expect(validateCase({ ...base, timeoutMs: 0 }).errors).toContain('timeoutMs 必须是正数(毫秒)');
  });
});
```

`eval/lib/templates.test.mjs` 末尾追加（沿用该文件既有 evaluateAssertion 调用形态；无 turn_end + 有 error 事件的超时强停场景）：

```js
describe('process_no_error 超时独立分类', () => {
  const ctx = (timedOut) => ({
    canvas: { elements: [], freeVars: [] },
    events: [{ type: 'error' }, { type: 'turn_end', stopped: true }],
    appletEval: async () => ({ ok: false, value: '?' }),
    timedOut,
  });
  it('timedOut 采样 → timeout_incomplete(不判 process_error)', async () => {
    const r = await evaluateAssertion({ kind: 'process_no_error' }, ctx(true));
    expect(r.passed).toBe(false);
    expect(r.failureClass).toBe('timeout_incomplete');
  });
  it('非超时路径不受影响(仍判 process_error)', async () => {
    const r = await evaluateAssertion({ kind: 'process_no_error' }, ctx(false));
    expect(r.failureClass).toBe('process_error');
  });
});
```

`eval/lib/aggregate.test.mjs`：import 行加 `median`；既有两条 `expect(r.buckets.basics).toEqual({ total: 1, passed: 1, rate: 1 })` 与 traps 同款**各补 `p50Ms: null`**；末尾追加：

```js
describe('median 与分桶 p50', () => {
  // 带延迟的采样: 复用文件头部 s() 辅助, 补 durationMs 字段
  const sd = (ok, dur, kindResults) => ({ ...s(ok, kindResults), durationMs: dur });
  it('median: 奇数取中 / 偶数取均值 / 空为 null', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
  it('p50 只统计 ok 采样的 durationMs; run_error 采样不计入', () => {
    const r = aggregate([{ id: 'a', category: 'basics', majorityPassed: true, samples: [
      sd(true, 9000, [['object_exists', true]]),
      sd(true, 10000, [['object_exists', true]]),
      sd(true, 30000, [['object_exists', true]]),
      { ok: false, error: 'x', assertions: [], stats: null, durationMs: 99000 },
    ] }]);
    expect(r.buckets.basics.p50Ms).toBe(10000);
  });
  it('timeout_incomplete 独立成类, 不并入 process_error', () => {
    const r = aggregate([{ id: 't', category: 'traps', majorityPassed: false, samples: [s(true, [['process_no_error', false, 'timeout_incomplete']])] }]);
    expect(r.failureDist).toEqual({ timeout_incomplete: 1 });
  });
});
```

`eval/lib/report.test.mjs` 末尾追加：

```js
  it('延迟分布段渲染分桶 P50', () => {
    const withLatency = renderMarkdown({
      ...results,
      buckets: { ...results.buckets, basics: { total: 1, passed: 1, rate: 1, p50Ms: 12345 } },
    });
    expect(withLatency).toContain('延迟分布');
    expect(withLatency).toContain('12.3s');
  });
  it('边界信号/覆盖声明按 runs 与条数参数化(runs=2)', () => {
    const md2 = renderMarkdown({ ...results, variant: { ...results.variant, runs_per_case: 2 } });
    expect(md2).toContain('2 次中有 1 次通过');
    expect(md2).toContain(`这 ${results.cases.length} 条用例`);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm eval:unit`
Expected: FAIL —— median 未导出、p50Ms 断言失败、timeout_incomplete 不存在、延迟分布缺失。

- [ ] **Step 3: 实现四处**

3a. `eval/lib/types.mjs` `validateCase` 末尾 `return { ok: errors.length === 0, errors };`（:48）之前加：

```js
  if (c.timeoutMs !== undefined && (typeof c.timeoutMs !== 'number' || !(c.timeoutMs > 0))) errors.push('timeoutMs 必须是正数(毫秒)');
```

3b. `eval/lib/templates.mjs` `process_no_error`（:87-96）头部插超时分支：

```js
    case 'process_no_error': {
      // runner 超时强停: 轨迹必然不完整(turn_end 缺失/强停注入 error), 不足以判"过程出错"——
      // 记 timeout_incomplete 边界信号, 与真实 process_error 分离(spec §3.4)
      if (ctx.timedOut) return result(a, false, 'timeout_incomplete', 'runner 超时强停, 过程轨迹不完整');
      const turnEnd = (events || []).filter((e) => e.type === 'turn_end').pop();
      /* 其余原样不动 */
```

3c. `eval/lib/runner.mjs`：runSample 计时与 timedOut 上下文（整函数按下面替换），runOneCase 并行：

```js
async function runSample(browser, case_, opts) {
  const { page, events } = await openPage(browser, opts);
  try {
    await settleReady(page);
    const t0 = Date.now();   // 端到端延迟: 发送 → 回合收尾(含 drain), spec §3.4 durationMs
    const feed = await feedAndWait(page, case_.prompt, { timeoutMs: opts.timeoutMs });
    if (feed === 'timeout') {
      await page.click('button.send-btn.stop').catch(() => {});
      await drainEvents(page, events, { waitMs: 2000 });
    } else {
      await drainEvents(page, events);
    }
    const durationMs = Date.now() - t0;
    const stats = statsFromEvents(events);
    // feedAndWait 瞬回 done 或超时卡死且 0 轮无 finalText = 引擎未就绪(send 静默早退的已知签名)——
    // 编排层故障归 run_error, 不进断言评分(否则记成模型失败, 污染失败归因分布)。
    if (stats.rounds === 0 && !stats.finalText) {
      return { ok: false, error: 'engine_not_ready: 0 tool rounds and no finalText', assertions: [], stats };
    }
    const xml = await captureCanvas(page);
    const canvas = parseCanvasXml(xml);
    // timedOut 入上下文: 超时采样的过程断言改记 timeout_incomplete, 不再误判 process_error
    const assertions = await evaluateAll(case_.assertions, { canvas, events, appletEval: makeAppletEval(page), timedOut: feed === 'timeout' });
    return { ok: true, timedOut: feed === 'timeout', durationMs, assertions, stats };
  } finally {
    await page.close();
  }
}

export async function runOneCase(browser, case_, opts) {
  // 采样并行(各开独立 page/context, Playwright newPage 每页独立 context)——campaign 墙钟约 ÷runs。
  // opts.serial=true 退回串行(spec §6: 上游 429 限流时的降级开关, CLI --serial 传入)。
  // 逐采样兜底为 run_error, 单采样崩溃不拖垮整条用例(与原串行语义一致)。
  const one = async () => {
    try {
      return await runSample(browser, case_, opts);
    } catch (e) {
      return { ok: false, error: String(e?.message || e), assertions: [], stats: null };
    }
  };
  const samples = [];
  if (opts.serial) {
    for (let i = 0; i < opts.runs; i++) samples.push(await one());
  } else {
    samples.push(...await Promise.all(Array.from({ length: opts.runs }, one)));
  }
  return buildCaseResult(case_, samples);
}
```

3d. `eval/lib/aggregate.mjs`：导出 median + buckets 初始化与统计（`aggregate` 函数内）：

```js
export function median(xs) {
  if (!xs || !xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function aggregate(caseResults) {
  const buckets = Object.fromEntries(CATEGORIES.map((cat) => [cat, { total: 0, passed: 0, rate: 0, p50Ms: null }]));
  const assertionStats = {};
  const failureDist = {};
  const durations = {};   // bucket → ok 采样的 durationMs 列表
  let total = 0, passed = 0;

  for (const cr of caseResults) {
    total++;
    if (cr.majorityPassed) passed++;
    const b = buckets[cr.category] || (buckets[cr.category] = { total: 0, passed: 0, rate: 0, p50Ms: null });
    b.total++;
    if (cr.majorityPassed) b.passed++;
    for (const sm of cr.samples) {
      if (sm.ok && typeof sm.durationMs === 'number') {
        (durations[cr.category] || (durations[cr.category] = [])).push(sm.durationMs);
      }
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
  for (const [cat, ds] of Object.entries(durations)) if (buckets[cat]) buckets[cat].p50Ms = median(ds);
  return { buckets, assertionStats, failureDist, overall: { total, passed, rate: total ? passed / total : 0 } };
}
```

3e. `eval/lib/report.mjs`：分桶表后加延迟分布段；边界信号/覆盖声明参数化：

```js
  L.push('## 延迟分布（分桶采样 P50）', '');
  L.push('| 桶 | P50 |');
  L.push('|---|---|');
  for (const [cat, b] of Object.entries(buckets)) {
    L.push(`| ${cat} ${CATEGORY_LABELS[cat] || ''} | ${b.p50Ms == null ? '—' : (Math.round(b.p50Ms / 100) / 10) + 's'} |`);
  }
  L.push('');
```

```js
  // runs=2 时区间退化成 "1 次通过"(不写难看的 "1–1")
  const edgeRange = v.runs_per_case > 2 ? `1–${v.runs_per_case - 1}` : '1';
  L.push(`## 边界信号（${v.runs_per_case} 次中有 ${edgeRange} 次通过：不稳定而非全坏）`, '');
  const edge = cases.filter((c) => c.passVotes > 0 && !c.majorityPassed);
  L.push(edge.length ? edge.map((c) => `- \`${c.id}\`: ${c.passVotes}/${v.runs_per_case}`).join('\n') : '- （无）');
```

```js
  L.push(`- 本报告只证明：这 ${cases.length} 条用例在该 variant 配置下的多数决成功率与失败分类。`);
```

3f. `eval/scripts/run.mjs`：文件头 CLI 注释（:1）补 `--serial`；runOneCase 调用处（:73-77）opts 改：

```js
  const r = await runOneCase(browser, c, {
    baseUrl, promptVersion: v.prompt_version, promptText,
    variant: resolved, temperature: v.temperature, maxToolRounds: v.max_tool_rounds,
    runs,
    timeoutMs: c.timeoutMs || 180000,   // 每用例可覆盖(spec §3.4; 默认 180s)
    serial: args.serial === true,       // 429 限流时的降级开关(spec §6)
  });
```

- [ ] **Step 4: 跑 eval 单测确认通过**

Run: `pnpm eval:unit`
Expected: PASS（含既有测试——buckets toEqual 已在 Step 1 补 p50Ms: null）。

- [ ] **Step 5: 根测试回归 + 提交**

Run: `pnpm test && pnpm typecheck`
Expected: 通过。

```bash
git add eval/lib/types.mjs eval/lib/types.test.mjs eval/lib/templates.mjs eval/lib/templates.test.mjs eval/lib/runner.mjs eval/lib/aggregate.mjs eval/lib/aggregate.test.mjs eval/lib/report.mjs eval/lib/report.test.mjs eval/scripts/run.mjs
git commit -m "feat(eval): durationMs+分桶P50+超时独立分类(timeout_incomplete)+采样并行"
```

---

### Task 6: 三臂 variants + thinking_mode 注入 + budget 用例 420s

**Files:**
- Modify: `eval/variants/deepseek-v2.json`（增 `"thinking_mode": "always"`）
- Create: `eval/variants/deepseek-v2-auto.json`、`eval/variants/deepseek-v2-fast.json`
- Modify: `eval/scripts/run.mjs`（resolved 增 thinking_mode 并透传/入 results.variant）
- Modify: `eval/lib/browser.mjs:9-21`（buildByokPayload profile 增 thinking_mode）
- Modify: `eval/cases/trap-budget-unit-circle.json`（增 `"timeoutMs": 420000`）
- Test: `eval/lib/browser.test.mjs`（新建）

**Interfaces:**
- Consumes: Task 4 的 ByokProfile.thinking_mode 字段名；Task 5 的 case timeoutMs。
- Produces: 三臂 variant 名称 `deepseek-v2`(always，锁定 v1 基线语义) / `deepseek-v2-auto`(auto) / `deepseek-v2-fast`(never)；variant schema 增可选 `thinking_mode`。Task 7 逐臂消费。

- [ ] **Step 1: 写失败测试**

创建 `eval/lib/browser.test.mjs`：

```js
import { describe, it, expect } from 'vitest';
import { buildByokPayload } from './browser.mjs';

const variant = {
  llm: { api_key: 'k', base_url: 'https://x/v1', model_name: 'm' },
  vision: { api_key: 'k', base_url: 'https://x/v1', model_name: 'v' },
  embedding: { api_key: 'k', base_url: 'https://x/v1', model_name: 'e' },
};

describe('buildByokPayload — thinking_mode 注入', () => {
  it('variant 带 thinking_mode → 写入 profile(引擎经 Task 4 管道消费)', () => {
    const p = buildByokPayload({ variant: { ...variant, thinking_mode: 'never' }, temperature: 0.2, maxToolRounds: 30 });
    expect(p.state.byokProfiles[0].thinking_mode).toBe('never');
  });
  it('缺省 → auto', () => {
    const p = buildByokPayload({ variant, temperature: 0.2, maxToolRounds: 30 });
    expect(p.state.byokProfiles[0].thinking_mode).toBe('auto');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm eval:unit`
Expected: FAIL —— payload 无 thinking_mode（undefined ≠ 'never'/'auto'）。

- [ ] **Step 3: 实现**

3a. `eval/lib/browser.mjs` `buildByokPayload` profile 加一行：

```js
      model_name: variant.llm.model_name, temperature,
      thinking_mode: variant.thinking_mode || 'auto',
```

3b. `eval/scripts/run.mjs` resolved（:47-55）增字段并透传：

```js
const resolved = {
  name: v.name,
  prompt_version: v.prompt_version,
  temperature: v.temperature,
  max_tool_rounds: v.max_tool_rounds,
  thinking_mode: v.thinking_mode || 'auto',
  runs_per_case: parseInt(String(args.runs || v.runs_per_case || 3), 10),
  model: process.env[v.llm.model_env],
  llm: resolve(v.llm), vision: resolve(v.vision), embedding: resolve(v.embedding),
};
```

启动日志（:61）追加 thinking 显示，results.variant（:84）增 `thinking_mode: resolved.thinking_mode`：

```js
console.log(`eval: variant=${resolved.name} model=${resolved.model} prompt=${v.prompt_version} temp=${v.temperature} thinking=${resolved.thinking_mode} runs=${runs} cases=${cases.length}`);
```

```js
const results = { variant: { name: resolved.name, prompt_version: v.prompt_version, model: resolved.model, temperature: v.temperature, max_tool_rounds: v.max_tool_rounds, thinking_mode: resolved.thinking_mode, runs_per_case: runs }, ... };
```

3c. `eval/variants/deepseek-v2.json` 全文替换为（只增 thinking_mode 一行，键序如下）：

```json
{
  "name": "deepseek-v2",
  "prompt_version": "v2",
  "thinking_mode": "always",
  "temperature": 0.2,
  "max_tool_rounds": 30,
  "runs_per_case": 3,
  "llm": { "api_key_env": "DEEPSEEK_API_KEY", "base_url_env": "DEEPSEEK_BASE_URL", "model_env": "DEEPSEEK_MODEL" },
  "vision": { "api_key_env": "GLM_API_KEY", "base_url_env": "GLM_BASE_URL", "model_env": "GLM_VISION_MODEL" },
  "embedding": { "api_key_env": "GLM_API_KEY", "base_url_env": "GLM_BASE_URL", "model_env": "GLM_EMBEDDING_MODEL" }
}
```

3d. 创建 `eval/variants/deepseek-v2-auto.json`（同上，仅 name 与 thinking_mode 不同）：

```json
{
  "name": "deepseek-v2-auto",
  "prompt_version": "v2",
  "thinking_mode": "auto",
  "temperature": 0.2,
  "max_tool_rounds": 30,
  "runs_per_case": 3,
  "llm": { "api_key_env": "DEEPSEEK_API_KEY", "base_url_env": "DEEPSEEK_BASE_URL", "model_env": "DEEPSEEK_MODEL" },
  "vision": { "api_key_env": "GLM_API_KEY", "base_url_env": "GLM_BASE_URL", "model_env": "GLM_VISION_MODEL" },
  "embedding": { "api_key_env": "GLM_API_KEY", "base_url_env": "GLM_BASE_URL", "model_env": "GLM_EMBEDDING_MODEL" }
}
```

3e. 创建 `eval/variants/deepseek-v2-fast.json`（同 3d，`"name": "deepseek-v2-fast"`、`"thinking_mode": "never"`）。

3f. `eval/cases/trap-budget-unit-circle.json` `"category": "traps",` 行后加：

```json
  "timeoutMs": 420000,
```

- [ ] **Step 4: 测试与回归**

Run: `pnpm eval:unit && pnpm test && node --env-file=.env.local eval/scripts/run.mjs --variant eval/variants/deepseek-v2-auto.json --list`
Expected: 单测全绿；--list 正常列出 10 条（含 `_` 前缀排除语义不变）。

- [ ] **Step 5: 提交**

```bash
git add eval/variants/ eval/lib/browser.mjs eval/lib/browser.test.mjs eval/scripts/run.mjs eval/cases/trap-budget-unit-circle.json
git commit -m "feat(eval): 三臂 thinking_mode variants(always/auto/fast)+budget 用例 420s 上限"
```

---

### Task 7: 三模式冒烟 + 三臂 A/B 官方跑 + 决策报告

**Files:**
- Create: `docs/eval-report-speed-ab.md`（决策报告）

**Interfaces:**
- Consumes: Task 5/6 的全部产物（三 variants、durationMs/P50、timeout_incomplete、420s 上限）；Task 1-4 的 app 侧行为（eval 经真实 app 驱动）。
- Produces: 三臂实测数据 + 默认档决策结论（用户裁决材料）。

前置：`pnpm dev` 在 localhost:3000 跑着、`.env.local` 齐全（DEEPSEEK_*/GLM_*）。**本任务不 push、不部署。**

- [ ] **Step 1: 三模式 _selftest 冒烟（真实 LLM）**

```bash
pnpm eval --variant eval/variants/deepseek-v2.json --case _selftest
pnpm eval --variant eval/variants/deepseek-v2-auto.json --case _selftest
pnpm eval --variant eval/variants/deepseek-v2-fast.json --case _selftest
```

Expected: 三次均正常完成（用例通过或如实计分均可——冒烟验证的是管道不炸：thinking 字段被端点接受、思考流不炸 parseSSE、结果文件含 durationMs）。任一臂报 4xx/解析错误 → 停下按 Task 2 的 400 兜底与 thinkingFromBody 白名单排查，修完重跑。

- [ ] **Step 2: 三臂官方跑（各 10 条 × 3 采样，长任务）**

```bash
pnpm eval --variant eval/variants/deepseek-v2.json
# 后两臂带 --compare 指向前一臂产物, stdout 直接出 variant × category 对比矩阵(spec §3.4⑤); 矩阵数据并入 Step 4 报告
pnpm eval --variant eval/variants/deepseek-v2-auto.json --compare eval/reports/<当日YYYYMMDD>-deepseek-v2.results.json
pnpm eval --variant eval/variants/deepseek-v2-fast.json --compare eval/reports/<当日YYYYMMDD>-deepseek-v2-auto.results.json
```

Expected: `eval/reports/` 各产出 `YYYYMMDD-<variant>.results.json/.md`（三臂名不同，无同日覆盖）；报告含「延迟分布」段；若有超时采样，失败分类出现 `timeout_incomplete` 而**非** process_error。记录三臂墙钟耗时（console 时间戳即可）。

- [ ] **Step 3: 按 spec §4 判据逐臂判定（数据从三份 results.json 提取）**

| 臂 | 质量门 | 延迟门 |
|---|---|---|
| always | 总 ≥80% 且 basics/func/dyn/multi 各 2/2 | （基线臂，只记录不作决策输入） |
| auto | 同上 | budget 用例 P50 ≤60s 且 basics 桶 P50 ≤15s |
| fast | 同上 | 同上 |

外加超时干净度：三臂 failureDist 中 `process_error` 不含超时强停样本（对照 `timedOut` 采样与 failureDist 分布）。

- [ ] **Step 4: 写决策报告**

创建 `docs/eval-report-speed-ab.md`，结构（数字全部取自三份 results.json，禁止手填估计）：

```markdown
# 速度优化 A/B 报告 · 三臂 thinking_mode

- 日期: YYYY-MM-DD ｜ model: deepseek-v4-flash ｜ prompt_version: v2 ｜ 判据: spec §4

## 三臂总览

| 臂 | thinking_mode | 总成功率 | 四正桶 | traps | budget P50 | basics P50 | 超时采样数 | 墙钟 |
|---|---|---|---|---|---|---|---|---|
| deepseek-v2 | always | …% (n/10) | … | … | …s | …s | … | … |
| deepseek-v2-auto | auto | … | … | … | … | … | … | … |
| deepseek-v2-fast | never | … | … | … | … | … | … | … |

## 判定（逐条对照 spec §4）

1. auto 双达标: 是/否 ——（质量 …；延迟 …）
2. fast 双达标且总分 ≥ auto: 是/否 ——…
3. 超时干净度: …（timeout_incomplete 独立成类, process_error 不含强停样本）

## 决策

- 默认档: auto（或按判据 2/3 的结论写）
- （若 auto 任一不达标）: 已停止, 待用户裁决回退链（reasoning_effort: low 重跑 → 默认改 always）

## 归因与观察

（各臂失败明细差异、auto 档 PLAN 轮耗时分布、EXECUTE 轮是否出现新增失败模式、429 退串行是否发生）
```

- [ ] **Step 5: 决策门**

按 Global Constraints 的 A/B 决策规则执行：
- auto 双达标 → 报告结论「确认 auto 默认」；
- fast 双达标且总分 ≥ auto → 结论写「fast 可讨论替代默认」，**提交用户裁决，不自行改默认**；
- auto 任一不达标 → **停在此步，向用户报告数据与回退链选项**（reasoning_effort 探针 / 默认回 always），不继续。

- [ ] **Step 6: 全量回归 + 提交**

Run: `pnpm test && pnpm typecheck`
Expected: 通过。

```bash
git add docs/eval-report-speed-ab.md
git commit -m "docs: 速度优化三臂 A/B 报告与默认档决策记录"
```

（eval/reports/ 是 gitignored，不入库。）
