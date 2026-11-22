/*! 抖音私信：在登录窗口里点开「私信」面板，读会话列表、读会话内容、发一条私信。
 *
 * 抖音网页版的私信没有可直调的外露接口（和评论一样挂在页面里），所以走页面操作。
 * 页面结构会变，这里不写死 class 名，改用几条稳定线索定位：
 *  - 导航上的私信入口是 data-e2e="im-entry"（未登录时会拉起登录框，不会开面板）；
 *  - 输入框是可见的 textarea / contenteditable，带「消息」类提示文本；
 *  - 会话条目是面板里带头像、宽 > 150、高 36–120 的列表项；
 *  - 气泡是面板里带 message 语义、可见且有文本的节点，靠左=对方、靠右=自己。
 * 任何一步定位不到都会返回具体哪一步失败，不猜着点。
 */

import { connectCdp, pageChallenge } from './creator.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const IM_ENTRY = '[data-e2e="im-entry"]';
const HOME_URL = 'https://www.douyin.com/jingxuan';

const STATE_JS = `(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 16 && r.bottom > 0 && r.top < window.innerHeight;
  };
  const inputs = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter(visible);
  const input = inputs.find((el) => /消息|发送|说点|聊天/.test(
    String(el.getAttribute('placeholder') || '') + String(el.getAttribute('aria-label') || '') + String(el.className || '')
  )) || null;
  let panel = null;
  if (input) {
    panel = input.closest('[class*="conversation"], [class*="chat"], [class*="session"], [class*="im-"]');
    let top = input.parentElement;
    for (let i = 0; i < 8 && !panel && top; i += 1) {
      if (top.querySelectorAll('img').length >= 3) panel = top;
      top = top.parentElement;
    }
  }
  const convs = panel ? [...panel.querySelectorAll('li, [role="listitem"]')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 150 && r.height >= 36 && r.height <= 120 && el.querySelector('img, [class*="avatar"]');
  }) : [];
  return {
    entry: Boolean(document.querySelector('${IM_ENTRY}')),
    input: Boolean(input),
    panel: Boolean(panel),
    convs: convs.length,
    url: location.href,
  };
})()`;

const CONV_JS = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 150 && r.height >= 36 && r.height <= 120; };
  const inputs = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 16; });
  const input = inputs.find((el) => /消息|发送|说点|聊天/.test(String(el.getAttribute('placeholder') || '') + String(el.getAttribute('aria-label') || '') + String(el.className || '')));
  let panel = input ? input.closest('[class*="conversation"], [class*="chat"], [class*="session"], [class*="im-"]') : null;
  if (!panel && input) {
    let top = input.parentElement;
    for (let i = 0; i < 8 && !panel && top; i += 1) { if (top.querySelectorAll('img').length >= 3) panel = top; top = top.parentElement; }
  }
  const scope = panel || document;
  const items = [...scope.querySelectorAll('li, [role="listitem"]')].filter((el) => visible(el) && el.querySelector('img, [class*="avatar"]'));
  return items.map((el, i) => {
    const lines = String(el.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
    return {
      i,
      name: (lines[0] || '').slice(0, 40),
      preview: (lines.slice(1).join(' ') || '').slice(0, 60),
      raw: String(el.innerText || '').replace(/\\s+/g, ' ').slice(0, 80),
    };
  });
})()`;

const MSG_JS = `(() => {
  const inputs = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 16; });
  const input = inputs.find((el) => /消息|发送|说点|聊天/.test(String(el.getAttribute('placeholder') || '') + String(el.getAttribute('aria-label') || '') + String(el.className || '')));
  let panel = input ? input.closest('[class*="conversation"], [class*="chat"], [class*="session"], [class*="im-"]') : null;
  if (!panel && input) {
    let top = input.parentElement;
    for (let i = 0; i < 8 && !panel && top; i += 1) { if (top.querySelectorAll('img').length >= 3) panel = top; top = top.parentElement; }
  }
  const scope = panel || document;
  const pr = scope.getBoundingClientRect();
  const mid = pr.left + pr.width / 2;
  const nodes = [...scope.querySelectorAll('[class*="message"], [class*="Message"], [data-e2e*="message"]')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      if (!(r.width > 20 && r.height > 16)) return false;
      const t = String(el.innerText || '').trim();
      if (!t || t.length > 2000) return false;
      // 只取最内层带文本的节点，避免一条消息被父容器重复计多次
      return ![...el.querySelectorAll('[class*="message"], [class*="Message"]')].some((c) => String(c.innerText || '').trim() === t);
    });
  const seen = new Set();
  const out = [];
  for (const el of nodes) {
    const t = String(el.innerText || '').replace(/\\n+/g, ' ').trim().slice(0, 500);
    if (seen.has(t)) continue;
    const r = el.getBoundingClientRect();
    seen.add(t);
    out.push({ from: r.left + r.width / 2 > mid ? 'me' : 'them', text: t });
  }
  return out.slice(-60);
})()`;

/** 输入框坐标（用于聚焦点击）。 */
const INPUT_RECT_JS = `(() => {
  const inputs = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 80 && r.height > 20; });
  const el = inputs.find((x) => /消息|发送|说点|聊天/.test(String(x.getAttribute('placeholder') || '') + String(x.getAttribute('aria-label') || '') + String(x.className || '')))
    || inputs[inputs.length - 1];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

