// GLM vision judge: 细粒度 rubric(每项 0/1) + 配对偏好(A/B/tie)。
// 复刻 lib/llm.ts visionByok 的 OpenAI 兼容协议; 解析"问题:" 行(与 app inspect_render 同格式)。

export const DEFAULT_RUBRIC = [
  '关键点(顶点/交点/动点)标签是否显示',
  '辅助线(高/中线/角平分线/构造垂线平行线)是否虚线',
  '标签是否遮挡或重叠',
  '图形是否贴边或被坐标轴切',
  '角弧是否 >180° 异常',
  '颜色是否 ≤4 且语义清晰',
  'Text 公式是否正常渲染(无裸 \\frac / ^2)',
  '整体是否看得懂',
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

export async function judgeSingle({ png, rubric, ctx, glm }) {
  const prompt = `你是 K12 数学课件审图员。题目: ${ctx.problem}。重点: ${ctx.key_insight || '(无)'}。
按清单逐项判定(只判视觉能可靠判断的): ${rubric.map((r, i) => `${i + 1}. ${r}`).join('\n')}
输出格式: 全部通过只输出"验收通过"; 否则每行"问题: <具体项+对象>"。`;
  const raw = await callGlmVision(glm, prompt, [png]);
  const issues = parseIssues(raw);
  const items = rubric.map((name) => ({ name, ok: !issues.some((iss) => iss.includes(kw(name))) }));
  return { items, issues };
}

export async function judgePaired({ pngA, pngB, rubric, ctx, glm }) {
  const prompt = `你是 K12 数学课件审图员, 比较 A/B 两张画布(同一题: ${ctx.problem})。
第一张=A, 第二张=B。按清单逐项比较哪张更好: ${rubric.map((r, i) => `${i + 1}. ${r}`).join('\n')}
输出格式: 第一行"偏好: A"或"偏好: B"或"偏好: 平"; 之后每行"问题A: ..."或"问题B: ..."列出各自问题。`;
  const raw = await callGlmVision(glm, prompt, [pngA, pngB]);
  const pref = /偏好[:：]\s*(A|B|平|tie)/i.exec(raw);
  const preference = pref ? ({ 'A': 'A', 'B': 'B', '平': 'tie', 'tie': 'tie' }[pref[1].toUpperCase()] || 'tie') : 'tie';
  // 配对模式专用解析: "问题A: ..." / "问题B: ..." → {side, text}
  // (不用 parseIssues: 它的正则要求冒号紧跟"问题", 不匹配 "问题A:" 这种 side 标记插在中间的格式)
  const paired = [...raw.matchAll(/^\s*问题([AB])[:：]\s*(.+)$/gm)].map((m) => ({ side: m[1], text: m[2].trim() })).filter((p) => p.text);
  return {
    preference,
    items: rubric.map((name) => {
      const k = kw(name);
      return {
        name,
        a_ok: !paired.some((p) => p.side === 'A' && p.text.includes(k)),
        b_ok: !paired.some((p) => p.side === 'B' && p.text.includes(k)),
      };
    }),
    issues: paired.map((p) => `${p.side}: ${p.text}`),
  };
}
