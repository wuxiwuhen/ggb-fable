// 查询当前用户的试用额度
// 返回 { used, limit, remaining }

import { getUserFromCookie, getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'edge';

export async function GET(req: Request) {
  const user = await getUserFromCookie(req);
  if (!user) return json(401, { error: '未登录' });

  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('usage')
    .select('used, trial_limit')
    .eq('user_id', user.id)
    .maybeSingle();

  const used = data?.used ?? 0;
  const limit = data?.trial_limit ?? Number(process.env.TRIAL_DEFAULT_LIMIT || 5);
  return json(200, { used, limit, remaining: Math.max(0, limit - used) });
}

function json(status: number, payload: any): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}
