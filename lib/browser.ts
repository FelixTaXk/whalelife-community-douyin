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

type Spawned = { pid?: number; port: number; profile: string; child?: ReturnType<typeof spawn> };

let current: Spawned | null = null;

function stateFile(dir: string) {
  return join(dir, 'login.json');
}

// 只清理与指定 PID 对应的记录；PID 对不上时保留，避免把新窗口的记录误删。
function clearSpawnedState(dir: string, pid?: number | null): void {
  try {
    if (pid) {
      const stored = JSON.parse(readFileSync(stateFile(dir), 'utf8'));
      if (Number(stored?.pid) !== pid) return;
    }
    rmSync(stateFile(dir), { force: true });
  } catch {}
}

function forgetSpawned(dir: string, pid?: number | null): void {
  if (current && (!pid || current.pid === pid)) current = null;
  clearSpawnedState(dir, pid);
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
  // 只认仍然存活的 ChildProcess；浏览器自己退出后即使 PID 被系统复用，也不再把记录当成窗口还开着。
  let open = Boolean(current?.pid) &&
    (!current?.child || (current.child.exitCode === null && current.child.signalCode === null));
  if (!open && !current?.pid && pid) {
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

// 轮询确认浏览器已退出：调试端口握手失败，且（本次持有 ChildProcess 时）进程确已退出。
// 不看状态文件里的旧 PID，避免系统复用 PID 后把别的进程当成自家浏览器。
async function waitForExit(port: number, child: ReturnType<typeof spawn> | null, timeoutMs: number): Promise<boolean> {
  const childExited = (): boolean => !child || child.exitCode !== null || child.signalCode !== null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await cdpAlive(port)) && childExited()) return true;
    await sleep(300);
  }
  return !(await cdpAlive(port)) && childExited();
}

export type WindowMode = 'visible' | 'offscreen' | 'headless';

/** 把 login.json 里的 mode 改成指定值，状态行和按钮文案才能跟着变。 */
function markMode(dir: string, mode: WindowMode): void {
  try {
    const stored = JSON.parse(readFileSync(stateFile(dir), 'utf8'));
    if (!stored || typeof stored !== 'object') return;
    writeFileSync(stateFile(dir), JSON.stringify({ ...stored, mode }, null, 2), 'utf8');
  } catch {}
}

// 通过已核实的 CDP 连接改窗口位置：显示=挪回屏幕，隐藏=挪出屏幕。
async function moveLoginWindow(
  dir: string,
  port: number,
  bounds: { left: number; top: number; width: number; height: number },
  nextMode: WindowMode,
  successMessage: string,
): Promise<{ ok: boolean; message: string }> {
  let targets: any[] = [];
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch {}
  const page = targets.find((x: any) => x.type === 'page' && String(x.url).includes('douyin.com')) ?? targets.find((x: any) => x.type === 'page');
  if (!page?.webSocketDebuggerUrl) return { ok: false, message: '连不上登录窗口里的页面，先点「关闭登录窗口」再重新打开。' };

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  return await new Promise<{ ok: boolean; message: string }>((resolve) => {
    let settled = false;
    const timers: any[] = [];
    const done = (value: { ok: boolean; message: string }) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      try {
        ws.close();
      } catch {}
      resolve(value);
    };
    timers.push(setTimeout(() => done({ ok: false, message: '改窗口位置超时，没等到浏览器回应。' }), 8000));

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Browser.getWindowForTarget', params: { targetId: page.id } }));
    });
    ws.addEventListener('message', (event) => {
      let message: any;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.error) {
        done({ ok: false, message: `浏览器不让改窗口位置：${message.error.message ?? '未知原因'}` });
        return;
      }
      if (message.id === 1) {
        const windowId = message?.result?.windowId;
        if (!windowId) {
          done({ ok: false, message: '拿不到窗口句柄，改不了窗口位置。' });
          return;
        }
        ws.send(JSON.stringify({
          id: 2,
          method: 'Browser.setWindowBounds',
          params: { windowId, bounds: { ...bounds, windowState: 'normal' } },
        }));
      } else if (message.id === 2) {
        if (nextMode === 'visible') ws.send(JSON.stringify({ id: 3, method: 'Page.bringToFront', params: {} }));
        else {
          markMode(dir, nextMode);
          done({ ok: true, message: successMessage });
        }
      } else if (message.id === 3) {
        markMode(dir, nextMode);
        done({ ok: true, message: successMessage });
      }
    });
    ws.addEventListener('error', () => done({ ok: false, message: '连窗口时出错，先关掉窗口再重新打开。' }));
  });
}

