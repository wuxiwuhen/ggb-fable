// 认证 hook: 基于 @supabase/ssr 的浏览器客户端, 提供 useAuth()
// 暴露: user(当前用户|null)、loading、signIn(邮箱密码/魔法链接)、signOut
//
// 邮箱注册策略: Magic Link(点链接登录, 无密码, 体验轻)。
// Supabase 默认邮箱确认开启时, 注册会发确认邮件; 关闭则直接登录。

'use client';

import { useEffect, useState, useCallback } from 'react';
import type { User } from '@supabase/supabase-js';
import { getSupabaseBrowser } from './supabase';

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const supabase = getSupabaseBrowser();
    // 首次: 取当前 session
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
      setLoading(false);
    });
    // 订阅登录态变化
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // 登录后查 profiles.is_admin(RLS 允许查自己), 给前端做管理员入口的条件渲染
  useEffect(() => {
    if (!user) { setIsAdmin(false); return; }
    let cancelled = false;
    getSupabaseBrowser()
      .from('profiles')
      .select('is_admin')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }) => { if (!cancelled) setIsAdmin(!!data?.is_admin); });
    return () => { cancelled = true; };
  }, [user]);

  // Magic Link: 发送登录邮件(登录/注册同一入口)
  const signInWithEmail = useCallback(async (email: string, redirectPath = '/app') => {
    const supabase = getSupabaseBrowser();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}${redirectPath}` },
    });
    if (error) throw error;
  }, []);

  // 邮箱+密码(备用, 若 Supabase 项目开了密码登录)
  const signUpWithPassword = useCallback(async (email: string, password: string) => {
    const supabase = getSupabaseBrowser();
    const { error } = await supabase.auth.signUp({ email, password });
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

  return { user, loading, isAdmin, signInWithEmail, signUpWithPassword, signInWithPassword, signOut };
}
