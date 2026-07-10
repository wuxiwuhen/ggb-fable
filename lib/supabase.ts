// Supabase 客户端封装
// - 浏览器端: 带 RLS 的 anon key 客户端
// - 后端(serverless): service_role 客户端, 绕过 RLS 做原子扣减/管理员操作
// 两个实例绝不能混用: service_role key 只在 API Route 里用, 不进前端 bundle

import { createBrowserClient, createServerClient } from '@supabase/ssr';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// 浏览器端单例
let browserClient: SupabaseClient | null = null;
export function getSupabaseBrowser(): SupabaseClient {
  if (browserClient) return browserClient;
  browserClient = createBrowserClient(SUPABASE_URL, ANON_KEY);
  return browserClient;
}

// 后端 service_role 客户端(仅 API Route 用)
// 注意: 调用方必须确保本函数只在 server 端执行
export function getSupabaseAdmin(): SupabaseClient {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY 未配置(后端专用)');
  return createClient(SUPABASE_URL, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// 从请求的 JWT 解出 user(后端验证身份)
export async function getUserFromRequest(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

// cookie 方式从请求解出当前用户(@supabase/ssr 把 session 存 httpOnly cookie, 可能分片+JSON)
// 用 createServerClient 读 cookie(它知道自己的编码格式), 再 getUser 验签
// 用于 trial 代理路由: 同源 fetch 自动带 cookie, 这里读取并验签
export async function getUserFromCookie(req: Request) {
  const cookieHeader = req.headers.get('cookie') || '';
  const all = cookieHeader
    .split(';')
    .map((c) => {
      const i = c.indexOf('=');
      return { name: c.slice(0, i).trim(), value: c.slice(i + 1).trim() };
    })
    .filter((c) => c.name);
  const supabase = createServerClient(SUPABASE_URL, ANON_KEY, {
    cookies: { getAll: () => all, setAll: () => {} },
  });
  const { data } = await supabase.auth.getUser();
  return data.user;
}
