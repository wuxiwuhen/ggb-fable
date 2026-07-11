'use client';

// 认证: 全局单例(React Context)。
// <AuthProvider> 挂在 app/layout.tsx, 所有页面/组件共享【同一份】已解析的会话状态 ——
// 客户端路由切换时 layout/Provider 常驻不卸载, 新页面直接读到已就绪状态,
// 不再每次 mount 都重新 getSession() 导致"未登录态闪一下再跳正"。
//
// 暴露: user | null、loading(session 解析中)、isAdmin、adminLoading(is_admin 查询中)、
//       signIn*、signOut。邮箱+密码登录为主, 保留魔法链接入口。
//
// 邮箱注册策略: Magic Link(点链接登录, 无密码, 体验轻)。
// Supabase 默认邮箱确认开启时, 注册会发确认邮件; 关闭则直接登录。

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { User } from '@supabase/supabase-js';
import { getSupabaseBrowser } from './supabase';

export interface AuthValue {
  user: User | null;
  loading: boolean;        // session 是否仍在解析(首屏/刷新时 true, 解析完 false)
  isAdmin: boolean;
  adminLoading: boolean;   // is_admin 是否仍在判定(user 已知但角色未查完, 或 session 仍未定 → true)
  signInWithEmail: (email: string, finalPath?: string) => Promise<void>;
  signUpWithPassword: (email: string, password: string) => Promise<any>;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminLoading, setAdminLoading] = useState(true);

  useEffect(() => {
    const supabase = getSupabaseBrowser();
    // 首次: 取当前 session
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
      setLoading(false);
    });
    // 订阅登录态变化(登录/登出/刷新 token 都会触发)
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // 登录后查 profiles.is_admin(RLS 允许查自己), 给前端做管理员入口的条件渲染。
  // adminLoading 语义: user 为 null 且 session 仍在解析 → true(还没资格判定); user 已知 → 查询期间 true, 查完 false。
  // 这样管理页可以等到 is_admin 真正查完再决定显示"管理后台"还是"非管理员", 不会闪"不是管理员"。
  useEffect(() => {
    if (!user) { setIsAdmin(false); setAdminLoading(loading); return; }
    let cancelled = false;
    setAdminLoading(true);
    getSupabaseBrowser()
      .from('profiles')
      .select('is_admin')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }) => { if (!cancelled) { setIsAdmin(!!data?.is_admin); setAdminLoading(false); } });
    return () => { cancelled = true; };
  }, [user, loading]);

  // Magic Link: 发送登录邮件(登录/注册同一入口)
  // 邮件链接必须指向 /api/auth/callback(那里做 code→session 交换), 经 next 参数告诉 callback 最终跳哪
  const signInWithEmail = useCallback(async (email: string, finalPath = '/app') => {
    const supabase = getSupabaseBrowser();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/api/auth/callback?next=${encodeURIComponent(finalPath)}` },
    });
    if (error) throw error;
  }, []);

  // 邮箱+密码注册(若开启邮箱确认, 会发确认邮件; 若未开启则直接返回 session 登录)
  const signUpWithPassword = useCallback(async (email: string, password: string) => {
    const supabase = getSupabaseBrowser();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/api/auth/callback?next=${encodeURIComponent('/app')}` },
    });
    if (error) throw error;
    return data;
  }, []);

  // 忘记密码: 发重置邮件(点链接后登录并跳设置页改新密码)
  const resetPassword = useCallback(async (email: string) => {
    const supabase = getSupabaseBrowser();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/api/auth/callback?next=${encodeURIComponent('/settings')}`,
    });
    if (error) throw error;
  }, []);

  const signInWithPassword = useCallback(async (email: string, password: string) => {
    const supabase = getSupabaseBrowser();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }, []);

  const signOut = useCallback(async () => {
    const supabase = getSupabaseBrowser();
    await supabase.auth.signOut();
    setUser(null);
  }, []);

  // 值用 memo 包裹: 回调均 useCallback 稳定, 仅 [user, loading, isAdmin, adminLoading] 变化才产生新引用,
  // 避免 Provider 重渲染导致所有 useAuth() 消费者(ChatApp 流式高频更新等)跟着重渲染。
  const value = useMemo<AuthValue>(() => ({
    user, loading, isAdmin, adminLoading,
    signInWithEmail, signUpWithPassword, signInWithPassword, resetPassword, signOut,
  }), [user, loading, isAdmin, adminLoading, signInWithEmail, signUpWithPassword, signInWithPassword, resetPassword, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 <AuthProvider> 内使用');
  return ctx;
}
