/**
 * Memory Pool for Vision Inference
 *
 * Manages tensor allocation and reuse to stay within the 500MB memory budget.
 * Uses WebGPU buffers where available, falls back to TypedArrays.
 */

interface TensorBuffer {
  data: Float32Array | Uint8Array;
  shape: number[];
  dtype: 'fp32' | 'uint8';
  usageCount: number;
}

export class VisionMemoryPool {
  private buffers: Map<string, TensorBuffer> = new Map();
  private totalSize = 0;
  private maxSize = 200 * 1024 * 1024; // 200MB budget for tensors

  /** Allocate or reuse a buffer for the given shape and dtype */
  allocate(id: string, shape: number[], dtype: 'fp32' | 'uint8' = 'fp32'): TensorBuffer {
    const elementSize = dtype === 'fp32' ? 4 : 1;
    const requiredSize = shape.reduce((a, b) => a * b, 1) * elementSize;

    // Check if we can reuse an existing buffer
    for (const [key, buffer] of this.buffers) {
      const currentData = buffer.data as unknown as ArrayBuffer;
      if (currentData.byteLength >= requiredSize && buffer.dtype === dtype) {
        buffer.usageCount++;
        this.buffers.set(id, {
          ...buffer,
          data: buffer.data.slice(0, requiredSize),
        });
        this.buffers.delete(key);
        console.log(`[MemoryPool] Reused buffer ${key} → ${id} (${requiredSize / 1024}KB)`);
        return this.buffers.get(id)!;
      }
    }

    // Allocate new buffer
    const array = dtype === 'fp32'
      ? new Float32Array(requiredSize)
      : new Uint8Array(requiredSize);

    this.buffers.set(id, {
      data: array,
      shape,
      dtype,
      usageCount: 1,
    });
    this.totalSize += requiredSize;

    console.log(`[MemoryPool] Allocated ${id} (${requiredSize / 1024}KB)`);

    // Prune if over budget
    this.pruneIfOverBudget();

    return this.buffers.get(id)!;
  }

  /** Release a buffer */
  release(id: string): void {
    const buffer = this.buffers.get(id);
    if (buffer) {
      buffer.usageCount--;
      if (buffer.usageCount <= 0) {
        this.totalSize -= buffer.data.byteLength;
        this.buffers.delete(id);
        console.log(`[MemoryPool] Released ${id}`);
      }
    }
  }

  /** Clear all buffers */
  clear(): void {
    this.buffers.clear();
    this.totalSize = 0;
    console.log('[MemoryPool] Cleared all buffers');
  }

  /** Get memory stats */
  getStats(): { usedMB: number; maxMB: number; bufferCount: number } {
    return {
      usedMB: Math.round((this.totalSize / 1024 / 1024) * 100) / 100,
      maxMB: Math.round((this.maxSize / 1024 / 1024) * 100) / 100,
      bufferCount: this.buffers.size,
    };
  }

  /** Check if under budget */
  isUnderBudget(): boolean {
    return this.totalSize < this.maxSize;
  }

  private pruneIfOverBudget(): void {
    while (this.totalSize > this.maxSize && this.buffers.size > 0) {
      // Remove oldest buffer (first entry)
      const firstKey = this.buffers.keys().next().value;
      if (firstKey) {
        const buffer = this.buffers.get(firstKey)!;
        this.totalSize -= buffer.data.byteLength;
        this.buffers.delete(firstKey);
        console.log(`[MemoryPool] Pruned buffer ${firstKey} to stay under budget`);
      }
    }
  }
}

// Export singleton instance
export const visionMemoryPool = new VisionMemoryPool();
