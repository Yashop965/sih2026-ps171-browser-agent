/**
 * Florence-2 Vision Inference Module
 *
 * Uses Transformers.js for on-device vision:
 * - Object detection and grounding
 * - Optical Character Recognition (OCR)
 * - Visual question answering
 * - Captioning
 *
 * Model: microsoft/Florence-2-base-ft (231M parameters, ~180MB)
 * Runtime: WebGPU (primary) → WASM fallback for Firefox
 */

import type { Pipeline } from '@huggingface/transformers';

// Florence-2 output formats per task
// Object Detection: { [x0, y0, x1, y1], [x0, y0, x1, y1], ... } or { bboxes: [...] }
// OCR: { text: string, words: [{word, bbox: [x0,y0,x1,y1]}] }
// Caption: { generated_text: string }
// VQA: { answer: string }

const MODEL_ID = 'microsoft/Florence-2-base-ft';

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  score?: number;
}

export interface VisionOptions {
  task: 'object-detection' | 'ocr' | 'caption' | 'question-answering';
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

class Florence2Pipeline {
  private pipeline: Pipeline | null = null;
  private initialized = false;
  private usingWebGPU = false;
  private loadPromise: Promise<void> | null = null;

  /** Check WebGPU availability */
  static isWebGPUSupported(): boolean {
    if (typeof navigator === 'undefined') return false;
    return 'gpu' in navigator && (navigator as Navigator & { gpu?: GPUAdapter }).gpu !== null;
  }

  async initialize(config: VisionModelConfig = {
    modelId: MODEL_ID,
    backend: Florence2Pipeline.isWebGPUSupported() ? 'webgpu' : 'wasm',
    dtype: 'q4',
  }): Promise<void> {
    if (this.initialized) return;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      try {
        const { pipeline, env } = await import('@huggingface/transformers');

        // Configure environment
        env.allowLocalModels = false;
        env.useBrowserCache = true;

        // Set dtype based on config
        const dtypeMap = { 'fp32': 'fp32', 'fp16': 'fp16', 'q4': 'q4' } as const;
        const selectedDtype = dtypeMap[config.dtype];

        // Detect WebGPU support
        const webgpuSupported = Florence2Pipeline.isWebGPUSupported();
        const backend = config.backend === 'webgpu' && webgpuSupported
          ? 'webgpu'
          : 'wasm';

        this.usingWebGPU = backend === 'webgpu';

        console.log(`[Vision] Initializing ${config.modelId} with ${backend} backend...`);

        this.pipeline = await pipeline('image-to-text', config.modelId, {
          device: backend === 'webgpu' ? 'webgpu' : 'wasm',
          dtype: selectedDtype,
        });

        this.initialized = true;
        console.log(`[Vision] Florence-2 initialized (${backend}, ${config.dtype})`);
      } catch (error) {
        console.error('[Vision] Failed to initialize:', error);
        throw error;
      } finally {
        this.loadPromise = null;
      }
    })();

    return this.loadPromise;
  }

  async processImage(
    image: HTMLCanvasElement | HTMLImageElement | string,
    options: VisionOptions
  ): Promise<VisionResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    const startTime = performance.now();

    try {
      let result: unknown;

      switch (options.task) {
        case 'object-detection':
          result = await this.runObjectDetection(image);
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
    }
  }

  private async runObjectDetection(image: HTMLCanvasElement | HTMLImageElement | string): Promise<unknown> {
    if (!this.pipeline) throw new Error('Pipeline not initialized');
    return this.pipeline({
      image,
      task: '<OD>',
    });
  }

  private async runOCR(image: HTMLCanvasElement | HTMLImageElement | string): Promise<unknown> {
    if (!this.pipeline) throw new Error('Pipeline not initialized');
    return this.pipeline({
      image,
      task: '<OCR>',
    });
  }

  private async runCaption(image: HTMLCanvasElement | HTMLImageElement | string): Promise<unknown> {
    if (!this.pipeline) throw new Error('Pipeline not initialized');
    return this.pipeline({
      image,
      task: '<CAP>',
    });
  }

  private async runVQA(image: HTMLCanvasElement | HTMLImageElement | string, question: string): Promise<unknown> {
    if (!this.pipeline) throw new Error('Pipeline not initialized');
    return this.pipeline({
      image,
      task: '<VQA>',
      question,
    });
  }

  /**
   * Extract bounding boxes from Florence-2 output.
   * Florence-2 returns coordinates as [x0, y0, x1, y1] or array of such arrays.
   */
  private extractBoxes(result: unknown, task: string): BoundingBox[] | undefined {
    if (!result) return undefined;

    // Handle array of {x0,y0,x1,y1} objects (common Florence-2 format)
    if (Array.isArray(result)) {
      return result.map((item: any, i: number) => {
        if (typeof item === 'object' && item !== null) {
          const x0 = typeof item.x0 !== 'undefined' ? item.x0 : item xmin;
          const y0 = typeof item.y0 !== 'undefined' ? item.y0 : item ymin;
          const x1 = typeof item.x1 !== 'undefined' ? item.x1 : item xmax;
          const y1 = typeof item.y1 !== 'undefined' ? item.y1 : item ymax;
          if (x0 !== undefined && y0 !== undefined && x1 !== undefined && y1 !== undefined) {
            return {
              x: x0,
              y: y0,
              width: x1 - x0,
              height: y1 - y0,
              label: item.label || item.text || `Item ${i + 1}`,
              score: item.score || item.confidence || 0.5,
            };
          }
        }
        // Handle array [x0,y0,x1,y1] format
        if (Array.isArray(item) && item.length >= 4) {
          return {
            x: item[0],
            y: item[1],
            width: item[2] - item[0],
            height: item[3] - item[1],
            label: `Item ${i + 1}`,
            score: 0.5,
          };
        }
        return null;
      }).filter((box): box is BoundingBox => box !== null);
    }

    // Handle object with bboxes property
    if (typeof result === 'object' && result !== null) {
      const obj = result as Record<string, unknown>;
      if (Array.isArray(obj.bboxes)) {
        return obj.bboxes.map((bbox: any, i: number) => ({
          x: bbox[0] ?? bbox.xmin ?? 0,
          y: bbox[1] ?? bbox.ymin ?? 0,
          width: (bbox[2] ?? bbox.xmax ?? 0) - (bbox[0] ?? bbox.xmin ?? 0),
          height: (bbox[3] ?? bbox.ymax ?? 0) - (bbox[1] ?? bbox.ymin ?? 0),
          label: obj.labels?.[i] || `Item ${i + 1}`,
          score: obj.scores?.[i] || 0.5,
        }));
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
          return (obj.words as any[]).map((w: any) => w.word).join(' ');
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
export async function captureTabAsImage(tabId?: number): Promise<HTMLCanvasElement> {
  throw new Error('Use browser.tabs.captureVisibleTab from background script');
}
