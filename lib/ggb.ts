// GeoGebra HTML5 applet 桥接层(从 js/ggb.js 迁移, 逻辑不变)
// 职责: 初始化 applet、执行命令(带错误捕获)、读取画布状态(XML→JSON)、视图控制
// 关键设计(来自 GeoChat 生产实践):
//   1. 用 asyncEvalCommandGetLabels 而非 evalCommand —— 后者只返回 boolean
//   2. 通过 client listener 捕获错误到全局, 否则静默失败
//   3. get_canvas_context 用 getXML() 解析出元素/标签
//
// 浏览器专用: 仅在客户端 useEffect 中 init(), deployggb.js 由 next/script 动态加载

import type { Logger as LoggerType } from './logger';

export interface GgbExecResult {
  cmd: string;
  ok: boolean;
  labels: string;
  error: string;
}

export interface CommandLogEntry {
  cmd: string;
  ok: boolean;
  labels: string;
  error: string;
  ts: number;
  ephemeral?: boolean;
}

export interface CanvasElement {
  label: string | null;
  definition: string;
  kind: string;
  type?: string;
}

export interface CanvasContext {
  elementCount: number;
  elements: CanvasElement[];
}

export interface MeasureResult {
  ok: boolean;
  value?: string;
  numeric?: number;
  error?: string;
}

interface GgbApi {
  asyncEvalCommandGetLabels?: (cmd: string) => Promise<string>;
  evalCommandGetLabels?: (cmd: string) => string;
  evalCommand?: (cmd: string) => boolean;
  registerClientListener?: (fn: (e: any) => void) => void;
  registerAddListener?: (fn: (name: string) => void) => void;
  registerRemoveListener?: (fn: (name: string) => void) => void;
  registerUpdateListener?: (fn: () => void) => void;
  setPerspective?: (s: string) => void;
  setAxesVisible?: (x: boolean, y: boolean) => void;
  setGridVisible?: (v: boolean) => void;
  setAxisLabels?: (n: number, x: string, y: string) => void;
  setRepaintingActive?: (v: boolean) => void;
  getXML?: () => string;
  getDefinitionString?: (label: string) => string;
  getObjectType?: (label: string) => string;
  exists?: (label: string) => boolean;
  getValueString?: (label: string) => string;
  getValue?: (label: string) => number;
  deleteObject?: (label: string) => void;
  reset?: () => void;
  getPNGBase64?: (scale: number, transparent: boolean, dpi: number) => string;
  getBase64?: () => string;
  [k: string]: any;
}

export class GGB {
  private applet: GgbApi | null = null;
  private ready = false;
  private lastError = '';
  private readyResolvers: (() => void)[] = [];
  private updateListeners: Array<(kind: string, name: string | null) => void> = [];
  private commandLog: CommandLogEntry[] = [];
  private commandListeners: Array<(entry: any, log: CommandLogEntry[]) => void> = [];
  private logger: LoggerType | null = null;

  constructor(logger?: LoggerType) {
    if (logger) this.logger = logger;
  }

  setLogger(logger: LoggerType) { this.logger = logger; }

  private onReady() {
    this.ready = true;
    while (this.readyResolvers.length) this.readyResolvers.shift()!();
  }

