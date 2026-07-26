// GLM vision judge: 细粒度 rubric(每项 0/1) + 配对偏好(A/B/tie)。
// 复刻 lib/llm.ts visionByok 的 OpenAI 兼容协议; 解析"问题:" 行(与 app inspect_render 同格式)。

// spec §9: guards 强制必填——每条视觉项也要标它守护的 prompt 规则,
// 否则 L1 归因(spec §15 旗舰特性)漏掉所有视觉失败(attribution 仅遍历 assertions)。
// failureClass 取自 spec §9 失败分类枚举。
export const DEFAULT_RUBRIC = [
  { name: '关键点(顶点/交点/动点)标签是否显示', guards: ['视觉规范·标签'], failureClass: 'visual_label_missing' },
  { name: '辅助线(高/中线/角平分线/构造垂线平行线)是否虚线', guards: ['视觉规范·线型'], failureClass: 'visual_aux_solid' },
  { name: '标签是否遮挡或重叠', guards: ['视觉规范·标签'], failureClass: 'visual_label_overlap' },
  { name: '图形是否贴边或被坐标轴切', guards: ['视觉规范·画布范围'], failureClass: 'visual_clipped' },
  { name: '角弧是否 >180° 异常', guards: ['视觉规范·角弧默认不标'], failureClass: 'visual_angle_arc' },
  { name: '颜色是否 ≤4 且语义清晰', guards: ['视觉规范·配色'], failureClass: 'visual_color' },
  { name: 'Text 公式是否正常渲染(无裸 \\frac / ^2)', guards: ['LaTeX铁律'], failureClass: 'latex_garbled' },
  { name: '整体是否看得懂', guards: ['视觉规范'], failureClass: 'visual_unclear' },
];

async function callGlmVision(glm, prompt, imageUrls) {
  const base = glm.base_url.replace(/\/+$/, '');
  const url = /\/v\d+$/.test(base) ? base + '/chat/completions' : base + '/v1/chat/completions';
  const body = {
    model: glm.model,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: prompt }, ...imageUrls.map((u) => ({ type: 'image_url', image_url: { url: u } }))],
    }],
    max_tokens: 4000, temperature: 0.1, stream: false,
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${glm.api_key}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`GLM vision 请求失败 ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  return (await resp.json()).choices?.[0]?.message?.content || '';
}

function parseIssues(text) {
  if (/验收通过|无问题|no\s*issues/i.test(text)) return [];
  return text.split('\n').map((l) => l.match(/^\s*问题[:：]\s*(.+)/i)).filter(Boolean).map((m) => m[1].trim()).filter(Boolean);
}

// rubric 项主题词: 取首段(遇到 ( / 空白 / "是否" 即止), 用于把 issue 文本回匹配到具体清单项。
// (brief 原用 name.slice(0,4) 会在 "(" 处截断如 "辅助线(高", 与 issue "辅助线该..." 对不上; 取主题词更稳。)
function kw(name) {
  return name.split(/[(\s是否]/)[0];
}

// rubric 既支持字符串(自定义 visual_rubric)也支持对象(DEFAULT_RUBRIC 新形态, 带 guards/failureClass)。
// 统一规整成 {name, guards, failureClass}, 让 judgeSingle/judgePaired 不用关心入参形态。
function normalizeEntry(r) {
  return typeof r === 'string'
    ? { name: r, guards: ['视觉规范'], failureClass: 'visual_unclear' }
    : { name: r.name, guards: r.guards || ['视觉规范'], failureClass: r.failureClass || 'visual_unclear' };
}

export async function judgeSingle({ png, rubric, ctx, glm }) {
  const entries = rubric.map(normalizeEntry);
  const prompt = `你是 K12 数学课件审图员。题目: ${ctx.problem}。重点: ${ctx.key_insight || '(无)'}。
按清单逐项判定(只判视觉能可靠判断的): ${entries.map((r, i) => `${i + 1}. ${r.name}`).join('\n')}
输出格式: 全部通过只输出"验收通过"; 否则每行"问题: <具体项+对象>"。`;
  const raw = await callGlmVision(glm, prompt, [png]);
  const issues = parseIssues(raw);
  const items = entries.map((e) => {
    const ok = !issues.some((iss) => iss.includes(kw(e.name)));
    return { name: e.name, guards: e.guards, ok, ...(ok ? {} : { failureClass: e.failureClass }) };
  });
  return { items, issues };
}

export async function judgePaired({ pngA, pngB, rubric, ctx, glm }) {
  const entries = rubric.map(normalizeEntry);
  const prompt = `你是 K12 数学课件审图员, 比较 A/B 两张画布(同一题: ${ctx.problem})。
第一张=A, 第二张=B。按清单逐项比较哪张更好: ${entries.map((r, i) => `${i + 1}. ${r.name}`).join('\n')}
输出格式: 第一行"偏好: A"或"偏好: B"或"偏好: 平"; 之后每行"问题A: ..."或"问题B: ..."列出各自问题。`;
  const raw = await callGlmVision(glm, prompt, [pngA, pngB]);
  const pref = /偏好[:：]\s*(A|B|平|tie)/i.exec(raw);
  const preference = pref ? ({ 'A': 'A', 'B': 'B', '平': 'tie', 'tie': 'tie' }[pref[1].toUpperCase()] || 'tie') : 'tie';
  // 配对模式专用解析: "问题A: ..." / "问题B: ..." → {side, text}
  // (不用 parseIssues: 它的正则要求冒号紧跟"问题", 不匹配 "问题A:" 这种 side 标记插在中间的格式)
  const paired = [...raw.matchAll(/^\s*问题([AB])[:：]\s*(.+)$/gm)].map((m) => ({ side: m[1], text: m[2].trim() })).filter((p) => p.text);
  return {
    preference,
    items: entries.map((e) => {
      const k = kw(e.name);
      return {
        name: e.name,
        guards: e.guards,
        a_ok: !paired.some((p) => p.side === 'A' && p.text.includes(k)),
        b_ok: !paired.some((p) => p.side === 'B' && p.text.includes(k)),
      };
    }),
    issues: paired.map((p) => `${p.side}: ${p.text}`),
  };
}
