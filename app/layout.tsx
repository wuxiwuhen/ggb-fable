import type { Metadata } from 'next';
import 'katex/dist/katex.min.css';
import './globals.css';
import { AuthProvider } from '@/lib/auth';

export const metadata: Metadata = {
  title: 'GGB Fable · GeoGebra AI 画布助手',
  description: 'K12 GeoGebra AI 画布助手 —— 用自然语言生成可探究的动态数学课件',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // AuthProvider 常驻 layout: 客户端路由切换时不卸载, 全站共享同一份已解析的会话状态,
  // 避免每个页面各自 useAuth() 重新解析导致"未登录/非管理员"闪现。
  return (
    <html lang="zh-CN">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
