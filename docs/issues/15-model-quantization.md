## Task: Model Quantization Pipeline

**Assignee:** @Yashop965  
**Priority:** High  
**Due:** Day 1 (Aug 29)

### Requirements
- [ ] Create `src/lib/model.ts`
- [ ] INT8 quantization pipeline
- [ ] ONNX optimization passes
- [ ] Model pruning evaluation
- [ ] Accuracy vs size tradeoff analysis

### Quantization Approach
```python
# Model optimization script (run once, output ONNX)
from optimum.onnxruntime import ORTModelForVision2Seq
from optimum.onnxruntime.configuration import OptimizationConfig

optimization_config = OptimizationConfig(
    optimization_level=1,
    float16=True,           # FP16 for speed
    optimize_for_gpu=False  # Keep CPU-compatible
)

model = ORTModelForVision2Seq.from_pretrained(
    'microsoft/florence-2-base-ft',
    optimization_config=optimization_config
)
model.save_pretrained('./models/florence-2-optimized')
```

### Target Specs
- Original: 231M params, ~600MB
- Optimized: ~200MB (INT8/FP16)
- Target accuracy retention: > 90%
- Inference speed: < 1000ms on mid-range GPU

### Deliverables
- Quantized model files (`models/florence-2-optimized/`)
- Quantization script in `scripts/quantize.py`
- Accuracy benchmark report
- Memory usage comparison
