/*! 在登录窗口里像人一样滑推荐流：滚轮下切，滚不动时补一次方向键。 */

import { connectCdp } from './creator.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const VIDEO_SRC = '(()=>{const v=document.querySelector("video");return v?String(v.currentSrc||v.src||"").slice(-48):""})()';
const VIDEO_DESC = '(()=>{const d=document.querySelector(\'[data-e2e="video-desc"]\');return d?String(d.innerText||"").slice(0,60):""})()';

export type SwipeResult = {
  ok: boolean;
  switched: number;
  count: number;
  message: string;
};

export async function swipeRecommend(opts: { port: number; count: number; dwellMs?: number; url?: string }): Promise<SwipeResult> {
  const cdp = await connectCdp(opts.port);
  if (!cdp) return { ok: false, switched: 0, count: 0, message: '连不上登录窗口的调试端口。' };
  const count = Math.max(1, Math.min(10, Number(opts.count) || 1));
  const dwell = Math.max(1500, Number(opts.dwellMs) || 4000);

  const readSig = async () => {
    const src = String((await cdp.evaluate(VIDEO_SRC)) ?? '');
    const desc = String((await cdp.evaluate(VIDEO_DESC)) ?? '');
    return `${src}|${desc}`;
  };

  try {
    await cdp.send('Page.navigate', { url: String(opts.url || 'https://www.douyin.com/jingxuan') });
    await sleep(6500);

    // 点一下页面，让窗口拿到焦点。
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 640, y: 420, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 420, button: 'left', clickCount: 1 });
    await sleep(900);

    const first = await readSig();
    if (!first.replace(/\|/g, '')) {
      return { ok: true, switched: 0, count, message: '页面滑了但没有视频内容，可能还没加载完或登录过期。' };
    }

    // 首屏刚渲染时滚动容器常没就绪，先空滑一次当预热。
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 420, deltaX: 0, deltaY: 1000 });
    await sleep(1500);

    let switched = 0;
    for (let i = 0; i < count; i += 1) {
      const before = await readSig();
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: 640,
        y: 420,
        deltaX: 0,
        deltaY: 1000,
      });
      await sleep(Math.min(2200, dwell));
      let after = await readSig();

      // 滚轮没带动时，补一次方向键——实测它比滚轮可靠。
      if (after === before) {
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          key: 'ArrowDown',
          code: 'ArrowDown',
          windowsVirtualKeyCode: 40,
        });
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'ArrowDown',
          code: 'ArrowDown',
          windowsVirtualKeyCode: 40,
        });
        await sleep(Math.max(1500, dwell - 1000));
        after = await readSig();
      }

      if (after && after !== before) switched += 1;
    }

    return {
      ok: true,
      switched,
      count,
      message: `在窗口里刷了 ${count} 条，画面切换 ${switched} 次。`,
    };
  } catch (error: any) {
    return { ok: false, switched: 0, count, message: `滑动失败：${String(error?.message ?? error).slice(0, 120)}` };
  } finally {
    cdp.close();
  }
}