const sendBtnScript = `(() => {
  const hits = [...document.querySelectorAll('button, div, span')].filter((x) => (x.innerText || '').trim() === '发送');
  const el = hits.find((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

async function realClick(cdp: any, point: { x: number; y: number }) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 0 });
}

/** 打开私信面板：已开就直接过，没开就点导航上的私信入口。 */
async function openInbox(cdp: any): Promise<{ ok: boolean; message?: string }> {
  let state: any = await cdp.evaluate(STATE_JS).catch(() => null);
  if (state?.input) return { ok: true };

  if (!state?.entry) {
    await cdp.send('Page.navigate', { url: HOME_URL });
    await sleep(6000);
    state = await cdp.evaluate(STATE_JS).catch(() => null);
    if (state?.input) return { ok: true };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rect: any = await cdp.evaluate(`(() => {
      const el = document.querySelector('${IM_ENTRY}');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`).catch(() => null);
    if (!rect) break;
    await realClick(cdp, rect);
    await sleep(2500);
    state = await cdp.evaluate(STATE_JS).catch(() => null);
    if (state?.input) return { ok: true };
  }

  // 到这一步最常见的原因就是没登录（点私信入口会拉起登录框，而不是面板）。
  // 注意登录框的提示写在 input 的 placeholder 里，不在 body 文本里，只看文本会漏。
  const loggedOut: any = await cdp.evaluate(`(() => {
    const ph = [...document.querySelectorAll('input, textarea')].map((x) => String(x.getAttribute('placeholder') || ''));
    return { loginBox: ph.some((p) => /手机号|验证码|扫码/.test(p)) || /扫码登录/.test(String(document.body ? document.body.innerText : '').slice(0, 2000)) };
  })()`).catch(() => null);
  if (loggedOut?.loginBox) {
    return { ok: false, message: '这个浏览器还没登录抖音：在登录窗口里扫码登录一次，再试私信。' };
  }
  return { ok: false, message: '没打开私信面板：可能导航入口变了，或页面还在加载。' };
}

export type Conversation = { index: number; name: string; preview: string };

export async function listConversations(port: number): Promise<{ ok: boolean; items?: Conversation[]; message?: string }> {
  const cdp = await connectCdp(port);
  if (!cdp) return { ok: false, message: '登录窗口没开着，先在设置页点「打开登录窗口」。' };
  try {
    const challenge = await pageChallenge(port);
    if (challenge) return { ok: false, message: challenge === 'sms' ? '页面要短信验证，先去窗口里手动过一次。' : '页面挂着滑块/安全验证，先去窗口里手动过一次。' };
    const opened = await openInbox(cdp);
    if (!opened.ok) return { ok: false, message: opened.message ?? '没打开私信面板。' };
    const raw: any = await cdp.evaluate(CONV_JS).catch(() => null);
    const list: any[] = Array.isArray(raw) ? raw : [];
    if (!list.length) return { ok: false, message: '私信面板开了，但没读到会话（可能一条私信都还没有，或列表结构变了）。' };
    return {
      ok: true,
      items: list.map((x) => ({ index: Number(x?.i) || 0, name: String(x?.name ?? '').slice(0, 40), preview: String(x?.preview ?? '').slice(0, 60) })),
    };
  } catch (error: any) {
    return { ok: false, message: String(error?.message ?? error).slice(0, 160) };
  } finally {
    cdp.close();
  }
}

async function selectConversation(cdp: any, target: { index?: number; name?: string }): Promise<{ ok: boolean; name?: string; message?: string }> {
  const raw: any = await cdp.evaluate(CONV_JS).catch(() => null);
  const list: any[] = Array.isArray(raw) ? raw : [];
  if (!list.length) return { ok: false, message: '没有读到会话列表。' };

  let hit: any = null;
  if (typeof target.index === 'number' && Number.isFinite(target.index)) {
    hit = list.find((x) => Number(x.i) === Number(target.index)) ?? null;
    if (!hit) return { ok: false, message: `没有第 ${target.index} 个会话（共 ${list.length} 个）。` };
  } else {
    const needle = String(target.name ?? '').trim().toLowerCase();
    if (!needle) return { ok: false, message: '要给对方昵称（name）或会话下标（index）。' };
    const hits = list.filter((x) => String(x.name ?? '').toLowerCase().includes(needle) || String(x.preview ?? '').toLowerCase().includes(needle));
    if (hits.length > 1) {
      return { ok: false, message: `有 ${hits.length} 个会话都匹配「${needle}」，用 index 指定：` + hits.slice(0, 5).map((x) => `#${x.i} ${x.name}`).join(' / ') };
    }
    hit = hits[0] ?? null;
    if (!hit) return { ok: false, message: `没找到昵称包含「${needle}」的会话。` };
  }

  const point: any = await cdp.evaluate(`(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 150 && r.height >= 36 && r.height <= 120; };
    const inputs = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 16; });
    const input = inputs.find((el) => /消息|发送|说点|聊天/.test(String(el.getAttribute('placeholder') || '') + String(el.getAttribute('aria-label') || '') + String(el.className || '')));
    let panel = input ? input.closest('[class*="conversation"], [class*="chat"], [class*="session"], [class*="im-"]') : null;
    if (!panel && input) { let top = input.parentElement; for (let i = 0; i < 8 && !panel && top; i += 1) { if (top.querySelectorAll('img').length >= 3) panel = top; top = top.parentElement; } }
    const scope = panel || document;
    const items = [...scope.querySelectorAll('li, [role="listitem"]')].filter((el) => visible(el) && el.querySelector('img, [class*="avatar"]'));
    const el = items[${Number(hit.i)}];
    if (!el) return null;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 24)) };
  })()`).catch(() => null);
  if (!point) return { ok: false, message: '会话条目定位不到坐标。' };
  await realClick(cdp, point);
  await sleep(2200);
  return { ok: true, name: String(hit.name ?? '') };
}

