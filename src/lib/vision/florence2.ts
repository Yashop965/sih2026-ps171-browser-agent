/**
 * Florence-2 Vision Inference Module
 *
 * Uses Transformers.js for on-device vision:
 * - Object detection and grounding
 * - Optical Character Recognition (OCR)
 * - Visual question answering
 * - Captioning
 *
 * Model: onnx-community/Florence-2-base-ft (231M parameters, q4 ONNX ~150MB)
 * Runtime: WebGPU (primary) → WASM fallback for Firefox
 *
 * NOTE: must load via Florence2ForConditionalGeneration + AutoProcessor
 * directly. v3.8.1's `image-to-text` pipeline hardcodes
 * AutoModelForVision2Seq, whose model map has no `florence2` entry, so
 * `pipeline('image-to-text', ...)` can never load it (verified 2026-09-17).
 */

// Florence-2 output formats per task
// Object Detection: { [x0, y0, x1, y1], [x0, y0, x1, y1], ... } or { bboxes: [...] }
// OCR: { text: string, words: [{word, bbox: [x0,y0,x1,y1]}] }
// Caption: { generated_text: string }
// VQA: { answer: string }

// The microsoft/* repo ships PyTorch weights only - there is NO ONNX for it,
// so browser inference (Transformers.js) must use the onnx-community export.
// (Issue #100 verification, 2026-09-17: microsoft/Florence-2-base-ft has an
// empty ONNX sibling list and fails with "no matching files".)
const MODEL_ID = 'onnx-community/Florence-2-base-ft';

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  score?: number;
}

export interface VisionOptions {
  task: 'object-detection' | 'ocr' | 'caption' | 'question-answering' | 'grounding';
  query?: string;
  maxNewTokens?: number;
  temperature?: number;
}

export interface VisionResult {
  type: 'OCR' | 'GROUNDING' | 'DESCRIPTION';
  data: unknown;
  boundingBoxes?: BoundingBox[];
  text?: string;
  processingTime: number;
}

export interface VisionModelConfig {
  modelId: string;
  backend: 'webgpu' | 'wasm';
  dtype: 'fp32' | 'fp16' | 'q4';
}

// #136: the VLM live-indicator's view of the on-device vision pipeline.
// Pure status (state + backend + last OCR outcome), no PII.
export interface VisionStatus {
  state: 'idle' | 'loading' | 'ready' | 'unsupported' | 'failed';
  backend?: 'webgpu' | 'wasm';
  model?: string;
  lastOcrAt?: number;
  lastOcrOk?: boolean;
  lastOcrDetail?: string;
  /** Set when state === 'failed': why the on-device model load failed. */
  lastLoadError?: string;
  loadFailedAt?: number;
}

class Florence2Pipeline {
  private model: any = null;
  private processor: any = null;
  private initialized = false;
  private usingWebGPU = false;
  private loadPromise: Promise<void> | null = null;
  // #136: live status for the popup VLM indicator. Records the last OCR
  // verdict so the UI can show "ready", "not-yet-loaded", "last check
  // failed", etc. Pure state, no PII.
  private lastOcrAt = 0;
  private lastOcrOk = false;
  private lastOcrDetail = '';
  // Load-failure tracking: a failed model load is recorded (not silently
  // reset to idle), and re-attempts within the cooldown are short-circuited
  // so every VISION_OCR call does not re-trigger a 150MB download.
  private loadFailedAt = 0;
  private lastLoadError = '';
  /** Between load attempts after a failure (ms). */
  private static readonly LOAD_RETRY_COOLDOWN_MS = 60_000;

