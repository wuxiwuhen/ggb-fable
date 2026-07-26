// 免费模式视觉模型代理(非流式)
// 用途: ① OCR(用户上传数学题图片转录) ② inspect_render(画布验收检查)
// 计费: 不单独扣减试用次数 —— inspect_render 复用所属意图的 trial_token(验签免扣);
//       OCR 仅需登录(视觉调用成本由 API 充值额度物理上限兜底, 不计入5次额度)
//
// 为什么 OCR 不计次数: "试用次数"语义 = 画布生成次数(=Agent send)。OCR 是输入辅助,
// 单独计费会让"识别→生成"一次操作扣两次, 体验差。OCR 滥用由充值额度硬上限兜底。

import { getUserFromCookie } from '@/lib/supabase';
import { signToken, verifyToken } from '@/lib/trial-token';

// ⚠️ 用 nodejs runtime 而非 edge —— 区别于 /api/trial/llm(它走流式, Edge 无硬时长上限)。
// 视觉调用是【非流式】(stream:false, 整段等 GLM-4.6v 生成完毕): 大图 + inspect_render 长 prompt
// 单次常 20–40s, 超出 Edge ~25–30s 硬上限会被 Vercel 杀掉 → 504 FUNCTION_INVOCATION_TIMEOUT。
// Node.js serverless 配 maxDuration 才有足够余量。Edge 对非流式零收益, 别改回去。
export const runtime = 'nodejs';
export const maxDuration = 60;   // Hobby/Pro 均支持; Pro 可按需提到 120/300

const TOKEN_TTL = Number(process.env.TRIAL_TOKEN_TTL || 900) * 1000;

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  if (/\/v\d+$/.test(b)) return b + path;
  return b + '/v1' + path;
}

export async function POST(req: Request) {
  const user = await getUserFromCookie(req);
  if (!user) return json(401, { error: '未登录' });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: '请求体解析失败' }); }

  const clientToken: string | null = body.trial_token || null;
  let newToken: string | null = null;
  if (clientToken) {
    const payload = await verifyToken(clientToken, user.id);
    if (payload) {
      // 续期同意图 token(沿用累计轮数/token, 不增加)
      newToken = await signToken({ ...payload, exp: Date.now() + TOKEN_TTL });
    }
  }

  const baseUrl = process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
  const apiKey = process.env.GLM_API_KEY!;
  const modelName = body.model || process.env.GLM_VISION_MODEL || 'glm-4.6v';

  const upstreamBody = {
    model: modelName,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: body.prompt },
        { type: 'image_url', image_url: { url: body.image } },
      ],
    }],
    max_tokens: 4000,
    temperature: 0.1,
    stream: false,
  };

  const upstream = await fetch(joinUrl(baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(upstreamBody),
  });

  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => '');
    // 固定 502, 不透传厂商码(避免厂商 402 撞业务 402=试用用完, 见 trial/llm 注释)
    return json(502, { error: `视觉模型请求失败: ${txt.slice(0, 300)}` });
  }

  const json_resp = await upstream.json();
  const content = json_resp.choices?.[0]?.message?.content || '';

  // OCR 单独调用(无 token)也注入一个轻量 token, 方便前端统一管理
  const respBody: any = { content };
  if (newToken) respBody.token = newToken;
  return new Response(JSON.stringify(respBody), {
    status: 200,
    headers: newToken ? { 'Content-Type': 'application/json', 'x-trial-token': newToken } : { 'Content-Type': 'application/json' },
  });
}

function json(status: number, payload: any): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}
