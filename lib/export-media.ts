// 导出媒体工具函数: PNG / 视频录制(MP4 优先, WebM 兜底)
// 职责:
//   1. exportPng: 调用 applet.getPNGBase64 → 生成并下载 PNG
//   2. startRecording/stopRecording: 用 MediaRecorder 录制 canvas, 开始/停止交互
//      mimeType 优先探测 MP4(Chrome 126+/Safari 原生支持), 不支持退 WebM, 扩展名跟实际格式走
// 全部纯前端, 不经服务器, 不读写本地文件(产物仅在内存, 最后一键下载)。

import type { GGB } from './ggb';

// ─── PNG 导出(原 ChatApp 逻辑搬入, 保持一致) ───

export function exportPng(ggb: GGB | null, filename?: string) {
  if (!ggb) return;
  const base64 = ggb.getPNGBase64(2, false, 200);
  if (!base64) return;
  const a = document.createElement('a');
  a.href = base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`;
  a.download = filename || `ggb-fable-${Date.now()}.png`;
  a.click();
}

// ─── 视频录制(MP4 优先, WebM 兜底) ───

interface RecState {
  recording: boolean;
  mediaRecorder: MediaRecorder | null;
  chunks: Blob[];
  startedAnimation: boolean;
  mimeType: string;   // 实际选中的容器格式, 决定下载扩展名
}

const recState: RecState = { recording: false, mediaRecorder: null, chunks: [], startedAnimation: false, mimeType: '' };

// mimeType 探测: MP4 在前(PPT/微信/iPhone 通吃), WebM 兜底(老 Chrome)
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.64003E,mp4a.40.2',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
}

function extFor(mimeType: string): string {
  return mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
}

// 当前浏览器实际会录出的格式(用于 UI 展示 "MP4 视频" / "WebM 视频")
export function recordingFormat(): 'mp4' | 'webm' | null {
  const m = pickMimeType();
  if (!m) return null;
  return m.startsWith('video/mp4') ? 'mp4' : 'webm';
}

// 开始录制: 对 GeoGebra canvas 走 captureStream + MediaRecorder, 同时启动画布动画。
// 返回是否成功开始(失败多为浏览器不支持 MediaRecorder 或取不到 canvas)。
export function startRecording(ggb: GGB | null): boolean {
  if (!ggb) return false;
  if (recState.recording) return false;

  const canvas = ggb.getCanvas();
  if (!canvas) return false;

  const mimeType = pickMimeType();
  if (!mimeType) return false;

  try {
    const stream = canvas.captureStream(30); // 30fps
    recState.chunks = [];
    recState.mimeType = mimeType;
    recState.mediaRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 });
    recState.mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recState.chunks.push(e.data); };
    recState.mediaRecorder.start();
    recState.recording = true;

    // 启动 applet 内置动画(若有滑块在做动画)
    try {
      const api = ggb.getAPI();
      api?.startAnimation?.();
      recState.startedAnimation = true;
    } catch (e) { recState.startedAnimation = false; }

    return true;
  } catch (e) {
    console.error('开始录制失败:', e);
    return false;
  }
}

// 停止录制: 停 MediaRecorder + 停动画, 合并 chunks 按实际格式下载
export function stopRecording(ggb: GGB | null, filename?: string): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      const type = recState.mimeType.split(';')[0] || 'video/webm';
      const blob = new Blob(recState.chunks, { type });
      if (blob.size > 0) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename || `ggb-fable-${Date.now()}.${extFor(recState.mimeType)}`;
        a.click();
        URL.revokeObjectURL(url);
      }
      recState.recording = false;
      recState.mediaRecorder = null;
      recState.chunks = [];
      recState.startedAnimation = false;
      recState.mimeType = '';
      resolve();
    };

    if (!recState.mediaRecorder) { finish(); return; }

    recState.mediaRecorder.onstop = finish;
    try { recState.mediaRecorder.stop(); } catch (e) { finish(); }

    if (ggb && recState.startedAnimation) {
      try { ggb.getAPI()?.stopAnimation?.(); } catch (e) {}
    }
  });
}

export function isRecording(): boolean {
  return recState.recording;
}