  /** #136: poll this (or the VISION_STATUS message) to render the indicator. */
  status(): VisionStatus {
    const webgpu = Florence2Pipeline.isWebGPUSupported();
    if (this.initialized) {
      return {
        state: 'ready',
        backend: this.usingWebGPU ? 'webgpu' : 'wasm',
        model: this.getModelId(),
        lastOcrAt: this.lastOcrAt,
        lastOcrOk: this.lastOcrOk,
        lastOcrDetail: this.lastOcrDetail,
      };
    }
    if (this.loadPromise) {
      return { state: 'loading', backend: webgpu ? 'webgpu' : 'wasm', model: this.getModelId() };
    }
    // Not started. If WebGPU is absent the model may still load via WASM,
    // so "unsupported" only when neither path is available on this browser.
    if (!webgpu && typeof window === 'undefined') {
      return { state: 'unsupported' };
    }
    // A previous load failed and the retry cooldown has not elapsed: report
    // the failure honestly instead of resetting to idle (which made the
    // popup claim "loads on first vision check" forever while every OCR
    // attempt re-triggered the download).
    if (
      this.lastLoadError &&
      Date.now() - this.loadFailedAt < Florence2Pipeline.LOAD_RETRY_COOLDOWN_MS
    ) {
      return {
        state: 'failed',
        backend: webgpu ? 'webgpu' : 'wasm',
        model: this.getModelId(),
        lastLoadError: this.lastLoadError,
        loadFailedAt: this.loadFailedAt,
      };
    }
    // Cooldown elapsed: start a re-attempt so the model can come back (e.g.
    // network recovered). initialize() sets loadPromise synchronously, so
    // this call is already tracked as a load in flight.
    if (this.lastLoadError) {
      this.initialize().catch(() => {});
      return { state: 'loading', backend: webgpu ? 'webgpu' : 'wasm', model: this.getModelId() };
    }
    return { state: 'idle', backend: webgpu ? 'webgpu' : 'wasm' };
  }

  /** #136: record an OCR attempt's outcome (called by ocrVisibleScreen). */
  recordOcr(ok: boolean, detail: string): void {
    this.lastOcrAt = Date.now();
    this.lastOcrOk = ok;
    this.lastOcrDetail = detail;
  }

  /** Check WebGPU availability */
  static isWebGPUSupported(): boolean {
    if (typeof navigator === 'undefined') return false;
    return 'gpu' in navigator && (navigator as any).gpu !== null;
  }

  async initialize(config: VisionModelConfig = {
    modelId: MODEL_ID,
    backend: Florence2Pipeline.isWebGPUSupported() ? 'webgpu' : 'wasm',
    dtype: 'q4',
  }): Promise<void> {
    if (this.initialized) return;
    if (this.loadPromise) return this.loadPromise;
    // Fast-fail within the retry cooldown after a failed load: reject with
    // the recorded reason instead of re-triggering a ~150MB model download
    // on every VISION_OCR call.
    if (
      this.lastLoadError &&
      Date.now() - this.loadFailedAt < Florence2Pipeline.LOAD_RETRY_COOLDOWN_MS
    ) {
      const waitS = Math.ceil(
        (Florence2Pipeline.LOAD_RETRY_COOLDOWN_MS - (Date.now() - this.loadFailedAt)) / 1000,
      );
      return Promise.reject(
        new Error(`on-device model load failed (${this.lastLoadError}); retrying in ~${waitS}s`),
      );
    }

    // Suppress ALL console output during initialization
    const silencedConsole = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      time: console.time,
      timeEnd: console.timeEnd,
      timeStamp: console.timeStamp,
    };
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    console.time = () => {};
    console.timeEnd = () => {};
    console.timeStamp = () => {};

