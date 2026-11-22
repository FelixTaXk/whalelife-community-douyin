/*! 在登录窗口里刷推荐流：点播放器自带的「下一条」切条，碰到失效视频自动跳过。
 *
 * 抖音电脑版推荐流（https://www.douyin.com/?recommend=1）不是滚动页面切条：
 * 滚轮只会把整页往下滑，画面还停在原视频上——这正是「刷一条等于在推荐里下滑一条」的原因。
 * 真正的切条控件是播放器右侧的 .xgplayer-playswitch-next，点一次换一条。
 * 推荐队列里本来就夹着已删除/私密作品，播放器会显示「你要观看的视频不存在」；
 * 这里识别到这句就再点一次下一条，不把错误页当成一条刷到的视频。
 */

import { connectCdp } from './creator.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FEED_URL = 'https://www.douyin.com/?recommend=1&from_nav=1';
const NEXT_BTN = '.xgplayer-playswitch-next';

const STATE_JS = `(() => {
  const inView = (r) => r.top >= 0 && r.top < window.innerHeight && r.height > 160;
  const vids = [...document.querySelectorAll('video')].map((v) => ({ v, r: v.getBoundingClientRect() })).filter((x) => inView(x.r));
  const descs = [...document.querySelectorAll('[data-e2e="video-desc"]')].map((d) => ({ d, r: d.getBoundingClientRect() })).filter((x) => x.r.top >= 0 && x.r.top < window.innerHeight - 40);
  const body = String(document.body.innerText || '');
  const btn = document.querySelector('${NEXT_BTN}');
  const br = btn && btn.getBoundingClientRect();
  return {
    desc: descs[0] ? String(descs[0].d.innerText || '').replace(/\\s+/g, ' ').slice(0, 60) : '',
    src: vids[0] ? String(vids[0].v.currentSrc || vids[0].v.src || '').slice(-48) : '',
    playing: vids[0] ? !vids[0].v.paused : null,
    dead: /你要观看的视频不存在|视频不存在/.test(body),
    btn: br && br.width > 0 && br.height > 0 ? { x: Math.round(br.left + br.width / 2), y: Math.round(br.top + br.height / 2) } : null,
    url: location.href,
  };
})()`;

export type SwipeResult = {
  ok: boolean;
  switched: number;
  count: number;
  skipped: number;
  message: string;
};

export async function swipeRecommend(opts: { port: number; count: number; dwellMs?: number; url?: string }): Promise<SwipeResult> {
  const cdp = await connectCdp(opts.port);
  if (!cdp) return { ok: false, switched: 0, count: 0, skipped: 0, message: '连不上登录窗口的调试端口。' };
  const count = Math.max(1, Math.min(30, Number(opts.count) || 1));
  const dwell = Math.max(2000, Number(opts.dwellMs) || 4000);

  const read = async (): Promise<any> => (await cdp.evaluate(STATE_JS).catch(() => null)) ?? null;
  const sigOf = (s: any) => `${String(s?.desc || '')}|${String(s?.src || '')}`;
  const clickNext = async (point: { x: number; y: number }) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 0 });
  };

  try {
    await cdp.send('Page.navigate', { url: String(opts.url || FEED_URL) });
    await sleep(3000);

    // 等播放器和「下一条」按钮就绪（推荐流首屏要几秒）。
    let state: any = null;
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      state = await read();
      if (state?.btn && (state.desc || state.src)) break;
      await sleep(1200);
    }
    if (!state?.btn) {
      return { ok: false, switched: 0, count, skipped: 0, message: '推荐流没加载出「下一条」按钮：可能页面不是推荐流，或登录过期了。' };
    }

    // 首屏如果停在失效视频上，先跳过去再开始计数。
    let skipped = 0;
    for (let guard = 0; state?.dead && guard < 3; guard += 1) {
      await clickNext(state.btn);
      skipped += 1;
      await sleep(dwell);
      state = await read();
    }

    let switched = 0;
    let before = sigOf(state);
    const tries = count * 3;
    for (let i = 0; i < tries && switched < count; i += 1) {
      const point = state?.btn;
      if (!point) break;
      await clickNext(point);
      await sleep(dwell);
      state = await read();
      if (!state) break;
      if (state.dead) {
        skipped += 1;
        continue; // 失效视频：直接再点一次下一条，不算刷到一条
      }
      const after = sigOf(state);
      if (after !== before) {
        switched += 1;
        before = after;
      }
    }

    const tail = skipped ? `，跳过 ${skipped} 条失效视频` : '';
    return {
      ok: switched > 0,
      switched,
      count,
      skipped,
      message: switched > 0
        ? `在推荐流里刷了 ${switched} 条${tail}${state?.playing === false ? '（当前这条是暂停状态）' : ''}。`
        : `一条都没切动${tail}：播放器可能没加载好，去窗口里看一眼。`,
    };
  } catch (error: any) {
    return { ok: false, switched: 0, count, skipped: 0, message: `刷流失败：${String(error?.message ?? error).slice(0, 120)}` };
  } finally {
    cdp.close();
  }
}
