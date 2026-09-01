'use client';

// 域名迁移公告: 旧域名 2026-09-07 到期, 提示用户收藏新域名。
// localStorage 记忆是否已读, 全站任意页面首次访问弹出一次, 关闭后不再弹出。
import { useEffect, useState } from 'react';

const STORAGE_KEY = 'ggb-fable-domain-notice-v1';
const NEW_URL = 'https://ggbfable.nanobanano.online';

export default function DomainMigrationNotice() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // 未读过则弹出; 延迟 800ms 错开 /app 新手引导的首屏
  useEffect(() => {
    let seen = false;
    try { seen = localStorage.getItem(STORAGE_KEY) === 'seen'; } catch { /* 隐私模式/禁用 */ }
    if (seen) return;
    const t = setTimeout(() => setOpen(true), 800);
    return () => clearTimeout(t);
  }, []);

  // 任意方式关闭(知道了/✕/点遮罩)都标记已读, 后续不再弹出
  const close = () => {
    setOpen(false);
    try { localStorage.setItem(STORAGE_KEY, 'seen'); } catch { /* 隐私模式/禁用 */ }
  };

  const copyNewUrl = async () => {
    try {
      await navigator.clipboard.writeText(NEW_URL);
    } catch {
      // 剪贴板 API 不可用(非安全上下文)时退回 execCommand
      const ta = document.createElement('textarea');
      ta.value = NEW_URL;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!open) return null;

  return (
    <div className="modal-mask" onClick={close}>
      <div className="xhs-modal domain-notice-modal" onClick={(e) => e.stopPropagation()}>
        <button className="xhs-modal-close" onClick={close}>✕</button>
        <div className="xhs-modal-icon">📢</div>
        <h2 className="xhs-modal-title">网址迁移通知</h2>
        <p className="xhs-modal-desc">
          本站即将更换网址:旧域名 <strong>ggbfable.nanobanano.xyz</strong> 将于{' '}
          <strong>2026 年 9 月 7 日</strong> 到期,到期后无法再通过旧网址访问。
          请收藏并使用新网址:
        </p>
        <div className="xhs-modal-account domain-notice-url">
          <span className="domain-notice-new">{NEW_URL}</span>
          <button className="btn ghost sm" onClick={copyNewUrl}>{copied ? '已复制 ✓' : '复制'}</button>
        </div>
        <button className="btn primary xhs-modal-btn" onClick={close}>知道了</button>
      </div>
    </div>
  );
}
