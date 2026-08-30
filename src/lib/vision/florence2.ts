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

/**
 * Florence-2 output format for grounding/detection tasks.
 * Returns normalized coordinates as {x0, y0, x1, y1}.
 */
export interface Florence2GroundingOutput {
  [key: string]: unknown;
}

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

export interface PipelineConfig {
  backend: 'webgpu' | 'wasm';
  dtype: 'fp32' | 'fp16' | 'q4';
  useWebGPU: boolean;
}

class Florence2Pipeline {
  private pipeline: ReturnType<typeof pipeline> | null = null;
  private initialized = false;
  private usingWebGPU = false;
  private currentBackend: 'webgpu' | 'wasm' = 'wasm';
  private currentDtype: 'fp32' | 'fp16' | 'q4' = 'fp32';
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
        this.currentDtype = hardware.quantizationSupported ? 'fp16' : 'fp32';

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
          modelConfig,
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
    return this.pipeline!({
      image,
      task: '<OD>',
    });
  }

  private async runOCR(image: HTMLCanvasElement | HTMLImageElement | string): Promise<unknown> {
    return this.pipeline!({
      image,
      task: '<OCR>',
    });
  }

  private async runCaption(image: HTMLCanvasElement | HTMLImageElement | string): Promise<unknown> {
    return this.pipeline!.({
      image,
      task: '<CAP>',
    });
  }

  private async runVQA(image: HTMLCanvasElement | HTMLImageElement | string, question: string): Promise<unknown> {
    return this.pipeline!.({
      image,
      question,
    });
  }

  /**
   * Extract bounding boxes from Florence-2 output.
   * Florence-2 returns normalized coordinates as {x0, y0, x1, y1} objects
   * or flat arrays depending on the task.
   */
  private extractBoxes(result: unknown): BoundingBox[] | undefined {
    if (!result) return undefined;

    // Handle object detection output with explicit bboxes field
    const groundingResult = result as Florence2GroundingOutput;

    // Check for bboxes in various formats
    const rawBboxes = groundingResult.bboxes;
    if (Array.isArray(rawBboxes) && rawBboxes.length > 0) {
      // Case 1: Array of {x0, y0, x1, y1} objects
      if (typeof rawBboxes[0] === 'object' && rawBboxes[0] !== null) {
        return (rawBboxes as Array<{ x0: number; y0: number; x1: number; y1: number }>).map(
          (bbox, i) => ({
            x: bbox.x0,
            y: bbox.y0,
            width: bbox.x1 - bbox.x0,
            height: bbox.y1 - bbox.y0,
            label: groundingResult.labels?.[i] || `Item ${i}`,
            score: groundingResult.scores?.[i] ?? 0.5,
          }),
        );
      }

      // Case 2: Array of [x0, y0, x1, y1] arrays
      return (rawBboxes as number[][]).map((bbox, i) => ({
        x: bbox[0],
        y: bbox[1],
        width: bbox[2] - bbox[0],
        height: bbox[3] - bbox[1],
        label: groundingResult.labels?.[i] || `Item ${i}`,
        score: groundingResult.scores?.[i] ?? 0.5,
      }));
    }

    // Handle flat coordinates format (common in Florence-2 OCR/grounding)
    const coordinates = groundingResult.coordinates;
    if (Array.isArray(coordinates)) {
      return (coordinates as number[][]).map((coords, i) => ({
        x: coords[0],
        y: coords[1],
        width: coords[2] - coords[0],
        height: coords[3] - coords[1],
        label: groundingResult.labels?.[i] || `Item ${i}`,
        score: groundingResult.scores?.[i] ?? 0.5,
      }));
    }

    // Handle single bbox as object
    const singleBbox = groundingResult.bbox;
    if (singleBbox && typeof singleBbox === 'object') {
      return [{
        x: (singleBbox as { x0: number; y0: number; x1: number; y1: number }).x0,
        y: (singleBbox as { x0: number; y0: number; x1: number; y1: number }).y0,
        width: (singleBbox as { x0: number; y0: number; x1: number; y1: number }).x1 -
               (singleBbox as { x0: number; y0: number; x1: number; y1: number }).x0,
        height: (singleBbox as { x0: number; y0: number; x1: number; y1: number }).y1 -
                (singleBbox as { x0: number; y0: number; x1: number; y1: number }).y0,
        label: groundingResult.labels?.[0] || 'Item',
        score: groundingResult.scores?.[0] ?? 0.5,
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

  getBackend(): 'webgpu' | 'wasm' {
    return this.currentBackend;
  }

  getDtype(): 'fp32' | 'fp16' | 'q4' {
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
