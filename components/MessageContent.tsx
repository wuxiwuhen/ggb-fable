'use client';

// 消息内容渲染: markdown-it 渲染 markdown + katex.renderToString 渲染数学(占位符策略, 同原项目)
//
// 原理(为何不用 remark-math 或 auto-render):
//   - remark-math: AST 严格, 要求 $ 紧贴非空格, $ x $ 这类直接拒收 → 不稳定
//   - auto-render: 命令式修改 DOM, 和 React 虚拟 DOM 冲突, 重渲染时 removeChild 崩
//   - 本方案: 先把 $...$/$$...$$ 抽成占位符(顺便保护公式内 _ ^ 不被 markdown 当强调),
//             markdown-it 渲染剩余文本, katex.renderToString 回填占位符,
//             最后 dangerouslySetInnerHTML 一次性写入 —— React 不管理子节点, 无冲突。
//             占位符正则不挑空格($ x $/$x $ 都认), throwOnError 容错, 稳定。

import MarkdownIt from 'markdown-it';
import katex from 'katex';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

function renderContent(content: string): string {
  if (!content) return '';
  const math: Array<{ e: string; d: boolean }> = [];
  let work = content;
  // 行间优先: $$...$$ 和 \[...\]; 行内: $...$ 和 \(...\)
  // 兼容模型可能输出的 LaTeX 原生定界符 \( \) \[ \](DeepSeek 等强偏好), 不能只认 $
  work = work.replace(/\$\$([\s\S]+?)\$\$/g, (_m, e) => { math.push({ e, d: true }); return `@@MX${math.length - 1}XM@@`; });
  work = work.replace(/\\\[([\s\S]+?)\\\]/g, (_m, e) => { math.push({ e, d: true }); return `@@MX${math.length - 1}XM@@`; });
  work = work.replace(/\$([^$\n]+?)\$/g, (_m, e) => { math.push({ e, d: false }); return `@@MX${math.length - 1}XM@@`; });
  work = work.replace(/\\\(([\s\S]+?)\\\)/g, (_m, e) => { math.push({ e, d: false }); return `@@MX${math.length - 1}XM@@`; });
  let html = md.render(work);
  // 回填: 占位符 → katex 渲染(坏公式 throwOnError 红字, 不崩)
  html = html.replace(/@@MX(\d+)XM@@/g, (_m, i) => {
    const m = math[+i];
    try { return katex.renderToString(m.e, { displayMode: m.d, throwOnError: false }); }
    catch { return `<code>${m.e}</code>`; }
  });
  return html;
}

export default function MessageContent({ content }: { content: string }) {
  return <div className="msg-content" dangerouslySetInnerHTML={{ __html: renderContent(content) }} />;
}
