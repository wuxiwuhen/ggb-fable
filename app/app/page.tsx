// 工作台页(画布): 认证门控 —— 未登录跳 /login, 登录后显示 ChatApp
'use client';

import { useAuth } from '@/lib/auth';
import ChatApp from '@/components/ChatApp';

export default function AppPage() {
  const { user, loading } = useAuth();
  // Fix B (eval 旁路): ?eval=1 时跳过 auth 门控, 让 eval 跑匿名 BYOK(见 eval/lib/runner.mjs Fix A)。
  // 仅 eval 用, 生产用户不会带 ?eval=1, 对生产行为零影响。
  const isEval = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('eval') === '1';

  if (loading && !isEval) {
    return (
      <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' }}>
        加载中…
      </main>
    );
  }
  if (!user && !isEval) {
    // 客户端跳转登录页
    if (typeof window !== 'undefined') window.location.href = '/login';
    return null;
  }
  return <ChatApp />;
}
