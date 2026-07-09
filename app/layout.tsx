import type { Metadata } from 'next';
import 'katex/dist/katex.min.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'GGB Fable · GeoGebra AI 画布助手',
  description: 'K12 GeoGebra AI 画布助手 —— 用自然语言生成可探究的动态数学课件',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
