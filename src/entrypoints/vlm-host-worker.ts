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

type VlmTaskType = 'INIT' | 'OCR' | 'DETECT' | 'GROUND' | 'CAPTION' | 'VQA' | 'STATUS';

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
  GROUND: 'grounding',
  CAPTION: 'caption',
  VQA: 'question-answering',
};

export default defineUnlistedScript(() => {
  const selfRef = self as unknown as {
    onmessage: ((e: MessageEvent) => void) | null;
    postMessage: (m: VlmResponse) => void;
  };

  // #115: box-producing tasks (GROUND/DETECT) need the image decoded to an
  // ImageBitmap so Florence-2 can scale its bboxes by the real pixel size
  // (img.size = [h, w]). The OCR/CAPTION/VQA text tasks are fine with the
  // raw data-URL string. A dedicated worker has createImageBitmap (browser/
  // webworker capability) and fetch(dataUrl) for same-origin PNGs.
  async function decodeToBitmap(dataUrl: string): Promise<ImageBitmap> {
    const blob = await (await fetch(dataUrl)).blob();
    return await createImageBitmap(blob);
  }

  const isBoxTask = (t: VlmTaskType) => t === 'GROUND' || t === 'DETECT';

  // #149 review: serialize inference. The shared model is NOT
  // concurrent-safe (a SW timeout + retry can overlap two runs), so a
  // second work request while one is in flight is answered {busy} - the
  // SW treats that as unavailable and the deterministic backstop carries
  // on; the next check runs cleanly.
  let busy = false;

  selfRef.onmessage = async (ev: MessageEvent) => {
    const req = ev.data as VlmRequest;
    const reply = (r: Omit<VlmResponse, 'id'>): void => {
      selfRef.postMessage({ id: req.id, ...r });
    };
    const isWork = req.type === 'OCR' || req.type === 'DETECT' || req.type === 'GROUND' || req.type === 'CAPTION' || req.type === 'VQA';
    if (isWork && busy) {
      reply({ ok: false, error: 'busy', status: visionPipeline.status() });
      return;
    }
    if (isWork) busy = true;
    try {
      switch (req.type) {
        case 'INIT': {
          if (!visionPipeline.isInitialized()) await visionPipeline.initialize();
          reply({ ok: true, status: visionPipeline.status() });
          break;
        }
        case 'OCR':
        case 'DETECT':
        case 'GROUND':
        case 'CAPTION':
        case 'VQA': {
          if (!visionPipeline.isInitialized()) await visionPipeline.initialize();
          if (!req.dataUrl) {
            if (req.type === 'OCR') visionPipeline.recordOcr(false, 'no image');
            reply({ ok: false, error: 'no image', status: visionPipeline.status() });
            break;
          }
          let image: HTMLCanvasElement | HTMLImageElement | ImageBitmap | string;
          if (isBoxTask(req.type)) {
            // Decode to a bitmap so bbox scaling gets real dimensions.
            image = await decodeToBitmap(req.dataUrl);
          } else {
            // #149 review: text tasks pass the data-URL string straight
            // (the documented transformers.js browser path).
            image = req.dataUrl;
          }
          const res = await visionPipeline.processImage(image, {
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
          const boxes = res?.boundingBoxes?.map((b) => ({
            x: b.x,
            y: b.y,
            width: b.width,
            height: b.height,
            label: b.label ?? '',
          }));
          reply({
            ok: isBoxTask(req.type) ? !!boxes && boxes.length > 0 : !!text || req.type !== 'OCR',
            text,
            boxes: boxes,
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
      // #149 review: recordOcr is the OCR-specific indicator; other tasks'
      // failures must not skew the "last OCR" the pill shows.
      if (req.type === 'OCR') visionPipeline.recordOcr(false, String(e));
      reply({ ok: false, error: String(e), status: visionPipeline.status() });
    } finally {
      if (isWork) busy = false;
    }
  };
});
