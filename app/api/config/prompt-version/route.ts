// 公开(诊断用): 返回当前请求者的生效提示词版本号。文本走 /api/config/prompt-text。
import { resolveEffectiveVersion } from '@/lib/prompt-resolver';

export const runtime = 'edge';

export async function GET(req: Request) {
  const { version, source } = await resolveEffectiveVersion(req);
  return new Response(JSON.stringify({ version, source }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
