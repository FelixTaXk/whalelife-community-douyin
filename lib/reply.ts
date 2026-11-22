/*! 作品评论回复：在登录窗口里打开作品页、找评论、点「回复」、打字、发送。
 *
 * 抖音网页版没有可直调的评论回复接口，只能在页面里操作；这里的元素结构参考
 * Britneycode/dsh-fish-soul（MIT）在真实账号上踩出来的结论：
 *  - 评论区默认折叠，容器在 DOM 里但 display:none，只判存在会把折叠态误判成已打开；
 *  - 整条评论的 innerText 常常是单行，正文要取「作者信息块的下一个兄弟节点」；
 *  - 「作者」标记是文本恰为「作者」的叶子节点，不靠行号。
 */

import { createHash } from 'node:crypto';
import { connectCdp, pageChallenge } from './creator.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SEL = {
  input: '.comment-input-inner-container',
  item: '[data-e2e="comment-item"]',
  stats: '.comment-item-stats-container',
  commentBtn: '[data-e2e="feed-comment-icon"]',
  editor: '.public-DraftEditor-content[contenteditable="true"]',
};

export type PageComment = {
  index: number;
  cid: string;
  author: string;
  content: string;
  isAuthor: boolean;
  canReply: boolean;
};

/** 评论去重键：优先平台自己的评论 id，没有就落回「作者 + 正文」哈希。 */
export function replyKey(awemeId: string, cid: string, author: string, content: string): string {
  const c = String(cid ?? '').trim();
  if (c) return `${awemeId}:cid:${c}`;
  return `${awemeId}:text:${createHash('sha1').update(`${author}\n${content}`).digest('hex').slice(0, 16)}`;
}

// 评论区状态：容器必须可见（有布局尺寸），否则折叠态会被误判成已打开。
const STATE_JS = `(() => {
  const box = document.querySelector('${SEL.input}');
  const r = box ? box.getBoundingClientRect() : null;
  return {
    box: Boolean(r && r.width > 0 && r.height > 0),
    inDom: Boolean(box),
    items: document.querySelectorAll('${SEL.item}').length,
    btn: Boolean(document.querySelector('${SEL.commentBtn}')),
    url: location.href
  };
})()`;

const LIST_JS = `(() => [...document.querySelectorAll('${SEL.item}')].map((el, i) => {
  const stats = el.querySelector('${SEL.stats}');
  const canReply = Boolean(stats && [...stats.querySelectorAll('*')].some((x) => (x.innerText || '').trim() === '回复'));
  const infoWrap = el.querySelector('.comment-item-info-wrap')
    || (el.querySelector('[data-e2e="video-comment-more"]') || {}).parentElement
    || null;
  const nameLink = el.querySelector('a[href*="/user/"]');
  let author = nameLink ? (nameLink.innerText || '').trim() : '';
  let content = infoWrap && infoWrap.nextElementSibling ? (infoWrap.nextElementSibling.innerText || '').trim() : '';
  const NOISE = (s) => s === '' || s === '...' || s === '···' || s === '…' || s === '作者' || s === '置顶' || s === '作者赞过';
  if (NOISE(content)) content = '';
  if (!content) {
    const cand = [...el.querySelectorAll('span, div, p')].filter((x) => x.children.length === 0)
      .map((x) => (x.innerText || '').trim())
      .filter((s) => !NOISE(s) && s !== author
        && !/^展开/.test(s) && !/^收起/.test(s)
        && !/^\\d+$/.test(s)
        && !/^(分享|回复|点赞|收藏|举报|关注)$/.test(s)
        && !/\\d+\\s*(天|小时|分钟|秒|周|月|年)前/.test(s)
        && !/·\\S+$/.test(s));
    content = cand[0] || '';
  }
  if (!author) author = ((el.innerText || '').split('\\n')[0] || '').slice(0, 40);
  const isAuthor = [...el.querySelectorAll('span, div, p')].some((x) => x.children.length === 0 && (x.innerText || '').trim() === '作者');
  const cid = String(el.getAttribute('data-cid') || el.getAttribute('data-comment-id') || '').trim();
  return { i, cid, author: author.slice(0, 40), content: content.slice(0, 300), isAuthor, canReply };
}))()`;

