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

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const pageSize = Math.min(Number(url.searchParams.get('pageSize')) || 20, 100);
  const email = url.searchParams.get('email')?.trim().toLowerCase() || '';
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const admin = getSupabaseAdmin();

  // 主查询: profiles(所有注册用户) + 总数(count='exact') + 可选邮箱过滤 + 分页(range)。
  // 以 profiles 为数据源, 确保注册未试用(used=0)的用户也能看到; email 直接在 profiles
  // 上, 搜索无需两跳。count='exact' 一并拿到总人数, 供前端渲染分页器。
  let query = admin
    .from('profiles')
    .select('user_id, email, is_admin, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);
  if (email) query = query.ilike('email', `%${email}%`);

  const { data: profileRows, count, error } = await query;
  if (error) return json(500, { error: error.message });

  // 补 usage(当前页这批用户的 used / trial_limit), 内存合并 + coalesce 兜底。
  // 正常情况注册触发器已为每个用户建 usage 行, 兜底仅防触发器遗漏的老数据。
  const DEFAULT_LIMIT = 5; // 对应 schema 里 trial_limit default / 注册触发器 trial_default
  const ids = (profileRows || []).map((p: any) => p.user_id);
  const usageMap = new Map<string, { used: number; trial_limit: number }>();
  if (ids.length) {
    const { data: uRows } = await admin
      .from('usage')
      .select('user_id, used, trial_limit')
      .in('user_id', ids);
    (uRows || []).forEach((u: any) => usageMap.set(u.user_id, { used: u.used, trial_limit: u.trial_limit }));
  }

  const rows = (profileRows || []).map((p: any) => {
    const u = usageMap.get(p.user_id);
    const limit = u?.trial_limit ?? DEFAULT_LIMIT;
    const used = u?.used ?? 0;
    return {
      user_id: p.user_id,
      email: p.email || '',
      used,
      limit,
      remaining: Math.max(0, limit - used),
    };
  });

  return json(200, { rows, total: count ?? 0, page, pageSize });
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
