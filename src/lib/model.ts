/**
 * Model Quantization Configuration
 *
 * Provides utilities for:
 * - Quantization mode selection (INT8, FP16, Q4)
 * - Model size estimation
 * - Hardware capability detection
 */

/**
 * Available quantization modes
 */
export type QuantizationMode = 'fp32' | 'fp16' | 'int8' | 'q4';

/**
 * Hardware capability information
 */
export interface HardwareCapabilities {
  webgpuSupported: boolean;
  webgpuMaxTextureSize: number;
  hasFP16Support: boolean;
  hasINT8Support: boolean;
  isFirefox: boolean;
  estimatedMemoryMB: number;
  deviceName?: string;
}

/**
 * Model size estimation configuration
 */
export interface ModelConfig {
  modelId: string;
  baseSizeMB: number;
  parameterCount: number;
  supportedModes: QuantizationMode[];
}

/**
 * Quantization configuration for model loading
 */
export interface QuantizationConfig {
  mode: QuantizationMode;
  targetSizeMB: number;
  accuracyThreshold: number;
  hardware: HardwareCapabilities;
}

// Florence-2 model specifications
const FLORENCE2_MODEL: ModelConfig = {
  modelId: 'microsoft/Florence-2-base-ft',
  baseSizeMB: 180,
  parameterCount: 231_000_000,
  supportedModes: ['fp32', 'fp16', 'q4'],
};

/**
 * Estimate model size based on quantization mode
 */
export function estimateModelSize(
  baseSizeMB: number,
  mode: QuantizationMode,
): number {
  switch (mode) {
    case 'fp32':
      return baseSizeMB;
    case 'fp16':
      return Math.round(baseSizeMB * 0.5); // ~50% reduction
    case 'int8':
      return Math.round(baseSizeMB * 0.25); // ~75% reduction
    case 'q4':
      return Math.round(baseSizeMB * 0.125); // ~87.5% reduction
    default:
      return baseSizeMB;
  }
}

/**
 * Select optimal quantization mode based on hardware capabilities
 */
export function selectQuantizationMode(hardware: HardwareCapabilities): QuantizationMode {
  // Firefox has limited WebGPU support, prefer FP32 for stability
  if (hardware.isFirefox) {
    return 'fp32';
  }

  // High-end GPU with FP16 support
  if (hardware.hasFP16Support && hardware.webgpuMaxTextureSize >= 16384) {
    return 'fp16';
  }

  // If memory is constrained, use Q4
  if (hardware.estimatedMemoryMB < 4096) {
    return 'q4';
  }

  // Default to FP32 for maximum compatibility
  return 'fp32';
}

/**
 * Detect hardware capabilities for optimal model selection
 */
export function detectHardwareCapabilities(): HardwareCapabilities {
  const isFirefox = navigator.userAgent.includes('Firefox');
  const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;

  let webgpuMaxTextureSize = 0;
  let hasFP16Support = false;
  let deviceName: string | undefined;

  if (hasWebGPU) {
    try {
      webgpuMaxTextureSize = 8192;
      hasFP16Support = true;
    } catch {
      webgpuMaxTextureSize = 8192;
      hasFP16Support = true;
    }
  }

  // Estimate available memory (best effort)
  const estimatedMemoryMB = (navigator as Navigator & { deviceMemory?: number })?.deviceMemory ?? 8;

  return {
    webgpuSupported: hasWebGPU,
    webgpuMaxTextureSize,
    hasFP16Support,
    hasINT8Support: hasFP16Support, // INT8 support typically correlates with FP16
    isFirefox,
    estimatedMemoryMB,
    deviceName,
  };
}

/**
 * Get the recommended configuration for a given model
 */
export function getModelConfig(modelId: string): ModelConfig {
  if (modelId.includes('Florence') || modelId.includes('florence')) {
    return FLORENCE2_MODEL;
  }
  // Default conservative config
  return {
    modelId,
    baseSizeMB: 500,
    parameterCount: 1_000_000_000,
    supportedModes: ['fp32', 'fp16'],
  };
}

/**
 * Validate that a quantization mode is compatible with hardware
 */
export function validateQuantization(
  hardware: HardwareCapabilities,
  mode: QuantizationMode,
): { valid: boolean; reason?: string } {
  if (hardware.isFirefox && mode === 'q4') {
    return {
      valid: false,
      reason: 'Q4 quantization not recommended for Firefox (WASM fallback)',
    };
  }

  if (!hardware.hasFP16Support && (mode === 'fp16' || mode === 'int8')) {
    return {
      valid: false,
      reason: 'FP16/INT8 quantization requires hardware support',
    };
  }

  const baseSize = FLORENCE2_MODEL.baseSizeMB;
  const estimatedSize = estimateModelSize(baseSize, mode);
  if (estimatedSize > hardware.estimatedMemoryMB * 0.4) {
    // Leave 60% headroom for other operations
    return {
      valid: false,
      reason: `Model size (${estimatedSize}MB) exceeds 40% of available memory (${hardware.estimatedMemoryMB}MB)`,
    };
  }

  return { valid: true };
}

/**
 * Calculate estimated inference memory usage
 */
export function estimateInferenceMemory(
  modelSizeMB: number,
  batchSize: number = 1,
  inputResolution: number = 224,
): number {
  // Model weights + activations + overhead
  const activationMemory = inputResolution * inputResolution * 3 * batchSize * 4; // fp32
  const overhead = modelSizeMB * 1024 * 1024 * 0.2; // 20% overhead for intermediates

  return (modelSizeMB * 1024 * 1024) + activationMemory + overhead;
}

/**
 * Get recommended quantization configuration for the current environment
 */
export function getRecommendedConfig(): QuantizationConfig {
  const hardware = detectHardwareCapabilities();
  const mode = selectQuantizationMode(hardware);
  const baseSize = FLORENCE2_MODEL.baseSizeMB;

  return {
    mode,
    targetSizeMB: estimateModelSize(baseSize, mode),
    accuracyThreshold: mode === 'q4' ? 0.85 : 0.95,
    hardware,
  };
}
