'use client';

// 工具轨迹面板: 展示 Agent 每步调用的工具名/参数/结果 + 命令逐条执行结果

export interface TraceItem {
  id: number;
  name: string;
  args: any;
  result: any;
}

export interface ExecLine {
  cmd: string;
  result: { ok: boolean; labels: string; error: string };
}

export default function TracePanel({
  trace, execLines,
}: { trace: TraceItem[]; execLines: ExecLine[] }) {
  return (
    <details className="trace-panel">
      <summary>🛠 Agent 工具轨迹 <span className="count">{trace.length}</span></summary>
      <div className="trace-list">
        {trace.length === 0 && execLines.length === 0 && (
          <div className="trace-empty">尚无工具调用</div>
        )}
        {trace.map((t) => (
          <div key={t.id} className={`trace-item ${t.result?.error ? 'fail' : 'ok'}`}>
            <div className="trace-head">
              <span className="trace-name">{t.name}</span>
              {t.result?.error ? ' ✗' : ' ✓'}
            </div>
            {t.args && Object.keys(t.args).length > 0 && (
              <pre className="trace-args">{JSON.stringify(t.args, null, 2)}</pre>
            )}
            {t.result && (
              <pre className="trace-result">
                {typeof t.result === 'string' ? t.result : JSON.stringify(t.result).slice(0, 500)}
              </pre>
            )}
          </div>
        ))}
        {execLines.length > 0 && (
          <div className="exec-block">
            {execLines.map((e, i) => (
              <div key={i} className={`exec-line ${e.result.ok ? 'ok' : 'fail'}`}>
                <code>{e.cmd}</code>
                <span className="exec-meta">
                  {e.result.ok ? `✓ ${e.result.labels}` : `✗ ${e.result.error}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}
