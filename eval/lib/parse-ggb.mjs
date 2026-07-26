// GeoGebra xml 解析: 提取 objectInventory / freeVars / elements。
// .ggb 是 zip, readGgbFile 用 fflate 解压取 geogebra.xml; xml 解析用正则提取扁平标签(GeoGebra 结构规整, 够 v1)。
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';

export function readGgbFile(path) {
  const buf = readFileSync(path);
  const files = unzipSync(new Uint8Array(buf));
  const xmlKey = Object.keys(files).find((k) => k.endsWith('geogebra.xml')) || 'geogebra.xml';
  return new TextDecoder().decode(files[xmlKey]);
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

export function parseGeogebraXml(xml) {
  const counts = {};
  const freeVars = [];
  const elements = [];

  // <element type="X" label="Y"> ... </element> 或自闭合 <element type="X" label="Y"/>
  const elemRe = /<element\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/element>)/g;
  let m;
  while ((m = elemRe.exec(xml)) !== null) {
    const head = m[1], body = m[2] || '';
    const type = attr(head, 'type');
    const label = attr(head, 'label');
    if (type) counts[type] = (counts[type] || 0) + 1;
    if (label && type) elements.push({ label, type, definition: '' });

    if (type === 'numeric' && /<slider/.test(body)) {
      const slider = body.match(/<slider\s+([^>]*?)\/>/);
      const sh = slider ? slider[1] : '';
      freeVars.push({
        name: label, type: 'slider',
        min: parseFloat(attr(sh, 'min')), max: parseFloat(attr(sh, 'max')), inc: parseFloat(attr(sh, 'inc')),
      });
    }
    if (type === 'point' && /isIndependent bool="true"/.test(body)) {
      freeVars.push({ name: label, type: 'point' });
    }
  }

  // <expression label="B" exp="B = Midpoint(A, c)"/>
  const exprRe = /<expression\s+([^>]*?)\/>/g;
  while ((m = exprRe.exec(xml)) !== null) {
    const label = attr(m[1], 'label');
    const exp = attr(m[1], 'exp') || '';
    if (label) {
      const existing = elements.find((e) => e.label === label);
      if (existing) existing.definition = exp;
      else elements.push({ label, type: 'expression', definition: exp });
    }
  }

  const objectInventory = Object.entries(counts).map(([type, count]) => ({ type, count }));
  return { objectInventory, freeVars, elements };
}
