'use client';

// 命令条: 展示 AI 执行历史(每条 GeoGebra 命令 + 成功/失败)。
// 数据源 execLines: live 由 onExec 维护, 恢复态由 rebuildExecLines 从 messages 重建 → 刷新后不空。

import type { ExecLine } from './TracePanel';

interface Props {
  execLines: ExecLine[];
}

// 临时测量命令(verify_geometry 建的 ggbTmpM 等)不展示
function isTempMeasure(cmd: string): boolean {
  return /^ggbTmp\w*\s*=/.test((cmd || '').trim());
}

export default function CommandBar({ execLines }: Props) {
  const visible = execLines.filter((e) => !isTempMeasure(e.cmd));
  return (
    <details className="cmd-bar">
      <summary data-tour="command-history">
        🧱 执行历史 <span className="count">{visible.length}</span>
      </summary>
      <div className="cmd-bar-body">
        <div className="cmd-list">
          {visible.length === 0 && <div className="cmd-empty">尚无命令</div>}
          {visible.map((e, i) => (
            <div key={i} className={`cmd-row ${e.result.ok ? 'ok' : 'fail'}`}>
              <span className="cmd-idx">{i + 1}.</span>
              <code>{e.cmd}</code>
              <span className="cmd-status">{e.result.ok ? '✓' : '✗'}</span>
              <span className="cmd-meta">{e.result.ok ? e.result.labels : e.result.error}</span>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}
