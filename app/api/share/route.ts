// 公开分享查询: 无需登录, 通过 share_id 获取 session + messages
// 用 service_role 绕过 RLS —— 只返回 share_enabled=true 的会话
export const runtime = 'edge';

import { getSupabaseAdmin } from '@/lib/supabase';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const shareId = url.searchParams.get('shareId');
  if (!shareId) return json(400, { error: '缺少 shareId' });

  const admin = getSupabaseAdmin();
  const { data: session } = await admin
    .from('sessions')
    .select('*')
    .eq('share_id', shareId)
    .eq('share_enabled', true)
    .maybeSingle();

  if (!session) return json(404, { error: '分享不存在或已关闭' });

  // 脱敏: 不暴露 user_id
  const { user_id: _uid, ...safe } = session;

  const { data: messages } = await admin
    .from('messages')
    .select('role, content, tool_name, tool_args, tool_result, round, created_at')
    .eq('session_id', session.id)
    .order('id', { ascending: true });

  return json(200, { session: safe, messages: messages || [] });
}

function json(status: number, payload: any): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
