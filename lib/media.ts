/*! 抖音媒体：挑播放地址、按字节上限下载、封面抓取。 */

import { UA, REFERER } from './api.ts';

export type PlaySource = { url: string; via: 'gateway' | 'cdn' };

/** 抖音 CDN 直链带 webid 校验会 403，必须走 douyin.com 的 play 网关。 */
export function pickPlayUrl(aweme: any): PlaySource | null {
  const lists: string[][] = [];
  const push = (value: any) => {
    if (value && Array.isArray(value.url_list) && value.url_list.length) lists.push(value.url_list);
  };
  push(aweme?.video?.play_addr_h264);
  push(aweme?.video?.play_addr);
  const bitRates = Array.isArray(aweme?.video?.bit_rate) ? aweme.video.bit_rate : [];
  const sorted = [...bitRates].sort((x, y) => Number(x?.bit_rate ?? 0) - Number(y?.bit_rate ?? 0));
  for (const item of sorted) push(item?.play_addr);

  for (const list of lists) {
    const gateway = list.find((u) => typeof u === 'string' && /\/aweme\/v1\/play\/?/.test(u));
    if (gateway) return { url: gateway, via: 'gateway' };
  }
  for (const list of lists) {
    const cdn = list.find((u) => typeof u === 'string' && /^https?:/.test(u));
    if (cdn) return { url: cdn, via: 'cdn' };
  }
  return null;
}

export function coverUrl(aweme: any): string | null {
  const list = aweme?.video?.cover?.url_list ?? aweme?.video?.origin_cover?.url_list ?? [];
  const first = Array.isArray(list) ? list.find((u: any) => typeof u === 'string') : '';
  return first || null;
}

export type DownloadOutcome = {
  ok: boolean;
  bytes?: Buffer;
  size?: number;
  totalSize?: number | null;
  complete?: boolean;
  mime?: string;
  code?: string;
  message?: string;
};

async function readCapped(res: Response, maxBytes: number): Promise<{ bytes: Buffer; size: number }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const all = Buffer.from(await res.arrayBuffer());
    return { bytes: all.subarray(0, maxBytes), size: Math.min(all.length, maxBytes) };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const room = maxBytes - size;
    if (room <= 0) {
      try {
        await reader.cancel();
      } catch {}
      break;
    }
    const piece = value.length <= room ? Buffer.from(value) : Buffer.from(value.subarray(0, room));
    chunks.push(piece);
    size += piece.length;
    if (size >= maxBytes) {
      try {
        await reader.cancel();
      } catch {}
      break;
    }
  }
  return { bytes: Buffer.concat(chunks), size };
}

export async function download(
  url: string,
  opts: { cookie: string; maxBytes: number; timeoutMs?: number; signal: AbortSignal; range?: boolean },
): Promise<DownloadOutcome> {
  const maxBytes = Math.max(64 * 1024, Math.floor(opts.maxBytes));
  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 60000, 10000), 180000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const signal = AbortSignal.any([opts.signal, controller.signal]);
  try {
    const headers: Record<string, string> = {
      'user-agent': UA,
      referer: REFERER,
      accept: '*/*',
      cookie: opts.cookie,
    };
    if (opts.range !== false) headers.range = `bytes=0-${maxBytes - 1}`;
    const res = await fetch(url, { headers, signal, redirect: 'follow' });
    if (res.status !== 200 && res.status !== 206) {
      return {
        ok: false,
        code: res.status === 403 ? 'media_forbidden' : 'http_error',
        message: `视频地址返回 HTTP ${res.status}`,
      };
    }
    const mime = String(res.headers.get('content-type') ?? '').split(';')[0].trim() || 'video/mp4';
    const { bytes, size } = await readCapped(res, maxBytes);
    if (!size) return { ok: false, code: 'media_empty', message: '视频没有取到任何数据。' };
    const contentRange = res.headers.get('content-range') ?? '';
    const totalMatch = contentRange.match(/\/(\d+)$/);
    const totalSize = totalMatch ? Number(totalMatch[1]) : null;
    const complete = res.status === 200 ? size >= (Number(res.headers.get('content-length') ?? 0) || size) : false;
    return { ok: true, bytes, size, totalSize, complete, mime };
  } catch (error: any) {
    if (opts.signal.aborted) return { ok: false, code: 'cancelled', message: '下载已取消。' };
    if (controller.signal.aborted) return { ok: false, code: 'timeout', message: `下载超过 ${timeoutMs} 毫秒。` };
    return { ok: false, code: 'network_error', message: `下载失败：${String(error?.message ?? error).slice(0, 160)}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadCover(
  url: string,
  opts: { cookie: string; maxBytes?: number; timeoutMs?: number; signal: AbortSignal },
): Promise<DownloadOutcome> {
  return download(url, {
    cookie: opts.cookie,
    maxBytes: Math.min(Number(opts.maxBytes) || 4 * 1024 * 1024, 8 * 1024 * 1024),
    timeoutMs: opts.timeoutMs ?? 25000,
    signal: opts.signal,
    range: false,
  });
}
