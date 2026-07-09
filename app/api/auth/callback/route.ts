// Magic Link 回调: 把 URL 里的 code 换成 session, 写入 cookie, 跳回首页
// @supabase/ssr 服务端客户端处理 code 交换 + cookie 设置

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') || '/app';

  if (code) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const res = NextResponse.redirect(`${url.origin}${next}`);

    const supabase = createServerClient(supabaseUrl, anonKey, {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (cookies: Array<{ name: string; value: string; options: any }>) => {
          cookies.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
        },
      },
    });

    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return res;
    // 出错跳回登录页带错误信息
    return NextResponse.redirect(`${url.origin}/login?error=auth_failed`);
  }

  return NextResponse.redirect(`${url.origin}/login`);
}
