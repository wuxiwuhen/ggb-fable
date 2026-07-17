'use client';

// GeoGebra 命令输入面板：替换对话区，提供手动输入 GGB 命令、载入历史、清空画布等功能
// 手动命令通过 onExec 回调交给 ChatApp 统一入库（ggb_exec → execLines），与 AI 命令同一数据源

import { useState, useCallback, useEffect, useRef } from 'react';
import type { GGB, GgbExecResult } from '@/lib/ggb';
import type { ExecLine } from './TracePanel';

interface Props {
  ggbRef: React.MutableRefObject<GGB | null>;
  execLines: ExecLine[];
  currentSessionId: string | null;
  onClose: () => void;
  onExec: (cmd: string, result: GgbExecResult) => void;
}

interface FailedEntry {
  cmd: string;
  error: string;
}

export default function GgbCommandPanel({ ggbRef, execLines, currentSessionId, onClose, onExec }: Props) {
  const [commandInput, setCommandInput] = useState('');
  const [failedCommands, setFailedCommands] = useState<FailedEntry[]>([]);
  const [executing, setExecuting] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 切换会话时清空输入和执行失败记录
  const prevSessionRef = useRef(currentSessionId);
  useEffect(() => {
    if (currentSessionId !== prevSessionRef.current) {
      prevSessionRef.current = currentSessionId;
      setCommandInput('');
      setFailedCommands([]);
    }
  }, [currentSessionId]);

  // textarea 自动撑高以匹配内容，触发外层 .command-editor-wrap 滚动
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
    }
  }, [commandInput]);

  // 清空画布（含二次确认，因为 reset() 后 undo 不可恢复）
  const handleClearCanvas = useCallback(async () => {
    if (!ggbRef.current) return;
    try {
      await ggbRef.current.clearAll();
      setFailedCommands([]);
    } catch (e: any) {
      // 静默
    } finally {
      setConfirmClear(false);
    }
  }, [ggbRef]);

  // 载入历史：统一从 execLines 读取（AI + 手动命令均入库到此）
  const handleLoadHistory = useCallback(() => {
    const lines = execLines
      .filter((line) => line.result?.ok)
      .map((line) => line.cmd.trim())
      .filter((cmd, i, arr) => arr.indexOf(cmd) === i);  // 去重
    if (lines.length > 0) {
      setCommandInput(lines.join('\n'));
    }
  }, [execLines]);

  // 清空输入框
  const handleClearInput = useCallback(() => {
    setCommandInput('');
  }, []);

  // 执行命令：逐行执行，成功回调 onExec 入库，失败收集展示
  const handleExecute = useCallback(async () => {
    const text = commandInput.trim();
    if (!text || !ggbRef.current || executing) return;
    setExecuting(true);
    setFailedCommands([]);

    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const failed: FailedEntry[] = [];
    for (const line of lines) {
      try {
        const r: GgbExecResult = await ggbRef.current.execCommand(line);
        if (r.ok) {
          onExec(line, r);
        } else {
          failed.push({ cmd: line, error: r.error || '执行失败' });
        }
      } catch (e: any) {
        failed.push({ cmd: line, error: e.message || String(e) });
      }
    }
    if (failed.length > 0) {
      setFailedCommands(failed);
    }
    setExecuting(false);
  }, [commandInput, ggbRef, executing, onExec]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleExecute();
      }
    },
    [handleExecute],
  );

  return (
    <div className="command-panel">
      {/* 顶部：操作按钮 */}
      <div className="command-panel-header">
        <div className="command-panel-actions">
          <button
            className="btn ghost sm"
            onClick={() => setConfirmClear(true)}
            title="清空画布上的所有图形（不可撤销）"
          >
            🗑 清空画布
          </button>
          <button
            className="btn ghost sm"
            onClick={handleLoadHistory}
            title="载入本会话中执行成功的 AI 和手动命令"
          >
            📋 载入历史
          </button>
          <button
            className="btn ghost sm"
            onClick={handleClearInput}
            title="清空命令输入框"
            disabled={!commandInput}
          >
            ✕ 清空输入
          </button>
        </div>
        <button className="btn ghost sm" onClick={onClose} title="返回对话模式">
          ← 返回对话
        </button>
      </div>

      {/* 中间：输入区 + 失败反馈 */}
      <div className="command-panel-body">
        <div className="command-input-section">
          <label className="command-input-label">GeoGebra 命令</label>
          <div className="command-input-box">
            <div className="command-editor-wrap">
              <div className="command-editor-inner">
                <div className="command-line-gutter" aria-hidden="true">
                  {(commandInput || ' ').split('\n').map((_, i) => (
                    <span key={i}>{i + 1}</span>
                  ))}
                </div>
                <textarea
                  ref={textareaRef}
                  className="command-textarea"
                  value={commandInput}
                  onChange={(e) => setCommandInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={'输入 GGB 命令，每行一条，如：\nA = (0, 0)\nB = (3, 4)\nCircle(A, B)'}
                  rows={1}
                  spellCheck={false}
                />
              </div>
            </div>
            <div className="command-toolbar">
              <div className="toolbar-spacer" />
              <button
                className="send-btn"
                onClick={handleExecute}
                disabled={!commandInput.trim() || executing}
                title="执行全部命令（逐行执行）"
                aria-label="执行命令"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V6M6 12l6-6 6 6" />
                </svg>
              </button>
            </div>
          </div>
          <div className="command-status">Cmd/Ctrl+Enter 执行 · 每行一条命令逐行执行</div>
        </div>

        {/* 仅执行失败时展示错误明细 */}
        {failedCommands.length > 0 && (
          <div className="command-results fail-only">
            <div className="command-results-label">执行失败（{failedCommands.length} 条）</div>
            <div className="command-results-list">
              {failedCommands.map((f, i) => (
                <div key={i} className="command-result-item fail">
                  <code className="command-fail-cmd">{f.cmd}</code>
                  <span className="command-fail-error">{f.error}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 清空画布确认弹窗 */}
      {confirmClear && (
        <>
          <div className="sidebar-overlay" onClick={() => setConfirmClear(false)} />
          <div className="modal-confirm" style={{ maxWidth: 360 }} onClick={(e) => e.stopPropagation()}>
            <p>确定要清空画布吗？清空后无法通过撤销恢复。</p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setConfirmClear(false)}>取消</button>
              <button className="btn danger" onClick={handleClearCanvas}>确认清空</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
