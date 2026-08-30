/**
 * Florence-2 Vision Inference Module
 *
 * Uses Transformers.js with WebGPU acceleration for:
 * - Object detection and grounding
 * - Optical Character Recognition (OCR)
 * - Visual question answering
 * - Captioning
 *
 * Model: microsoft/Florence-2-base-ft (231M parameters)
 * Runtime: ONNX Runtime Web with WebGPU backend
 */

import { pipeline, env } from '@huggingface/transformers';
import { getAvailableBackends } from '../vision';
import { detectHardwareCapabilities } from '../model';
import type { BoundingBox } from '../../types';

// Disable local model loading for safety (use HuggingFace Hub)
env.allowLocalModels = false;
env.useBrowserCache = true;

const MODEL_ID = 'microsoft/Florence-2-base-ft';

export interface VisionOptions {
  task: 'object-detection' | 'ocr' | 'caption' | 'question-answering';
  query?: string;
  maxNewTokens?: number;
  temperature?: number;
  useQuantized?: boolean;
}

export interface VisionResult {
  type: 'OCR' | 'GROUNDING' | 'DESCRIPTION';
  data: unknown;
  boundingBoxes?: BoundingBox[];
  text?: string;
  processingTime: number;
}

export type BackendType = 'webgpu' | 'wasm';
export type QuantizationType = 'fp32' | 'fp16' | 'q4';

class Florence2Pipeline {
  private pipeline: any = null;
  private initialized = false;
  private usingWebGPU = false;
  private currentBackend: BackendType = 'wasm';
  private currentDtype: QuantizationType = 'fp32';
  private loadPromise: Promise<void> | null = null;
  private options?: VisionOptions;

