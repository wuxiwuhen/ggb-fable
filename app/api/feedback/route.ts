// 用户反馈收集(仅限已登录用户), 存 Supabase feedback 表
// POST { content } → 插入 feedback 行, 返回 { ok }
import { getUserFromCookie, getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'edge';

export async function POST(req: Request) {
  // 鉴权: 仅注册用户可提交反馈
  const user = await getUserFromCookie(req);
  if (!user) return json(401, { error: '请先登录' });

  try {
    const body = await req.json();
    const content = (body.content || '').trim();
    if (!content) return json(400, { error: '内容不能为空' });

    const admin = getSupabaseAdmin();
    await admin.from('feedback').insert({
      user_id: user.id,
      content: content.slice(0, 2000),
      email: user.email || null,
    });

    return json(200, { ok: true });
  } catch (e: any) {
    console.warn('反馈提交失败:', e.message);
    return json(500, { error: '提交失败, 请稍后重试' });
  }
}

function json(status: number, payload: any): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
