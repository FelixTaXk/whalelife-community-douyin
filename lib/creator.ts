/*! 创作者中心：通过已登录的 Chrome 窗口走真实网页发布流程（图文）。 */

import { existsSync } from 'node:fs';

const UPLOAD_URL = 'https://creator.douyin.com/creator-micro/content/upload';
const POST_URL_PREFIX = 'https://creator.douyin.com/creator-micro/content/post/image';
// 视频走「发布视频」页签（default-tab=1）；图文是 default-tab=3。页签不对就传不了文件。
const VIDEO_UPLOAD_URL = 'https://creator.douyin.com/creator-micro/content/upload?default-tab=1';
const MY_WORKS_URL = 'https://www.douyin.com/user/self?showTab=post';

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

// ── 页面风控/验证码探测 ───────────────────────────────────
// 抖音常在发布或回复前弹短信验证或滑块；滑块常挂在独立 iframe 里，body 文本一个字都不露。
const CHALLENGE_JS = String.raw`(() => {
  const t = document.body ? document.body.innerText : '';
  const sms = /接收短信验证码|获取验证码|请输入验证码/.test(t);
  const captcha = /滑块验证|安全验证|请完成验证|拖动滑块/.test(t);
  const frame = [...document.querySelectorAll('iframe')].some((f) => {
    const r = f.getBoundingClientRect();
    // 抖音页面上常驻一个 0×0 的 rc-verifycenter 空壳 iframe，只看 src 会天天误报「挂着滑块」。
    return r.width > 120 && r.height > 60 && /rc-verifycenter|verifycenter|captcha/i.test(String(f.src || ''));
  });
  return sms || captcha || frame ? (sms ? 'sms' : 'captcha') : '';
})()`;

export type Challenge = '' | 'sms' | 'captcha';

/** 当前页面上挂着验证码没有。只读判断，不点任何东西。 */
export async function pageChallenge(port: number): Promise<Challenge> {
  const cdp = await connectCdp(port, 4000);
  if (!cdp) return '';
  try {
    const value = await cdp.evaluate(CHALLENGE_JS);
    return value === 'sms' || value === 'captcha' ? value : '';
  } catch {
    return '';
  } finally {
    cdp.close();
  }
}

// 视频转好没：判据是 video 元素能播（有时长）且源在抖音自己的 CDN 上。
// 不能拿「上传中」文字消失当判据——实测那行字几分钟都不消，可视频早转好了。
const VIDEO_READY_JS = String.raw`(() => {
  const videos = [...document.querySelectorAll('video')];
  if (!videos.length) return { ok: false, duration: 0, src: '' };
  const cdnRe = /(?:video-cn\.douyin\.com|douyinvod\.com|douyinpic\.com|bytevcloudcdn\.com|ixigua\.com)/i;
  for (const v of videos) {
    const duration = Number(v.duration);
    const src = String(v.currentSrc || v.src || '');
    if (Number.isFinite(duration) && duration > 0 && cdnRe.test(src)) return { ok: true, duration, src };
  }
  const v0 = videos[0];
  return { ok: false, duration: Number(v0?.duration) || 0, src: String(v0?.currentSrc || v0?.src || '') };
})()`;

async function fileInputNode(cdp: Cdp, selector: string): Promise<number | null> {
  await cdp.send('DOM.enable', {});
  const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const rootId = doc?.result?.root?.nodeId;
  if (!rootId) return null;
  const q = await cdp.send('DOM.querySelector', { nodeId: rootId, selector });
  return Number(q?.result?.nodeId) || null;
}

export type VideoPublishInput = {
  video: string;
  desc: string;
  /** 点发布后等结果的上限。 */
  waitMs?: number;
  /** 等转码的上限，默认 300 秒。 */
  transcodeMs?: number;
};

