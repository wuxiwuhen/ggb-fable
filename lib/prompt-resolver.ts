// 服务端: 解析当前请求者的生效提示词版本(全局 active; admin 预览覆盖)
// 复用于 /api/config/prompt-version(公开, 仅返回版本号, 诊断用)
// 和 /api/config/prompt-text(登录, 返回版本号+文本)

import { getUserFromCookie, getSupabaseAdmin } from '@/lib/supabase';
import { DEFAULT_VERSION } from '@/lib/prompt-constants';

export async function resolveEffectiveVersion(req: Request): Promise<{
  version: string;
  source: 'global' | 'preview';
}> {
  const sb = getSupabaseAdmin();

  // 1) 全局 active
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

  // 2) admin 预览覆盖
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

  return { version, source };
}
