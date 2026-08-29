/**
 * Vision inference worker
 * Runs in a Web Worker to avoid blocking the main thread
 */

/// <reference lib="webworker" />

import type { BoundingBox } from '../types';

interface WorkerMessage {
  type: 'LOAD_MODEL' | 'DETECT' | 'CLEAR';
  payload?: any;
}

interface WorkerResponse {
  type: 'MODEL_READY' | 'DETECTION_RESULT' | 'ERROR';
  payload?: any;
}

let model: any = null;
let isModelReady = false;

self.addEventListener('message', async (event: MessageEvent<WorkerMessage>) => {
  const { type, payload } = event.data;

  switch (type) {
    case 'LOAD_MODEL':
      await loadModel(payload?.modelId || 'onnx-community/Florence-2-base-ft');
      break;

    case 'DETECT':
      if (!model) {
        postMessage({ type: 'ERROR', payload: 'Model not loaded' } as WorkerResponse);
        return;
      }
      await detect(payload?.image);
      break;

    case 'CLEAR':
      model = null;
      isModelReady = false;
      break;
  }
});

async function loadModel(modelId: string) {
  try {
    self.postMessage({ type: 'LOADING', payload: { modelId } } as any);

    const { pipeline } = await import('@huggingface/transformers');
    model = await pipeline('image-to-text', modelId);
    isModelReady = true;

    self.postMessage({ type: 'MODEL_READY', payload: { modelId } } as WorkerResponse);
  } catch (err) {
    self.postMessage({ type: 'ERROR', payload: err instanceof Error ? err.message : String(err) } as WorkerResponse);
  }
}

async function detect(image: HTMLImageElement | HTMLCanvasElement) {
  try {
    const startTime = performance.now();
    const result = await model(image);
    const endTime = performance.now();

    const boxes: BoundingBox[] = [];
    if (result && Array.isArray(result)) {
      result.forEach((item: any, idx: number) => {
        if (item.box && item.label) {
          boxes.push({
            id: idx + 1,
            label: item.label,
            x: item.box.xmin ?? 0,
            y: item.box.ymin ?? 0,
            width: (item.box.xmax ?? 0) - (item.box.xmin ?? 0),
            height: (item.box.ymax ?? 0) - (item.box.ymin ?? 0),
            score: item.score ?? 0.5,
          });
        }
      });
    }

    self.postMessage({
      type: 'DETECTION_RESULT',
      payload: {
        boxes,
        processingTimeMs: Math.round(endTime - startTime),
      }
    } as WorkerResponse);
  } catch (err) {
    self.postMessage({ type: 'ERROR', payload: err instanceof Error ? err.message : String(err) } as WorkerResponse);
  }
}
