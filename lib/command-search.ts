// 混合检索 GeoGebra 命令(从 js/command-search.js 迁移, 逻辑不变)
// 策略: 中文别名 → 精确/前缀 → 关键词 → 向量语义重排(GLM embedding-3, 1024维)
// 数据源: public/knowledge/commandSignatures.json (509条官方命令) + 手工中文别名/陷阱
//
// 向量 embedding 调用可注入: trial 模式走 /api/trial/embeddings(用我的 key),
// byok 模式前端直连用户的 GLM 端点。CommandSearch 本身与模式无关。

const DIM = 1024;

export type EmbedFunction = (texts: string[]) => Promise<number[][] | null>;

interface SignatureEntry {
  commandBase: string;
  signature: string;
  description?: string;
  examples?: any[];
  note?: string;
}

interface Overload {
  signature: string;
  description: string;
  examples: any[];
  note: string;
}

export interface CommandEntry {
  commandBase: string;
  category: string;
  aliases: string[];
  pitfalls: string | null;
  overloads: Overload[];
}

// 中文同义词桥接(官方文档只有英文)
const ALIASES: Record<string, string[]> = {
  Point: ['点', '动点', '坐标点'], Midpoint: ['中点', '中心'], Intersect: ['交点', '相交'],
  Segment: ['线段'], Line: ['直线', '一次函数'], Ray: ['射线'], Vector: ['向量'],
  PerpendicularLine: ['垂线', '垂直', '高线'], ParallelLine: ['平行线', '平行'],
  Circle: ['圆', '圆心', '半径'], Semicircle: ['半圆'], Ellipse: ['椭圆'],
  Hyperbola: ['双曲线'], Parabola: ['抛物线'], Polygon: ['多边形', '三角形', '四边形', '正多边形'],
  Tangent: ['切线', '相切', '切点'], Root: ['根', '零点', '交x轴'], Extremum: ['极值', '最值', '顶点'],
  Derivative: ['导数', '求导', '导函数'], Integral: ['积分', '定积分', '面积'],
  Translate: ['平移'], Rotate: ['旋转', '旋转角'], Reflect: ['对称', '反射', '翻折'], Dilate: ['缩放', '位似'],
  Slider: ['滑块', '参数', '变量', '拖动', '动画'], Locus: ['轨迹', '动点轨迹'],
  Distance: ['距离', '长度'], Length: ['长度'], Angle: ['角', '内角', '夹角', '直角标记'],
  ArePerpendicular: ['垂直', '正交', '直角', '垂线验证'], Area: ['面积', '区域'], Slope: ['斜率', '坡度'],
  If: ['条件', '分段', '分段函数'], Curve: ['参数方程', '曲线', '参数曲线'],
  Sequence: ['序列', '数列', '列表', '点列'], SetCoordSystem: ['坐标系', '坐标范围', '缩放'],
  SetConditionToShowObject: ['显示条件', '显隐', '动态显隐'], SetVisible: ['隐藏', '显示', '可见', '显隐'],
  ShowLabel: ['标签', '显示标签'], SetColor: ['颜色', '着色', '蓝色', '红色'],
  SetPointSize: ['点大小'], SetLineThickness: ['线宽', '粗细'], SetFilling: ['填充'],
  Delete: ['删除', '移除'], Rename: ['重命名', '改名'], ZoomIn: ['放大'],
  ShowAxes: ['坐标轴'], ShowGrid: ['网格'], Text: ['文本', '文字', '标注'],
  Execute: ['批量执行'], LowerSum: ['黎曼和', '下和'], UpperSum: ['上和', '黎曼上'],
  TaylorSeries: ['泰勒', '展开'], Numeric: ['数值', '求值'],
};

