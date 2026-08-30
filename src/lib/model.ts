/**
 * Model Quantization & Optimization Module
 *
 * Handles model selection, quantization config, and runtime optimization
 * for on-device vision inference.
 */

import { visionMemoryPool } from './vision/memory';

export type QuantizationMode = 'fp32' | 'fp16' | 'q4';
export type DeviceBackend = 'webgpu' | 'wasm';

export interface ModelConfig {
  modelId: string;
  quantization: QuantizationMode;
  backend: DeviceBackend;
  maxTextureSize: number;
}

export interface HardwareProfile {
  hasWebGPU: boolean;
  webgpuMaxTextureSize: number;
  hasFP16Support: boolean;
  isFirefox: boolean;
}

/** Detect hardware capabilities */
export function detectHardware(): HardwareProfile {
  const isFirefox = navigator.userAgent.includes('Firefox');
  const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;
  const gpu = (navigator as Navigator & { gpu?: GPUAdapter }).gpu;

  // Estimate max texture size
  let maxTextureSize = 8192; // Default conservative value
  if (hasWebGPU && gpu) {
    const limits = gpu.adapterLimits;
    maxTextureSize = Math.min(limits.maxTextureDimension2D || 8192, 8192);
  }

  // FP16 support check
  let hasFP16Support = false;
  if (hasWebGPU && gpu) {
    // Check for float16 feature
    hasFP16Support = gpu.features.has('float32-filterable-texture') || maxTextureSize >= 8192;
  }

  return {
    hasWebGPU,
    webgpuMaxTextureSize: maxTextureSize,
    hasFP16Support,
    isFirefox,
  };
}

/** Select optimal model config based on hardware */
export function selectModelConfig(hardware: HardwareProfile = detectHardware()): ModelConfig {
  // Firefox has limited WebGPU support, prefer FP32 for stability
  if (hardware.isFirefox) {
    return {
      modelId: 'microsoft/Florence-2-base-ft',
      quantization: 'fp32',
      backend: 'wasm',
      maxTextureSize: 4096,
    };
  }

  // High-end GPU with FP16 support
  if (hardware.hasFP16Support && hardware.webgpuMaxTextureSize >= 16384) {
    return {
      modelId: 'microsoft/Florence-2-base-ft',
      quantization: 'fp16',
      backend: 'webgpu',
      maxTextureSize: 16384,
    };
  }

  // Standard configuration - Q4 quantization for memory efficiency
  return {
    modelId: 'microsoft/Florence-2-base-ft',
    quantization: 'q4',
    backend: hardware.hasWebGPU ? 'webgpu' : 'wasm',
    maxTextureSize: hardware.webgpuMaxTextureSize,
  };
}

/** Get estimated model size in MB */
export function getModelSizeEstimate(quantization: QuantizationMode): number {
  const sizes = {
    'fp32': 720, // Full precision
    'fp16': 360, // Half precision
    'q4': 180,   // 4-bit quantized
  };
  return sizes[quantization];
}

/** Check if we're within memory budget */
export function isWithinMemoryBudget(quantization: QuantizationMode): boolean {
  const modelSize = getModelSizeEstimate(quantization);
  const budgetMB = 500;
  return modelSize < budgetMB;
}

/** Get quantization info for logging */
export function getQuantizationInfo(
  quantization: QuantizationMode,
  hardware: HardwareProfile
): string {
  const sizeMB = getModelSizeEstimate(quantization);
  const withinBudget = sizeMB < 500;

  return `Quantization: ${quantization.toUpperCase()} | ` +
         `Model: ~${sizeMB}MB | ` +
         `Backend: ${hardware.backend} | ` +
         `GPU: ${hardware.hasWebGPU ? 'Yes' : 'No'} | ` +
         `${withinBudget ? '✓ Within 500MB budget' : '✗ Over budget'}`;
}

// Export singleton for runtime config
export const modelConfig = selectModelConfig();
