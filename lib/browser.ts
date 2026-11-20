/*! 登录窗口：用独立 Chrome 配置打开抖音，登录后经 CDP 读回 Cookie。 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
  join(process.env.ProgramFiles ?? '', 'Microsoft\\Edge\\Application\\msedge.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

export function findBrowser(): string | null {
  for (const path of CANDIDATES) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type LoginState = {
  open: boolean;
  pid: number | null;
  port: number | null;
  profile: string | null;
  browser: string | null;
  mode?: string | null;
};

type Spawned = { pid?: number; port: number; profile: string };

let current: Spawned | null = null;

function stateFile(dir: string) {
  return join(dir, 'login.json');
}

// 会话归属标记：open 时生成并写进专用 profile 的 localStorage，读 Cookie 前必须对上。
export function loginToken(dir: string): string | null {
  try {
    const stored = JSON.parse(readFileSync(stateFile(dir), 'utf8'));
    return typeof stored?.token === 'string' && stored.token ? stored.token : null;
  } catch {
    return null;
  }
}

function ensureToken(dir: string): string {
  const existing = loginToken(dir);
  if (existing) return existing;
  const token = randomBytes(16).toString('hex');
  let stored: any = {};
  try {
    stored = JSON.parse(readFileSync(stateFile(dir), 'utf8'));
  } catch {
    stored = {};
  }
  writeFileSync(stateFile(dir), JSON.stringify({ ...stored, token }, null, 2), 'utf8');
  return token;
}

export function loginState(dir: string): LoginState {
  let stored: any = null;
  try {
    stored = JSON.parse(readFileSync(stateFile(dir), 'utf8'));
  } catch {
    stored = null;
  }
  const pid = Number(stored?.pid) || null;
  const port = Number(stored?.port) || null;
  let open = Boolean(current?.pid);
  if (!open && pid) {
    try {
      process.kill(pid, 0);
      open = true;
    } catch {
      open = false;
    }
  }
  return { open, pid: open ? pid : null, port: open ? port : null, profile: stored?.profile ?? null, browser: findBrowser(), mode: stored?.mode ?? null };
}

export async function storageReady(port: number): Promise<boolean> {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

/** TCP 探测本地端口，不依赖 HTTP 栈，受代理设置影响小。 */
export function portOpen(port: number, timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

/** 单次探测调试端口，用于状态判断，不等待。 */
export async function cdpAlive(port: number): Promise<boolean> {
  if (!(await portOpen(port))) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok;
  } catch {
    // TCP 通但 HTTP 读不到，仍然算窗口在。
    return true;
  }
}

export type WindowMode = 'visible' | 'offscreen' | 'headless';

export async function openLoginWindow(
  dir: string,
  port: number,
  url: string,
  mode: WindowMode = 'visible',
): Promise<{ ok: boolean; message?: string; state?: LoginState }> {
  // 只认一件事：调试端口能不能握手。PID 探活会被系统复用骗到，端口在听也可能是僵尸实例。
  if (await cdpAlive(port)) {
    // 端口已被某个实例占着时，也补一个归属标记，避免把别人的浏览器当成自己的。
    ensureToken(dir);
    return { ok: true, message: '登录窗口已经开着，不用重复打开。', state: loginState(dir) };
  }
  const browser = findBrowser();
  if (!browser) return { ok: false, message: '没找到 Chrome 或 Edge，无法自动打开登录窗口。' };
  const profile = join(dir, 'browser-profile');
  mkdirSync(profile, { recursive: true });
  const sessionToken = ensureToken(dir);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
  ];
  if (mode === 'headless') {
    args.push('--headless=new', '--window-size=1280,900', '--mute-audio');
  } else if (mode === 'offscreen') {
    // 放在屏幕外：进程和页面都活着，但用户看不到，也不抢工作区。
    args.push('--window-size=1280,900', '--window-position=-2400,-2400', '--mute-audio');
  } else {
    args.push('--window-size=1280,900', '--window-position=80,60');
  }
  args.push(url);
  try {
    const child = spawn(browser, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    current = { pid: child.pid, port, profile };
    writeFileSync(stateFile(dir), JSON.stringify({ pid: child.pid, port, profile, mode, token: sessionToken, at: Date.now() }, null, 2), 'utf8');
    const ready = await Promise.race([storageReady(port), sleep(3000).then(() => false)]);
    const label = mode === 'headless' ? '无界面' : mode === 'offscreen' ? '隐藏' : '可见';
    if (!ready) return { ok: true, message: `登录窗口已打开（${label}模式）；调试端口还在启动，等你登录完再点读取。`, state: loginState(dir) };
    return { ok: true, message: `登录窗口已打开（${label}模式），在里面登录抖音即可。`, state: loginState(dir) };
  } catch (error: any) {
    return { ok: false, message: `打开浏览器失败：${String(error?.message ?? error).slice(0, 160)}` };
  }
}