/** 发短视频：走创作者中心「发布视频」页签，等转码出可播放预览后才点发布。 */
export async function publishVideo(port: number, input: VideoPublishInput): Promise<PublishResult> {
  const video = String(input.video ?? '').trim();
  if (!video) return { ok: false, code: 'no_video', message: '没有给视频文件路径。' };
  if (!existsSync(video)) return { ok: false, code: 'video_missing', message: `视频文件不存在：${video}` };
  const desc = String(input.desc ?? '').trim();
  if (!desc) return { ok: false, code: 'no_desc', message: '作品描述是空的。' };

  const cdp = await connectCdp(port);
  if (!cdp) return { ok: false, code: 'no_window', message: '登录窗口没开着，先在设置页点「打开登录窗口」。' };

  try {
    await cdp.send('Page.navigate', { url: VIDEO_UPLOAD_URL });
    await sleep(6500);

    const challenge = await cdp.evaluate(CHALLENGE_JS).catch(() => '');
    if (challenge === 'sms' || challenge === 'captcha') {
      return {
        ok: false,
        code: 'verify_required',
        message: challenge === 'sms'
          ? '创作者中心要求短信验证：在登录窗口里手动验证一次，再重新发布。'
          : '创作者中心弹了滑块/安全验证：在登录窗口里手动过一下，再重新发布。',
      };
    }

    const nodeId = await fileInputNode(cdp, 'input[accept*="video"]');
    if (!nodeId) {
      return { ok: false, code: 'no_video_input', message: '上传页没找到视频文件输入框（可能不在「发布视频」页签，或创作者中心改版了）。' };
    }
    const setResult = await cdp.send('DOM.setFileInputFiles', { nodeId, files: [video] });
    if (setResult?.error) {
      return { ok: false, code: 'upload_failed', message: `注入视频失败：${setResult.error.message}` };
    }

    // 等编辑页出现
    let ready = false;
    for (let i = 0; i < 30; i += 1) {
      await sleep(1000);
      const state = await cdp.evaluate(`JSON.stringify({ href: location.href, hasEditor: !!document.querySelector('[contenteditable="true"]') })`);
      let parsed: any = {};
      try {
        parsed = JSON.parse(String(state ?? '{}'));
      } catch {}
      if (parsed.hasEditor) {
        ready = true;
        break;
      }
    }
    if (!ready) return { ok: false, code: 'editor_timeout', message: '视频传上去后没能进入编辑页（可能被平台拦了或文件太大）。' };

    await cdp.evaluate(`(() => { const el = document.querySelector('[contenteditable="true"]'); if (!el) return false; el.focus(); return true; })()`);
    await sleep(300);
    await cdp.send('Input.insertText', { text: desc });
    await sleep(1200);

    const descNow = await cdp.evaluate(`(document.querySelector('[contenteditable="true"]')?.textContent || '').slice(0, 60)`);
    if (!String(descNow ?? '').includes(desc.slice(0, 12))) {
      return { ok: false, code: 'desc_failed', message: '描述没写进编辑框，可能需要人工确认。' };
    }

    // 等转码：没出可播放预览就点发布，平台会把它当成没配好，白花一次上传。
    const transcodeMs = Math.min(Math.max(Number(input.transcodeMs) || 300000, 30000), 420000);
    const deadlineAt = Date.now() + transcodeMs;
    let videoReady = false;
    while (Date.now() < deadlineAt) {
      const state: any = await cdp.evaluate(VIDEO_READY_JS).catch(() => null);
      if (state && state.ok) {
        videoReady = true;
        break;
      }
      await sleep(3000);
    }
    if (!videoReady) {
      return { ok: false, code: 'transcode_timeout', message: `等了 ${Math.round(transcodeMs / 1000)} 秒还没等到视频转码完成，没有点发布。` };
    }

    const pressed = await cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '发布' && x.offsetParent !== null && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!pressed) return { ok: false, code: 'publish_button', message: '「发布」按钮不可点（可能还有必填项没填）。' };

    const waitMs = Math.min(Math.max(Number(input.waitMs) || 15000, 3000), 60000);
    const deadline = Date.now() + waitMs;
    let outcome: PublishResult = { ok: true, message: '已点击发布，去创作者中心「内容管理」确认一下。' };
    while (Date.now() < deadline) {
      await sleep(1500);
      const state = await cdp.evaluate(`JSON.stringify({
        href: location.href,
        text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300)
      })`);
      let parsed: any = {};
      try {
        parsed = JSON.parse(String(state ?? '{}'));
      } catch {}
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

// ── 我的作品列表（只读） ───────────────────────────────────
// 「我的」页作品网格：每条是 a[href*="/video/"] 或 a[href*="/note/"]，作品 ID 直接从 href 取。
const WORKS_JS = String.raw`(() => {
  const out = [];
  const scope = document.querySelector('[data-e2e="user-post-list"]') || document;
  for (const a of scope.querySelectorAll('a[href*="/video/"], a[href*="/note/"]')) {
    const m = String(a.getAttribute('href') || '').match(/\/(video|note)\/(\d{8,})/);
    if (!m || out.some((x) => x.id === m[2])) continue;
    const cell = a.closest('li') || a;
    out.push({
      id: m[2],
      kind: m[1],
      title: (a.innerText || cell.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      text: (cell.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    });
  }
  return out;
})()`;

export type MyWork = { id: string; kind: string; title: string; text: string };

/** 读「我的」页作品列表。只读，不改页面状态。 */
export async function listMyWorks(port: number, limit = 20): Promise<{ ok: boolean; items?: MyWork[]; message?: string }> {
  const cdp = await connectCdp(port);
  if (!cdp) return { ok: false, message: '登录窗口没开着，先在设置页点「打开登录窗口」。' };
  try {
    await cdp.send('Page.navigate', { url: MY_WORKS_URL });
    await sleep(6500);
    const challenge = await cdp.evaluate(CHALLENGE_JS).catch(() => '');
    if (challenge === 'sms' || challenge === 'captcha') {
      return { ok: false, message: '页面上挂着验证码，先在登录窗口里手动过一下再读作品。' };
    }
    const raw = await cdp.evaluate(WORKS_JS).catch(() => null);
    const list = Array.isArray(raw) ? raw : [];
    if (!list.length) {
      return { ok: false, message: '没读到作品。可能没登录、作品页还没加载完，或账号里还没有作品。' };
    }
    const cap = Math.max(1, Math.min(50, Number(limit) || 20));
    return {
      ok: true,
      items: list.slice(0, cap).map((x: any) => ({
        id: String(x?.id ?? ''),
        kind: String(x?.kind ?? 'video'),
        title: String(x?.title ?? '').slice(0, 60),
        text: String(x?.text ?? '').slice(0, 120),
      })),
    };
  } catch (error: any) {
    return { ok: false, message: String(error?.message ?? error).slice(0, 160) };
  } finally {
    cdp.close();
  }
}
