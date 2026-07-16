// 管理员数据洞察: 用户反馈 + 用户指令查看
// GET ?type=feedback  → 反馈列表
// GET ?type=messages&limit=100  → 用户指令列表

import { getUserFromCookie, getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'edge';

async function requireAdmin(req: Request) {
  const user = await getUserFromCookie(req);
  if (!user) return null;
  const admin = getSupabaseAdmin();
  const { data } = await admin.from('profiles').select('is_admin').eq('user_id', user.id).maybeSingle();
  return data?.is_admin ? user : null;
}

export async function GET(req: Request) {
  const adminUser = await requireAdmin(req);
  if (!adminUser) return json(403, { error: '需要管理员权限' });

  const url = new URL(req.url);
  const type = url.searchParams.get('type') || 'feedback';
  const searchEmail = url.searchParams.get('email')?.trim().toLowerCase();
  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 500);
  const admin = getSupabaseAdmin();

  if (type === 'feedback') {
    let query = admin
      .from('feedback')
      .select('id, user_id, email, content, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    // email 搜索: 直接在 feedback 表上过滤(email 冗余字段)
    if (searchEmail) {
      query = query.ilike('email', `%${searchEmail}%`);
    }

    const { data: feedback } = await query;
    return json(200, { rows: feedback || [] });
  }

  if (type === 'messages') {
    // 邮箱搜索: 先根据 email 找到 user_id, 再查 messages
    if (searchEmail) {
      const { data: matchedProfiles } = await admin
        .from('profiles')
        .select('user_id')
        .ilike('email', `%${searchEmail}%`)
        .limit(50);

      const matchedIds = (matchedProfiles || []).map((p: any) => p.user_id);
      if (matchedIds.length === 0) return json(200, { rows: [] });

      const { data: messages } = await admin
        .from('messages')
        .select('id, session_id, user_id, content, created_at')
        .eq('role', 'user')
        .in('user_id', matchedIds)
        .order('created_at', { ascending: false })
        .limit(limit);

      return json(200, { rows: await enrichMessages(messages, admin) });
    }

    // 无搜索: 取最近 limit 条
    const { data: messages } = await admin
      .from('messages')
      .select('id, session_id, user_id, content, created_at')
      .eq('role', 'user')
      .order('created_at', { ascending: false })
      .limit(limit);

    return json(200, { rows: await enrichMessages(messages, admin) });
  }

  return json(400, { error: '未知 type, 支持 feedback / messages' });
}

async function enrichMessages(messages: any[] | null, admin: any) {
  if (!messages || messages.length === 0) return [];

  const userIds = [...new Set(messages.map((m: any) => m.user_id))];
  const sessionIds = [...new Set(messages.map((m: any) => m.session_id))];

  const [{ data: profiles }, { data: sessions }] = await Promise.all([
    admin.from('profiles').select('user_id, email').in('user_id', userIds),
    admin.from('sessions').select('id, title').in('id', sessionIds),
  ]);

  const emailMap = new Map((profiles || []).map((p: any) => [p.user_id, p.email]));
  const titleMap = new Map((sessions || []).map((s: any) => [s.id, s.title]));

  return messages.map((m: any) => ({
    id: m.id,
    email: emailMap.get(m.user_id) || m.user_id.slice(0, 8),
    content: m.content || '',
    session_title: titleMap.get(m.session_id) || '',
    created_at: m.created_at,
  }));
}

function json(status: number, payload: any): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
