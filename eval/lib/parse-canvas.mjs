// GeoGebra 画布 XML → CanvasCtx。结构规整, 正则提取足够(GeoGebra XML 无嵌套 element)。
// .ggb zip 解析是 v2(社区材料)的事, v1 只吃 getXML() 文本。

function attr(head, name) {
  const m = head.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

export function parseCanvasXml(xml) {
  const elements = [];
  const freeVars = [];
  const exps = [];
  const cmdBlocks = [];
  if (typeof xml !== 'string' || !xml) return { elements, freeVars, corpus: '' };

  let m;
  // body 用 tempered 模式(不得跨越下一个 <element 开标签): 否则自闭合标签的 '/' 落进 head,
  // 惰性 body 会一直吃到后面某个成对元素的 </element>, 把那个元素整个吞掉
  const elemRe = /<element\s+([^>]*?)>((?:(?!<element\b)[\s\S])*?)<\/element>/g;
  while ((m = elemRe.exec(xml)) !== null) {
    const head = m[1], body = m[2];
    const type = attr(head, 'type');
    const label = attr(head, 'label');
    if (!type || !label) continue;
    const visible = !/<showObject\s+[^>]*bool="false"/.test(body);
    elements.push({ label, type, visible, definition: '' });

    if (type === 'numeric' && /<slider/.test(body)) {
      freeVars.push({ name: label, type: 'slider' });
    }
    if ((type === 'point' || type === 'numeric') && /isIndependent bool="true"/.test(body)) {
      if (!freeVars.some((v) => v.name === label)) freeVars.push({ name: label, type: type === 'point' ? 'point' : 'slider' });
    }
  }

  // 自闭合 <element .../>(无子节点的派生对象, 如被命令创建的圆)——tempered 成对正则不吃这种
  const elemSelfRe = /<element\s+([^>]*?)\/>/g;
  while ((m = elemSelfRe.exec(xml)) !== null) {
    const type = attr(m[1], 'type'), label = attr(m[1], 'label');
    if (!type || !label || elements.some((e) => e.label === label)) continue;
    elements.push({ label, type, visible: true, definition: '' });
  }

  const exprRe = /<expression\s+([^>]*?)\/>/g;
  while ((m = exprRe.exec(xml)) !== null) {
    const label = attr(m[1], 'label');
    const exp = attr(m[1], 'exp') || '';
    exps.push(exp);
    const existing = elements.find((e) => e.label === label);
    if (existing) existing.definition = exp;
    else elements.push({ label, type: 'expression', visible: true, definition: exp });
  }

  const cmdRe = /<command\s+([^>]*?)>([\s\S]*?)<\/command>/g;
  const inRe = /<input\s+([^>]*?)\/>/g;
  while ((m = cmdRe.exec(xml)) !== null) {
    // 只取 <input/> 属性值作依赖语料(<output/> 是 label, 不构成表达式——避免自由变量名撞输出 label 误报)
    let im; const inputs = [];
    while ((im = inRe.exec(m[2])) !== null) inputs.push(...(im[1].match(/"[^"]*"/g) || []).map((s) => s.slice(1, -1)));
    cmdBlocks.push(inputs.join(' '));
  }

  return { elements, freeVars, corpus: [...exps, ...cmdBlocks].join('\n') };
}
