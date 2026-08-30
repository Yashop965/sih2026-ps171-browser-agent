/**
 * Vision Inference Worker
 *
 * Runs Florence-2 inference in a Web Worker to avoid blocking the main thread.
 * Features:
 * - Tensor memory pool integration
 * - IndexedDB caching for lazy loading
 * - WebGPU primary / WASM fallback for Firefox
 * - Graceful error handling and fallback
 */

/// <reference lib="webworker" />

import type { BoundingBox } from '../types';
import { tensorMemoryPool } from '../lib/vision/memory';
import { detectHardwareCapabilities, selectQuantizationMode } from '../lib/model';
import type { QuantizationMode } from '../lib/model';

interface WorkerMessage {
  type: 'LOAD_MODEL' | 'DETECT' | 'CLEAR' | 'MEMORY_STATS' | 'GET_CACHE';
  payload?: {
    modelId?: string;
    image?: HTMLImageElement | HTMLCanvasElement;
    taskId?: string;
  };
}

interface WorkerResponse {
  type: 'MODEL_READY' | 'DETECTION_RESULT' | 'ERROR' | 'LOADING_PROGRESS' | 'MEMORY_STATS' | 'CACHE_INFO';
  payload?: unknown;
}

interface ModelCacheEntry {
  modelId: string;
  backend: 'webgpu' | 'wasm';
  dtype: QuantizationMode;
  loadedAt: number;
  accessCount: number;
}

// Module-level state
let model: Awaited<ReturnType<typeof import('@huggingface/transformers').pipeline>> | null = null;
let isModelReady = false;
let currentBackend: 'webgpu' | 'wasm' = 'wasm';
let currentDtype: QuantizationMode = 'fp32';
let loadPromise: Promise<void> | null = null;

// IndexedDB cache
const DB_NAME = 'vision_model_cache';
const DB_VERSION = 1;
const STORE_NAME = 'models';

self.addEventListener('message', async (event: MessageEvent<WorkerMessage>) => {
  const { type, payload } = event.data;

  try {
    switch (type) {
      case 'LOAD_MODEL':
        await loadModel(payload?.modelId || 'microsoft/Florence-2-base-ft');
        break;

      case 'DETECT':
        if (!model) {
          postMessage({
            type: 'ERROR',
            payload: 'Model not loaded. Call LOAD_MODEL first.',
          } as WorkerResponse);
          return;
        }
        await detect(payload?.image);
        break;

      case 'CLEAR':
        await clearModel();
        break;

      case 'MEMORY_STATS':
        postMessage({
          type: 'MEMORY_STATS',
          payload: tensorMemoryPool.getStats(),
        } as WorkerResponse);
        break;

      case 'GET_CACHE':
        await cacheModel();
        break;

      default:
        postMessage({
          type: 'ERROR',
          payload: `Unknown message type: ${type}`,
        } as WorkerResponse);
    }
  } catch (error) {
    postMessage({
      type: 'ERROR',
      payload: error instanceof Error ? error.message : String(error),
    } as WorkerResponse);
  }
});

/**
 * Load the Florence-2 model with intelligent fallback
 */
