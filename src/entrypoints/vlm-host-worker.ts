import { defineUnlistedScript } from 'wxt/sandbox';
import { visionPipeline } from '../lib/vision/florence2';
import type { VisionOptions } from '../lib/vision/florence2';

/**
 * #142: the dedicated on-device VLM worker.
 *
 * This file is emitted by WXT as a root-level script at the extension origin
 * (dist/chrome-mv3/vlm-host-worker.js). The offscreen document spawns it with
 * `new Worker(url, { type: 'module' })` — a module-scope, same-origin worker.
 * That context is the ONE place that can both `import()` the bundled
 * onnxruntime-web loader (the thing the content-script isolated world blocks —
 * the root cause of "no available backend found") AND expose WebGPU, so the
 * Florence-2 pipeline finally loads. The service worker can't spawn it
 * (`Worker is not defined` on the SW scope, probed in #113), and the popup is
 * transient, so a thin offscreen document owns it.
 *
 * PII boundary (unchanged from the #100 "screenshot stays local" design): the
 * SW captures the visible tab and relays the data-URL here; only OCR TEXT
 * (and detection boxes) travel back. Pixels never reach the page DOM or the
 * LLM.
 *
 * Note on bundling: WXT inlines this entrypoint's static deps
 * (@huggingface/transformers + onnxruntime-web) at build time, so no static
 * `import` is needed at module scope. The ONLY runtime `import()` is
 * onnxruntime-web's own loader of `vlm/ort/ort-*.mjs` + the .wasm (configured
 * via `wasmPaths` in florence2.initialize), which is same-origin and legal in
 * a module worker.
 */

type VlmTaskType = 'INIT' | 'OCR' | 'DETECT' | 'CAPTION' | 'VQA' | 'STATUS';

export interface VlmRequest {
  id?: number;
  type: VlmTaskType;
  query?: string;
  /** data-URL (base64 PNG) captured by the SW. */
  dataUrl?: string;
}

export interface VlmResponse {
  id?: number;
  ok: boolean;
  text?: string;
  boxes?: Array<{ x: number; y: number; width: number; height: number; label: string }>;
  status?: unknown;
  error?: string;
}

const TASK_MAP: Record<string, VisionOptions['task']> = {
  OCR: 'ocr',
  DETECT: 'object-detection',
  CAPTION: 'caption',
  VQA: 'question-answering',
};

/**
 * Decode a data-URL screenshot into an ImageBitmap. Workers have no
 * `Image`/`canvas`, but `fetch` + `createImageBitmap` cover PNG decoding in
 * the worker context (both are same-origin / data-URL capable).
 */
async function decodeImageDataUrl(dataUrl: string): Promise<ImageBitmap | string> {
  if (!dataUrl) return '';
  try {
    const blob = await (await fetch(dataUrl)).blob();
    return await createImageBitmap(blob);
  } catch {
    // Fall back to handing the raw data-URL to the pipeline (transformers.js
    // decodes data URLs itself in a worker env).
    return dataUrl;
  }
}

export default defineUnlistedScript(() => {
  const selfRef = self as unknown as {
    onmessage: ((e: MessageEvent) => void) | null;
    postMessage: (m: VlmResponse) => void;
  };

  selfRef.onmessage = async (ev: MessageEvent) => {
    const req = ev.data as VlmRequest;
    const reply = (r: Omit<VlmResponse, 'id'>): void => {
      selfRef.postMessage({ id: req.id, ...r });
    };
    try {
      switch (req.type) {
        case 'INIT': {
          if (!visionPipeline.isInitialized()) await visionPipeline.initialize();
          reply({ ok: true, status: visionPipeline.status() });
          break;
        }
        case 'OCR':
        case 'DETECT':
        case 'CAPTION':
        case 'VQA': {
          if (!visionPipeline.isInitialized()) await visionPipeline.initialize();
          const image = req.dataUrl ? await decodeImageDataUrl(req.dataUrl) : '';
          if (!image) {
            visionPipeline.recordOcr(false, 'no image');
            reply({ ok: false, error: 'no image', status: visionPipeline.status() });
            break;
          }
          const res = await visionPipeline.processImage(image as never, {
            task: TASK_MAP[req.type],
            query: req.query,
          });
          const text = res?.text ?? (res?.data as { text?: string } | undefined)?.text ?? '';
          if (req.type === 'OCR') {
            visionPipeline.recordOcr(!!text, text ? 'ok' : 'empty ocr');
            // "empty ocr" = the model RAN and read nothing - a verdict, not an
            // availability failure (the SW's confirmGoal distinguishes the two).
            if (!text) {
              reply({ ok: false, error: 'empty ocr', status: visionPipeline.status() });
              break;
            }
          }
          reply({
            ok: !!text || req.type !== 'OCR',
            text,
            boxes: res?.boundingBoxes,
            status: visionPipeline.status(),
          });
          break;
        }
        case 'STATUS': {
          reply({ ok: true, status: visionPipeline.status() });
          break;
        }
      }
    } catch (e) {
      visionPipeline.recordOcr(false, String(e));
      reply({ ok: false, error: String(e), status: visionPipeline.status() });
    }
  };
});
