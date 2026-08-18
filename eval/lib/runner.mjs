// 单 case 编排: 每采样一页(干净会话/画布), 跑完抓画布 + 断言评分, 组装 SampleResult。
import { openPage, feedAndWait, drainEvents, captureCanvas, makeAppletEval } from './browser.mjs';
import { parseCanvasXml } from './parse-canvas.mjs';
import { evaluateAll } from './templates.mjs';
import { buildCaseResult } from './aggregate.mjs';

function statsFromEvents(events) {
  const calls = events.filter((e) => e.type === 'tool_call' && e.name);
  const turnEnd = events.filter((e) => e.type === 'turn_end').pop();
  const insp = calls.filter((e) => e.name === 'inspect_render' && e.result?.ok).pop();
  return {
    rounds: new Set(calls.map((e) => e.round)).size,
    verifyCount: calls.filter((e) => e.name === 'verify_geometry').length,
    renderCount: calls.filter((e) => e.name === 'inspect_render').length,
    failCmds: events.filter((e) => e.type === 'ggb_exec' && e.ok === false).length,
    stopped: !!turnEnd?.stopped,
    errorCount: events.filter((e) => e.type === 'error').length,
    inspectPassed: insp ? insp.result.passed === true : null,
    finalText: String(turnEnd?.finalText || '').slice(0, 200),
  };
}

async function runSample(browser, case_, opts) {
  const { page, events } = await openPage(browser, opts);
  try {
    const feed = await feedAndWait(page, case_.prompt, { timeoutMs: opts.timeoutMs });
    if (feed === 'timeout') {
      await page.click('button.send-btn.stop').catch(() => {});
      await drainEvents(page, events, { waitMs: 2000 });
    } else {
      await drainEvents(page, events);
    }
    const xml = await captureCanvas(page);
    const canvas = parseCanvasXml(xml);
    const assertions = await evaluateAll(case_.assertions, { canvas, events, appletEval: makeAppletEval(page) });
    return { ok: true, timedOut: feed === 'timeout', assertions, stats: statsFromEvents(events) };
  } finally {
    await page.close();
  }
}

export async function runOneCase(browser, case_, opts) {
  const samples = [];
  for (let i = 0; i < opts.runs; i++) {
    try {
      samples.push(await runSample(browser, case_, opts));
    } catch (e) {
      samples.push({ ok: false, error: String(e?.message || e), assertions: [], stats: null });
    }
  }
  return buildCaseResult(case_, samples);
}
