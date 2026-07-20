// 公开: 解析当前请求者的生效提示词版本
// 全局 active(app_config.prompt_version); 若请求者是 admin 且设了 preview(profiles)则覆盖
import { getUserFromCookie, getSupabaseAdmin } from '@/lib/supabase';
import { DEFAULT_VERSION } from '@/lib/prompt-loader';

export const runtime = 'edge';

function json(status: number, payload: any): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function GET(req: Request) {
  const sb = getSupabaseAdmin();

  // 1. 全局 active
  let active = DEFAULT_VERSION;
  try {
    const { data } = await sb
      .from('app_config')
      .select('value')
      .eq('key', 'prompt_version')
      .maybeSingle();
    if (data?.value?.active) active = String(data.value.active);
  } catch {
    /* 读不到 → 默认 v1 */
  }

  // 2. admin 预览覆盖
  let version = active;
  let source: 'global' | 'preview' = 'global';
  try {
    const user = await getUserFromCookie(req);
    if (user) {
      const { data: prof } = await sb
        .from('profiles')
        .select('is_admin, prompt_preview_version')
        .eq('user_id', user.id)
        .maybeSingle();
      if (prof?.is_admin && prof.prompt_preview_version) {
        version = String(prof.prompt_preview_version);
        source = 'preview';
      }
    }
  } catch {
    /* 身份解析失败 → 全局 */
  }

  return json(200, { version, source });
}
