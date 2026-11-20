/*! 纯文字发布：把文案渲染成一张文字卡片图，再走已验证的图文发布链路。 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type TextCardResult = { ok: true; path: string } | { ok: false; message: string };

export async function renderTextCard(opts: {
  text: string;
  outDir: string;
  title?: string;
  footer?: string;
  timeoutMs?: number;
}): Promise<TextCardResult> {
  const dir = opts.outDir;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}
  const txt = join(dir, `card-${stamp}.txt`);
  const out = join(dir, `card-${stamp}.png`);
  try {
    writeFileSync(txt, String(opts.text ?? ''), 'utf8');
  } catch (error: any) {
    return { ok: false, message: `写文字文件失败：${String(error?.message ?? error).slice(0, 120)}` };
  }

  const script = join(import.meta.dirname, 'textcard.ps1');
  if (!existsSync(script)) return { ok: false, message: '缺少文字卡片脚本 textcard.ps1。' };

  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-TextFile',
    txt,
    '-OutFile',
    out,
  ];

  const timeoutMs = Number(opts.timeoutMs ?? 30000);
  const code = await new Promise<number>((resolve) => {
    let settled = false;
    const done = (value: number) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: 'ignore' });
    child.on('close', (c) => done(Number(c ?? 0)));
    child.on('error', () => done(1));
    setTimeout(() => {
      try {
        child.kill();
      } catch {}
      done(2);
    }, timeoutMs);
  });

  if (code !== 0) return { ok: false, message: `文字卡片渲染失败（exit ${code}）。` };
  if (!existsSync(out)) return { ok: false, message: '文字卡片没有生成。' };
  return { ok: true, path: out };
}
