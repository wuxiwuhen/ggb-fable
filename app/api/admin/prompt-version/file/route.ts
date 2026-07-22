// admin 查看某版本提示词原文(text/plain, 新标签页直接渲染)
import { getUserFromCookie, getSupabaseAdmin } from '@/lib/supabase';
import { getPromptContent } from '@/lib/server-prompts';

export const runtime = 'edge';

async function requireAdmin(req: Request) {
  const user = await getUserFromCookie(req);
  if (!user) return null;
  const sb = getSupabaseAdmin();
  const { data } = await sb.from('profiles').select('is_admin').eq('user_id', user.id).maybeSingle();
  return data?.is_admin ? user : null;
}

export async function GET(req: Request) {
  const adminUser = await requireAdmin(req);
  if (!adminUser) return new Response('需要管理员权限', { status: 403 });
  const id = new URL(req.url).searchParams.get('id') || '';
  const content = getPromptContent(id);
  if (content == null) return new Response('未知版本: ' + id, { status: 404 });
  return new Response(content, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
