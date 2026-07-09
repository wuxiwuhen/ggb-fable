// 主应用页: 认证门控 —— 未登录跳 /login, 登录后显示 ChatApp
'use client';

import { useAuth } from '@/lib/auth';
import ChatApp from '@/components/ChatApp';

export default function Home() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' }}>
        加载中…
      </main>
    );
  }
  if (!user) {
    // 客户端跳转登录页
    if (typeof window !== 'undefined') window.location.href = '/login';
    return null;
  }
  return <ChatApp />;
}
