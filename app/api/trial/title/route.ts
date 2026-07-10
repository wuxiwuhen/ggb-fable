// 会话标题生成(独立轻量调用, 不扣试用次数, 不碰 agent 画布核心)
// 流程: 验 cookie JWT → 注入服务端 key 转发厂商(非流式) → 返回 ≤15 字标题

import { getUserFromCookie } from '@/lib/supabase';

export const runtime = 'edge';

interface ModelCfg { base_url: string; api_key: string; model_name: string; }

function getModelCfg(model?: string): ModelCfg {
  const want = model || process.env.TRIAL_DEFAULT_MODEL || 'deepseek';
  if (want === 'glm') {
    return { base_url: process.env.GLM_BASE_URL!, api_key: process.env.GLM_API_KEY!, model_name: process.env.GLM_MODEL || 'glm-4.6' };
  }
  return { base_url: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1', api_key: process.env.DEEPSEEK_API_KEY!, model_name: process.env.DEEPSEEK_MODEL || 'deepseek-chat' };
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  if (/\/v\d+$/.test(b)) return b + path;
  return b + '/v1' + path;
}

const TITLE_PROMPT = '给下面这段用户输入的数学问题生成一个简短的中文标题(不超过15字)。只输出标题文本, 不要解释、不要引号、不要句号。';

export async function POST(req: Request) {
  const user = await getUserFromCookie(req);
  if (!user) return json(401, { error: '未登录' });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: '请求体解析失败' }); }
  const text = (body.text || '').trim().slice(0, 500);
  if (!text) return json(400, { error: '缺少 text' });

  const cfg = getModelCfg(body.model);
  const upstream = await fetch(joinUrl(cfg.base_url, '/chat/completions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
    body: JSON.stringify({
      model: cfg.model_name,
      messages: [
        { role: 'system', content: TITLE_PROMPT },
        { role: 'user', content: text },
      ],
      temperature: 0.2,
      max_tokens: 40,
      stream: false,
    }),
  });

  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => '');
    return json(upstream.status || 502, { error: `标题生成失败: ${txt.slice(0, 200)}` });
  }

  const data = await upstream.json();
  console.log('[title API] text:', text.slice(0, 80), '| choices:', JSON.stringify(data.choices).slice(0, 300));
  const raw = (data.choices?.[0]?.message?.content || '');
  const title = raw.trim().slice(0, 15).replace(/["""''。]/g, '');
  console.log('[title API] raw:', JSON.stringify(raw), '| title:', JSON.stringify(title));
  return json(200, { title });
}

function json(status: number, payload: any): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}
