/**
 * ASR —— 语音转文字。
 *
 * 走 OpenAI 兼容的 `POST {baseUrl}/audio/transcriptions`（multipart/form-data）。
 * 硅基流动的 SenseVoiceSmall / Qwen3-ASR / XingChenASR 都是这个形状，
 * 所以**模型名走配置、换模型不用改代码**。
 *
 * 用法：拿到音频字节 → transcribe() → 得到文字 → 当成普通文本走后面的对话链路。
 */

export interface AsrOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  audio: Uint8Array;
  /** 给服务端看的文件名，带扩展名它才好判断容器格式 */
  filename?: string;
  mime?: string;
  /** 可选：'zh' 之类，部分模型支持 */
  language?: string;
  timeoutMs?: number;
}

/** 把 baseUrl 补成 transcriptions 端点（兼容带/不带 /v1 的写法） */
function endpointOf(baseUrl: string): string {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  if (/\/audio\/transcriptions$/.test(b)) return b;
  return b + '/audio/transcriptions';
}

export async function transcribe(opts: AsrOptions): Promise<string> {
  if (!opts.model) throw new Error('没有配置 ASR 模型');
  if (!opts.audio?.length) throw new Error('音频是空的');

  const form = new FormData();
  const mime = opts.mime || 'audio/ogg';
  const blob = new Blob([opts.audio as unknown as BlobPart], { type: mime });
  form.append('file', blob, opts.filename || ('audio.' + (mime.split('/')[1] || 'ogg')));
  form.append('model', opts.model);
  if (opts.language) form.append('language', opts.language);

  const r = await fetch(endpointOf(opts.baseUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });

  const raw = await r.text();
  if (!r.ok) throw new Error(`ASR 失败(${r.status})：${raw.slice(0, 200)}`);

  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const t = j.text ?? j.result ?? j.transcription;
    return String(t ?? '').trim();
  } catch {
    return raw.trim(); // 有的服务直接回纯文本
  }
}

/** 从 data URL 还原出字节（通道把音频以 data URL 塞进 MediaRef.url 时用） */
export function bytesFromDataUrl(url: string): { bytes: Uint8Array; mime: string } | undefined {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(url || ''));
  if (!m) return undefined;
  const mime = m[1] || 'application/octet-stream';
  const body = m[3] || '';
  if (m[2]) return { bytes: new Uint8Array(Buffer.from(body, 'base64')), mime };
  return { bytes: new Uint8Array(Buffer.from(decodeURIComponent(body), 'utf8')), mime };
}
