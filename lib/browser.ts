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
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

/** 找浏览器：优先用设置页里填的路径，填了但不存在就如实报错，不再偷偷换成别的浏览器。 */
export function findBrowser(preferred?: string): string | null {
  const custom = String(preferred ?? '').trim();
  if (custom) return existsSync(custom) ? custom : null;
  for (const path of CANDIDATES) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

/** 设置页填了路径却找不到文件时的提示语，没有填就返回空。 */
export function browserPathError(preferred?: string): string {
  const custom = String(preferred ?? '').trim();
  if (!custom || existsSync(custom)) return '';
  return `设置页填的浏览器路径不存在：${custom}`;
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

export function loginState(dir: string, preferredBrowser?: string): LoginState {
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
  return { open, pid: open ? pid : null, port: open ? port : null, profile: stored?.profile ?? null, browser: findBrowser(preferredBrowser), mode: stored?.mode ?? null };
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

// 通过已核实归属的浏览器级 CDP 连接发送 Browser.close；不依赖本地旧记录的 PID。
async function closeBrowserViaCdp(port: number): Promise<boolean> {
  let version: any = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (res.ok) version = await res.json();
  } catch {
    return false;
  }
  const wsUrl = version?.webSocketDebuggerUrl;
  if (!wsUrl) return false;
  const ws = new WebSocket(wsUrl);
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let replied = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => done(replied), 4000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      // Browser.close 后浏览器会主动断开，不一定回包；指令送达即视为已发起关闭，退出结果由 waitForExit 核对。
      setTimeout(() => done(true), 600);
    });
    ws.addEventListener('message', (event) => {
      let message: any;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id === 1) {
        replied = true;
        done(true);
      }
    });
    ws.addEventListener('error', () => done(false));
  });
}

// 轮询确认浏览器已退出：调试端口握手失败，且（有记录 PID 时）进程也已不在。
async function waitForExit(port: number, pid: number | null, timeoutMs: number): Promise<boolean> {
  const pidAlive = (p: number | null): boolean => {
    if (!p) return false;
    try {
      process.kill(p, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await cdpAlive(port)) && !pidAlive(pid)) return true;
    await sleep(300);
  }
  return !(await cdpAlive(port)) && !pidAlive(pid);
}

export type WindowMode = 'visible' | 'offscreen' | 'headless';

// 把归属标记写入某个页面的 localStorage，写完读回校验，一致才算成功。
async function writeMarkToPage(page: any, token: string): Promise<boolean> {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => done(false), 4000);
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression: `localStorage.setItem("__dl_session",${JSON.stringify(token)})`, returnByValue: true },
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
        ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: 'localStorage.getItem("__dl_session")||""', returnByValue: true } }));
      } else if (message.id === 2) {
        done(String(message?.result?.result?.value ?? '') === token);
      }
    });
    ws.addEventListener('error', () => done(false));
  });
}

// 把归属标记写进指定窗口的 localStorage；仅对本插件刚启动的新窗口调用。
// 新窗口启动时页面可能还在 about:blank 或跳转中，需等到进入抖音域名再写，避免落到错误 origin；写入后读回校验，失败重试。
async function writeSessionMark(port: number, token: string): Promise<void> {
  const deadline = Date.now() + 8000;
  let fallbackPage: any = null;
  while (Date.now() < deadline) {
    let targets: any[] = [];
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    } catch {
      await sleep(300);
      continue;
    }
    const page = targets.find((t) => t?.type === 'page' && t?.webSocketDebuggerUrl) ?? targets.find((t) => t?.webSocketDebuggerUrl);
    if (!page) {
      await sleep(300);
      continue;
    }
    fallbackPage = page;
    if (!/douyin\.com/.test(String(page.url ?? ''))) {
      await sleep(300);
      continue;
    }
    if (await writeMarkToPage(page, token)) return;
    await sleep(300);
  }
  if (fallbackPage) await writeMarkToPage(fallbackPage, token);
}

// 核实一个已在监听的窗口是否属于本插件：login.json 里的标记必须能在该窗口的 localStorage 对上。
// 对不上、没有标记或读不到页面，一律视为归属未确认，不写标记、不读登录信息。
export async function verifySession(dir: string, port: number): Promise<{ owned: boolean; reason?: string }> {
  if (!(await cdpAlive(port))) return { owned: false, reason: '调试端口没响应。' };
  const token = loginToken(dir);
  if (!token) return { owned: false, reason: '没有会话标记，无法确认归属。' };
  let targets: any[] = [];
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch {
    return { owned: false, reason: '读不到浏览器页面。' };
  }
  const pages = targets.filter((t) => t?.webSocketDebuggerUrl);
  const page =
    pages.find((t) => t?.type === 'page' && /douyin\.com/.test(String(t.url ?? ''))) ??
    pages.find((t) => t?.type === 'page') ??
    pages[0];
  if (!page) return { owned: false, reason: '浏览器里没有可核实的页面。' };
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const got = await new Promise<string>((resolve) => {
    let settled = false;
    const done = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => done(''), 6000);
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
      if (message.id === 1) done(String(message?.result?.result?.value ?? ''));
    });
    ws.addEventListener('error', () => done(''));
  });
  return got === token ? { owned: true } : { owned: false, reason: '窗口里的会话标记对不上，无法确认是插件启动的专用窗口。' };
}

