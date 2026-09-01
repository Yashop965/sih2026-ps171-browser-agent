## Task: Vision Pipeline Implementation

**Assignee:** @Yashop965  
**Priority:** High  
**Due:** Day 2 (Aug 30)

### Requirements
- [ ] Create `src/workers/vision.worker.ts`
- [ ] WebGPU tensor allocation
- [ ] Florence-2 ONNX model loading
- [ ] Compute shader optimization
- [ ] Memory pool management
- [ ] WASM fallback for Firefox

### Model Loading
```typescript
import { pipeline, env } from '@xenova/transformers';

// Configure environment
env.allowLocalModels = false;
env.useBrowserCache = true;

// Load model (lazy)
const pipe = await pipeline(
  'image-to-text',
  'Xenova/florence-2-base-ft',
  {
    device: 'webgpu',  // Falls back to wasm
    dtype: 'q4',       // Quantized for memory
  }
);
```

### Technical Details
- Use WebGPU for GPU acceleration
- Allocate tensors in memory pool (reuse buffers)
- Handle model download (~180MB) with progress indicator
- Cache model in IndexedDB for persistence
- Implement feature detection for WebGPU support

### Deliverables
- Vision worker with WebGPU inference
- Model loading with progress tracking
- Memory-efficient tensor management
- Firefox compatibility (WASM fallback)
