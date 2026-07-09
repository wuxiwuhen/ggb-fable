// Supabase 中间件: 每次请求刷新 session(access_token 过期时用 refresh_token 自动续期)
// 没有 middleware, @supabase/ssr 存的 cookie 会在 token 过期后失效 → 用户被登出

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(req: NextRequest) {
  const res = NextResponse.next({ request: req });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (cookiesToSet: Array<{ name: string; value: string; options: any }>) => {
          cookiesToSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
        },
      },
    },
  );

  // 触发 session 刷新(若有过期 token)
  await supabase.auth.getSession();
  return res;
}

export const config = {
  // 对所有路由生效(api + 页面), 排除静态资源
  matcher: ['/((?!_next/static|_next/image|favicon.ico|knowledge|.*\\.).*)'],
};