export async function openLoginWindow(
  dir: string,
  port: number,
  url: string,
  mode: WindowMode = 'visible',
  browserPath = '',
): Promise<{ ok: boolean; fresh: boolean; message?: string; state?: LoginState }> {
  // 端口被占用时，先核实归属；核实不过就拒绝，不补标记、不读取登录信息。
  if (await cdpAlive(port)) {
    const check = await verifySession(dir, port);
    if (check.owned) return { ok: true, fresh: false, message: '登录窗口已经开着，不用重复打开。', state: loginState(dir, browserPath) };
    return {
      ok: false,
      fresh: false,
      message: `检测到调试端口上有一个无法核实归属的浏览器实例（${check.reason ?? '标记对不上'}）。请先点「关闭登录窗口」，再重新打开专用窗口。`,
      state: loginState(dir, browserPath),
    };
  }
  const browser = findBrowser(browserPath);
  if (!browser) {
    const custom = String(browserPath ?? '').trim();
    return {
      ok: false,
      fresh: false,
      message: custom
        ? `${browserPathError(custom)}；改成正确的浏览器路径，或留空自动探测。`
        : '没找到 Chrome 或 Edge：在设置页「本机连接」里填一下浏览器路径，或留空让它自动探测。',
    };
  }
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
    // 新窗口由本插件启动，归属天然成立；就绪后把标记写进它的 localStorage，供后续归属核对。
    await writeSessionMark(port, sessionToken);
    const label = mode === 'headless' ? '无界面' : mode === 'offscreen' ? '隐藏' : '可见';
    if (!ready) return { ok: true, fresh: true, message: `登录窗口已打开（${label}模式）；调试端口还在启动，等你登录完再点读取。`, state: loginState(dir, browserPath) };
    return { ok: true, fresh: true, message: `登录窗口已打开（${label}模式），在里面登录抖音即可。`, state: loginState(dir, browserPath) };
  } catch (error: any) {
    return { ok: false, fresh: false, message: `打开浏览器失败：${String(error?.message ?? error).slice(0, 160)}` };
  }
}

export async function closeLoginWindow(dir: string, port: number): Promise<{ ok: boolean; message: string; open: boolean }> {
  const stored = loginState(dir);

  // 端口失联：无法确认归属，保留进程与会话记录，不报成功、不清记录。
  if (!(await cdpAlive(port))) {
    return {
      ok: false,
      open: true,
      message: '调试端口无响应，无法确认这个进程仍属于当前实例，未关闭。请在任务管理器手动确认后关闭，或重新打开专用窗口。',
    };
  }

  // 会话标记对不上：归属未确认，保留进程与记录。
  const check = await verifySession(dir, port);
  if (!check.owned) {
    return {
      ok: false,
      open: true,
      message: `调试端口上的窗口无法确认属于当前实例（${check.reason ?? '标记对不上'}），未关闭。请手动关闭该窗口，或重新打开专用窗口后再关闭。`,
    };
  }

  // 归属已确认：通过这条已核实的 CDP 连接关闭浏览器，不按本地旧记录的 PID 强杀。
  let closedViaCdp = false;
  try {
    closedViaCdp = await closeBrowserViaCdp(port);
  } catch {
    closedViaCdp = false;
  }

  // 必须等到退出得到确认（端口握手失败、进程不在）才报成功并清记录；退出失败或结果未知则保留记录。
  const exited = await waitForExit(port, stored.pid, 5000);
  if (!exited) {
    return {
      ok: false,
      open: true,
      message: '已尝试关闭，但暂时无法确认浏览器是否退出；进程与会话记录均已保留。请手动确认窗口状态，或重新打开专用窗口后再关闭。',
    };
  }

  current = null;
  try {
    rmSync(stateFile(dir), { force: true });
  } catch {}
  return {
    ok: true,
    open: false,
    message: closedViaCdp ? '登录窗口已关闭。' : '登录窗口已关闭（调试端口已断开）。',
  };
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
