// 免费模式 embedding 代理(command-search 向量检索用)
// 复用 GLM embedding-3, 不计入 5 次额度(检索辅助, 由登录 + 充值额度兜底)

import { getUserFromCookie } from '@/lib/supabase';

export const runtime = 'edge';

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
  const input = body.input;
  if (!input || (Array.isArray(input) && !input.length)) return json(400, { error: '缺少 input' });

  const baseUrl = process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
  const apiKey = process.env.GLM_API_KEY!;
  const model = process.env.GLM_EMBEDDING_MODEL || 'embedding-3';

  const upstream = await fetch(joinUrl(baseUrl, '/embeddings'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input, dimensions: body.dimensions || 1024 }),
  });

  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => '');
    return json(upstream.status, { error: `embedding 请求失败: ${txt.slice(0, 200)}` });
  }
  const data = await upstream.json();
  // 透传 GLM 的 data[].embedding
  const vectors = (data.data || []).map((d: any) => d.embedding);
  return json(200, { vectors });
}

function json(status: number, payload: any): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}
