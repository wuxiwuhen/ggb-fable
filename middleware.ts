// Supabase 中间件: 每次请求刷新 session(access_token 过期时用 refresh_token 自动续期)
// 没有 middleware, @supabase/ssr 存的 cookie 会在 token 过期后失效 → 用户被登出
//
// 关键(官方 @supabase/ssr 模式): token 刷新时既回写浏览器 cookie(response),
// 也要更新【本请求】的 cookie(request) 并用它重建 response 转发给路由处理器。
// 否则同一次请求里路由读到的还是旧 token → 过期瞬间 401；
// SPA 客户端路由(<Link>)不走整页刷新, 没有页面请求先"吸收"一次刷新, 这个 401 就会暴露成
// "会话列表加载不出来"。整页刷新时代因每次导航都先过一次 middleware 而被掩盖。

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet: Array<{ name: string; value: string; options: any }>) => {
          // 1. 更新本请求 cookie —— 路由处理器据此读到刷新后的新 token
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          // 2. 用更新后的 request 重建 response, 才能把新 cookie 头转发给下游路由
          response = NextResponse.next({ request });
          // 3. 回写浏览器 cookie(给下一次请求用)
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  // 触发 session 刷新(若有过期 token)
  await supabase.auth.getSession();
  return response;
}

export const config = {
  // 对所有路由生效(api + 页面), 排除静态资源
  matcher: ['/((?!_next/static|_next/image|favicon.ico|knowledge|.*\\.).*)'],
};