// 取某个元素里「文本正好等于 label」的可见叶子节点的中心坐标（先滚到视口中间）。
const rectScript = (root: string, label: string) => `(() => {
  const rootEl = document.querySelector(${JSON.stringify(root)});
  if (!rootEl) return null;
  const target = ${JSON.stringify(label)};
  const hits = [...rootEl.querySelectorAll('*')].filter((x) => x.children.length === 0 && (x.innerText || '').trim() === target);
  const el = hits.find((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; }) || hits[0];
  if (!el) return null;
  const before = el.getBoundingClientRect();
  if (before.top < 60 || before.bottom > window.innerHeight - 60) {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
  }
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

// 第 index 条评论里的「回复」按钮坐标。
const replyRectScript = `(() => {
  const items = [...document.querySelectorAll('${SEL.item}')];
  const el = items[${'${INDEX}'}];
  if (!el) return null;
  const stats = el.querySelector('${SEL.stats}');
  if (!stats) return null;
  const hit = [...stats.querySelectorAll('*')].find((x) => x.children.length === 0 && (x.innerText || '').trim() === '回复' && x.getBoundingClientRect().width > 0);
  if (!hit) return null;
  const before = hit.getBoundingClientRect();
  if (before.top < 60 || before.bottom > window.innerHeight - 60) hit.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = hit.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

const commentBtnRectScript = `(() => {
  const el = document.querySelector('${SEL.commentBtn}');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

const sendBtnRectScript = `(() => {
  const box = document.querySelector('${SEL.input}');
  const scope = box || document;
  const hits = [...scope.querySelectorAll('button, div, span')].filter((x) => (x.innerText || '').trim() === '发送');
  const el = hits.find((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

async function realClick(cdp: any, point: { x: number; y: number }) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 0 });
}

/** 打开某条作品的评论区：折叠着就点评论图标。 */
async function ensureCommentsOpen(cdp: any): Promise<boolean> {
  for (let i = 0; i < 12; i += 1) {
    const state: any = await cdp.evaluate(STATE_JS).catch(() => null);
    if (state?.box) return true;
    if (state?.btn) {
      const point: any = await cdp.evaluate(commentBtnRectScript).catch(() => null);
      if (point) {
        await realClick(cdp, point);
        await sleep(1200);
        continue;
      }
    }
    await sleep(1000);
  }
  const state: any = await cdp.evaluate(STATE_JS).catch(() => null);
  return Boolean(state?.box);
}

export type ReadCommentsResult = { ok: boolean; items?: PageComment[]; message?: string };

/** 打开作品页并读出评论列表（一级评论，按页面顺序）。 */
export async function readWorkComments(port: number, awemeId: string): Promise<ReadCommentsResult> {
  const id = String(awemeId ?? '').trim();
  if (!/^\d{8,}$/.test(id)) return { ok: false, message: '作品 ID 不像抖音的作品 ID。' };
  const cdp = await connectCdp(port);
  if (!cdp) return { ok: false, message: '登录窗口没开着，先在设置页点「打开登录窗口」。' };
  try {
    const challenge = await pageChallenge(port);
    if (challenge) return { ok: false, message: challenge === 'sms' ? '页面上要短信验证，先去登录窗口里手动过一次。' : '页面上挂着滑块/安全验证，先去登录窗口里手动过一次。' };
    await cdp.send('Page.navigate', { url: `https://www.douyin.com/video/${id}` });
    await sleep(6500);
    await ensureCommentsOpen(cdp);
    const raw = await cdp.evaluate(LIST_JS).catch(() => null);
    const list = Array.isArray(raw) ? raw : [];
    const items: PageComment[] = list.map((x: any) => ({
      index: Number(x?.i) || 0,
      cid: String(x?.cid ?? ''),
      author: String(x?.author ?? '').slice(0, 40),
      content: String(x?.content ?? '').slice(0, 300),
      isAuthor: Boolean(x?.isAuthor),
      canReply: Boolean(x?.canReply),
    }));
    if (!items.length) return { ok: false, message: '没读到评论：可能评论区还没加载出来，或这条作品没有开放评论。' };
    return { ok: true, items };
  } catch (error: any) {
    return { ok: false, message: String(error?.message ?? error).slice(0, 160) };
  } finally {
    cdp.close();
  }
}

export type ReplyInput = {
  awemeId: string;
  text: string;
  /** 目标评论的正文片段或作者昵称；给了 index 时可以省略。 */
  match?: string;
  /** 评论在列表里的下标（从 0 开始），优先级高于 match。 */
  index?: number;
};

export type ReplyResult = { ok: boolean; code?: string; message: string; author?: string; content?: string; verified?: boolean };

/** 回一条评论：定位目标 → 点「回复」→ 写进编辑框 → 发送 → 回读校验。 */
export async function replyToWorkComment(port: number, input: ReplyInput): Promise<ReplyResult> {
  const id = String(input.awemeId ?? '').trim();
  const text = String(input.text ?? '').trim();
  if (!/^\d{8,}$/.test(id)) return { ok: false, code: 'bad_aweme', message: '作品 ID 不像抖音的作品 ID。' };
  if (!text) return { ok: false, code: 'no_text', message: '回复内容是空的。' };
  if (text.length > 100) return { ok: false, code: 'too_long', message: '抖音评论最长 100 字。' };

  const cdp = await connectCdp(port);
  if (!cdp) return { ok: false, code: 'no_window', message: '登录窗口没开着，先在设置页点「打开登录窗口」。' };
  try {
    const challenge = await pageChallenge(port);
    if (challenge) {
      return {
        ok: false,
        code: 'verify_required',
        message: challenge === 'sms'
          ? '页面要求短信验证，先去登录窗口里手动过一次，再回来重试。'
          : '页面挂着滑块/安全验证，先去登录窗口里手动过一次，再回来重试。',
      };
    }
    await cdp.send('Page.navigate', { url: `https://www.douyin.com/video/${id}` });
    await sleep(6500);
    if (!(await ensureCommentsOpen(cdp))) {
      return { ok: false, code: 'no_comment_box', message: '打不开评论区（没找到评论输入区，可能页面改版或这条作品关了评论）。' };
    }

    const raw = await cdp.evaluate(LIST_JS).catch(() => null);
    const list: any[] = Array.isArray(raw) ? raw : [];
    if (!list.length) return { ok: false, code: 'no_comments', message: '评论区里没有读到一级评论。' };

    const want = typeof input.index === 'number' && Number.isFinite(input.index) ? Number(input.index) : null;
    const needle = String(input.match ?? '').trim().toLowerCase();
    let target: any = null;
    if (want !== null) {
      target = list.find((x) => Number(x.i) === want) ?? null;
      if (!target) return { ok: false, code: 'not_found', message: `没有第 ${want} 条评论（现在共 ${list.length} 条）。` };
    } else if (needle) {
      const hits = list.filter((x) => `${String(x.author ?? '')} ${String(x.content ?? '')}`.toLowerCase().includes(needle));
      if (hits.length > 1) {
        return {
          ok: false,
          code: 'ambiguous',
          message: `有 ${hits.length} 条评论都匹配「${needle}」，用 index 指定一条。候选：` +
            hits.slice(0, 5).map((x) => `#${x.i} ${x.author}：${String(x.content).slice(0, 24)}`).join(' / '),
        };
      }
      target = hits[0] ?? null;
      if (!target) return { ok: false, code: 'not_found', message: `没找到包含「${needle}」的评论。` };
    } else {
      return { ok: false, code: 'need_target', message: '要给 match（评论正文片段或作者昵称）或 index，才能确定回复哪一条。' };
    }

    if (target.isAuthor) return { ok: false, code: 'is_author', message: '这条是作者自己的评论，不回。' };
    if (!target.canReply) return { ok: false, code: 'not_repliable', message: '这条评论没有「回复」入口（可能已被关闭）。' };

    const point: any = await cdp.evaluate(replyRectScript.replace('${INDEX}', String(Number(target.i)))).catch(() => null);
    if (!point) return { ok: false, code: 'no_reply_button', message: '没找到这条评论的「回复」按钮。' };
    await realClick(cdp, point);
    await sleep(1200);

    // 等编辑框出现并可用
    let editorReady = false;
    for (let i = 0; i < 10; i += 1) {
      const ok: any = await cdp.evaluate(`(() => { const el = document.querySelector('${SEL.editor}'); if (!el) return false; el.focus(); return true; })()`).catch(() => false);
      if (ok) {
        editorReady = true;
        break;
      }
      await sleep(800);
    }
    if (!editorReady) return { ok: false, code: 'no_editor', message: '点了回复但没出现输入框（可能需要人工在窗口里确认）。' };

    await cdp.send('Input.insertText', { text });
    await sleep(800);

    const typed: any = await cdp.evaluate(`(() => { const el = document.querySelector('${SEL.editor}'); return el ? String(el.textContent || '').slice(0, 80) : ''; })()`).catch(() => '');
    if (!String(typed ?? '').includes(text.slice(0, 10))) {
      return { ok: false, code: 'insert_failed', message: '文字没写进回复框，没发送。' };
    }

    const sendPoint: any = await cdp.evaluate(sendBtnRectScript).catch(() => null);
    if (sendPoint) {
      await realClick(cdp, sendPoint);
    } else {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    }
    await sleep(2500);

    // 回读校验：页面上出现我们刚发的那句话，才算发出去。
    let verified = false;
    for (let i = 0; i < 6; i += 1) {
      const body: any = await cdp.evaluate(`(() => String(document.body ? document.body.innerText : '').slice(0, 20000))()`).catch(() => '');
      if (String(body ?? '').includes(text.slice(0, Math.min(20, text.length)))) {
        verified = true;
        break;
      }
      await sleep(800);
    }
    const after: any = await cdp.evaluate(LIST_JS).catch(() => null);
    const last: any = Array.isArray(after) && after.length ? after[after.length - 1] : null;
    return {
      ok: true,
      message: verified ? '回复已发出（页面上能看到）。' : '已点发送，但没在页面上回读到自己这条，去 App 里确认一下。',
      author: String(target.author ?? ''),
      content: String(target.content ?? '').slice(0, 120),
      verified: verified || Boolean(last && String(last.content ?? '').includes(text.slice(0, 8))),
    };
  } catch (error: any) {
    return { ok: false, code: 'reply_error', message: String(error?.message ?? error).slice(0, 200) };
  } finally {
    cdp.close();
  }
}
