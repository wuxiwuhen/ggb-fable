// 管理员: 查看/切换提示词版本
// GET  → { active, preview, manifest }
// POST { action:"preview"|"publish", version } → 写 profiles 或 app_config
import { getUserFromCookie, getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'edge';

async function requireAdmin(req: Request) {
  const user = await getUserFromCookie(req);
  if (!user) return null;
  const sb = getSupabaseAdmin();
  const { data } = await sb.from('profiles').select('is_admin').eq('user_id', user.id).maybeSingle();
  return data?.is_admin ? user : null;
}

function json(status: number, payload: any): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readManifest(req: Request): Promise<{ versions: Array<{ id: string }> }> {
  try {
    const url = new URL('/knowledge/prompts/manifest.json', req.url);
    const resp = await fetch(url);
    if (!resp.ok) return { versions: [] };
    return await resp.json();
  } catch {
    return { versions: [] };
  }
}

export async function GET(req: Request) {
  const adminUser = await requireAdmin(req);
  if (!adminUser) return json(403, { error: '需要管理员权限' });
  const sb = getSupabaseAdmin();

  let active: string | null = null;
  const { data: cfg } = await sb.from('app_config').select('value').eq('key', 'prompt_version').maybeSingle();
  if (cfg?.value?.active) active = String(cfg.value.active);

  const { data: prof } = await sb
    .from('profiles')
    .select('prompt_preview_version')
    .eq('user_id', adminUser.id)
    .maybeSingle();
  const preview = prof?.prompt_preview_version || null;

  const manifest = await readManifest(req);
  return json(200, { active, preview, manifest });
}

export async function POST(req: Request) {
  const adminUser = await requireAdmin(req);
  if (!adminUser) return json(403, { error: '需要管理员权限' });
  const sb = getSupabaseAdmin();

  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  const version = String(body?.version || '').trim();
  if (!version) return json(400, { error: '缺少 version' });

  // 校验 version 在 manifest 内(防幽灵版本)
  const manifest = await readManifest(req);
  const known = (manifest.versions || []).some((v) => v.id === version);
  if (!known) return json(400, { error: '未知版本: ' + version });

  if (action === 'preview') {
    const { error } = await sb.from('profiles').update({ prompt_preview_version: version }).eq('user_id', adminUser.id);
    if (error) return json(500, { error: '写入失败: ' + error.message });
    return json(200, { ok: true, preview: version });
  }

  if (action === 'publish') {
    const { error: e1 } = await sb
      .from('app_config')
      .update({ value: { active: version }, updated_at: new Date().toISOString() })
      .eq('key', 'prompt_version');
    if (e1) return json(500, { error: '发布失败: ' + e1.message });
    // 发布即对全员含自己生效 → 清掉自己 preview
    await sb.from('profiles').update({ prompt_preview_version: null }).eq('user_id', adminUser.id);
    return json(200, { ok: true, active: version, preview: null });
  }

  return json(400, { error: '未知 action, 支持 preview / publish' });
}
