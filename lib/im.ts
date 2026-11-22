/*! 抖音私信：在登录窗口里打开私信页，读会话列表、读会话内容、发一条私信。
 *
 * 抖音网页版私信有独立页面 https://www.douyin.com/chat，从首页「消息」入口点开
 * 并不稳定（精选页那个入口只做埋点，不跳转）。这里直接导航到私信页，再用页面里
 * 的真实线索定位：
 *  - 会话条目是 [data-e2e="conversation-item"]，昵称在 [class*="conversationConversationItem"]；
 *  - 点开会话后输入框是 contenteditable，class 带 messageEditor/inputArea，data-placeholder 是「发送消息」；
 *  - 文本气泡是 [class*="MessageTextpureText"]，靠祖先 class 里的 isFromMe 区分谁发的；
 *  - 发送按钮是 svg[class*="e2e-send-msg-btn"]（红圈箭头），点它发送。
 * 任何一步定位不到都会返回具体哪一步失败，不猜着点。
 */

import { connectCdp, pageChallenge } from './creator.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const INBOX_URL = 'https://www.douyin.com/chat';
const CONV_ITEM = '[data-e2e="conversation-item"]';

// 可编辑元素判定：抖音的输入框没有 placeholder 属性，提示写在 data-placeholder 里。
const EDITABLE_MATCH = `/messageEditor|inputArea|chatEditor|editor-kit/i.test(String(el.className || '')) || /消息|发送|说点|聊天/.test(String(el.getAttribute('placeholder') || '') + String(el.getAttribute('data-placeholder') || '') + String(el.getAttribute('aria-label') || ''))`;

const STATE_JS = `(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 16 && r.bottom > 0 && r.top < window.innerHeight;
  };
  const isEditable = (el) => ${EDITABLE_MATCH};
  const input = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter(visible).find(isEditable) || null;
  const convs = [...document.querySelectorAll('${CONV_ITEM}')].filter(visible);
  const panel = input ? input.closest('[class*="imContainer"], [class*="chat"], [class*="conversation"]') : null;
  return {
    inbox: Boolean(input || convs.length),
    editor: Boolean(input),
    panel: Boolean(panel),
    convs: convs.length,
    entry: Boolean(document.querySelector('[data-e2e="im-entry"]')),
    url: location.href,
  };
})()`;

const CONV_JS = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 150 && r.height >= 36 && r.height <= 120; };
  const items = [...document.querySelectorAll('${CONV_ITEM}')].filter(visible);
  return items.map((el, i) => {
    const nameEl = el.querySelector('[class*="conversationConversationItem"]');
    const hintEl = el.querySelector('[class*="ConversationItemHint"]');
    const lines = String(el.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
    const name = String((nameEl && nameEl.innerText) || lines[0] || '').trim();
    const hint = String((hintEl && hintEl.innerText) || '');
    const rest = lines.filter((x) => x !== name && !/^\\d{1,2}\\/\\d{1,2}$/.test(x));
    const preview = (hint || rest.join(' ')).trim();
    return { i, name: name.slice(0, 40), preview: preview.slice(0, 60), raw: String(el.innerText || '').replace(/\\s+/g, ' ').slice(0, 80) };
  });
})()`;

const MSG_JS = `(() => {
  let nodes = [...document.querySelectorAll('[class*="MessageTextpureText"], [class*="TextMessageTextpureText"]')];
  if (!nodes.length) nodes = [...document.querySelectorAll('[class*="MessageItemTextbubbleTextContent"]')];
  const out = [];
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (!(r.width > 8 && r.height > 8)) continue;
    const t = String(el.innerText || '').replace(/\\n+/g, ' ').trim();
    if (!t) continue;
    const fromMe = Boolean(el.closest('[class*="isFromMe"], [class*="IsFromMe"]'));
    out.push({ from: fromMe ? 'me' : 'them', text: t.slice(0, 500) });
  }
  return out.slice(-80);
})()`;

/** 输入框坐标（用于聚焦点击）。 */
const INPUT_RECT_JS = `(() => {
  const el = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 80 && r.height > 20;
  }).find((el) => ${EDITABLE_MATCH});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

