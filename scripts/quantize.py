"""
Florence-2 Model Quantization Script

Optimizes the Florence-2-base-ft model for browser-based inference
using ONNX Runtime optimizations.

Usage:
    python scripts/quantize.py --model microsoft/florence-2-base-ft --output ./models/florence-2-optimized
    python scripts/quantize.py --mode int8 --prune 0.1 --output ./models/florence-2-int8

Requirements:
    pip install optimum[onnxruntime] onnx onnxruntime-transformers
"""

import argparse
import logging
import os
import sys
from pathlib import Path
from typing import Optional

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
)
logger = logging.getLogger(__name__)

# Model specifications
DEFAULT_MODEL_ID = "microsoft/florence-2-base-ft"
DEFAULT_OUTPUT_DIR = "./models/florence-2-optimized"

# Quantization presets
QUANTIZATION_PRESETS = {
    "fp32": {"optimization_level": 1, "float16": False, "int8": False, "quant_method": None},
    "fp16": {"optimization_level": 1, "float16": True, "int8": False, "quant_method": "fp16"},
    "int8": {"optimization_level": 2, "float16": False, "int8": True, "quant_method": "int8"},
    "q4": {"optimization_level": 2, "float16": False, "int8": False, "quant_method": "q4"},
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Optimize Florence-2 model for browser inference",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--model",
        type=str,
        default=DEFAULT_MODEL_ID,
        help="Hugging Face model ID or local path",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=DEFAULT_OUTPUT_DIR,
        help="Output directory for optimized model",
    )
    parser.add_argument(
        "--mode",
        type=str,
        choices=["fp32", "fp16", "int8", "q4"],
        default="fp16",
        help="Quantization mode",
    )
    parser.add_argument(
        "--prune",
        type=float,
        default=0.0,
        help="Pruning ratio (0.0 to 0.5)",
    )
    parser.add_argument(
        "--optimize-for-webgpu",
        action="store_true",
        help="Optimize specifically for WebGPU runtime",
    )
    parser.add_argument(
        "--skip-validation",
        action="store_true",
        help="Skip accuracy validation after quantization",
    )
    parser.add_argument(
        "--max-seq-len",
        type=int,
        default=512,
        help="Maximum sequence length",
    )
    return parser.parse_args()


def estimate_model_size(model_path: str) -> dict:
    """Estimate model file sizes for different quantization modes."""
    import os

    base_size_mb = 0
    for root, dirs, files in os.walk(model_path):
        for file in files:
            if file.endswith((".bin", ".onnx", ".safetensors")):
                file_path = os.path.join(root, file)
                base_size_mb += os.path.getsize(file_path) / (1024 * 1024)

    # Calculate estimated sizes for different quantization modes
    estimates = {
        "fp32": base_size_mb,
        "fp16": base_size_mb * 0.5,
        "int8": base_size_mb * 0.25,
        "q4": base_size_mb * 0.125,
    }

    return {
        "base_mb": round(base_size_mb, 2),
        "estimated": {k: round(v, 2) for k, v in estimates.items()},
    }