async function loadModel(modelId: string): Promise<void> {
  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = (async () => {
    try {
      // Detect hardware capabilities
      const hardware = detectHardwareCapabilities();
      currentBackend = hardware.webgpuSupported ? 'webgpu' : 'wasm';
      currentDtype = selectQuantizationMode(hardware);

      self.postMessage({
        type: 'LOADING_PROGRESS',
        payload: {
          stage: 'detecting_hardware',
          backend: currentBackend,
          dtype: currentDtype,
        },
      } as WorkerResponse);

      // Check IndexedDB cache first
      const cachedModel = await getCachedModel(modelId);
      if (cachedModel) {
        self.postMessage({
          type: 'LOADING_PROGRESS',
          payload: { stage: 'using_cache' },
        } as WorkerResponse);
      }

      self.postMessage({
        type: 'LOADING_PROGRESS',
        payload: {
          stage: 'downloading',
          modelId,
          backend: currentBackend,
          dtype: currentDtype,
        },
      } as WorkerResponse);

      // Dynamic import to avoid bundling issues
      const { pipeline, env } = await import('@huggingface/transformers');

      // Configure environment
      env.allowLocalModels = false;
      env.useBrowserCache = true;

      // Load model with selected backend and dtype
      model = await pipeline('image-to-text', modelId, {
        backend: currentBackend,
        dtype: currentDtype,
      });

      isModelReady = true;

      // Cache the model in IndexedDB
      await cacheModelEntry(modelId, currentBackend, currentDtype);

      self.postMessage({
        type: 'MODEL_READY',
        payload: {
          modelId,
          backend: currentBackend,
          dtype: currentDtype,
          memoryStats: tensorMemoryPool.getStats(),
        },
      } as WorkerResponse);

    } catch (error) {
      console.error('[VisionWorker] Failed to load model:', error);

      // Attempt fallback if WebGPU failed
      if (currentBackend === 'webgpu') {
        console.warn('[VisionWorker] Attempting WASM fallback...');
        try {
          const { pipeline } = await import('@huggingface/transformers');
          model = await pipeline('image-to-text', modelId, {
            backend: 'wasm',
            dtype: 'fp32',
          });
          currentBackend = 'wasm';
          currentDtype = 'fp32';
          isModelReady = true;

          self.postMessage({
            type: 'MODEL_READY',
            payload: {
              modelId,
              backend: 'wasm',
              dtype: 'fp32',
              fallback: true,
            },
          } as WorkerResponse);
          return;
        } catch (fallbackError) {
          console.error('[VisionWorker] WASM fallback also failed:', fallbackError);
        }
      }

      throw error;
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
}

/**
 * Run detection on the provided image
 */
async function detect(image: HTMLImageElement | HTMLCanvasElement): Promise<void> {
  if (!model) {
    throw new Error('Model not loaded');
  }

  const startTime = performance.now();

  try {
    self.postMessage({
      type: 'LOADING_PROGRESS',
      payload: { stage: 'inference', progress: 0 },
    } as WorkerResponse);

    // Allocate tensor memory for input
    const tensorId = tensorMemoryPool.allocate([
      image.naturalHeight ?? image.height,
      image.naturalWidth ?? image.width,
      3, // RGB channels
    ], 'input_tensor');

    // Run inference
    const result = await model(image);
    const endTime = performance.now();

    // Free input tensor
    tensorMemoryPool.free(tensorId);

    // Extract bounding boxes
    const boxes = extractBoxes(result);

    self.postMessage({
      type: 'DETECTION_RESULT',
      payload: {
        boxes,
        processingTimeMs: Math.round(endTime - startTime),
        memoryStats: tensorMemoryPool.getStats(),
      },
    } as WorkerResponse);

  } catch (error) {
    console.error('[VisionWorker] Detection error:', error);
    throw error;
  }
}

/**
 * Extract bounding boxes from Florence-2 output
 */
function extractBoxes(result: unknown): BoundingBox[] {
  const boxes: BoundingBox[] = [];

  if (!result) return boxes;

  // Handle array format (traditional detection output)
  if (Array.isArray(result)) {
    result.forEach((item: unknown, idx: number) => {
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        if (obj.box && obj.label) {
          const box = obj.box as Record<string, number>;
          boxes.push({
            id: idx + 1,
            label: String(obj.label),
            x: box.xmin ?? 0,
            y: box.ymin ?? 0,
            width: (box.xmax ?? 0) - (box.xmin ?? 0),
            height: (box.ymax ?? 0) - (box.ymin ?? 0),
            score: typeof obj.score === 'number' ? obj.score : 0.5,
          });
        }
      }
    });
    return boxes;
  }

  // Handle object format (Florence-2 grounding output)
  if (typeof result === 'object') {
    const obj = result as Record<string, unknown>;

    // Check for bboxes array
    if (Array.isArray(obj.bboxes)) {
      obj.bboxes.forEach((bbox: unknown, i: number) => {
        if (Array.isArray(bbox)) {
          const coords = bbox as number[];
          if (coords.length >= 4) {
            boxes.push({
              id: i + 1,
              label: Array.isArray(obj.labels) ? String(obj.labels[i]) : `Item ${i + 1}`,
              x: coords[0],
              y: coords[1],
              width: coords[2] - coords[0],
              height: coords[3] - coords[1],
              score: Array.isArray(obj.scores) ? (obj.scores[i] as number) : 0.5,
            });
          }
        } else if (bbox && typeof bbox === 'object') {
          const b = bbox as { x0: number; y0: number; x1: number; y1: number };
          boxes.push({
            id: i + 1,
            label: Array.isArray(obj.labels) ? String(obj.labels[i]) : `Item ${i + 1}`,
            x: b.x0,
            y: b.y0,
            width: b.x1 - b.x0,
            height: b.y1 - b.y0,
            score: Array.isArray(obj.scores) ? (obj.scores[i] as number) : 0.5,
          });
        }
      });
    }

    // Check for coordinates array
    if (Array.isArray(obj.coordinates) && boxes.length === 0) {
      obj.coordinates.forEach((coords: unknown, i: number) => {
        if (Array.isArray(coords)) {
          const c = coords as number[];
          if (c.length >= 4) {
            boxes.push({
              id: i + 1,
              label: Array.isArray(obj.labels) ? String(obj.labels[i]) : `Item ${i + 1}`,
              x: c[0],
              y: c[1],
              width: c[2] - c[0],
              height: c[3] - c[1],
              score: Array.isArray(obj.scores) ? (obj.scores[i] as number) : 0.5,
            });
          }
        }
      });
    }
  }

  return boxes;
}

/**
 * Clear model and free resources
 */
async function clearModel(): Promise<void> {
  model = null;
  isModelReady = false;
  tensorMemoryPool.clear();
  loadPromise = null;

  self.postMessage({
    type: 'MODEL_READY',
    payload: { modelId: null, cleared: true },
  } as WorkerResponse);
}

/**
 * Cache model metadata in IndexedDB
 */
async function cacheModelEntry(
  modelId: string,
  backend: 'webgpu' | 'wasm',
  dtype: QuantizationMode,
): Promise<void> {
  try {
    const db = await openDatabase();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    const entry: ModelCacheEntry = {
      modelId,
      backend,
      dtype,
      loadedAt: Date.now(),
      accessCount: 1,
    };

    const key = `${modelId}_${backend}_${dtype}`;
    await store.put(entry, key);
  } catch (error) {
    console.warn('[VisionWorker] Failed to cache model metadata:', error);
  }
}

/**
 * Get cached model metadata
 */
async function getCachedModel(modelId: string): Promise<ModelCacheEntry | null> {
  try {
    const db = await openDatabase();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);

    // Try all combinations
    const backends: ('webgpu' | 'wasm')[] = ['webgpu', 'wasm'];
    const dtypes: QuantizationMode[] = ['fp32', 'fp16', 'q4'];

    for (const backend of backends) {
      for (const dtype of dtypes) {
        const key = `${modelId}_${backend}_${dtype}`;
        const result = await store.get(key) as ModelCacheEntry | undefined;
        if (result) {
          return result;
        }
      }
    }
  } catch (error) {
    console.warn('[VisionWorker] Failed to read cache:', error);
  }
  return null;
}

/**
 * Cache model for future use
 */
async function cacheModel(): Promise<void> {
  if (!model) return;

  try {
    const db = await openDatabase();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    // Increment access count for all entries
    const cursor = await store.openCursor();
    while (cursor) {
      cursor.value.accessCount++;
      await cursor.update();
      cursor.advance();
    }

    self.postMessage({
      type: 'CACHE_INFO',
      payload: { cached: true },
    } as WorkerResponse);
  } catch (error) {
    console.warn('[VisionWorker] Failed to update cache:', error);
  }
}

/**
 * Open IndexedDB database
 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(new Error('Failed to open database'));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}
