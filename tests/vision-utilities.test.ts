/**
 * Tests for vision utilities
 */
import { describe, it, expect } from 'vitest';
import {
  isWebGPUSupported,
  getAvailableBackends,
  normalizeBoxes,
  calculateIoU,
  nonMaxSuppression,
} from '../src/lib/vision';

describe('vision utilities', () => {
  describe('isWebGPUSupported', () => {
    it('should return boolean', () => {
      const result = isWebGPUSupported();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('getAvailableBackends', () => {
    it('should always include wasm', () => {
      const backends = getAvailableBackends();
      expect(backends).toContain('wasm');
    });

    it('should return array', () => {
      const backends = getAvailableBackends();
      expect(Array.isArray(backends)).toBe(true);
    });
  });

  describe('normalizeBoxes', () => {
    it('should normalize boxes to 0-1 range', () => {
      const boxes = [{ x: 100, y: 100, width: 50, height: 50 }];
      const normalized = normalizeBoxes(boxes, 800, 600);

      expect(normalized[0].x).toBeCloseTo(100 / 800);
      expect(normalized[0].y).toBeCloseTo(100 / 600);
      expect(normalized[0].width).toBeCloseTo(50 / 800);
      expect(normalized[0].height).toBeCloseTo(50 / 600);
    });

    it('should handle edge case', () => {
      const boxes = [{ x: 0, y: 0, width: 800, height: 600 }];
      const normalized = normalizeBoxes(boxes, 800, 600);

      expect(normalized[0].x).toBe(0);
      expect(normalized[0].y).toBe(0);
      expect(normalized[0].width).toBe(1);
      expect(normalized[0].height).toBe(1);
    });
  });

  describe('calculateIoU', () => {
    it('should return 1 for identical boxes', () => {
      const box = { x: 0, y: 0, width: 100, height: 100 };
      expect(calculateIoU(box, box)).toBe(1);
    });

    it('should return 0 for non-overlapping boxes', () => {
      const box1 = { x: 0, y: 0, width: 50, height: 50 };
      const box2 = { x: 100, y: 100, width: 50, height: 50 };
      expect(calculateIoU(box1, box2)).toBe(0);
    });

    it('should return correct IoU for overlapping boxes', () => {
      const box1 = { x: 0, y: 0, width: 100, height: 100 };
      const box2 = { x: 50, y: 50, width: 100, height: 100 };
      const iou = calculateIoU(box1, box2);
      expect(iou).toBeGreaterThan(0);
      expect(iou).toBeLessThan(1);
    });

    it('should handle zero area', () => {
      const box1 = { x: 0, y: 0, width: 0, height: 0 };
      const box2 = { x: 0, y: 0, width: 0, height: 0 };
      expect(calculateIoU(box1, box2)).toBe(0);
    });
  });

  describe('nonMaxSuppression', () => {
    it('should keep only non-overlapping boxes', () => {
      const boxes = [
        { id: 1, x: 0, y: 0, width: 100, height: 100, score: 0.9 },
        { id: 2, x: 10, y: 10, width: 100, height: 100, score: 0.8 },
        { id: 3, x: 200, y: 200, width: 100, height: 100, score: 0.7 },
      ];

      const kept = nonMaxSuppression(boxes, 0.5);
      expect(kept.length).toBeLessThan(boxes.length);
    });

    it('should keep all boxes with high threshold', () => {
      const boxes = [
        { id: 1, x: 0, y: 0, width: 50, height: 50, score: 0.9 },
        { id: 2, x: 100, y: 100, width: 50, height: 50, score: 0.8 },
      ];

      const kept = nonMaxSuppression(boxes, 0.9);
      expect(kept.length).toBe(2);
    });

    it('should handle empty input', () => {
      const boxes: Array<{ id: number; x: number; y: number; width: number; height: number; score: number }> = [];
      const kept = nonMaxSuppression(boxes, 0.5);
      expect(kept.length).toBe(0);
    });
  });
});