// 陷阱提示(教学实践积累)
const PITFALLS: Record<string, string> = {
  Intersect: '多交点时务必带索引(第三个参数), 否则自动命名 B_1,B_2 导致后续引用失败',
  Angle: '默认不标角! 只标解题强相关的角(每题0-1个)。视觉弧始终逆时针, 值0-360°。',
  StartAnimation: '启动单滑块用 StartAnimation(k, true) 两参数(字面true), 别用单参。',
  Circle: 'Circle(A,3) 是半径数值; Circle(A,B) 是过点 B。7 种重载最易混淆',
  Ellipse: '第3参数是半长轴长度(数值), 不是点',
  SetColor: 'RGB 分量范围是 0~1 浮点(如 0.12, 0.47, 1), 不是 0~255',
  Tangent: '多切点时需带索引', Rotate: '角度默认度; 旋转中心常忘传第三参数',
  Slider: '9参数: (Min,Max,增量,速度,宽度,是否角,水平,是否动画,随机)。角度量必须带度符号。',
  Locus: '第一个点必须在某路径上, 不能是自由点',
  Sequence: '批量生成用 Sequence; 字符串表达式用 %1 占位符',
  Execute: 'Execute 列表内的命令必须是英文 (US)',
  Delete: '删依赖对象前确认无子对象引用',
  Function: '乘法必须显式写 *, 不要写 3x; 幂用 ^',
  If: '分段函数/条件对象必用 If',
  Text: '含数学符号必须开LaTeX渲染: 第4参传true, 即 Text(内容,(x,y),false,true)。',
  SetCaption: '中文标签需配合 ShowLabel(true) 用 SetCaption',
};

const CATEGORIES: Record<string, string> = {
  Point: '点', Midpoint: '点', Intersect: '点', FreePoint: '点',
  Segment: '线', Line: '线', Ray: '线', Vector: '线', PerpendicularLine: '线', ParallelLine: '线',
  Circle: '圆', Semicircle: '圆', Ellipse: '圆', Hyperbola: '圆', Parabola: '圆',
  Polygon: '多边形',
  Function: '函数', If: '函数', Curve: '函数', Tangent: '函数', Root: '函数', Extremum: '函数',
  Derivative: '微积分', Integral: '微积分', LowerSum: '微积分', UpperSum: '微积分', TaylorSeries: '微积分',
  Translate: '变换', Rotate: '变换', Reflect: '变换', Dilate: '变换',
  Slider: '动画', Locus: '轨迹', SetConditionToShowObject: '动画',
  Distance: '测量', Length: '测量', Angle: '测量', Area: '测量', Slope: '测量',
  SetColor: '样式', ShowLabel: '样式', SetPointSize: '样式', SetLineThickness: '样式', SetFilling: '样式',
  SetCaption: '样式', SetLabelVisible: '样式', SetFixed: '样式', SetVisible: '样式', Text: '样式',
  SetCoordSystem: '视图', ZoomIn: '视图', ShowAxes: '视图', ShowGrid: '视图',
  Delete: '编辑', Execute: '编辑', Sequence: '函数',
};

const FREQUENT_COMMANDS = [
  'Point', 'Segment', 'Circle', 'Line', 'Slider', 'Intersect', 'Midpoint', 'Polygon',
  'Distance', 'Angle', 'SetColor', 'ShowLabel', 'Text', 'Translate', 'Rotate',
  'PerpendicularLine', 'Tangent', 'Area', 'Reflect', 'Locus',
];

export class CommandSearch {
  private fullDB: SignatureEntry[] = [];
  private indexedDB: Record<string, CommandEntry> = {};
  private embeddingCache: Record<string, number[]> = {};
  private embed: EmbedFunction | null;
  private ready = false;
  private readyResolvers: (() => void)[] = [];
  private preWarmDone = false;

  constructor(embed: EmbedFunction | null = null) {
    this.embed = embed;
  }