export function closeLoginWindow(dir: string): { ok: boolean; message: string } {
  const stored = loginState(dir);
  let killed = false;
  if (stored.pid) {
    try {
      process.kill(stored.pid, 'SIGTERM');
      killed = true;
    } catch {}
  }
  current = null;
  try {
    rmSync(stateFile(dir), { force: true });
  } catch {}
  return { ok: true, message: killed ? '登录窗口已关闭。' : '没有正在运行的登录窗口。' };
}

type CookieRow = { name: string; value: string; domain: string; path: string; expires: number; secure?: boolean; httpOnly?: boolean };

export async function readCookies(
  port: number,
  expectedToken?: string,
): Promise<{ ok: boolean; cookie?: string; count?: number; hasSession?: boolean; message?: string }> {
  if (!expectedToken) {
    return {
      ok: false,
      message: '无法确认这个调试端口属于插件自己启动的专用会话，读 Cookie 已拒绝。请点「打开登录窗口」重新打开专用窗口。',
    };
  }
  if (!(await storageReady(port))) return { ok: false, message: '调试端口没响应，先打开登录窗口。' };
  let targets: any[] = [];
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch (error: any) {
    return { ok: false, message: `读取浏览器页面失败：${String(error?.message ?? error).slice(0, 120)}` };
  }
  const page = targets.find((t) => t?.type === 'page' && t?.webSocketDebuggerUrl) ?? targets.find((t) => t?.webSocketDebuggerUrl);
  if (!page) return { ok: false, message: '浏览器里没有可读取的页面。' };

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const result = await new Promise<any>((resolve) => {
    let settled = false;
    const finish = (value: any) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish({ __error: '调试连接超时。' }), 8000);
    timer.unref?.();
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression: 'localStorage.getItem("__dl_session")||""', returnByValue: true },
        }),
      );
    });
    ws.addEventListener('message', (event) => {
      let message: any;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id === 1) {
        // 先核对会话归属，对上了才去取 Cookie。
        const got = String(message?.result?.result?.value ?? '');
        if (got !== expectedToken) {
          clearTimeout(timer);
          finish({
            __error: '这个调试端口上的浏览器不是插件自己启动的专用会话，读 Cookie 已拒绝。请点「打开登录窗口」重新打开专用窗口。',
          });
          return;
        }
        ws.send(JSON.stringify({ id: 2, method: 'Storage.getCookies', params: {} }));
        return;
      }
      if (message.id === 2) {
        clearTimeout(timer);
        finish(message);
      }
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      finish({ __error: '调试连接失败。' });
    });
  });
  try {
    ws.close();
  } catch {}

  if (result?.__error) return { ok: false, message: result.__error };
  const rows: CookieRow[] = Array.isArray(result?.result?.cookies) ? result.result.cookies : [];
  const now = Date.now() / 1000;
  const useful = rows.filter((c) => {
    const domain = String(c?.domain ?? '');
    if (!domain.includes('douyin')) return false;
    if (!c?.name) return false;
    if (Number(c.expires) > 0 && Number(c.expires) < now) return false;
    return true;
  });
  if (!useful.length) return { ok: false, message: '浏览器里还没有抖音 Cookie，先在窗口里打开 douyin.com 并登录。' };

  // 同名 Cookie 只保留一个：优先 .douyin.com 这种更通用的域。
  const picked = new Map<string, CookieRow>();
  const sorted = [...useful].sort((a, b) => String(a.domain).length - String(b.domain).length);
  for (const row of sorted) {
    if (picked.has(row.name)) continue;
    picked.set(row.name, row);
  }
  const cookie = [...picked.values()].map((c) => `${c.name}=${c.value}`).join('; ');
  const hasSession = picked.has('sessionid');
  return { ok: true, cookie, count: picked.size, hasSession };
}
