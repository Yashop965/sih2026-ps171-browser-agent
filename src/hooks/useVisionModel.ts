import { useState, useCallback, useEffect, useRef } from 'react';
import type { SanitizedElement, BoundingBox } from '../types';
import { isWebGPUSupported } from '../lib/vision';

interface UseVisionModelOptions {
  modelId?: string;
  onBoxesDetected?: (boxes: BoundingBox[]) => void;
}

export function useVisionModel(options: UseVisionModelOptions = {}) {
  const { modelId = 'onnx-community/Florence-2-base-ft', onBoxesDetected } = options;
  const [isLoading, setIsLoading] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webGPUSupported] = useState(isWebGPUSupported());
  const modelRef = useRef<any>(null);
  const processorRef = useRef<any>(null);

  const loadModel = useCallback(async () => {
    if (isLoaded) return;

    setIsLoading(true);
    setError(null);

    try {
      // Dynamic import to avoid bundle issues
      const { pipeline } = await import('@huggingface/transformers');

      // Try WebGPU first, fall back to WASM
      const backend = webGPUSupported ? 'webgpu' : 'wasm';

      modelRef.current = await pipeline(
        'image-to-text',
        modelId,
        { backend }
      );

      setIsLoaded(true);
    } catch (err) {
      console.error('[VisionModel] Failed to load:', err);
      setError(err instanceof Error ? err.message : 'Failed to load vision model');
    } finally {
      setIsLoading(false);
    }
  }, [modelId, webGPUSupported, isLoaded]);

  const detectBoxes = useCallback(async (image: HTMLImageElement | HTMLCanvasElement): Promise<BoundingBox[]> => {
    if (!modelRef.current) {
      await loadModel();
    }

    if (!modelRef.current) {
      throw new Error('Model not loaded');
    }

    try {
      const result = await modelRef.current(image);
      const boxes: BoundingBox[] = [];

      // Parse Florence-2 output format
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

      onBoxesDetected?.(boxes);
      return boxes;
    } catch (err) {
      console.error('[VisionModel] Detection error:', err);
      throw err;
    }
  }, [loadModel, onBoxesDetected]);

  useEffect(() => {
    return () => {
      // Cleanup would go here
    };
  }, []);

  return {
    isLoading,
    isLoaded,
    error,
    webGPUSupported,
    loadModel,
    detectBoxes,
  };
}
