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

// Disable local model loading for safety (use HuggingFace Hub)
env.allowLocalModels = false;
env.useBrowserCache = true;

const MODEL_ID = 'microsoft/Florence-2-base-ft';

export interface VisionOptions {
  task: 'object-detection' | 'ocr' | 'caption' | 'question-answering';
  query?: string;
  maxNewTokens?: number;
  temperature?: number;
}

export interface VisionResult {
  type: 'OCR' | 'GROUNDING' | 'DESCRIPTION';
  data: any;
  boundingBoxes?: BoundingBox[];
  text?: string;
  processingTime: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  score: number;
}

class Florence2Pipeline {
  private pipeline: any = null;
  private initialized = false;
  private usingWebGPU = false;
  private loadPromise: Promise<void> | null = null;

  async initialize(options?: { useWebGPU?: boolean }): Promise<void> {
    if (this.initialized) return;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      try {
        console.log('[Vision] Initializing Florence-2...');
        
        // Check for WebGPU support
        const webgpuAvailable = typeof navigator !== 'undefined' && 
          'gpu' in navigator && 
          (navigator.gpu as GPUAdapter | null) !== null;
        
        this.usingWebGPU = options?.useWebGPU && webgpuAvailable;
        
        if (this.usingWebGPU) {
          console.log('[Vision] Using WebGPU backend');
          this.pipeline = await pipeline(
            'visual-question-answering',
            MODEL_ID,
            {
              backend: 'webgpu',
              dtype: 'fp32',
            }
          );
        } else {
          console.log('[Vision] Using WASM backend (WebGPU not available)');
          this.pipeline = await pipeline(
            'visual-question-answering',
            MODEL_ID,
            {
              backend: 'wasm',
              dtype: 'fp32',
            }
          );
        }
        
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
    options: VisionOptions
  ): Promise<VisionResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    const startTime = performance.now();
    
    try {
      let result: any;
      
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

  private async runObjectDetection(image: any): Promise<any> {
    // Florence-2 object detection task
    return this.pipeline({
      image,
      task: '<OD>',
    });
  }

  private async runOCR(image: any): Promise<any> {
    // Florence-2 OCR task
    return this.pipeline({
      image,
      task: '<OCR>',
    });
  }

  private async runCaption(image: any): Promise<any> {
    return this.pipeline({
      image,
      task: '<CAP>',
    });
  }

  private async runVQA(image: any, question: string): Promise<any> {
    return this.pipeline({
      image,
      question,
    });
  }

  private extractBoxes(result: any): BoundingBox[] | undefined {
    if (!result || !result.bboxes) return undefined;
    
    return result.bboxes.map((bbox: number[], i: number) => ({
      x: bbox[0],
      y: bbox[1],
      width: bbox[2] - bbox[0],
      height: bbox[3] - bbox[1],
      label: result.labels?.[i] || `Item ${i}`,
      score: result.scores?.[i] || 0.5,
    }));
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
  // This will be called from background context where browser API is available
  throw new Error('Use browser.tabs.captureVisibleTab from background script');
}