    this.loadPromise = (async () => {
      try {
        const { env, Florence2ForConditionalGeneration, AutoProcessor } =
          await import('@huggingface/transformers');

        // Configure environment
        env.allowLocalModels = false;
        env.useBrowserCache = true;
        env.logLevel = 'error';

        // #141: load the onnxruntime-web runtime from the EXTENSION's own
        // origin instead of the jsdelivr CDN. The content script's MV3 CSP is
        // `script-src 'self'`, so a cross-origin dynamic `import()` of
        // https://cdn.jsdelivr.net/.../ort-wasm-simd-threaded.jsep.mjs is
        // blocked -> onnxruntime-web's backend init fails with
        // "no available backend found" and the WebGPU + WASM fallbacks both
        // die. Pointing wasmPaths at a same-origin chrome-extension:// URL
        // (public/vlm/ort/ copied into the dist root by WXT) makes the
        // import() same-origin and legal, so the ORT runtime + the 21MB
        // jsep .wasm both load from inside the extension. Set BEFORE the
        // first from_pretrained so transformers.js's lazy CDN-defaulting
        // (which only fires when wasmPaths is unset) does not overwrite us.
        try {
          const g: any = globalThis;
          const extApi: any = g.browser ?? g.chrome;
          const baseUrl = extApi?.runtime?.getURL
            ? extApi.runtime.getURL('vlm/ort/')
            : undefined;
          if (baseUrl) {
            const ortWasm: any = (env as any).backends?.onnx?.wasm;
            if (ortWasm) {
              // `mjs` overrides the loader module transformers.js dynamically
              // imports (the CSP-blocked one); `wasm` is where ORT fetches the
              // jsep .wasm binary. Both ship inside the extension.
              ortWasm.wasmPaths = {
                mjs: `${baseUrl}ort-wasm-simd-threaded.jsep.mjs`,
                wasm: `${baseUrl}ort-wasm-simd-threaded.jsep.wasm`,
              };
            }
          }
        } catch {
          // If env.backends.onnx isn't shaped as expected, leave the
          // transformers.js default in place — a load failure is still
          // honestly reported by status() via lastLoadError.
        }

        try {
          // v3.8.1 has NO pipeline task wired to AutoModelForImageTextToText,
          // so pipeline('image-to-text', ...) can never resolve florence2
          // (its AutoModelForVision2Seq map lacks 'florence2'). The official
          // model card loads the model + processor classes directly - we do
          // the same here. (Verification, issue #100, 2026-09-17.)
          this.model = await Florence2ForConditionalGeneration.from_pretrained(config.modelId, {
            device: config.backend === 'webgpu' ? 'webgpu' : 'wasm',
            dtype: config.dtype,
          });
          this.processor = await AutoProcessor.from_pretrained(config.modelId);

          this.initialized = true;
          // A successful (re-)load clears the recorded failure so status()
          // reports ready/idle again instead of the stale error.
          this.lastLoadError = '';
          this.loadFailedAt = 0;
        } finally {
          // Restore console methods
          console.log = silencedConsole.log;
          console.warn = silencedConsole.warn;
          console.error = silencedConsole.error;
          console.time = silencedConsole.time;
          console.timeEnd = silencedConsole.timeEnd;
          console.timeStamp = silencedConsole.timeStamp;
        }
      } catch (error) {
        console.error('[Vision] Failed to initialize:', error);
        // Record the failure so status() reports 'failed' (with reason)
        // instead of silently resetting to idle, and so the UI + runner can
        // say WHY the model is unavailable. Narrow first: catch vars are
        // `unknown` here, so `.message` needs an instanceof guard.
        this.lastLoadError =
          error instanceof Error ? error.message : String(error);
        this.loadFailedAt = Date.now();
        throw error;
      } finally {
        this.loadPromise = null;
      }
    })();

