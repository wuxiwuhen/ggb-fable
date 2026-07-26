// 打印/复制 case 题目, 供手动在 web 端冒烟(资产单源多用途)。
import { loadCases } from '../lib/case-loader.mjs';
import { execSync } from 'node:child_process';

const id = process.argv[2];
if (!id) { console.error('用法: pnpm eval:manual <id>'); process.exit(1); }
const [c] = await loadCases({ id });
if (!c) { console.error(`找不到 case ${id}`); process.exit(1); }

console.log(`\n【${c.meta.title || c.id}】\n`);
console.log(c.meta.problem);
console.log('\n(已尝试复制到剪贴板, 直接粘进 web 端输入框)');

try {
  const cmd = process.platform === 'darwin' ? 'pbcopy' : process.platform === 'win32' ? 'clip' : 'wl-copy';
  execSync(cmd, { input: c.meta.problem, stdio: ['pipe', 'ignore', 'ignore'] });
} catch { /* 非 macOS/Linux/Win 或无 wl-copy, 忽略 */ }
