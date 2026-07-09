// 管理员额度管理: 刷新某用户额度(used=0) / 设置额度(trial_limit)
// 仅 is_admin=true 的用户可调用(用 service_role 查 profiles 鉴权)
//
// 用法:
//   POST { user_id, action: 'refresh' }            → used=0
//   POST { user_id, action: 'set_limit', limit }   → trial_limit=N
//   GET                                              → 列出全部用户额度(管理员面板用)

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

  const admin = getSupabaseAdmin();
  // 联表: usage + profiles(取 email)
  const { data: usage } = await admin.from('usage').select('user_id, used, trial_limit');
  const { data: profiles } = await admin.from('profiles').select('user_id, email');
  const emailMap = new Map((profiles || []).map((p: any) => [p.user_id, p.email]));

  const rows = (usage || []).map((u: any) => ({
    user_id: u.user_id,
    email: emailMap.get(u.user_id) || '',
    used: u.used,
    limit: u.trial_limit,
    remaining: Math.max(0, u.trial_limit - u.used),
  }));
  return json(200, { rows });
}

export async function POST(req: Request) {
  const adminUser = await requireAdmin(req);
  if (!adminUser) return json(403, { error: '需要管理员权限' });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: '请求体解析失败' }); }
  const { user_id, action, limit } = body;
  if (!user_id) return json(400, { error: '缺少 user_id' });

  const admin = getSupabaseAdmin();
  if (action === 'refresh') {
    await admin.rpc('refresh_usage', { target_user: user_id });
    return json(200, { ok: true, action: 'refresh', user_id });
  }
  if (action === 'set_limit') {
    if (typeof limit !== 'number' || limit < 0) return json(400, { error: 'limit 非法' });
    await admin.rpc('set_usage_limit', { target_user: user_id, new_limit: limit });
    return json(200, { ok: true, action: 'set_limit', user_id, limit });
  }
  return json(400, { error: '未知 action, 支持 refresh / set_limit' });
}

function json(status: number, payload: any): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}