// 红圈箭头发送按钮：class 里带 e2e-send-msg-btn。
const sendBtnScript = `(() => {
  const els = [...document.querySelectorAll('svg[class*="e2e-send-msg-btn"], [class*="publishBtn"], [data-e2e*="send"]')];
  const el = els.find((x) => {
    const r = x.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0;
  });
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

async function realClick(cdp: any, point: { x: number; y: number }) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 0 });
}

/** 点开会话列表里的某一条（React 监听的是 mousedown，用坐标点会受布局/遮挡影响）。 */
async function openConversation(cdp: any, index: number): Promise<boolean> {
  return Boolean(await cdp.evaluate(`(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 150 && r.height >= 36 && r.height <= 120; };
    const items = [...document.querySelectorAll('${CONV_ITEM}')].filter(visible);
    const el = items[${Number(index)}];
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    return true;
  })()`).catch(() => false));
}

/** 等私信页/聊天框出现。 */
async function waitForState(cdp: any, ms: number, need: 'inbox' | 'editor'): Promise<any> {
  const end = Date.now() + ms;
  let state: any = null;
  while (Date.now() < end) {
    state = await cdp.evaluate(STATE_JS).catch(() => null);
    if (need === 'editor' ? state?.editor : state?.inbox) return state;
    await sleep(1200);
  }
  return state;
}

async function hasSessionCookie(cdp: any): Promise<boolean> {
  const res: any = await cdp.send('Storage.getCookies', {}).catch(() => null);
  const cookies: any[] = Array.isArray(res?.cookies) ? res.cookies : [];
  return cookies.some((c) => /(^|\.)douyin\.com$/.test(String(c?.domain || '')) && /^(sessionid|sessionid_ss|sid_tt)$/.test(String(c?.name || '')) && String(c?.value || ''));
}

/** 打开私信页：已在聊天框直接过；否则导航到 /chat，没有选中会话就点开第一条。 */
async function openInbox(cdp: any): Promise<{ ok: boolean; message?: string }> {
  let state: any = await cdp.evaluate(STATE_JS).catch(() => null);
  if (state?.editor) return { ok: true };

  if (!state?.convs) {
    await cdp.send('Page.navigate', { url: INBOX_URL });
    state = await waitForState(cdp, 15000, 'inbox');
  }
  if (state?.editor) return { ok: true };

  if (state?.convs) {
    if (await openConversation(cdp, 0)) {
      state = await waitForState(cdp, 8000, 'editor');
    }
  }
  if (state?.editor) return { ok: true };

  // 1) 没登录：httpOnly 的 sessionid 只在 cookie 里，document.cookie 看不到。
  if (!(await hasSessionCookie(cdp))) {
    return { ok: false, message: '这个浏览器还没登录抖音：在登录窗口里扫码登录一次，再试私信。' };
  }
  // 2) 登录了但页面挂着登录框/扫码：多见于刚打开、身份还没填进页面。
  const loginBox: any = await cdp.evaluate(`(() => {
    const ph = [...document.querySelectorAll('input, textarea')].map((x) => String(x.getAttribute('placeholder') || ''));
    return /扫码登录/.test(String(document.body ? document.body.innerText : '').slice(0, 2000)) || ph.some((p) => /手机号|验证码|扫码/.test(p));
  })()`).catch(() => null);
  if (loginBox) {
    return { ok: false, message: '这个浏览器还没登录抖音：在登录窗口里扫码登录一次，再试私信。' };
  }
  return { ok: false, message: `没打开私信页：可能页面结构变了，或页面还在加载（当前 ${String(state?.url || '').slice(0, 80)}）。` };
}

export type Conversation = { index: number; name: string; preview: string };

export async function listConversations(port: number): Promise<{ ok: boolean; items?: Conversation[]; message?: string }> {
  const cdp = await connectCdp(port);
  if (!cdp) return { ok: false, message: '登录窗口没开着，先在设置页点「打开登录窗口」。' };
  try {
    const challenge = await pageChallenge(port);
    if (challenge) return { ok: false, message: challenge === 'sms' ? '页面要短信验证，先去窗口里手动过一次。' : '页面挂着滑块/安全验证，先去窗口里手动过一次。' };
    const opened = await openInbox(cdp);
    if (!opened.ok) return { ok: false, message: opened.message ?? '没打开私信页。' };
    const raw: any = await cdp.evaluate(CONV_JS).catch(() => null);
    const list: any[] = Array.isArray(raw) ? raw : [];
    if (!list.length) return { ok: false, message: '私信页开了，但没读到会话（可能一条私信都还没有，或列表结构变了）。' };
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

  if (!(await openConversation(cdp, Number(hit.i)))) return { ok: false, message: '会话条目定位不到。' };
  const state = await waitForState(cdp, 8000, 'editor');
  if (!state?.editor) return { ok: false, message: '点了会话，但聊天框没打开（可能列表还在加载）。' };
  return { ok: true, name: String(hit.name ?? '') };
}

export type ChatMessage = { from: 'me' | 'them'; text: string };

export async function readConversation(port: number, target: { index?: number; name?: string }): Promise<{ ok: boolean; with?: string; items?: ChatMessage[]; message?: string }> {
  const cdp = await connectCdp(port);
  if (!cdp) return { ok: false, message: '登录窗口没开着，先在设置页点「打开登录窗口」。' };
  try {
    const opened = await openInbox(cdp);
    if (!opened.ok) return { ok: false, message: opened.message ?? '没打开私信页。' };
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

/** 发一条私信：选中会话 → 点输入框 → 写内容 → 点发送 → 回读最后一条是不是自己发的这句。 */
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
    if (!opened.ok) return { ok: false, code: 'no_inbox', message: opened.message ?? '没打开私信页。' };
    const picked = await selectConversation(cdp, target);
    if (!picked.ok) return { ok: false, code: 'no_conversation', message: picked.message ?? '选不中会话。' };

    const inputRect: any = await cdp.evaluate(INPUT_RECT_JS).catch(() => null);
    if (!inputRect) return { ok: false, code: 'no_input', message: '找不到私信输入框。' };
    await realClick(cdp, inputRect);
    await sleep(400);
    let focused = await cdp.evaluate('(() => { const el = document.activeElement; if (!el) return false; return el.tagName === "TEXTAREA" || el.isContentEditable; })()').catch(() => false);
    if (!focused) {
      focused = await cdp.evaluate(`(() => {
        const el = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 80 && r.height > 20;
        }).find((el) => ${EDITABLE_MATCH.replace(/\n/g, ' ')});
        if (!el) return false;
        el.focus();
        return document.activeElement === el;
      })()`).catch(() => false);
    }
    if (!focused) return { ok: false, code: 'not_focused', message: '点了输入框但没聚焦，没发送。' };

    await cdp.send('Input.insertText', { text: body });
    await sleep(600);
    const typed: any = await cdp.evaluate('(() => { const el = document.activeElement; if (!el) return ""; return String(el.value || el.textContent || "").slice(0, 80); })()').catch(() => '');
    if (!String(typed ?? '').includes(body.slice(0, 8))) return { ok: false, code: 'insert_failed', message: '文字没写进输入框，没发送。' };

    const sendPoint: any = await cdp.evaluate(sendBtnScript).catch(() => null);
    if (!sendPoint) return { ok: false, code: 'no_send_btn', message: '没找到发送按钮，没发送。' };
    await realClick(cdp, sendPoint);
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

/** 诊断：私信页能不能打开、读到几个会话、输入框在不在。给「检测私信页」按钮用。 */
export async function probeInbox(port: number): Promise<{ ok: boolean; message: string; detail?: Record<string, unknown> }> {
  const cdp = await connectCdp(port);
  if (!cdp) return { ok: false, message: '登录窗口没开着。' };
  try {
    const opened = await openInbox(cdp);
    const state: any = await cdp.evaluate(STATE_JS).catch(() => null);
    const convs: any = await cdp.evaluate(CONV_JS).catch(() => null);
    const convCount = Array.isArray(convs) ? convs.length : 0;
    return {
      ok: Boolean(opened.ok && state?.editor),
      message: opened.ok
        ? `私信页已打开：输入框在，读到 ${convCount} 个会话。`
        : opened.message ?? '没打开私信页。',
      detail: { url: state?.url, entry: state?.entry, input: state?.editor, panel: state?.panel, conversations: convCount },
    };
  } finally {
    cdp.close();
  }
}
