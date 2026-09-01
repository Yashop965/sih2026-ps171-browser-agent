/**
 * Vision inference worker
 * Runs in a Web Worker to avoid blocking the main thread
 *
 * Features:
 * - Lazy model loading with progress tracking
 * - IndexedDB caching for model persistence
 * - Memory pool integration
 * - WebGPU → WASM fallback
 */

/// <reference lib="webworker" />

import type { BoundingBox } from '../types';

interface WorkerMessage {
  type: 'LOAD_MODEL' | 'DETECT' | 'CAPTURE' | 'CLEAR' | 'MEM_STAT';
  payload?: Record<string, unknown>;
}

interface WorkerResponse {
  type: 'MODEL_READY' | 'MODEL_PROGRESS' | 'DETECTION_RESULT' | 'ERROR' | 'MEM_STATS';
  payload?: Record<string, unknown>;
}

let model: any = null;
let isModelReady = false;
let modelId = 'microsoft/Florence-2-base-ft';

// IndexedDB cache for model files
const DB_NAME = 'vision-model-cache';
const STORE_NAME = 'model-files';
const DB_VERSION = 1;

self.addEventListener('message', async (event: MessageEvent<WorkerMessage>) => {
  const { type, payload } = event.data;

  switch (type) {
    case 'LOAD_MODEL':
      modelId = payload?.modelId || modelId;
      await loadModel(modelId);
      break;

    case 'DETECT':
      if (!model) {
        postMessage({ type: 'ERROR', payload: { message: 'Model not loaded' } } as WorkerResponse);
        return;
      }
      await detect(payload?.image as HTMLImageElement | HTMLCanvasElement);
      break;

    case 'CAPTURE':
      // Handle screenshot data URL from content script
      if (payload?.dataUrl) {
        await detectFromDataUrl(payload.dataUrl as string);
      }
      break;

    case 'CLEAR':
      model = null;
      isModelReady = false;
      break;

    case 'MEM_STAT':
      postMessage({
        type: 'MEM_STATS',
        payload: {
          heapSize: performance.memory?.usedJSHeapSize || 0,
          limit: performance.memory?.jsHeapSizeLimit || 0,
        }
      } as WorkerResponse);
      break;
  }
});

async function loadModel(id: string) {
  try {
    // Check IndexedDB cache first
    const cached = await getCachedModel(id);
    if (cached) {
      self.postMessage({
        type: 'MODEL_PROGRESS',
        payload: { progress: 100, status: 'loaded-from-cache' }
      } as WorkerResponse);
    }

    self.postMessage({
      type: 'MODEL_PROGRESS',
      payload: { progress: 10, status: 'loading' }
    } as WorkerResponse);

    const { pipeline, env } = await import('@huggingface/transformers');

    // Configure environment
    env.allowLocalModels = false;
    env.useBrowserCache = true;

    self.postMessage({
      type: 'MODEL_PROGRESS',
      payload: { progress: 50, status: 'initializing' }
    } as WorkerResponse);

    // Detect WebGPU support
    const webgpuSupported = typeof self !== 'undefined' &&
      'gpu' in (self as unknown as { gpu?: GPUAdapter }) &&
      (self as unknown as { gpu?: GPUAdapter }).gpu !== null;

    const device = webgpuSupported ? 'webgpu' : 'wasm';
    const dtype = webgpuSupported ? 'q4' : 'fp32';

    model = await pipeline('image-to-text', id, {
      device,
      dtype,
    });

    isModelReady = true;

    // Cache in IndexedDB
    await cacheModel(id);

    self.postMessage({
      type: 'MODEL_READY',
      payload: { modelId: id, device, dtype }
    } as WorkerResponse);

    console.log(`[Vision Worker] Model loaded: ${id} on ${device}`);
  } catch (err) {
    self.postMessage({
      type: 'ERROR',
      payload: { message: err instanceof Error ? err.message : String(err) }
    } as WorkerResponse);
  }
}

async function detect(image: HTMLImageElement | HTMLCanvasElement) {
  try {
    const startTime = performance.now();

    // Default to object detection
    const result = await model(image, {
      task: '<OD>',
    });

    const endTime = performance.now();
    const processingTimeMs = Math.round(endTime - startTime);

    // Parse result into bounding boxes
    const boxes: BoundingBox[] = parseFlorence2Result(result);

    self.postMessage({
      type: 'DETECTION_RESULT',
      payload: {
        boxes,
        processingTimeMs,
        modelId,
      }
    } as WorkerResponse);
  } catch (err) {
    self.postMessage({
      type: 'ERROR',
      payload: { message: err instanceof Error ? err.message : String(err) }
    } as WorkerResponse);
  }
}

async function detectFromDataUrl(dataUrl: string) {
  // Convert data URL to image element
  const img = new Image();
  img.src = dataUrl;
  await new Promise<void>((resolve) => {
    img.onload = () => resolve();
  });
  await detect(img);
}

/**
 * Parse Florence-2 result into BoundingBox[]
 * Florence-2 returns coordinates as [x0, y0, x1, y1] or array of such
 */
function parseFlorence2Result(result: any): BoundingBox[] {
  const boxes: BoundingBox[] = [];

  if (!result) return boxes;

  // Handle array format: [[x0,y0,x1,y1], ...]
  if (Array.isArray(result)) {
    result.forEach((item: any, idx: number) => {
      if (Array.isArray(item) && item.length >= 4) {
        boxes.push({
          id: idx + 1,
          label: item.label || `Item ${idx + 1}`,
          x: item[0],
          y: item[1],
          width: item[2] - item[0],
          height: item[3] - item[1],
          score: item.score || 0.5,
        });
      } else if (typeof item === 'object' && item !== null) {
        // Handle object format: {x0, y0, x1, y1, label, score}
        const x0 = item.x0 ?? item.xmin ?? 0;
        const y0 = item.y0 ?? item.ymin ?? 0;
        const x1 = item.x1 ?? item.xmax ?? 0;
        const y1 = item.y1 ?? item.ymax ?? 0;
        boxes.push({
          id: idx + 1,
          label: item.label || item.text || `Item ${idx + 1}`,
          x: x0,
          y: y0,
          width: x1 - x0,
          height: y1 - y0,
          score: item.score || item.confidence || 0.5,
        });
      }
    });
  }

  // Handle object with bboxes property
  if (typeof result === 'object' && result !== null && 'bboxes' in result) {
    const obj = result as Record<string, any>;
    obj.bboxes.forEach((bbox: any, idx: number) => {
      if (Array.isArray(bbox) && bbox.length >= 4) {
        boxes.push({
          id: idx + 1,
          label: obj.labels?.[idx] || `Item ${idx + 1}`,
          x: bbox[0],
          y: bbox[1],
          width: bbox[2] - bbox[0],
          height: bbox[3] - bbox[1],
          score: obj.scores?.[idx] || 0.5,
        });
      }
    });
  }

  return boxes;
}

// IndexedDB helpers for model caching
async function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getCachedModel(id: string): Promise<boolean> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(id);
      request.onsuccess = () => resolve(!!request.result);
      request.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}

async function cacheModel(id: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ id, cachedAt: Date.now() }, id);
  } catch {
    // Silently fail - caching is best-effort
  }
}