    return this.loadPromise;
  }

  async processImage(
    image: HTMLCanvasElement | HTMLImageElement | ImageBitmap | string,
    options: VisionOptions
  ): Promise<VisionResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Suppress ALL console output during processing
    const silencedConsole = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      time: console.time,
      timeEnd: console.timeEnd,
      timeStamp: console.timeStamp,
    };
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    console.time = () => {};
    console.timeEnd = () => {};
    console.timeStamp = () => {};

    const startTime = performance.now();

    try {
      let result: unknown;

      switch (options.task) {
        case 'object-detection':
          result = await this.runObjectDetection(image, options.query);
          break;
        case 'grounding':
          // #115: Florence-2 phrase grounding (<PG>) - "find: search box, button,
          // menu". Unlike COCO object-detection (<OD> finds cars/people/objects),
          // phrase grounding finds NAMED UI widgets by their label. Runs in the
          // offscreen module worker (#142), where the image processor decodes the
          // blob/bitmap so boxes scale by the real pixel size.
          result = await this.runGrounding(image, options.query || 'find: button, link, input box, text field, tab');
          break;
        case 'ocr':
          result = await this.runOCR(image);
          break;
        case 'caption':
          result = await this.runCaption(image);
          break;
        case 'question-answering':
          result = await this.runVQA(image, options.query || 'What is in this image?');
          break;
        default:
          throw new Error(`Unknown task: ${options.task}`);
      }

      const processingTime = performance.now() - startTime;

      return {
        type: this.mapTaskToResultType(options.task),
        data: result,
        boundingBoxes: this.extractBoxes(result, options.task),
        text: this.extractText(result, options.task),
        processingTime,
      };
    } catch (error) {
      console.error('[Vision] Processing failed:', error);
      throw error;
    } finally {
      // Restore console methods
      console.log = silencedConsole.log;
      console.warn = silencedConsole.warn;
      console.error = silencedConsole.error;
      console.time = silencedConsole.time;
      console.timeEnd = silencedConsole.timeEnd;
      console.timeStamp = silencedConsole.timeStamp;
    }
  }

  /** One Florence call: task prefix (+ optional query) -> raw text -> parsed.
   *  Mirrors the official onnx-community model-card recipe. */
  private async runTask(
    image: HTMLCanvasElement | HTMLImageElement | ImageBitmap | string,
    task: string,
    query?: string,
  ): Promise<unknown> {
    if (!this.model || !this.processor) throw new Error('Pipeline not initialized');
    // Florence expects an image with a .size ([h, w]) for <OD> box scaling.
    const img: any = image;
    if (img && !img.size && img.width) img.size = [img.height, img.width];
    const prompts = this.processor.construct_prompts(query ? `${task} ${query}` : task);
    const inputs = await this.processor(img, prompts);
    const generated_ids = await this.model.generate({ ...inputs, max_new_tokens: 128 });
    const generated_text = this.processor.batch_decode(generated_ids, { skip_special_tokens: false })[0];
    return this.processor.post_process_generation(generated_text, task, img.size);
  }

  private async runObjectDetection(image: HTMLCanvasElement | HTMLImageElement | ImageBitmap | string, query?: string): Promise<unknown> {
    return this.runTask(image, '<OD>', query);
  }

  // #115: phrase grounding (<PG>) - the "find: button / search box / menu" task.
  // Output post-processes to {labels, bboxes} exactly like <OD>, so the same
  // extractBoxes path handles both.
  private async runGrounding(image: HTMLCanvasElement | HTMLImageElement | ImageBitmap | string, query?: string): Promise<unknown> {
    return this.runTask(image, '<PG>', query);
  }

  private async runOCR(image: HTMLCanvasElement | HTMLImageElement | ImageBitmap | string): Promise<unknown> {
    return this.runTask(image, '<OCR>');
  }

  private async runCaption(image: HTMLCanvasElement | HTMLImageElement | ImageBitmap | string): Promise<unknown> {
    return this.runTask(image, '<CAP>');
  }

  private async runVQA(image: HTMLCanvasElement | HTMLImageElement | ImageBitmap | string, question: string): Promise<unknown> {
    return this.runTask(image, '<VQA>', question);
  }

  /**
   * Extract bounding boxes from Florence-2 output.
   * Florence-2 returns coordinates as [x0, y0, x1, y1] or array of such arrays.
   */
  private extractBoxes(result: unknown, _task: string): BoundingBox[] | undefined {
    if (!result) return undefined;

    // Handle array of {x0,y0,x1,y1} objects (common Florence-2 format)
    if (Array.isArray(result)) {
      const parsedBoxes: BoundingBox[] = [];
      result.forEach((item: any, i: number) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const x0 = item.x0 ?? item.xmin;
          const y0 = item.y0 ?? item.ymin;
          const x1 = item.x1 ?? item.xmax;
          const y1 = item.y1 ?? item.ymax;
          if (x0 !== undefined && y0 !== undefined && x1 !== undefined && y1 !== undefined) {
            parsedBoxes.push({
              x: Number(x0),
              y: Number(y0),
              width: Number(x1) - Number(x0),
              height: Number(y1) - Number(y0),
              label: (item.label as string) || (item.text as string) || `Item ${i + 1}`,
              score: (item.score as number) || (item.confidence as number) || 0.5,
            });
            return;
          }
        }
        // Handle array [x0,y0,x1,y1] format
        if (Array.isArray(item) && item.length >= 4) {
          parsedBoxes.push({
            x: Number(item[0]),
            y: Number(item[1]),
            width: Number(item[2]) - Number(item[0]),
            height: Number(item[3]) - Number(item[1]),
            label: `Item ${i + 1}`,
            score: 0.5,
          });
        }
      });
      return parsedBoxes;
    }

    // Handle object with bboxes property.
    // transformers.js 3.8.1 post_process_generation returns the parsed answer
    // NESTED under the task key: { '<PG>': { labels, bboxes } } (and '<OD>'
    // for object-detection). So `result.bboxes` is undefined - the real
    // container is one level down. Find it whether or not it's nested.
    if (typeof result === 'object' && result !== null) {
      const obj = result as Record<string, unknown>;
      const hasBoxes = (v: unknown): v is Record<string, unknown> =>
        typeof v === 'object' && v !== null && Array.isArray((v as Record<string, unknown>).bboxes);
      const container: Record<string, unknown> | undefined = hasBoxes(obj)
        ? obj
        : Object.values(obj).find(hasBoxes);
      if (container) {
        const labels = container.labels as string[] | undefined;
        const scores = container.scores as number[] | undefined;
        return (container.bboxes as Array<number[] | Record<string, number>>).map(
          (bbox, i) => ({
            x: Array.isArray(bbox) ? (bbox[0] ?? 0) : (bbox.xmin ?? 0),
            y: Array.isArray(bbox) ? (bbox[1] ?? 0) : (bbox.ymin ?? 0),
            width:
              (Array.isArray(bbox) ? (bbox[2] ?? 0) : (bbox.xmax ?? 0)) -
              (Array.isArray(bbox) ? (bbox[0] ?? 0) : (bbox.xmin ?? 0)),
            height:
              (Array.isArray(bbox) ? (bbox[3] ?? 0) : (bbox.ymax ?? 0)) -
              (Array.isArray(bbox) ? (bbox[1] ?? 0) : (bbox.ymin ?? 0)),
            label: labels?.[i] || `Item ${i + 1}`,
            score: scores?.[i] || 0.5,
          })
        );
      }
    }

    return undefined;
  }

  /**
   * Extract text from Florence-2 output.
   */
  private extractText(result: unknown, task: string): string | undefined {
    if (!result) return undefined;

    if (task === 'ocr') {
      // OCR may return {text: string} or {words: [...]}
      if (typeof result === 'object' && result !== null) {
        const obj = result as Record<string, unknown>;
        if (typeof obj.text === 'string') return obj.text as string;
        if (Array.isArray(obj.words)) {
          return (obj.words as Array<{ word: string }>).map((w) => w.word).join(' ');
        }
      }
    }

    if (task === 'caption' || task === 'question-answering') {
      // Returns {generated_text: string} or {answer: string}
      if (typeof result === 'object' && result !== null) {
        const obj = result as Record<string, unknown>;
        return (obj.generated_text as string) || (obj.answer as string);
      }
    }

    return undefined;
  }

  private mapTaskToResultType(task: string): VisionResult['type'] {
    switch (task) {
      case 'object-detection':
      case 'grounding':
      case 'ocr':
        return 'GROUNDING';
      case 'caption':
      case 'question-answering':
        return 'DESCRIPTION';
      default:
        return 'OCR';
    }
  }

  isWebGPU(): boolean {
    return this.usingWebGPU;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getModelId(): string {
    return MODEL_ID;
  }
}

// Export singleton instance
export const visionPipeline = new Florence2Pipeline();

// Utility: Convert canvas to blob for model input
export async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('Failed to convert canvas')),
      'image/png'
    );
  });
}

// Utility: Capture visible tab as image
export async function captureTabAsImage(_tabId?: number): Promise<HTMLCanvasElement> {
  throw new Error('Use browser.tabs.captureVisibleTab from background script');
}
