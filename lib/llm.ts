// LLM 客户端 —— OpenAI 兼容协议 (/v1/chat/completions)
// 支持功能: function calling, SSE 流式输出(assistant 文本)
//
// 两路请求(BYOK / 试用 共用同一套 SSE 解析逻辑):
//   - chatByok():   BYOK 模式, 前端直连用户配置的厂商, key 来自 localStorage 永不上传
//   - chatTrial():  试用模式, 走后端 /api/trial/llm 代理(后端注入我的 key + 限额 + trial_token)
//
// trial_token 机制: 一次用户发送(Agent 多轮工具循环)内复用同一 token 免重复扣次数。
//   首次请求不带 token → 后端扣 1 次并签发 token(放响应头 x-trial-token);
//   后续请求带该 token → 后端验签不扣次数, 直到超时(默认 15min)。

export interface LLMConfig {
  api_key: string;
  base_url: string;
  model_name: string;
  temperature?: number;
  max_tool_rounds?: number;
  dimensions?: number;          // embedding 向量维度(默认 1024)
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: object;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  // 思考内容(deepseek reasoning_content): 保留在消息上随历史回传——
  // thinking enabled 请求若历史中带 tool_calls 的 assistant 不回传该字段会被端点 400(Task 8 探针证实),
  // 且 disabled 请求带该字段也被接受(2026-08-19 探针) → 恒回传, 组装侧不过滤。
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export type ReasoningEffort = 'low' | 'medium' | 'high';

interface ChatParams {
  messages: any[];
  tools?: ToolDef[];
  config: LLMConfig;
  onToken?: (delta: string) => void;
  onThinking?: (delta: string) => void;              // 思考流(reasoning_content)增量, 仅展示
  thinking?: 'enabled' | 'disabled';                 // deepseek 思考模式开关; 缺省不携带=厂商默认
  reasoningEffort?: ReasoningEffort;                 // 思考力度(deepseek reasoning_effort, 与 thinking 组合); 缺省不携带
  signal?: AbortSignal;
}

// ── URL 拼接: base 带 /v1 直接拼, 否则补 /v1 ──
function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  if (/\/v\d+$/.test(b)) return b + path;
  return b + '/v1' + path;
}

function normalizeTool(t: ToolDef) {
  return { type: 'function', function: t };
}

async function safeText(resp: Response): Promise<string> {
  try { return await resp.text(); } catch { return ''; }
}

// 从后端响应取 error 文本(后端统一返回 {error: string}); 解析失败则回退原始片段
async function readRespError(resp: Response): Promise<string> {
  const txt = await safeText(resp);
  try { const j = JSON.parse(txt); if (typeof j?.error === 'string') return j.error; } catch {}
  return txt.slice(0, 500);
}

// 上游厂商错误(后端统一 502)转对人友好提示 —— 避免英文技术细节吓到 K12 用户,
// 也避免被误读成"试用次数用完"(那是业务 402 的语义; 厂商 402 已在后端隔离成 502)
function friendlyUpstreamError(msg: string): string {
  const low = msg.toLowerCase();
  if (/insufficient balance|余额不足|quota|配额/.test(low))
    return 'AI 服务额度不足, 暂时无法生成, 请联系管理员';
  if (/rate limit|too many requests|繁忙/.test(low))
    return 'AI 服务繁忙, 请稍后重试';
  if (/timeout|timed out|超时/.test(low))
    return 'AI 服务响应超时, 请稍后重试';
  return 'AI 服务暂时不可用, 请稍后重试';
}

