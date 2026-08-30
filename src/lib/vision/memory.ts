/**
 * Tensor Memory Pool Management
 *
 * Provides efficient tensor allocation, reuse, and cleanup
 * to stay within the ~200MB vision memory budget.
 */

interface TensorAllocation {
  id: string;
  shape: number[];
  bytes: number;
  timestamp: number;
  usageCount: number;
}

interface PoolStats {
  totalAllocations: number;
  activeAllocations: number;
  freedAllocations: number;
  totalBytesAllocated: number;
  currentBytes: number;
  peakBytes: number;
}

export class TensorMemoryPool {
  private readonly MAX_MEMORY_BYTES = 200 * 1024 * 1024; // 200MB budget
  private allocations: Map<string, TensorAllocation> = new Map();
  private freeList: string[] = [];
  private nextId = 0;
  private currentBytes = 0;
  private peakBytes = 0;
  private totalAllocations = 0;
  private freedAllocations = 0;

  /**
   * Allocate a new tensor with the given shape
   */
  allocate(shape: number[], label?: string): string {
    // Try to reuse from free list
    if (this.freeList.length > 0) {
      const existingId = this.findSuitableFree(shape);
      if (existingId) {
        this.reuse(existingId, shape);
        return existingId;
      }
    }

    // Check if we can allocate new memory
    const tensorBytes = this.calculateTensorBytes(shape);
    if (this.currentBytes + tensorBytes > this.MAX_MEMORY_BYTES) {
      this.evictOldest();
      if (this.currentBytes + tensorBytes > this.MAX_MEMORY_BYTES) {
        throw new Error(
          `Memory pool full: would exceed ${this.MAX_MEMORY_BYTES / 1024 / 1024}MB limit`,
        );
      }
    }

    const id = `tensor_${++this.nextId}`;
    const allocation: TensorAllocation = {
      id,
      shape,
      bytes: tensorBytes,
      timestamp: Date.now(),
      usageCount: 1,
    };

    this.allocations.set(id, allocation);
    this.currentBytes += tensorBytes;
    this.totalAllocations++;
    this.peakBytes = Math.max(this.peakBytes, this.currentBytes);

    console.debug(`[MemoryPool] Allocated ${id}: ${shape} (${tensorBytes / 1024}KB)`);
    return id;
  }

  /**
   * Reuse an existing tensor allocation
   */
  reuse(id: string, shape?: number[]): void {
    const allocation = this.allocations.get(id);
    if (!allocation) {
      throw new Error(`Tensor ${id} not found`);
    }

    allocation.usageCount++;
    allocation.timestamp = Date.now();
    if (shape) {
      allocation.shape = shape;
    }

    console.debug(`[MemoryPool] Reused ${id} (usage: ${allocation.usageCount})`);
  }

  /**
   * Free a tensor allocation and return to pool or release memory
   */
  free(id: string): void {
    const allocation = this.allocations.get(id);
    if (!allocation) {
      console.warn(`[MemoryPool] Cannot free unknown tensor: ${id}`);
      return;
    }

    this.allocations.delete(id);
    this.currentBytes -= allocation.bytes;
    this.freedAllocations++;

    // Keep in free list for reuse
    this.freeList.push(id);

    // Cap free list size to prevent memory leak
    if (this.freeList.length > 32) {
      this.freeList.shift();
    }

    console.debug(`[MemoryPool] Freed ${id}: ${allocation.bytes / 1024}KB`);
  }

  /**
   * Clear all tensor allocations
   */
  clear(): void {
    const freedBytes = this.currentBytes;
    this.allocations.clear();
    this.freeList = [];
    this.currentBytes = 0;
    this.freedAllocations += this.totalAllocations;
    console.debug(`[MemoryPool] Cleared ${freedBytes / 1024 / 1024}MB`);
  }

  /**
   * Get pool statistics
   */
  getStats(): PoolStats {
    return {
      totalAllocations: this.totalAllocations,
      activeAllocations: this.allocations.size,
      freedAllocations: this.freedAllocations,
      totalBytesAllocated: this.currentBytes,
      currentBytes: this.currentBytes,
      peakBytes: this.peakBytes,
    };
  }

  /**
   * Check if memory pool has sufficient space
   */
  hasSpace(requiredBytes: number): boolean {
    return this.currentBytes + requiredBytes <= this.MAX_MEMORY_BYTES;
  }

  /**
   * Get a free tensor ID or create new
   */
  getOrCreate(requiredShape: number[], label?: string): string {
    if (this.freeList.length > 0) {
      const id = this.findSuitableFree(requiredShape);
      if (id) {
        this.reuse(id, requiredShape);
        return id;
      }
    }
    return this.allocate(requiredShape, label);
  }

  private findSuitableFree(shape: number[]): string | null {
    for (const id of this.freeList) {
      const allocation = this.allocations.get(id);
      if (allocation && allocation.bytes >= this.calculateTensorBytes(shape)) {
        return id;
      }
    }
    return null;
  }

  private calculateTensorBytes(shape: number[]): number {
    const elements = shape.reduce((acc, size) => acc * size, 1);
    // Assume fp32 (4 bytes per float) for estimation
    return elements * 4;
  }

  private evictOldest(): void {
    if (this.allocations.size === 0) return;

    let oldestId: string | null = null;
    let oldestTimestamp = Infinity;

    for (const [id, alloc] of this.allocations) {
      if (alloc.timestamp < oldestTimestamp) {
        oldestTimestamp = alloc.timestamp;
        oldestId = id;
      }
    }

    if (oldestId) {
      this.free(oldestId);
      console.debug(`[MemoryPool] Evicted oldest tensor: ${oldestId}`);
    }
  }
}

// Export singleton instance
export const tensorMemoryPool = new TensorMemoryPool();
