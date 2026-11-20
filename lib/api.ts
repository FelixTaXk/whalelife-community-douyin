/*! 抖音网页接口客户端：本地 a_bogus 签名 + 设备指纹 + 用户 Cookie。 */

import { signParams, getMsToken, getTtwid, getWebId, getVerifyFp } from 'abogus';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
export const REFERER = 'https://www.douyin.com/';
const API_ROOT = 'https://www.douyin.com';

/** 浏览器固定公共参数（抓自真实网页，保持稳定，避免指纹漂移）。 */
const TEMPLATE: Record<string, string> = {
  device_platform: 'webapp',
  aid: '6383',
  channel: 'channel_pc_web',
  pc_client_type: '1',
  pc_libra_divert: 'Windows',
  update_version_code: '170400',
  support_h265: '1',
  support_dash: '0',
  version_code: '170400',
  version_name: '17.4.0',
  cookie_enabled: 'true',
  screen_width: '1920',
  screen_height: '1080',
  browser_language: 'zh-CN',
  browser_platform: 'Win32',
  browser_name: 'Chrome',
  browser_version: '157.0.0.0',
  browser_online: 'true',
  engine_name: 'Blink',
  engine_version: '157.0.0.0',
  os_name: 'Windows',
  os_version: '10',
  cpu_core_num: '24',
  device_memory: '32',
  platform: 'PC',
  downlink: '10',
  effective_type: '4g',
  round_trip_time: '0',
};

export type Device = {
  ttwid?: string;
  msToken?: string;
  msTokenAt?: number;
  webid?: string;
  verifyFp?: string;
};

export type Account = { cookie?: string; savedAt?: string };

export type ApiFailure = {
  ok: false;
  code: string;
  message: string;
  http?: number;
  apiCode?: number;
};
export type ApiSuccess<T> = { ok: true; data: T };
export type ApiResult<T = any> = ApiSuccess<T> | ApiFailure;

export type CallOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 失败时是否允许刷新设备后重试一次（只用于只读请求）。 */
  retry?: boolean;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function parseCookie(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of String(raw ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key) map.set(key, value);
  }
  return map;
}

export function isLoggedIn(account: Account): boolean {
  const map = parseCookie(String(account?.cookie ?? ''));
  for (const key of ['sessionid', 'sessionid_ss', 'sid_guard']) {
    if (map.get(key)) return true;
  }
  return false;
}

