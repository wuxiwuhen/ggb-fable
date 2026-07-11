'use client';

// 命令条: 双 tab —— "执行历史"(全量审计) / "重建脚本"(精简可重放)
// 重建脚本可编辑后重放到画布

import { useState } from 'react';

interface Props {
  commandLog: Array<{ cmd: string; ok: boolean; labels: string; error: string; ephemeral?: boolean }>;
  recipe: string[] | null;
  onGenerateRecipe: () => Promise<void>;
  onReplay: (lines: string[]) => Promise<void>;
  onSaveRecipe: (lines: string[]) => Promise<void>;
  recipeLoading: boolean;
}

export default function CommandBar({ commandLog, recipe, onGenerateRecipe, onReplay, onSaveRecipe, recipeLoading }: Props) {
  const [mode, setMode] = useState<'history' | 'recipe'>('history');
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [replaying, setReplaying] = useState(false);
  const [saving, setSaving] = useState(false);

  const visibleLog = commandLog.filter((e) => !e.ephemeral);

  function startEdit() {
    setEditText((recipe || []).join('\n'));
    setEditing(true);
  }

  // 完成: 把编辑内容解析为命令行, 写回 recipe 并持久化, 再退出编辑态
  async function finishEdit() {
    const lines = editText.split('\n').map((s) => s.trim()).filter(Boolean);
    setSaving(true);
    try {
      await onSaveRecipe(lines);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  async function replay() {
    const lines = editing
      ? editText.split('\n').map((s) => s.trim()).filter(Boolean)
      : (recipe || []);
    setReplaying(true);
    try { await onReplay(lines); } finally { setReplaying(false); }
  }

  async function gen() {
    setMode('recipe');
    await onGenerateRecipe();
  }

  return (
    <details className="cmd-bar">
      <summary data-tour="command-history">
        🧱 执行历史 / 重建脚本 <span className="count">{visibleLog.length}</span>
      </summary>
      <div className="cmd-bar-body">
        <div className="cmd-bar-actions">
          <div className="cmd-toggle">
            <button className={`cmd-tab ${mode === 'history' ? 'active' : ''}`} onClick={() => setMode('history')}>执行历史</button>
            <button className={`cmd-tab ${mode === 'recipe' ? 'active' : ''}`} data-tour="recipe-tab" onClick={() => setMode('recipe')}>重建脚本</button>
          </div>
          {mode === 'recipe' && (
            <>
              <button className="btn ghost sm" onClick={gen} disabled={recipeLoading}>
                {recipeLoading ? '生成中…' : '🔄 重新生成'}
              </button>
              {recipe && !editing && <button className="btn ghost sm" onClick={startEdit}>✏ 编辑</button>}
              {editing && <button className="btn ghost sm" onClick={finishEdit} disabled={saving}>{saving ? '保存中…' : '✓ 完成'}</button>}
              <button className="btn ghost sm" onClick={replay} disabled={replaying || !recipe}>
                {replaying ? '重放中…' : '▶ 重放'}
              </button>
            </>
          )}
        </div>

        {mode === 'history' ? (
          <div className="cmd-list">
            {visibleLog.length === 0 && <div className="cmd-empty">尚无命令</div>}
            {visibleLog.map((e, i) => (
              <div key={i} className={`cmd-row ${e.ok ? 'ok' : 'fail'}`}>
                <span className="cmd-idx">{i + 1}.</span>
                <code>{e.cmd}</code>
                <span className="cmd-status">{e.ok ? '✓' : '✗'}</span>
                <span className="cmd-meta">{e.ok ? e.labels : e.error}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className={`cmd-list ${editing ? 'editing' : ''}`}>
            {editing ? (
              <textarea
                className="recipe-editor"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                rows={Math.min(20, editText.split('\n').length + 1)}
              />
            ) : recipe ? (
              recipe.map((c, i) => (
                <div key={i} className="cmd-row ok"><span className="cmd-idx">{i + 1}.</span><code>{c}</code></div>
              ))
            ) : (
              <div className="cmd-empty">{recipeLoading ? '正在用模型精简…' : '点击"重新生成"产出最小重放脚本'}</div>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