export type ChatMessage = { from: 'me' | 'them'; text: string };

export async function readConversation(port: number, target: { index?: number; name?: string }): Promise<{ ok: boolean; with?: string; items?: ChatMessage[]; message?: string }> {
  const cdp = await connectCdp(port);
  if (!cdp) return { ok: false, message: '登录窗口没开着，先在设置页点「打开登录窗口」。' };
  try {
    const opened = await openInbox(cdp);
    if (!opened.ok) return { ok: false, message: opened.message ?? '没打开私信面板。' };
    const picked = await selectConversation(cdp, target);
    if (!picked.ok) return { ok: false, message: picked.message ?? '选不中会话。' };
    const raw: any = await cdp.evaluate(MSG_JS).catch(() => null);
    const items: ChatMessage[] = Array.isArray(raw) ? raw.map((x: any) => ({ from: x?.from === 'me' ? 'me' : 'them', text: String(x?.text ?? '').slice(0, 500) })) : [];
    return { ok: true, with: picked.name, items };
  } catch (error: any) {
    return { ok: false, message: String(error?.message ?? error).slice(0, 160) };
  } finally {
    cdp.close();
  }
}

export type SendDmResult = { ok: boolean; code?: string; message: string; with?: string; verified?: boolean };

/** 发一条私信：选中会话 → 点输入框 → 写内容 → 发送 → 回读最后一条是不是自己发的这句。 */
export async function sendDirectMessage(port: number, target: { index?: number; name?: string }, text: string): Promise<SendDmResult> {
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, code: 'no_text', message: '私信内容是空的。' };
  if (body.length > 500) return { ok: false, code: 'too_long', message: '私信太长了（上限 500 字）。' };

  const cdp = await connectCdp(port);
  if (!cdp) return { ok: false, code: 'no_window', message: '登录窗口没开着，先在设置页点「打开登录窗口」。' };
  try {
    const challenge = await pageChallenge(port);
    if (challenge) {
      return {
        ok: false,
        code: 'verify_required',
        message: challenge === 'sms' ? '页面要求短信验证，先去窗口里手动过一次。' : '页面挂着滑块/安全验证，先去窗口里手动过一次。',
      };
    }
    const opened = await openInbox(cdp);
    if (!opened.ok) return { ok: false, code: 'no_inbox', message: opened.message ?? '没打开私信面板。' };
    const picked = await selectConversation(cdp, target);
    if (!picked.ok) return { ok: false, code: 'no_conversation', message: picked.message ?? '选不中会话。' };

    const inputRect: any = await cdp.evaluate(INPUT_RECT_JS).catch(() => null);
    if (!inputRect) return { ok: false, code: 'no_input', message: '找不到私信输入框。' };
    await realClick(cdp, inputRect);
    await sleep(400);
    const focused = await cdp.evaluate(`(() => { const el = document.activeElement; if (!el) return false; return el.tagName === 'TEXTAREA' || el.isContentEditable; })()`).catch(() => false);
    if (!focused) return { ok: false, code: 'not_focused', message: '点了输入框但没聚焦，没发送。' };

    await cdp.send('Input.insertText', { text: body });
    await sleep(600);
    const typed: any = await cdp.evaluate(`(() => { const el = document.activeElement; if (!el) return ''; return String(el.value || el.textContent || '').slice(0, 80); })()`).catch(() => '');
    if (!String(typed ?? '').includes(body.slice(0, 8))) return { ok: false, code: 'insert_failed', message: '文字没写进输入框，没发送。' };

    const sendPoint: any = await cdp.evaluate(sendBtnScript).catch(() => null);
    if (sendPoint) await realClick(cdp, sendPoint);
    else {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    }
    await sleep(2000);

    const raw: any = await cdp.evaluate(MSG_JS).catch(() => null);
    const msgs: ChatMessage[] = Array.isArray(raw) ? raw.map((x: any) => ({ from: x?.from === 'me' ? 'me' : 'them', text: String(x?.text ?? '') })) : [];
    const last = msgs[msgs.length - 1];
    const verified = Boolean(last && last.from === 'me' && last.text.includes(body.slice(0, Math.min(12, body.length))));
    return {
      ok: true,
      message: verified ? '私信已发出（最后一条能看到是自己发的）。' : '已点发送，但没回读到这条，去 App 里确认一下。',
      with: picked.name,
      verified,
    };
  } catch (error: any) {
    return { ok: false, code: 'dm_error', message: String(error?.message ?? error).slice(0, 180) };
  } finally {
    cdp.close();
  }
}

/** 诊断：私信面板能不能打开、读到几个会话、输入框在不在。给「检测私信页」按钮用。 */
export async function probeInbox(port: number): Promise<{ ok: boolean; message: string; detail?: Record<string, unknown> }> {
  const cdp = await connectCdp(port);
  if (!cdp) return { ok: false, message: '登录窗口没开着。' };
  try {
    const opened = await openInbox(cdp);
    const state: any = await cdp.evaluate(STATE_JS).catch(() => null);
    const convs: any = await cdp.evaluate(CONV_JS).catch(() => null);
    const convCount = Array.isArray(convs) ? convs.length : 0;
    return {
      ok: Boolean(state?.input),
      message: opened.ok
        ? `私信面板已打开：输入框 ${state?.input ? '在' : '不在'}，读到 ${convCount} 个会话。`
        : opened.message ?? '没打开私信面板。',
      detail: { url: state?.url, entry: state?.entry, input: state?.input, panel: state?.panel, conversations: convCount },
    };
  } finally {
    cdp.close();
  }
}