  async initialize(options?: { useWebGPU?: boolean }): Promise<void> {
    if (this.initialized) return;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      try {
        console.log('[Vision] Initializing Florence-2...');

        // Detect hardware capabilities
        const hardware = detectHardwareCapabilities();
        this.usingWebGPU = options?.useWebGPU ?? hardware.webgpuSupported;
        this.currentBackend = this.usingWebGPU ? 'webgpu' : 'wasm';

        // Select dtype based on hardware
        this.currentDtype = hardware.hasFP16Support ? 'fp16' : 'fp32';

        const modelConfig = {
          backend: this.currentBackend,
          dtype: this.currentDtype,
        };

        if (this.usingWebGPU) {
          console.log(`[Vision] Using WebGPU backend with ${this.currentDtype} quantization`);
        } else {
          console.log(`[Vision] Using WASM backend with ${this.currentDtype} (Firefox/WASM fallback)`);
        }

        this.pipeline = await pipeline(
          'image-to-text',
          MODEL_ID,
          modelConfig as any,
        );

        this.initialized = true;
        console.log('[Vision] Florence-2 initialized successfully');
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
    options: VisionOptions,
  ): Promise<VisionResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    const startTime = performance.now();
    this.options = options;

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
        boundingBoxes: this.extractBoxes(result),
        processingTime,
      };
    } catch (error) {
      console.error('[Vision] Processing failed:', error);
      throw error;
    }
  }

  private async runObjectDetection(image: HTMLCanvasElement | HTMLImageElement | string): Promise<unknown> {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const result = await this.pipeline!({
      image,
      task: '<OD>',
    });
    return result;
  }

  private async runOCR(image: HTMLCanvasElement | HTMLImageElement | string): Promise<unknown> {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const result = await this.pipeline!({
      image,
      task: '<OCR>',
    });
    return result;
  }

  private async runCaption(image: HTMLCanvasElement | HTMLImageElement | string): Promise<unknown> {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const result = await this.pipeline!({
      image,
      task: '<CAP>',
    });
    return result;
  }

  private async runVQA(image: HTMLCanvasElement | HTMLImageElement | string, question: string): Promise<unknown> {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const result = await this.pipeline!({
      image,
      question,
    });
    return result;
  }

  /**
   * Extract bounding boxes from Florence-2 output.
   * Florence-2 returns normalized coordinates as {x0, y0, x1, y1} objects
   * or flat arrays depending on the task.
   */
  private extractBoxes(result: unknown): BoundingBox[] | undefined {
    if (!result) return undefined;

    // Handle object detection output with explicit bboxes field
    const obj = result as Record<string, unknown>;

    // Check for bboxes in various formats
    const rawBboxes = obj.bboxes;
    if (Array.isArray(rawBboxes) && rawBboxes.length > 0) {
      // Case 1: Array of {x0, y0, x1, y1} objects
      if (typeof rawBboxes[0] === 'object' && rawBboxes[0] !== null && !Array.isArray(rawBboxes[0])) {
        const typedBboxes = rawBboxes as Array<{ x0: number; y0: number; x1: number; y1: number }>;
        return typedBboxes.map((bbox, i) => ({
          x: bbox.x0,
          y: bbox.y0,
          width: bbox.x1 - bbox.x0,
          height: bbox.y1 - bbox.y0,
          label: Array.isArray(obj.labels) ? String(obj.labels[i]) : `Item ${i}`,
          score: Array.isArray(obj.scores) ? (obj.scores[i] as number) ?? 0.5 : 0.5,
        }));
      }

      // Case 2: Array of [x0, y0, x1, y1] arrays
      const arrayBboxes = rawBboxes as number[][];
      return arrayBboxes.map((bbox, i) => ({
        x: bbox[0],
        y: bbox[1],
        width: bbox[2] - bbox[0],
        height: bbox[3] - bbox[1],
        label: Array.isArray(obj.labels) ? String(obj.labels[i]) : `Item ${i}`,
        score: Array.isArray(obj.scores) ? (obj.scores[i] as number) ?? 0.5 : 0.5,
      }));
    }

    // Handle flat coordinates format (common in Florence-2 OCR/grounding)
    const coordinates = obj.coordinates;
    if (Array.isArray(coordinates)) {
      return (coordinates as number[][]).map((coords, i) => ({
        x: coords[0],
        y: coords[1],
        width: coords[2] - coords[0],
        height: coords[3] - coords[1],
        label: Array.isArray(obj.labels) ? String(obj.labels[i]) : `Item ${i}`,
        score: Array.isArray(obj.scores) ? (obj.scores[i] as number) ?? 0.5 : 0.5,
      }));
    }

    // Handle single bbox as object
    const singleBbox = obj.bbox;
    if (singleBbox && typeof singleBbox === 'object') {
      const b = singleBbox as { x0: number; y0: number; x1: number; y1: number };
      return [{
        x: b.x0,
        y: b.y0,
        width: b.x1 - b.x0,
        height: b.y1 - b.y0,
        label: Array.isArray(obj.labels) ? String(obj.labels[0]) : 'Item',
        score: Array.isArray(obj.scores) ? (obj.scores[0] as number) ?? 0.5 : 0.5,
      }];
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

  getBackend(): BackendType {
    return this.currentBackend;
  }

  getDtype(): QuantizationType {
    return this.currentDtype;
  }

  /**
   * Graceful fallback from WebGPU to WASM for Firefox compatibility
   */
  async fallbackToWasm(): Promise<void> {
    console.warn('[Vision] Falling back to WASM backend');
    this.usingWebGPU = false;
    this.currentBackend = 'wasm';
    this.currentDtype = 'fp32';
    this.initialized = false;
    this.pipeline = null;
    await this.initialize();
  }
}

// Export singleton instance
export const visionPipeline = new Florence2Pipeline();

// Utility: Convert canvas to blob for model input
export async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('Failed to convert canvas')),
      'image/png',
    );
  });
}

// Utility: Capture visible tab as image
export async function captureTabAsImage(tabId?: number): Promise<HTMLCanvasElement> {
  // This will be called from background context where browser API is available
  throw new Error('Use browser.tabs.captureVisibleTab from background script');
}
