/*! 创作者中心：通过已登录的 Chrome 窗口走真实网页发布流程（图文）。 */

import { existsSync } from 'node:fs';

const UPLOAD_URL = 'https://creator.douyin.com/creator-micro/content/upload';
const POST_URL_PREFIX = 'https://creator.douyin.com/creator-micro/content/post/image';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Cdp = {
  send: (method: string, params?: Record<string, unknown>) => Promise<any>;
  evaluate: (expression: string) => Promise<any>;
  close: () => void;
};

export async function connectCdp(port: number, timeoutMs = 8000): Promise<Cdp | null> {
  let targets: any[] = [];
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch {
    return null;
  }
  const page = targets.find((t) => t?.type === 'page' && t?.webSocketDebuggerUrl);
  if (!page) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map<number, (v: any) => void>();
  const opened = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(true);
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  if (!opened) {
    try {
      ws.close();
    } catch {}
    return null;
  }
  ws.addEventListener('message', (event) => {
    let message: any;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)!(message);
      pending.delete(message.id);
    }
  });
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression: string) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return res?.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

export async function creatorPage(port: number): Promise<{ ok: boolean; href?: string; loggedIn?: boolean; message?: string }> {
  const cdp = await connectCdp(port);
  if (!cdp) return { ok: false, message: '登录窗口没开着，先点「打开登录窗口」。' };
  try {
    const info = await cdp.evaluate('JSON.stringify({href: location.href, t: (document.body.innerText||"").slice(0,80)})');
    const parsed = JSON.parse(String(info ?? '{}'));
    return { ok: true, href: parsed.href, loggedIn: String(parsed.href ?? '').includes('creator') };
  } finally {
    cdp.close();
  }
}

export type PublishInput = {
  images: string[];
  desc: string;
  /** 点击发布按钮后等待结果的上限。 */
  waitMs?: number;
};

export type PublishResult = { ok: boolean; code?: string; message: string; href?: string };

/** 走真实网页流程发图文；不会绕过平台校验，失败就如实返回。 */
export async function publishImages(port: number, input: PublishInput): Promise<PublishResult> {
  const images = (input.images ?? []).filter((p) => typeof p === 'string' && p && existsSync(p));
  if (!images.length) return { ok: false, code: 'no_image', message: '没有可用的本地图片。先给图片路径，或用 ComfyUI 生成一张。' };
  if (images.length > 9) return { ok: false, code: 'too_many', message: '一次最多 9 张图。' };
  const desc = String(input.desc ?? '').trim();
  if (!desc) return { ok: false, code: 'no_desc', message: '作品描述是空的。' };

  const cdp = await connectCdp(port);
  if (!cdp) return { ok: false, code: 'no_window', message: '登录窗口没开着，先在设置页点「打开登录窗口」。' };

  try {
    await cdp.send('Page.navigate', { url: UPLOAD_URL });
    await sleep(6500);

    const clicked = await cdp.evaluate(`(() => {
      const hit = [...document.querySelectorAll('div,span,a,button,p')].find((el) => el.textContent.trim() === '发布图文' && el.offsetParent !== null);
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
    if (!clicked) return { ok: false, code: 'no_image_tab', message: '没找到「发布图文」入口，创作者中心可能改版了。' };
    await sleep(3000);

    await cdp.send('DOM.enable', {});
    const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const rootId = doc?.result?.root?.nodeId;
    const q = await cdp.send('DOM.querySelector', { nodeId: rootId, selector: 'input[accept*="image"]' });
    const nodeId = q?.result?.nodeId;
    if (!nodeId) return { ok: false, code: 'no_input', message: '没找到图片上传框。' };
    const setResult = await cdp.send('DOM.setFileInputFiles', { nodeId, files: images });
    if (setResult?.error) return { ok: false, code: 'upload_failed', message: `注入图片失败：${setResult.error.message}` };

    // 等编辑页出现
    let ready = false;
    for (let i = 0; i < 20; i += 1) {
      await sleep(1000);
      const state = await cdp.evaluate(`JSON.stringify({href: location.href, hasEditor: !!document.querySelector('[contenteditable="true"]')})`);
      const parsed = JSON.parse(String(state ?? '{}'));
      if (parsed.hasEditor) {
        ready = true;
        break;
      }
    }
    if (!ready) return { ok: false, code: 'editor_timeout', message: '图片上传后没能进入编辑页（可能被平台拦了或图太大）。' };

    await cdp.evaluate(`(() => { const el = document.querySelector('[contenteditable="true"]'); if (!el) return false; el.focus(); return true; })()`);
    await sleep(300);
    await cdp.send('Input.insertText', { text: desc });
    await sleep(1200);

    const descNow = await cdp.evaluate(`(document.querySelector('[contenteditable="true"]')?.textContent || '').slice(0, 60)`);
    if (!String(descNow ?? '').includes(desc.slice(0, 12))) {
      return { ok: false, code: 'desc_failed', message: '描述没写进编辑框，可能需要人工确认。' };
    }

    const pressed = await cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '发布' && x.offsetParent !== null && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!pressed) return { ok: false, code: 'publish_button', message: '「发布」按钮不可点（可能还有必填项没填）。' };

    const waitMs = Math.min(Math.max(Number(input.waitMs) || 12000, 3000), 40000);
    const deadline = Date.now() + waitMs;
    let outcome: PublishResult = { ok: true, message: '已点击发布，去创作者中心「内容管理」确认一下。' };
    while (Date.now() < deadline) {
      await sleep(1500);
      const state = await cdp.evaluate(`JSON.stringify({
        href: location.href,
        text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300)
      })`);
      const parsed = JSON.parse(String(state ?? '{}'));
      const href = String(parsed.href ?? '');
      const text = String(parsed.text ?? '');
      if (href.includes('content/manage')) {
        outcome = { ok: true, message: '发布成功，已跳到内容管理。', href };
        break;
      }
      if (/发布成功|审核中|已发布/.test(text)) {
        outcome = { ok: true, message: '页面提示发布成功。', href };
        break;
      }
      if (/发布失败|违规|不能发布|请上传/.test(text)) {
        outcome = { ok: false, code: 'platform_rejected', message: text.slice(0, 120), href };
        break;
      }
    }
    return outcome;
  } catch (error: any) {
    return { ok: false, code: 'publish_error', message: String(error?.message ?? error).slice(0, 200) };
  } finally {
    cdp.close();
  }
}
