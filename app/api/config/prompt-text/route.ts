// 登录才能访问: 返回当前请求者生效版本的提示词文本(供客户端 loader 注入 AgentEngine)。
// 匿名 → 401(防随意 curl 采集); 登录用户可拿到(与原 bundle/payload 暴露面一致)。
// 提示词内容只存服务端, 此 endpoint 是客户端唯一获取入口。
import { getUserFromCookie } from '@/lib/supabase';
import { resolveEffectiveVersion } from '@/lib/prompt-resolver';
import { getPromptContent } from '@/lib/server-prompts';
import { DEFAULT_VERSION, EMERGENCY_PROMPT } from '@/lib/prompt-constants';

export const runtime = 'edge';

function json(status: number, payload: any): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function GET(req: Request) {
  const user = await getUserFromCookie(req);
  if (!user) return json(401, { error: '未登录' });

  const { version, source } = await resolveEffectiveVersion(req);
  const text = getPromptContent(version);
  if (text != null) return json(200, { version, text, source });

  // 版本号指向不存在的文件 → 回退默认版本内容, 再不行 EMERGENCY
  const fallback = getPromptContent(DEFAULT_VERSION);
  return json(200, {
    version: DEFAULT_VERSION,
    text: fallback ?? EMERGENCY_PROMPT,
    source: 'fallback',
  });
}