/** 把挪到屏幕外的窗口拽回屏幕中间：窗口开着、但模式是 offscreen 时用。 */
export async function showLoginWindow(dir: string, port: number): Promise<{ ok: boolean; message: string }> {
  const state = loginState(dir);
  if (!state.open) return { ok: false, message: '登录窗口没开着，点「打开登录窗口」就行。' };
  if (state.mode === 'headless') {
    return { ok: false, message: '当前是无界面模式，本来就没有窗口可显示：要看得见，请把设置页的窗口模式改成「可见」，关掉窗口再重开一次。' };
  }
  return moveLoginWindow(dir, port, { left: 80, top: 60, width: 1280, height: 900 }, 'visible', '已把登录窗口从屏幕外拉回来。');
}

/** 把窗口挪出屏幕（隐藏模式），省得挡视线；聊天记录和登录态都不受影响。 */
export async function hideLoginWindow(dir: string, port: number): Promise<{ ok: boolean; message: string }> {
  const state = loginState(dir);
  if (!state.open) return { ok: false, message: '登录窗口没开着。' };
  if (state.mode === 'headless') return { ok: false, message: '当前是无界面模式，本来就没有窗口，不用隐藏。' };
  return moveLoginWindow(dir, port, { left: -2400, top: -2400, width: 1280, height: 900 }, 'offscreen', '已把登录窗口移出屏幕外。');
}

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
    if (check.owned) {
      const st = loginState(dir, browserPath);
      // 已经开着但窗口在屏幕外（隐藏模式）：直接把窗口拽回来，不让用户自己去猜。
      if (st.mode === 'offscreen') {
        const shown = await showLoginWindow(dir, port);
        return { ok: shown.ok, fresh: false, message: shown.ok ? `${shown.message}窗口会回到屏幕上的常规大小。` : shown.message, state: loginState(dir, browserPath) };
      }
      return { ok: true, fresh: false, message: '登录窗口已经开着，不用重复打开。', state: st };
    }
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
    // 浏览器自行退出时清掉本次的记录；只清 PID 对得上的那条，避免覆盖后来新开的窗口。
    child.once('exit', () => {
      if (current?.pid === child.pid) current = null;
      clearSpawnedState(dir, child.pid);
    });
    current = { pid: child.pid, port, profile, child };
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

/**
 * 停用/卸载时的同步收尾：只处理本进程仍持有的 ChildProcess，不按 login.json 里的旧 PID 强杀。
 * 浏览器自行退出后 ChildProcess 的 exitCode 已经落定，这里只会清记录，不会再碰可能被复用的 PID。
 */
export function closeSpawnedLoginWindow(dir: string): boolean {
  const entry = current;
  if (!entry?.pid) {
    clearSpawnedState(dir);
    return false;
  }
  const child = entry.child;
  // 没有 ChildProcess 引用就不具备确认归属的条件，只清记录，绝不按裸 PID 下手。
  const alive = Boolean(child) && child!.exitCode === null && child!.signalCode === null;
  if (alive) {
    try {
      child!.kill();
    } catch {}
  }
  current = null;
  clearSpawnedState(dir, entry.pid);
  return alive;
}

export async function closeLoginWindow(dir: string, port: number): Promise<{ ok: boolean; message: string; open: boolean }> {
  // 端口已经不在了：本次启动的 ChildProcess 若还活着，按确认归属结束它；
  // 若它已经退出（或本次进程没有记录），说明窗口早就关了，直接回「已经关闭」，绝不按旧 PID 去杀别的进程。
  if (!(await cdpAlive(port))) {
    const child = current?.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {}
      const exited = await waitForExit(port, child, 4000);
      if (exited) {
        forgetSpawned(dir, child.pid);
        return { ok: true, open: false, message: '登录窗口已经关闭。' };
      }
      return {
        ok: false,
        open: true,
        message: '已发出关闭，但暂时无法确认浏览器是否退出；进程与会话记录均已保留。请手动确认窗口状态，或重新打开专用窗口后再关闭。',
      };
    }
    // 没有仍在运行的、可确认归属的浏览器：清理过期记录，不碰任何 PID。
    forgetSpawned(dir, current?.pid);
    return { ok: true, open: false, message: '登录窗口已经关闭，不用再关。' };
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
  // 插件重启后没有 ChildProcess 时只核对端口，避免被复用的旧 PID 拖成假失败。
  const trackedChild = current?.child ?? null;
  const exited = await waitForExit(port, trackedChild, 5000);
  if (!exited) {
    return {
      ok: false,
      open: true,
      message: '已尝试关闭，但暂时无法确认浏览器是否退出；进程与会话记录均已保留。请手动确认窗口状态，或重新打开专用窗口后再关闭。',
    };
  }

  forgetSpawned(dir, trackedChild?.pid ?? null);
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
