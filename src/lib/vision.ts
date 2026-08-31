/**
 * Vision Utilities
 * 
 * Helper functions for vision model integration
 */

/**
 * Check if WebGPU is supported in the current browser
 */
export function isWebGPUSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  
  return 'gpu' in navigator && Boolean((navigator as any).gpu);
}

/**
 * Get available backends for inference
 */
export function getAvailableBackends(): string[] {
  const backends: string[] = [];
  
  if (isWebGPUSupported()) {
    backends.push('webgpu');
  }
  
  // WASM is always available as fallback
  backends.push('wasm');
  
  return backends;
}

/**
 * Convert canvas to base64 data URL
 */
export async function canvasToDataURL(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const dataURL = canvas.toDataURL('image/png');
      resolve(dataURL);
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Capture visible tab as canvas (to be called from background context)
 */
export async function captureVisibleTab(_windowId?: number): Promise<HTMLCanvasElement> {
  // This needs to be called from background script context
  throw new Error('Use browser.tabs.captureVisibleTab from background context');
}

/**
 * Create a temporary canvas from an image element
 */
export function imageToCanvas(image: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');
  
  ctx.drawImage(image, 0, 0);
  
  return canvas;
}

/**
 * Resize canvas to fit max dimensions
 */
export function resizeCanvas(canvas: HTMLCanvasElement, maxDim: number): HTMLCanvasElement {
  const { width, height } = canvas;
  
  if (width <= maxDim && height <= maxDim) {
    return canvas;
  }
  
  const scale = maxDim / Math.max(width, height);
  const newWidth = Math.round(width * scale);
  const newHeight = Math.round(height * scale);
  
  const newCanvas = document.createElement('canvas');
  newCanvas.width = newWidth;
  newCanvas.height = newHeight;
  
  const ctx = newCanvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');
  
  ctx.drawImage(canvas, 0, 0, newWidth, newHeight);
  
  return newCanvas;
}

/**
 * Normalize bounding boxes to percentage coordinates
 */
export function normalizeBoxes(
  boxes: Array<{ x: number; y: number; width: number; height: number }>,
  imageWidth: number,
  imageHeight: number
): Array<{ x: number; y: number; width: number; height: number }> {
  return boxes.map(box => ({
    x: box.x / imageWidth,
    y: box.y / imageHeight,
    width: box.width / imageWidth,
    height: box.height / imageHeight,
  }));
}

/**
 * Calculate Intersection over Union (IoU) between two boxes
 */
export function calculateIoU(
  box1: { x: number; y: number; width: number; height: number },
  box2: { x: number; y: number; width: number; height: number }
): number {
  const x1 = Math.max(box1.x, box2.x);
  const y1 = Math.max(box1.y, box2.y);
  const x2 = Math.min(box1.x + box1.width, box2.x + box2.width);
  const y2 = Math.min(box1.y + box1.height, box2.y + box2.height);
  
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const area1 = box1.width * box1.height;
  const area2 = box2.width * box2.height;
  const union = area1 + area2 - intersection;
  
  return union > 0 ? intersection / union : 0;
}

/**
 * Non-Maximum Suppression (NMS) to remove overlapping boxes
 */
export function nonMaxSuppression(
  boxes: Array<{ id: number; x: number; y: number; width: number; height: number; score: number }>,
  threshold: number = 0.5
): number[] {
  const indices = boxes.map((_, i) => i);
  const kept: number[] = [];
  
  while (indices.length > 0) {
    const current = indices[0];
    kept.push(current);
    
    const remaining: number[] = [];
    for (let i = 1; i < indices.length; i++) {
      const boxA = boxes[current];
      const boxB = boxes[indices[i]];
      
      if (calculateIoU(boxA, boxB) < threshold) {
        remaining.push(indices[i]);
      }
    }
    
    indices.length = 0;
    indices.push(...remaining);
  }
  
  return kept;
}
