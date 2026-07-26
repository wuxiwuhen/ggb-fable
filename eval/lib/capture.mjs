// 在 agent 真实画布上抓 XML/PNG, 并提供 appletEval(临时建对象取值再删, 复用 ggb.ts measure() 思路)。
// 视觉捕获协议: 截图前停动画 + 复位代表帧, 防动图瞬时退化帧误导 judge。

export async function captureArtifacts(page, meta) {
  await page.waitForFunction(() => !!(window.ggbApplet && window.ggbApplet.getXML), null, { timeout: 60000 });

  // 视觉捕获协议: 停动画 + 复位代表帧
  if (meta.animation?.hasAnimation) {
    const slider = meta.representativeFrame?.slider;
    const value = meta.representativeFrame?.value;
    await page.evaluate(([s, v]) => {
      try { window.ggbApplet.stopAnimation(); } catch {}
      if (s != null && v != null) { try { window.ggbApplet.setValue(s, v); } catch {} }
    }, [slider, value]);
    await page.waitForTimeout(300);   // 等渲染稳定
  }

  const xml = await page.evaluate(() => window.ggbApplet.getXML());
  const png = await page.evaluate(() => 'data:image/png;base64,' + window.ggbApplet.getPNGBase64(2, false, 150));
  return { xml, png };
}

// 供 deterministic.mjs 的 appletEval: 临时建 ggbTmpEval 对象读值再删(复用 ggb.ts measure 套路)。
export function makeAppletEval(page) {
  return async (expr) => page.evaluate(async (e) => {
    const a = window.ggbApplet;
    const tmp = 'ggbTmpEval';
    try { if (a.exists(tmp)) a.deleteObject(tmp); } catch {}
    let labels = '';
    try { labels = typeof a.evalCommandGetLabels === 'function' ? a.evalCommandGetLabels(`${tmp} = (${e})`) : await a.asyncEvalCommandGetLabels(`${tmp} = (${e})`); } catch {}
    if (!labels || !String(labels).trim()) return { ok: false, value: '', numeric: undefined };
    const value = a.getValueString(tmp);
    const numeric = a.getValue(tmp);
    try { a.deleteObject(tmp); } catch {}
    if (!value || value === '?' || value === 'NaN' || (typeof numeric === 'number' && !isFinite(numeric))) return { ok: false, value, numeric };
    return { ok: true, value, numeric };
  }, expr);
}