  private whenReady(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ready) return resolve();
      this.readyResolvers.push(resolve);
    });
  }

  async init() {
    try {
      if (this.embed) {
        console.log('[CommandSearch] embedding 已注入');
      } else {
        console.warn('[CommandSearch] 无 embedding 函数, 降级为关键词搜索');
      }
      this.fullDB = await this.loadCommandDB();
      this.buildIndex();
      this.preWarmEmbeddings(FREQUENT_COMMANDS);
      this.ready = true;
      while (this.readyResolvers.length) this.readyResolvers.shift()!();
    } catch (e: any) {
      console.error('[CommandSearch] 初始化失败:', e.message);
      this.fullDB = [];
      this.indexedDB = {};
      this.ready = true;
      while (this.readyResolvers.length) this.readyResolvers.shift()!();
    }
  }

  private async loadCommandDB(): Promise<SignatureEntry[]> {
    const resp = await fetch('/knowledge/commandSignatures.json');
    if (!resp.ok) throw new Error(`加载失败: ${resp.status}`);
    return await resp.json();
  }

  private buildIndex() {
    this.indexedDB = {};
    for (const entry of this.fullDB) {
      const base = entry.commandBase;
      if (!this.indexedDB[base]) {
        this.indexedDB[base] = {
          commandBase: base,
          category: CATEGORIES[base] || '',
          aliases: ALIASES[base] || [],
          pitfalls: PITFALLS[base] || null,
          overloads: [],
        };
      }
      this.indexedDB[base].overloads.push({
        signature: entry.signature,
        description: entry.description || '',
        examples: entry.examples || [],
        note: entry.note || '',
      });
    }
  }

  private async glmEmbedding(texts: string[]): Promise<number[][] | null> {
    if (!this.embed) return null;
    const input = Array.isArray(texts) ? texts : [texts];
    if (!input.length) return [];
    try {
      return await this.embed(input);
    } catch (e: any) {
      console.warn('[CommandSearch] embedding 异常:', e.message);
      return null;
    }
  }

  private normalize(v: number[]): number[] {
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }

  private dot(a: number[], b: number[]): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  private preWarmEmbeddings(cmds: string[]) {
    if (this.preWarmDone || !this.embed) return;
    this.preWarmDone = true;
    (async () => {
      const toWarm = cmds.filter((n) => !this.embeddingCache[n] && this.indexedDB[n]);
      if (!toWarm.length) return;
      try {
        const vecs = await this.glmEmbedding(toWarm);
        if (vecs) {
          toWarm.forEach((n, i) => { this.embeddingCache[n] = this.normalize(vecs[i]); });
          console.log(`[CommandSearch] 预热 ${toWarm.length} 个高频向量`);
        }
      } catch (e) { /* 静默 */ }
    })();
  }

  // 四层搜索: 别名 → 精确 → 关键词 → 向量重排
  async search(query: string, limit = 4): Promise<CommandEntry[]> {
    const q = (query || '').toLowerCase().trim();
    if (!q || !Object.keys(this.indexedDB).length) return [];

    // 1) 中文别名转换
    const aliasHits = this.matchAliases(q);
    if (aliasHits.length) {
      return aliasHits.slice(0, limit).map((base) => this.indexedDB[base]).filter(Boolean);
    }
    // 2) 精确/前缀
    const exact = this.exactMatch(q);
    if (exact.length) return exact.slice(0, limit);
    // 3) 关键词
    const kw = this.keywordMatch(q);
    if (kw.length > 5 && kw.length <= 60) {
      const rr = await this.reRank(q, kw, limit);
      return rr.length > 0 ? rr : kw.slice(0, limit);
    }
    if (kw.length > 0 && kw.length <= 5) return kw.slice(0, limit);
    if (kw.length > 60) return kw.slice(0, limit);
    // 4) 纯向量
    const allBases = Object.keys(this.indexedDB);
    const rr = await this.reRank(q, allBases, limit);
    if (rr.length > 0) return rr;
    return kw.length > 0 ? kw.slice(0, limit) : [];
  }

  private matchAliases(q: string): string[] {
    const hits: string[] = [];
    for (const [base, words] of Object.entries(ALIASES)) {
      if (words.some((w) => q === w || q.includes(w) || w.includes(q))) hits.push(base);
    }
    for (const base of Object.keys(this.indexedDB)) {
      const lb = base.toLowerCase();
      if (lb === q || lb.startsWith(q)) {
        if (!hits.includes(base)) hits.push(base);
      }
    }
    return hits;
  }

  private exactMatch(q: string): CommandEntry[] {
    const out: CommandEntry[] = [];
    for (const base of Object.keys(this.indexedDB)) {
      const lb = base.toLowerCase();
      if (lb === q || lb.startsWith(q)) out.push(this.indexedDB[base]);
    }
    return out;
  }

  private keywordMatch(q: string): CommandEntry[] {
    const words = q.split(/\s+/);
    const out: CommandEntry[] = [];
    for (const base of Object.keys(this.indexedDB)) {
      const entry = this.indexedDB[base];
      const searchText = [
        base.toLowerCase(),
        ...(entry.overloads || []).map((o) => (o.description + ' ' + (o.note || '')).toLowerCase()),
        ...(entry.aliases || []).map((a) => a.toLowerCase()),
      ].join(' ');
      if (words.some((w) => searchText.includes(w))) out.push(entry);
    }
    return out;
  }

  private async reRank(queryText: string, candidates: any[], limit: number): Promise<CommandEntry[]> {
    if (!this.embed) return [];
    const bases: string[] = Array.isArray(candidates)
      ? (typeof candidates[0] === 'string' ? candidates : candidates.map((c) => c.commandBase))
      : [];
    if (!bases.length) return [];

    const qVecs = await this.glmEmbedding([queryText]);
    if (!qVecs || !qVecs[0]) return [];
    const qv = this.normalize(qVecs[0]);

    const needed = bases.filter((b) => !this.embeddingCache[b]);
    if (needed.length > 0) {
      const newVecs = await this.glmEmbedding(needed);
      if (newVecs) {
        needed.forEach((b, i) => { this.embeddingCache[b] = this.normalize(newVecs[i]); });
      }
    }

    const ql = queryText.toLowerCase();
    const scored = bases
      .filter((b) => this.embeddingCache[b])
      .map((b) => {
        const vecScore = this.dot(qv, this.embeddingCache[b]);
        let kw = 0;
        const lb = b.toLowerCase();
        if (lb === ql) kw = 0.6;
        else if (ql.includes(lb)) kw = 0.5;
        else if (lb.startsWith(ql)) kw = 0.45;
        else if (lb.includes(ql)) kw = 0.3;
        return { b, score: vecScore + kw };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map((s) => this.indexedDB[s.b]).filter(Boolean);
  }

  // 格式化为给模型看的签名块
  format(results: CommandEntry[], limit = 5): string {
    if (!results || !results.length) {
      return '(未找到匹配的命令。请用中文或英文描述效果, 如"隐藏对象"→SetVisible、"显示标签"→ShowLabel)';
    }
    return results.map((entry) => this.formatEntry(entry, limit)).join('\n\n');
  }

  private formatEntry(entry: CommandEntry, maxOverloads = 5): string {
    const pitfallsBlock = entry.pitfalls ? `\n  陷阱: ${entry.pitfalls}` : '';
    const catStr = entry.category ? ` (${entry.category})` : '';
    const sorted = [...entry.overloads].sort((a, b) => {
      const aHas = a.examples && a.examples.length ? 1 : 0;
      const bHas = b.examples && b.examples.length ? 1 : 0;
      return bHas - aHas;
    });
    const shown = sorted.slice(0, maxOverloads);
    const more = sorted.length > maxOverloads ? `\n  (…还有 ${sorted.length - maxOverloads} 个重载, 如需查看请精确搜索)` : '';
    const sigBlock = shown.map((o) => {
      const exStr = o.examples && o.examples.length
        ? `\n    例: ${o.examples[0].command || o.examples[0].description || o.examples[0]}`
        : '';
      return `  ${o.signature}${exStr}`;
    }).join('\n');
    return `[${entry.commandBase}]${catStr}\n${sigBlock}${more}${pitfallsBlock}`;
  }

  isReady() { return this.ready; }
  async waitReady() { if (!this.ready) await this.whenReady(); }
}