// ── SSE 解析: 累积 assistant 文本 + tool_calls(两路共用, 逻辑不变) ──
async function parseSSE(
  body: ReadableStream<Uint8Array>,
  onToken?: (delta: string) => void,
  onThinking?: (delta: string) => void,
): Promise<AssistantMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let content = '';
  let reasoning = '';
  const toolCalls: Record<number, { id: string; type: 'function'; function: { name: string; arguments: string } }> = {};
  let finishByStream = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { finishByStream = true; continue; }

      let json: any;
      try { json = JSON.parse(data); } catch { continue; }

      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;

      // 思考增量: 流给 onThinking 展示, 同时累积进返回消息的 reasoning_content(随历史回传, 不进 content)
      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        onThinking?.(delta.reasoning_content);
      }
      if (delta.content) {
        content += delta.content;
        onToken?.(delta.content);
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) {
            toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          }
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.type) toolCalls[idx].type = tc.type;
          if (tc.function) {
            if (tc.function.name) toolCalls[idx].function.name += tc.function.name;
            if (tc.function.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
      }
    }
  }

  const tcList = Object.keys(toolCalls)
    .sort((a, b) => +a - +b)
    .map((k, i) => {
      const t = toolCalls[+k];
      if (!t.id) t.id = `call_${i}_${Date.now()}`;   // 兜底: 部分端点流式不发 id
      return t;
    })
    .filter((t) => t.function && t.function.name);

  return {
    role: 'assistant',
    content: content || null,
    reasoning_content: reasoning || undefined,
    tool_calls: tcList.length ? tcList : undefined,
  };
}

// ──────────────────────────────────────────────────────────────
// BYOK: 前端直连用户配置的厂商
// key 只在浏览器, 永不发送到我方后端
// ──────────────────────────────────────────────────────────────
export async function chatByok({ messages, tools, config, onToken, onThinking, thinking, reasoningEffort, signal }: ChatParams): Promise<AssistantMessage> {
  if (!config.api_key || !config.base_url || !config.model_name) {
    throw new Error('LLM 配置不完整: 请填写 api_key / base_url / model_name');
  }

  const url = joinUrl(config.base_url, '/chat/completions');
  // messages 原样透传: 历史 assistant.reasoning_content 恒回传(见 AssistantMessage 注释, Task 8 探针)
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
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;   // 同模式: 仅显式传入时携带

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
  // 端点不认 thinking/reasoning_effort 字段(部分 OpenAI 兼容端点 400) → 去掉这两个字段原样重试一次, 降级为厂商默认行为
  if (resp.status === 400 && (body.thinking || body.reasoning_effort)) {
    const fallback = { ...body };
    delete fallback.thinking;
    delete fallback.reasoning_effort;
    resp = await doFetch(fallback);
  }

  if (!resp.ok) {
    const txt = await safeText(resp);
    throw new Error(`LLM 请求失败 ${resp.status}: ${txt.slice(0, 500)}`);
  }
  if (!resp.body) throw new Error('当前环境不支持流式读取响应体');

  return parseSSE(resp.body as any, onToken, onThinking);
}

// ──────────────────────────────────────────────────────────────
// 试用模式: 走后端 /api/trial/llm 代理
// trialCtx 由调用方维护: { token, setToken } —— 同一意图内多轮复用 token
//   首次 token 为空 → 后端扣 1 次并在响应头回传新 token → setToken 落地
// ──────────────────────────────────────────────────────────────
export interface TrialContext {
  token: string | null;
  setToken: (t: string) => void;
}

interface TrialChatParams extends Omit<ChatParams, 'config'> {
  trialCtx: TrialContext;
  model?: string;          // 试用模式锁定的模型(默认走 TRIAL_DEFAULT_MODEL)
}

