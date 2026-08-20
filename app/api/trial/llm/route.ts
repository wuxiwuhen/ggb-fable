// 免费模式 LLM 代理(核心限额控制)
// 流程: 验 cookie JWT → 原子扣减(首次)/验 token(后续) → 注入我的 key 转发厂商 → 流式回传
// 上限(防失控软上限, 物理硬上限靠 API 充值额度): 单意图最多 MAX_ROUNDS 轮 / 累计 MAX_TOKENS 输入 token
// Edge runtime: 流式响应无硬时长限制, 适合代理

import { getUserFromCookie } from '@/lib/supabase';
import { getSupabaseAdmin } from '@/lib/supabase';
import { signToken, verifyToken, newIntentId } from '@/lib/trial-token';
import { thinkingFromBody, reasoningEffortFromBody } from '@/lib/llm';
import { estimateInputTokens } from '@/lib/loop-context';

export const runtime = 'edge';

const MAX_ROUNDS = Number(process.env.TRIAL_MAX_ROUNDS || 50);
const MAX_TOKENS = Number(process.env.TRIAL_MAX_TOKENS || 100000);
const TOKEN_TTL = Number(process.env.TRIAL_TOKEN_TTL || 900) * 1000;

interface ModelCfg { base_url: string; api_key: string; model_name: string; }

function getModelCfg(model?: string): ModelCfg {
  const want = model || process.env.TRIAL_DEFAULT_MODEL || 'deepseek';
  if (want === 'glm') {
    return {
      base_url: process.env.GLM_BASE_URL!,
      api_key: process.env.GLM_API_KEY!,
      model_name: process.env.GLM_MODEL || 'glm-4.6',
    };
  }
  // 默认 deepseek
  return {
    base_url: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    api_key: process.env.DEEPSEEK_API_KEY!,
    model_name: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  };
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  if (/\/v\d+$/.test(b)) return b + path;
  return b + '/v1' + path;
}

export async function POST(req: Request) {
  // 1) 验证用户身份
  const user = await getUserFromCookie(req);
  if (!user) return json(401, { error: '未登录' });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: '请求体解析失败' }); }

  const clientToken: string | null = body.trial_token || null;
  const wantModel = body.model;
  const cfg = getModelCfg(wantModel);

  // 2) 扣减 / 验 token(管理员不限次数)
  const isAdmin = await checkIsAdmin(user.id);
  let iid = '';
  let roundsDone = 0;       // 本意图已完成的轮数
  let tokensUsed = 0;        // 本意图已消费的输入 token
  let deductResult: { used: number; trial_limit: number } | null = null;

  if (clientToken) {
    // 后续轮次: 验签, 不扣次数
    const payload = await verifyToken(clientToken, user.id);
    if (payload) {
      iid = payload.iid;
      roundsDone = payload.r;
      tokensUsed = payload.t;
    } else {
      // token 无效/超时 → 视为新意图, 走扣减(管理员跳过)
      if (!isAdmin) {
        const fresh = await deduct(user.id);
        if (!fresh) return json(402, { error: '试用次数已用完', remaining: 0 });
        deductResult = fresh;
      }
      iid = newIntentId();
    }
  } else {
    // 首次: 扣 1 次(管理员跳过)
    if (!isAdmin) {
      const fresh = await deduct(user.id);
      if (!fresh) return json(402, { error: '试用次数已用完', remaining: 0 });
      deductResult = fresh;
    }
    iid = newIntentId();
  }

  // 3) 防失控上限检查(软上限)
  const inputTokens = estimateInputTokens(body);
  if (roundsDone >= MAX_ROUNDS) {
    return json(429, { error: `已达单次请求工具轮数上限(${MAX_ROUNDS}轮), 请发送新的需求重新开始` });
  }
  if (tokensUsed + inputTokens > MAX_TOKENS) {
    return json(429, { error: '本次请求上下文过大, 请清空画布或精简后重试' });
  }

  // 4) 转发到厂商(流式)
  const upstreamBody: any = {
    model: cfg.model_name,
    messages: body.messages,
    temperature: body.temperature ?? 0.2,
    stream: true,
  };
  if (Number(body.max_tokens) > 0) upstreamBody.max_tokens = Number(body.max_tokens);
  if (body.tools && body.tools.length) {
    upstreamBody.tools = body.tools;
    upstreamBody.tool_choice = 'auto';
  }
  const thinking = thinkingFromBody(body);
  if (thinking) upstreamBody.thinking = thinking;
  const effort = reasoningEffortFromBody(body);
  if (effort) upstreamBody.reasoning_effort = effort;

  const upstream = await fetch(joinUrl(cfg.base_url, '/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.api_key}`,
    },
    body: JSON.stringify(upstreamBody),
  });

  if (!upstream.ok || !upstream.body) {
    const txt = await upstream.text().catch(() => '');
    // 固定 502, 不透传厂商状态码 —— 厂商 402(余额不足)/429(限流)会撞 app 业务专用码
    // (402=试用次数用完, 429=防失控上限), 一旦透传前端就把"厂商没钱"误报成"试用用完"。
    // 统一 502=上游错误, 真实原因带在 error 文本里交给前端友好展示。
    return json(502, { error: `上游模型请求失败: ${txt.slice(0, 300)}` });
  }

  // 5) 签发/续期 token(本轮过后累计+1轮, 累计本次输入 token)
  const newToken = await signToken({
    uid: user.id,
    iid,
    exp: Date.now() + TOKEN_TTL,
    r: roundsDone + 1,
    t: tokensUsed + inputTokens,
  });

  // 6) 流式回传, 透传上游 SSE
  const headers = new Headers(upstream.headers);
  headers.set('x-trial-token', newToken);
  // 本路由的输入累计上限: 前端引擎据此放宽/收紧自己的 90K 默认收手线(留 5% 余量),
  // 否则本地调大 TRIAL_MAX_TOKENS 后引擎仍在 90K 误停(抛物线题实测: 收尾阶段被掐)
  headers.set('x-trial-budget', String(MAX_TOKENS));
  headers.set('x-remaining', String(deductResult ? deductResult.trial_limit - deductResult.used : ''));
  // 移除可能干扰的编码头
  headers.delete('content-encoding');
  headers.delete('content-length');

  return new Response(upstream.body, { status: 200, headers });
}

// 原子扣减
async function deduct(userId: string): Promise<{ used: number; trial_limit: number } | null> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.rpc('deduct_usage', { target_user: userId });
  if (error || !data || !Array.isArray(data) || data.length === 0) return null;
  return { used: data[0].used, trial_limit: data[0].trial_limit };
}

// 管理员不限次数(方便测试/管理) —— is_admin=true 的用户跳过扣减
async function checkIsAdmin(userId: string): Promise<boolean> {
  const admin = getSupabaseAdmin();
  const { data } = await admin.from('profiles').select('is_admin').eq('user_id', userId).maybeSingle();
  return !!data?.is_admin;
}

function json(status: number, payload: any): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