  private waitForReady(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ready) return resolve();
      this.readyResolvers.push(resolve);
    });
  }

  // client listener —— 捕获错误事件
  private clientListener = (evt: any) => {
    let obj: any;
    try { obj = typeof evt === 'string' ? JSON.parse(evt) : evt; } catch { return; }
    if (!obj) return;
    if (obj.type === 'error' || obj.type === 'undefined') {
      const msg = obj.message || '';
      if (/open file|load failed|file not found/i.test(msg)) return;  // 抑制误报
      this.lastError = obj.message || JSON.stringify(obj);
    }
  };

  private addListener = (name: string) => this.fireUpdate('add', name);
  private removeListener = (name: string) => this.fireUpdate('remove', name);
  private updateListener = () => this.fireUpdate('update', null);

  private fireUpdate(kind: string, name: string | null) {
    this.updateListeners.forEach((fn) => { try { fn(kind, name); } catch (e) { console.warn(e); } });
  }

  onUpdate(fn: (kind: string, name: string | null) => void) { this.updateListeners.push(fn); }
  onCommand(fn: (entry: any, log: CommandLogEntry[]) => void) { this.commandListeners.push(fn); }
  getCommandLog() { return this.commandLog.slice(); }
  private fireCommand(entry: any) {
    this.commandListeners.forEach((fn) => { try { fn(entry, this.commandLog); } catch (e) {} });
  }

  // 初始化 applet —— 注入容器并加载
  init(containerId: string, params: Record<string, any> = {}): Promise<GgbApi> {
    return new Promise((resolve, reject) => {
      const container = document.getElementById(containerId);
      if (!container) return reject(new Error(`容器 ${containerId} 不存在`));

      const GGBAppletCtor = (window as any).GGBApplet;
      const appletParams = {
        appName: 'classic',
        width: container.clientWidth || 600,
        height: container.clientHeight || 500,
        showToolBar: true,
        showMenuBar: true,
        showAlgebraInput: true,
        allowUpscale: true,
        autoHeight: true,
        scaleContainerClass: 'canvas-wrap',
        enableRightClick: true,
        enableShiftDragZoom: true,
        errorDialogsActive: false,
        useBrowserForJS: true,
        language: 'zh',
        ...params,
        appletOnLoad: (api: GgbApi) => {
          this.applet = api || (window as any).ggbApplet;
          if (this.applet) {
            try {
              this.applet.registerClientListener?.(this.clientListener);
              this.applet.registerAddListener?.(this.addListener);
              this.applet.registerRemoveListener?.(this.removeListener);
              this.applet.registerUpdateListener?.(this.updateListener);
              try { this.applet.setPerspective?.('G'); } catch (e) { console.warn('setPerspective 失败:', e); }
              try { this.applet.setAxesVisible?.(true, true); } catch (e) {}
              try { this.applet.setGridVisible?.(true); } catch (e) {}
              try { this.applet.setAxisLabels?.(1, 'x', 'y'); } catch (e) {}
            } catch (e) {
              console.warn('listener 注册失败:', e);
            }
            this.onReady();
          }
          resolve(this.applet);
        },
      };

      try {
        if (typeof GGBAppletCtor === 'undefined') {
          return reject(new Error('deployggb.js 未加载, 请检查网络'));
        }
        const ggbApplet = new GGBAppletCtor(appletParams, true);
        ggbApplet.inject(containerId);
      } catch (e) {
        reject(e);
      }
    });
  }

  private async ensureReady(): Promise<GgbApi> {
    if (!this.ready) await this.waitForReady();
    if (!this.applet) throw new Error('GeoGebra applet 未初始化');
    return this.applet;
  }

  // 显式定义命令(形如 A=(..) / c=Circle(..))必有对象产出, 无产出即失败
  private isExplicitDefinition(cmd: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*(\([^)]*\))?\s*=/.test(cmd.trim());
  }

  // 执行单条命令: 判定成功/失败, 失败时给可操作提示
  async execCommand(cmd: string, opts: { ephemeral?: boolean } = {}): Promise<GgbExecResult> {
    const a = await this.ensureReady();
    this.lastError = '';
    const t0 = Date.now();
    let labels = '';
    try {
      if (typeof a.asyncEvalCommandGetLabels === 'function') {
        labels = await a.asyncEvalCommandGetLabels(cmd);
      } else if (typeof a.evalCommandGetLabels === 'function') {
        labels = a.evalCommandGetLabels(cmd);
      } else {
        const ok = a.evalCommand?.(cmd) ?? false;
        if (!ok) this.lastError = this.lastError || 'evalCommand 返回 false (命令可能语法错误)';
      }
    } catch (e: any) {
      this.lastError = String(e.message || e);
    }

    let ok: boolean;
    let error = this.lastError;
    const isAscii = !/[^\x00-\x7F]/.test(cmd);
    if (labels && String(labels).trim()) {
      ok = true;
    } else if (this.lastError) {
      ok = false;
    } else if (this.isExplicitDefinition(cmd)) {
      ok = false;
      error = isAscii
        ? '该定义未产生对象(语法/命令名/参数类型错误)。请先 search_command 查正确签名后再重试。'
        : '命令含非英文字符; evalCommand 只接受英文(US)命令名(如 Point/Circle/Segment), 不要用本地化命令或中文。';
    } else {
      ok = true;
    }

    const result: GgbExecResult = { cmd, ok, labels: labels || '', error: error || '' };
    this.commandLog.push({ cmd, ok, labels: result.labels, error: result.error, ts: Date.now(), ephemeral: !!opts.ephemeral });
    this.fireCommand({ ok: result.ok, cmd, error: result.error, ephemeral: !!opts.ephemeral });
    this.logger?.ggbExec({ command: cmd, ok, labels: result.labels, error: result.error, durationMs: Date.now() - t0 });
    return result;
  }

  // 批量执行(多条用 \n 分隔), setRepaintingActive 包裹避免 O(n) 重绘
  async execBatch(cmdText: string): Promise<GgbExecResult[]> {
    const a = await this.ensureReady();
    const lines = cmdText.split('\n').map((s) => s.trim()).filter(Boolean);
    const results: GgbExecResult[] = [];
    try { a.setRepaintingActive?.(false); } catch (e) {}
    for (const line of lines) {
      const r = await this.execCommand(line);
      results.push({ ...r, cmd: line });
    }
    try { a.setRepaintingActive?.(true); } catch (e) {}
    return results;
  }

  // 读取画布状态: getXML → 解析元素, 再用 API 丰富 definition/type
  async getCanvasContext(): Promise<CanvasContext> {
    const a = await this.ensureReady();
    let xml = '';
    try { xml = a.getXML?.() || ''; } catch { xml = ''; }
    const elements = this.parseElements(xml);
    for (const el of elements) {
      try { if (a.getDefinitionString && el.label) el.definition = a.getDefinitionString(el.label) || el.definition; } catch (e) {}
      try { if (a.getObjectType && el.label) el.type = a.getObjectType(el.label); } catch (e) {}
    }
    return { elementCount: elements.length, elements };
  }

  private parseElements(xml: string): CanvasElement[] {
    const out: CanvasElement[] = [];
    if (!xml || typeof DOMParser === 'undefined') return out;
    try {
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      doc.querySelectorAll('construction expression').forEach((el) => {
        out.push({ label: el.getAttribute('label'), definition: el.getAttribute('value') || '', kind: 'expression' });
      });
      doc.querySelectorAll('construction command').forEach((el) => {
        const name = el.getAttribute('name');
        const out0 = el.querySelector('output');
        const label = out0 ? out0.getAttribute('a0') : '';
        if (label && !out.find((x) => x.label === label)) {
          out.push({ label, definition: `${name}(...)`, kind: 'command' });
        }
      });
    } catch (e) {
      console.warn('XML 解析失败:', e);
    }
    return out;
  }

  // 测量表达式值 —— 验证几何约束(临时建对象读值再删)
  async measure(expression: string): Promise<MeasureResult> {
    if (/^[0-9+\-*/().\s]+$/.test(expression || '')) {
      return { ok: false, error: '请勿用 verify_geometry 验证算术(如 1+1); 它只用于几何量测量。' };
    }
    const tmpLabel = 'ggbTmpM';
    const a = await this.ensureReady();
    try { if (a.exists?.(tmpLabel)) a.deleteObject?.(tmpLabel); } catch (e) {}
    const cmd = `${tmpLabel} = (${expression})`;
    const r = await this.execCommand(cmd, { ephemeral: true });
    if (!r.ok) {
      try { a.deleteObject?.(tmpLabel); } catch (e) {}
      return { ok: false, error: r.error || '表达式执行失败, 请检查对象引用是否存在' };
    }
    const val = a.getValueString?.(tmpLabel) || '';
    const num = a.getValue?.(tmpLabel);
    try { a.deleteObject?.(tmpLabel); } catch (e) {}
    if (!val || val === '?' || val === 'NaN' || val === 'undefined' || (typeof num === 'number' && !isFinite(num))) {
      return { ok: false, error: '测量无意义: 值为空/未定义, 可能引用的对象不存在或表达式不产生数值。' };
    }
    return { ok: true, value: val, numeric: num };
  }

  async clearAll() {
    if (!this.applet) return;
    try { this.applet.reset?.(); } catch (e) {}
    try {
      if (!this.applet.reset) {
        const xml = this.applet.getXML?.() || '';
        if (xml && typeof DOMParser !== 'undefined') {
          const doc = new DOMParser().parseFromString(xml, 'text/xml');
          const labels = [...doc.querySelectorAll('construction element')]
            .map((el) => el.getAttribute('label')).filter(Boolean) as string[];
          for (const lb of labels) {
            try { this.applet.evalCommand?.('Delete(' + lb + ')'); } catch (e) {}
          }
        }
      }
    } catch (e) {}
    this.commandLog = [];
    this.fireCommand(null);
  }

  setCoordSystem(xmin: number, xmax: number, ymin: number, ymax: number) {
    if (!this.applet) return;
    try { this.applet.setCoordSystem?.(xmin, xmax, ymin, ymax); } catch (e) {}
  }

  getPNGBase64(scale = 2, transparent = false, dpi = 300): string | null {
    if (!this.applet) return null;
    try { return this.applet.getPNGBase64?.(scale, transparent, dpi) || null; } catch (e) { return null; }
  }

  getBase64(): string | null {
    if (!this.applet) return null;
    try { return this.applet.getBase64?.() || null; } catch (e) { return null; }
  }

  isReady() { return this.ready; }
  getAPI() { return this.applet; }
}