export async function chatTrial({
  messages, tools, trialCtx, model, onToken, onThinking, thinking, reasoningEffort, signal,
}: TrialChatParams): Promise<AssistantMessage> {
  const body: any = {
    model: model || 'deepseek',
    messages,
    temperature: 0.2,
    stream: true,
    trial_token: trialCtx.token || null,
  };
  if (thinking) body.thinking = { type: thinking };
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  if (tools && tools.length) {
    body.tools = tools.map(normalizeTool);
    body.tool_choice = 'auto';
  }

  // 身份凭证: Supabase access_token 存 httpOnly cookie, 同源 fetch 自动携带, 后端从 cookie 读 JWT
  const resp = await fetch('/api/trial/llm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    const msg = await readRespError(resp);
    // 402 = 试用次数用完(业务专用码; 厂商 402 已在后端隔离成 502, 不会到这里)
    if (resp.status === 402) {
      const err = new Error('TRIAL_EXHAUSTED');
      (err as any).detail = msg;
      throw err;
    }
    // 502 = 上游厂商错误(余额不足/限流/超时等) → 友好提示, 不暴露技术细节
    if (resp.status === 502) throw new Error(friendlyUpstreamError(msg));
    // 其他(401 未登录 / 400 请求体 / 429 防失控等) → 透出后端原始中文信息
    throw new Error(msg || `试用请求失败 ${resp.status}`);
  }

  // 后端在响应头回传 trial_token(首次签发或续期)
  const newToken = resp.headers.get('x-trial-token');
  if (newToken && newToken !== trialCtx.token) trialCtx.setToken(newToken);

  if (!resp.body) throw new Error('试用响应不支持流式读取');
  return parseSSE(resp.body as any, onToken, onThinking);
}

// ──────────────────────────────────────────────────────────────
// 视觉模型(非流式): 同样拆 BYOK / 试用 两路
// 用于 OCR(vision.recognize) 和 inspect_render
// ──────────────────────────────────────────────────────────────
interface VisionParams {
  image: string;            // data URL
  prompt: string;
  signal?: AbortSignal;
}

export async function visionByok(visionConfig: LLMConfig, { image, prompt, signal }: VisionParams): Promise<string> {
  if (!visionConfig.api_key || !visionConfig.base_url || !visionConfig.model_name) {
    throw new Error('视觉模型配置不完整: 请填写 api_key / base_url / model_name');
  }
  const url = joinUrl(visionConfig.base_url, '/chat/completions');
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: image } },
    ],
  }];
  const body = {
    model: visionConfig.model_name,
    messages,
    max_tokens: 4000,
    temperature: 0.1,
    stream: false,
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${visionConfig.api_key}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    const txt = await safeText(resp);
    throw new Error(`视觉模型请求失败 ${resp.status}: ${txt.slice(0, 500)}`);
  }
  const json = await resp.json();
  return json.choices?.[0]?.message?.content || '';
}

export async function visionTrial({ image, prompt, signal, trialCtx, model }: VisionParams & {
  trialCtx: TrialContext; model?: string;
}): Promise<string> {
  const resp = await fetch('/api/trial/vision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image, prompt,
      trial_token: trialCtx.token || null,
      model: model || 'glm-4.6v',
    }),
    signal,
  });
  if (!resp.ok) {
    const msg = await readRespError(resp);
    if (resp.status === 402) {
      const err = new Error('TRIAL_EXHAUSTED');
      (err as any).detail = msg;
      throw err;
    }
    if (resp.status === 502) throw new Error(friendlyUpstreamError(msg));
    throw new Error(msg || `试用视觉请求失败 ${resp.status}`);
  }
  const newToken = resp.headers.get('x-trial-token');
  if (newToken && newToken !== trialCtx.token) trialCtx.setToken(newToken);
  const json = await resp.json();
  return json.content || '';
}

// trial 路由用: 从客户端请求体提取白名单 thinking(非法值一律丢弃, 不透传到上游)
export function thinkingFromBody(body: any): { type: 'enabled' | 'disabled' } | null {
  const t = body?.thinking?.type;
  return t === 'enabled' || t === 'disabled' ? { type: t } : null;
}

// trial 路由用: 从客户端请求体提取白名单 reasoning_effort(非法值一律丢弃, 不透传到上游)
export function reasoningEffortFromBody(body: any): 'low' | 'medium' | 'high' | null {
  const e = body?.reasoning_effort;
  return e === 'low' || e === 'medium' || e === 'high' ? e : null;
}