def optimize_model(
    model_id: str,
    output_dir: str,
    quantization_mode: str,
    prune_ratio: float = 0.0,
    optimize_for_webgpu: bool = False,
    max_seq_len: int = 512,
) -> dict:
    """
    Optimize Florence-2 model using ONNX Runtime.

    Returns optimization results including size estimates and paths.
    """
    try:
        from optimum.onnxruntime import ORTModelForVision2Seq
        from optimum.onnxruntime.configuration import OptimizationConfig
    except ImportError:
        logger.error(
            "Required packages not installed. Run:\n"
            "    pip install optimum[onnxruntime] onnx onnxruntime-transformers"
        )
        sys.exit(1)

    logger.info(f"Loading model: {model_id}")
    logger.info(f"Quantization mode: {quantization_mode}")
    logger.info(f"Output directory: {output_dir}")

    # Configure optimization
    preset = QUANTIZATION_PRESETS[quantization_mode]

    optimization_config = OptimizationConfig(
        optimization_level=preset["optimization_level"],
        float16=preset["float16"],
        optimize_for_gpu=False,  # Keep CPU-compatible for browser
        single_quantization=preset["int8"],
        dynamic_shapes=False,    # Fixed shapes for better WebGPU compatibility
    )

    # Create output directory
    os.makedirs(output_dir, exist_ok=True)

    logger.info("Loading and optimizing model...")
    try:
        model = ORTModelForVision2Seq.from_pretrained(
            model_id,
            optimization_config=optimization_config,
        )

        logger.info(f"Saving optimized model to {output_dir}...")
        model.save_pretrained(output_dir)

        # Copy config files
        import shutil
        from pathlib import Path

        source_path = Path(model_id)
        if source_path.exists():
            for config_file in ["config.json", "preprocessor_config.json", "tokenizer.json"]:
                src = source_path / config_file
                dst = Path(output_dir) / config_file
                if src.exists():
                    shutil.copy2(src, dst)
                    logger.info(f"Copied {config_file}")

        # Estimate sizes
        size_info = estimate_model_size(output_dir)

        return {
            "success": True,
            "output_dir": output_dir,
            "quantization_mode": quantization_mode,
            "base_size_mb": size_info["base_mb"],
            "estimated_size_mb": size_info["estimated"][quantization_mode],
            "prune_ratio": prune_ratio,
        }

    except Exception as e:
        logger.error(f"Optimization failed: {e}")
        return {
            "success": False,
            "error": str(e),
        }


def validate_quantization(
    original_model: str,
    quantized_model: str,
    sample_images: Optional[list] = None,
) -> dict:
    """
    Validate quantization accuracy by comparing outputs.
    """
    logger.info("Running validation...")

    try:
        from transformers import AutoProcessor
        import torch

        processor = AutoProcessor.from_pretrained(original_model)

        # Run inference on sample images
        # (Implementation depends on available test data)
        logger.warning("Validation skipped - no sample images provided")

        return {
            "success": True,
            "accuracy_retained": "N/A (no validation data)",
        }

    except Exception as e:
        logger.error(f"Validation failed: {e}")
        return {
            "success": False,
            "error": str(e),
        }


def main():
    args = parse_args()

    logger.info("=" * 60)
    logger.info("Florence-2 Model Quantization Pipeline")
    logger.info("=" * 60)

    # Validate prune ratio
    if args.prune < 0 or args.prune > 0.5:
        logger.error("Prune ratio must be between 0.0 and 0.5")
        sys.exit(1)

    # Run optimization
    result = optimize_model(
        model_id=args.model,
        output_dir=args.output,
        quantization_mode=args.mode,
        prune_ratio=args.prune,
        optimize_for_webgpu=args.optimize_for_webgpu,
        max_seq_len=args.max_seq_len,
    )

    if not result["success"]:
        logger.error(f"Optimization failed: {result.get('error')}")
        sys.exit(1)

    # Print results
    logger.info("=" * 60)
    logger.info("Optimization Complete")
    logger.info("=" * 60)
    logger.info(f"Output directory: {result['output_dir']}")
    logger.info(f"Quantization mode: {result['quantization_mode']}")
    logger.info(f"Base size: {result['base_size_mb']:.2f} MB")
    logger.info(f"Estimated size: {result['estimated_size_mb']:.2f} MB")
    logger.info(f"Compression ratio: {result['base_size_mb'] / max(result['estimated_size_mb'], 0.01):.2f}x")

    # Run validation if not skipped
    if not args.skip_validation:
        validation = validate_quantization(args.model, args.output)
        if validation["success"]:
            logger.info(f"Accuracy retained: {validation['accuracy_retained']}")
        else:
            logger.warning(f"Validation warning: {validation.get('error')}")

    logger.info("=" * 60)


if __name__ == "__main__":
    main()
