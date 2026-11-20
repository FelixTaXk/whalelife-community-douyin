/*! ComfyUI：按已有 workflow 生成图片，返回本地文件路径。 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ComfyInput = {
  server: string;
  workflowPath: string;
  prompt: string;
  negative?: string;
  outDir: string;
  timeoutMs?: number;
};

export type ComfyResult = { ok: boolean; paths?: string[]; code?: string; message: string; promptId?: string };

function patchWorkflow(workflow: any, prompt: string, negative?: string) {
  const patched = JSON.parse(JSON.stringify(workflow));
  const textNodes: any[] = [];
  for (const [key, node] of Object.entries<any>(patched)) {
    if (!node || typeof node !== 'object') continue;
    if (String(node.class_type ?? '').includes('CLIPTextEncode')) textNodes.push({ key, node });
  }
  // 优先占位符，其次按标题区分正负向，最后退回第一个节点。
  let replacedByPlaceholder = false;
  for (const [key, node] of Object.entries<any>(patched)) {
    if (!node || typeof node !== 'object' || !node.inputs) continue;
    for (const [inputKey, value] of Object.entries<any>(node.inputs)) {
      if (typeof value !== 'string') continue;
      if (value.includes('{{PROMPT}}') || value.includes('%PROMPT%')) {
        node.inputs[inputKey] = value.replace(/\{\{PROMPT\}\}|%PROMPT%/g, prompt);
        replacedByPlaceholder = true;
      } else if (negative && (value.includes('{{NEGATIVE}}') || value.includes('%NEGATIVE%'))) {
        node.inputs[inputKey] = value.replace(/\{\{NEGATIVE\}\}|%NEGATIVE%/g, negative);
      }
    }
  }
  if (replacedByPlaceholder || !textNodes.length) return patched;

  const positive = textNodes.find(({ node }) => /pos|正向/i.test(String(node?._meta?.title ?? ''))) ?? textNodes[0];
  const negativeNode = textNodes.find(({ key, node }) => key !== positive.key && /neg|负向/i.test(String(node?._meta?.title ?? '')));
  if (positive?.node?.inputs) positive.node.inputs.text = prompt;
  if (negative && negativeNode?.node?.inputs) negativeNode.node.inputs.text = negative;
  return patched;
}

export async function comfyGenerate(input: ComfyInput): Promise<ComfyResult> {
  const server = String(input.server || 'http://127.0.0.1:8188').replace(/\/$/, '');
  const workflowPath = String(input.workflowPath ?? '').trim();
  if (!workflowPath) return { ok: false, code: 'no_workflow', message: '没有配置 ComfyUI workflow 文件路径。' };
  let workflow: any;
  try {
    workflow = JSON.parse(readFileSync(workflowPath, 'utf8'));
  } catch (error: any) {
    return { ok: false, code: 'workflow_read', message: `读不了 workflow 文件：${String(error?.message ?? error).slice(0, 120)}` };
  }
  if (Array.isArray(workflow?.nodes)) {
    return { ok: false, code: 'ui_format', message: '这个 workflow 是界面格式，需要在 ComfyUI 里用「Save (API Format)」导出。' };
  }
  const prompt = String(input.prompt ?? '').trim();
  if (!prompt) return { ok: false, code: 'no_prompt', message: '提示词是空的。' };

  const body = patchWorkflow(workflow, prompt, input.negative);
  let promptId = '';
  try {
    const res = await fetch(`${server}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: body, client_id: 'whalelife-douyin' }),
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok || !json?.prompt_id) {
      return { ok: false, code: 'comfy_submit', message: `ComfyUI 拒绝了任务：${res.status} ${String(json?.error?.message ?? json?.error ?? '').slice(0, 140)}` };
    }
    promptId = String(json.prompt_id);
  } catch (error: any) {
    return { ok: false, code: 'comfy_down', message: `连不上 ComfyUI（${server}）：${String(error?.message ?? error).slice(0, 120)}` };
  }

  const timeoutMs = Math.min(Math.max(Number(input.timeoutMs) || 120000, 20000), 300000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1500);
    try {
      const res = await fetch(`${server}/history/${promptId}`);
      const json: any = await res.json().catch(() => null);
      const entry = json?.[promptId];
      if (!entry) continue;
      const status = entry?.status?.status_str;
      if (status === 'error') return { ok: false, code: 'comfy_error', message: 'ComfyUI 执行失败，看看它自己的报错。', promptId };
      const outputs = entry?.outputs ?? {};
      const files: { filename: string; subfolder: string; type: string }[] = [];
      for (const node of Object.values<any>(outputs)) {
        for (const image of node?.images ?? []) {
          if (image?.filename) files.push({ filename: String(image.filename), subfolder: String(image.subfolder ?? ''), type: String(image.type ?? 'output') });
        }
      }
      if (files.length) {
        mkdirSync(input.outDir, { recursive: true });
        const saved: string[] = [];
        for (const file of files) {
          const url = `${server}/view?filename=${encodeURIComponent(file.filename)}&subfolder=${encodeURIComponent(file.subfolder)}&type=${file.type}`;
          const imgRes = await fetch(url);
          if (!imgRes.ok) continue;
          const bytes = Buffer.from(await imgRes.arrayBuffer());
          const name = `${Date.now()}-${String(saved.length + 1)}-${file.filename.replace(/[^\w.-]/g, '_')}`;
          const path = join(input.outDir, name);
          writeFileSync(path, bytes);
          saved.push(path);
        }
        if (saved.length) return { ok: true, paths: saved, message: `生成 ${saved.length} 张图。`, promptId };
        return { ok: false, code: 'download_failed', message: '图生成了但没下载下来。', promptId };
      }
    } catch {}
  }
  return { ok: false, code: 'comfy_timeout', message: `等了 ${Math.round(timeoutMs / 1000)} 秒还没出图。`, promptId };
}
