// 读 eval/cases/*.yaml → Case[]; 支持 split / id 筛选。
import { readdirSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';

const DEFAULT_DIR = new URL('../cases/', import.meta.url).pathname;

export async function loadCases({ casesDir = DEFAULT_DIR, split = 'all', id } = {}) {
  let files = [];
  try { files = readdirSync(casesDir).filter((f) => f.endsWith('.yaml')); } catch { return []; }
  let cases = files.map((f) => {
    const text = readFileSync(`${casesDir}/${f}`, 'utf8');
    return parse(text);
  }).filter(Boolean);
  if (id) cases = cases.filter((c) => c.id === id);
  if (split && split !== 'all') cases = cases.filter((c) => c.split === split);
  return cases;
}
