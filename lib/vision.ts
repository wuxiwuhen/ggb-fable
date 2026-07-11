// 图片预处理 + OCR 识别编排(从 js/vision.js 迁移, 逻辑不变)
// 职责:
//   1. compress(file) → canvas 压缩/限尺寸 → data URL
//   2. recognize({image, visionFn, signal}) → 调视觉模型 OCR → 清洗后文本
// 整体策略: 视觉模型只出文本, 文本再进 Agent 工具循环(两步解耦)
//
// visionFn 由调用方注入(trial=visionTrial / byok=visionByok), Vision 与模式无关

const MAX_DIM = 1600;
const JPEG_QUALITY = 0.85;

// glm-4.6v 顽固用「带空格圆括号」( X ) 作数学定界; 真正数学括号(点坐标/条件/题号)不带空格
function normalizeMathDelimiters(text: string): string {
  if (!text) return text;
  let prev: string;
  let cur = text;
  for (let pass = 0; pass < 2; pass++) {
    prev = cur;
    cur = cur.replace(/\(\s+([\s\S]*?)\s+\)/g, (full, inner) => {
      const t = inner.trim();
      if (!t || t.includes('$')) return full;
      if (!isMathLike(t)) return full;
      return '$' + t + '$';
    });
    if (cur === prev) break;
  }
  return cur;
}

function isMathLike(t: string): boolean {
  if (!t) return false;
  if (/\\[a-zA-Z]/.test(t)) return true;
  if (/[=^_<>]/.test(t)) return true;
  if (/\d/.test(t)) return true;
  if (/^[A-Za-z]{1,6}(?:[,，][A-Za-z]{1,6})*$/.test(t)) return true;
  return false;
}

function trimSections(text: string): string {
  if (!text) return text;
  let t = text;
  t = t.replace(/=+\s*第一块[^\n]*\n?/g, '');
  const m = t.match(/=+\s*第二块[^\n]*\n/);
  if (m) {
    const idx = m.index!;
    const rest = t.slice(idx + m[0].length).trim();
    if (!rest || /^(无图形|无图|无|（\s*无图形?\s*）|\(\s*无图形?\s*\))$/.test(rest)) {
      t = t.slice(0, idx);
    }
  }
  return t.replace(/[\s\n]+$/, '');
}

export const Vision = {
  // 从 File/Blob 压缩 → data:image/jpeg;base64,...
  async compress(file: Blob): Promise<string> {
    const img = await createImageBitmap(file);
    let { width, height } = img;
    if (Math.max(width, height) > MAX_DIM) {
      const ratio = MAX_DIM / Math.max(width, height);
      width = Math.round(width * ratio);
      height = Math.round(height * ratio);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, width, height);
    img.close();
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  },

  async fromClipboardItem(item: ClipboardItem): Promise<string | null> {
    for (const type of item.types) {
      if (type.startsWith('image/')) {
        const blob = await item.getType(type);
        return await this.compress(blob);
      }
    }
    return null;
  },

  // 调视觉模型做 OCR, 返回清洗后的完整文本
  // visionFn: (image, prompt, signal) => Promise<string>
  async recognize({
    image, signal, visionFn,
  }: {
    image: string;
    signal?: AbortSignal;
    visionFn: (image: string, prompt: string, signal?: AbortSignal) => Promise<string>;
  }): Promise<string> {
    const prompt = `你是数学题 OCR 专家。看这张题目图片，输出一段文字，让别人仅凭这段文字能 100% 复刻原题（全部文字+全部图形）。

【最重要·数学必须可渲染】所有数学公式必须用 LaTeX，且只允许两种定界符：
- 行内公式用 $...$，例如 $\\frac{1}{2}$、$x^2$、$\\angle A$、$\\pi r^2$
- 独占一行的公式/方程用 $$...$$
$...$ 只包裹数学表达式本身，绝不把汉字或标点包进去（错：$当 x>0 时$；对：当 $x>0$ 时）。
绝对禁止：① 用 ( ) [ ] { } 当公式定界符；② 公式裸露不加 $（直接写 x^2+1=0 是错的）；③ 用 Unicode 符号写数学——x²、√2、≥、≤、π、×、÷ 全不行，必须写成 $x^2$、$\\sqrt{2}$、$\\geq$、$\\leq$、$\\pi$、$\\times$、$\\div$（角度的 ° 写成如 $30^\\circ$）。

【错误 vs 正确】
错：( \\frac{a}{b} )            对：$\\frac{a}{b}$
错：x² + 1 = 0                 对：$x^2 + 1 = 0$
错：求 ∠A 的度数                对：求 $\\angle A$ 的度数
错：sin30° = 0.5               对：$\\sin 30^\\circ = 0.5$
错：圆面积 πr²                  对：圆面积 $\\pi r^2$

【多行公式】方程组/分段函数/矩阵/多步推导必须用 $$...$$ 包裹并选对应环境（换行用 \\\\）：
- 方程组：$$\\begin{cases} 2x+y=1 \\\\ x-y=3 \\end{cases}$$
- 分段函数：$$f(x)=\\begin{cases} 1, & x>0 \\\\ 0, & x\\leq 0 \\end{cases}$$
- 多步对齐：$$\\begin{aligned} 2x+1 &= 5 \\\\ 2x &= 4 \\\\ x &= 2 \\end{aligned}$$
- 矩阵：$$\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}$$

【输出结构】严格按以下两块输出，且只输出这两块：

===== 第一块：题目原文逐字转录 =====
按阅读顺序转录图片里的所有文字。文字保持原文措辞，禁止改写/概括/翻译/润色；其中的数学符号必须按上面要求转成可渲染 LaTeX。遮挡或模糊处用〚不清〛标注，不要猜。

===== 第二块：图形/图片详细描述 =====
若题目含任何图，对每一个图独立详尽描述，详细到别人能照着精确重画。若完全没有图形，本块写"无图形"。

【可用 LaTeX 命令】\\frac \\dfrac \\sqrt \\sqrt[n]{} _{} ^{} \\angle \\triangle \\cdot \\times \\div \\pm \\geq \\leq \\neq \\approx \\infty \\pi \\sum \\lim \\sin \\cos \\tan \\log \\ln \\vec{} \\overline{} \\circ \\quad

【输出纪律】不要解题，不要生成代码或 JSON。上面所有【】里的要求与示例本身绝不能出现在你的输出里。完整性优先，宁冗勿漏。

现在开始：你输出的第一个字符必须是 =（即第一块的标题行）。`;

    const raw = await visionFn(image, prompt, signal);
    return trimSections(normalizeMathDelimiters(raw));
  },
};