export function cookieHeader(account: Account, device: Device): string {
  const map = parseCookie(String(account?.cookie ?? ''));
  if (!map.has('ttwid') && device.ttwid) map.set('ttwid', device.ttwid);
  if (!map.has('s_v_web_id') && device.verifyFp) map.set('s_v_web_id', device.verifyFp);
  if (!map.has('webid') && device.webid) map.set('webid', device.webid);
  // msToken 必须与本次查询串里的值一致，所以以设备值为准。
  if (device.msToken) map.set('msToken', device.msToken);
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** 平台返回码到固定错误码的映射。 */
function classify(json: any, http: number): ApiFailure | null {
  if (http === 403) return { ok: false, code: 'access_blocked', message: '平台拒绝了这次请求（403），通常是未登录或触发了风控。', http };
  if (http === 429) return { ok: false, code: 'rate_limited', message: '请求太频繁，平台限流了，过一会儿再刷。', http };
  if (http >= 500) return { ok: false, code: 'platform_error', message: `平台服务出错（HTTP ${http}）。`, http };
  const code = json?.status_code;
  if (typeof code === 'number' && code !== 0) {
    const detail = String(json?.status_msg ?? json?.message ?? '').slice(0, 160);
    if (code === 2483) {
      return { ok: false, code: 'login_required', message: '抖音要求先登录才能继续（搜索、评论、详情等需要登录态）。', http, apiCode: code };
    }
    if ([8, 2053, 2071, 2154, 2153].includes(code)) {
      return { ok: false, code: 'risk_control', message: `平台风控拦截（${code}）${detail ? '：' + detail : ''}。停一停，别连续请求。`, http, apiCode: code };
    }
    return { ok: false, code: 'api_error', message: `抖音接口返回 ${code}${detail ? '：' + detail : ''}`, http, apiCode: code };
  }
  return null;
}

export type ApiClient = ReturnType<typeof createApi>;

export function createApi(opts: {
  read: (file?: string) => Promise<any>;
  save: (file: string, value: any) => Promise<void>;
  signal: AbortSignal;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}) {
  let deviceCache: Device | null = null;
  let deviceTask: Promise<Device> | null = null;
  let refreshing = false;

  async function readDevice(): Promise<Device> {
    if (deviceCache) return deviceCache;
    if (deviceTask) return deviceTask;
    deviceTask = (async () => {
      const stored = ((await opts.read('device.json').catch(() => null)) ?? {}) as Device;
      const base: Device = { ...stored };
      const msTokenStale = !base.msToken || Date.now() - Number(base.msTokenAt ?? 0) > 6 * 3600_000;
      try {
        if (!base.verifyFp) base.verifyFp = getVerifyFp();
        if (!base.webid) base.webid = await getWebId();
        if (!base.ttwid) base.ttwid = await getTtwid();
        if (msTokenStale) {
          base.msToken = await getMsToken();
          base.msTokenAt = Date.now();
        }
      } catch (error) {
        opts.log?.('抖音设备指纹获取失败', { error: String((error as any)?.message ?? error).slice(0, 200) });
      }
      await opts.save('device.json', base).catch(() => {});
      deviceCache = base;
      return base;
    })().finally(() => {
      deviceTask = null;
    });
    return deviceTask;
  }

  async function refreshDevice(): Promise<Device> {
    if (refreshing) return readDevice();
    refreshing = true;
    try {
      deviceCache = null;
      const stored = ((await opts.read('device.json').catch(() => null)) ?? {}) as Device;
      const keep: Device = { webid: stored.webid, verifyFp: stored.verifyFp };
      await opts.save('device.json', keep).catch(() => {});
      return await readDevice();
    } finally {
      refreshing = false;
    }
  }

  async function readAccount(): Promise<Account> {
    return (((await opts.read('account.json').catch(() => null)) ?? {}) as Account) ?? {};
  }

  function query(device: Device, params: Record<string, unknown>): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...TEMPLATE };
    if (device.webid) merged.webid = device.webid;
    if (device.verifyFp) {
      merged.verifyFp = device.verifyFp;
      merged.fp = device.verifyFp;
    }
    if (device.msToken) merged.msToken = device.msToken;
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      merged[k] = v;
    }
    return merged;
  }

  async function once(path: string, params: Record<string, unknown>, o: CallOptions, device: Device): Promise<ApiResult> {
    const account = await readAccount();
    const method = o.method ?? 'GET';
    const bodyText = o.body === undefined ? '' : typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
    const url = API_ROOT + path;
    const { searchParams, aBogus } = signParams(query(device, params), {
      url,
      body: bodyText,
      userAgent: UA,
    });
    searchParams.set('a_bogus', aBogus);
    const headers: Record<string, string> = {
      'user-agent': UA,
      referer: REFERER,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      cookie: cookieHeader(account, device),
    };
    if (method === 'POST') headers['content-type'] = 'application/json';

    const timeoutMs = Math.min(Math.max(Number(o.timeoutMs) || 25000, 5000), 120000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const signal = AbortSignal.any([opts.signal, controller.signal, ...(o.signal ? [o.signal] : [])]);

    let res: Response;
    try {
      res = await fetch(`${url}?${searchParams.toString()}`, {
        method,
        headers,
        ...(method === 'POST' ? { body: bodyText } : {}),
        signal,
        redirect: 'follow',
      });
    } catch (error: any) {
      clearTimeout(timer);
      const aborted = controller.signal.aborted;
      const cancelled = opts.signal.aborted || o.signal?.aborted;
      if (cancelled) return { ok: false, code: 'cancelled', message: '请求已取消。' };
      if (aborted) return { ok: false, code: 'timeout', message: `请求超过 ${timeoutMs} 毫秒没有返回。` };
      return { ok: false, code: 'network_error', message: `连不上抖音：${String(error?.message ?? error).slice(0, 160)}` };
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => '');
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!json) {
      if (res.status === 403) return { ok: false, code: 'access_blocked', message: '平台返回了拦截页（403），可能需要重新登录或稍后再试。', http: 403 };
      if (res.status === 429) return { ok: false, code: 'rate_limited', message: '请求太频繁，平台限流了。', http: 429 };
      return {
        ok: false,
        code: 'access_blocked',
        message: `平台返回了非 JSON 响应（HTTP ${res.status}），可能触发了验证页。`,
        http: res.status,
      };
    }
    const failure = classify(json, res.status);
    if (failure) return failure;
    return { ok: true, data: json };
  }

  async function call(path: string, params: Record<string, unknown> = {}, o: CallOptions = {}): Promise<ApiResult> {
    const retryable = o.retry !== false && (o.method ?? 'GET') === 'GET';
    const device = await readDevice();
    const first = await once(path, params, o, device);
    if (first.ok || !retryable) return first;
    if (!['access_blocked', 'risk_control', 'api_error'].includes(first.code)) return first;
    opts.log?.('抖音请求失败，刷新设备指纹后重试一次', { path, code: first.code, apiCode: first.apiCode });
    await sleep(400);
    const fresh = await refreshDevice();
    return once(path, params, o, fresh);
  }

  return { readDevice, refreshDevice, readAccount, call, isLoggedIn: () => readAccount().then(isLoggedIn) };
}
