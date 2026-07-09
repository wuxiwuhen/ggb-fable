'use client';

// 消息内容渲染: react-markdown + remark-math + rehype-katex
// 替代原版 markdown-it + innerHTML(避免 XSS, 数学公式统一 $...$ / $$...$$)

import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

export default function MessageContent({ content }: { content: string }) {
  return (
    <div className="msg-content">
      <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
