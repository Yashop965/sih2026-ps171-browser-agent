/**
 * Latency Profiler
 *
 * Tracks timing for agent pipeline stages and reports performance metrics.
 * Enforces threshold-based bottleneck detection.
 */

import type { PerfMark, PerformanceMetrics, Stage } from '../types';

const THRESHOLDS: Record<Stage, number> = {
  dom_extract: 10,
  vision_inference: 1000,
  plan_response: 500,
  action_execution: 100,
};

export class Profiler {
  private marks: PerfMark[] = [];
  private stageStarts: Record<string, number> = {};
  private stepStart: number | null = null;

  /** Mark the start of a stage. Multiple calls for the same stage reset the timer. */
  start(stage: Stage): void {
    this.stageStarts[stage] = performance.now();
  }

  /** Mark the end of a stage, record the mark, and return it. */
  end(stage: Stage): PerfMark {
    const start = this.stageStarts[stage];
    if (start === undefined) {
      throw new Error(`Profiler: cannot end stage "${stage}" without a preceding start()`);
    }
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    const mark: PerfMark = {
      name: stage,
      timestamp: Date.now(),
      durationMs,
    };
    this.marks.push(mark);
    delete this.stageStarts[stage];
    return mark;
  }

  /** Convenience: start + end in one call. Returns the recorded PerfMark. */
  recordStage(stage: Stage): PerfMark {
    this.start(stage);
    return this.end(stage);
  }

  /** Aggregate all recorded marks into a PerformanceMetrics report. */
  report(): PerformanceMetrics {
    const grouped = this.aggregateMarks();

    return {
      dom_extract_ms: grouped.dom_extract ?? 0,
      vision_inference_ms: grouped.vision_inference ?? 0,
      plan_response_ms: grouped.plan_response ?? 0,
      action_execution_ms: grouped.action_execution ?? 0,
      total_step_ms: this.computeTotal(grouped),
      memory_mb: this.getMemoryEstimate(),
      marks: this.marks,
    };
  }

  /** Estimate current RSS in MB using the Performance API where available. */
  getMemoryEstimate(): number {
    if (typeof performance !== 'undefined' && 'memory' in performance) {
      const mem = (performance as Performance & { memory?: PerformanceMemory }).memory;
      if (mem && typeof mem.usedJSHeapSize === 'number') {
        return Math.round((mem.usedJSHeapSize / 1024 / 1024) * 100) / 100;
      }
    }
    // Fallback: return 0 — memory data unavailable in this environment
    return 0;
  }

  /**
   * Check thresholds against a metrics snapshot and return a list of alert strings.
   * Empty array means all stages are within limits.
   */
  checkThresholds(metrics: PerformanceMetrics): string[] {
    const alerts: string[] = [];

    const checks: Array<{ stage: Stage; value: number; label: string }> = [
      { stage: 'dom_extract', value: metrics.dom_extract_ms, label: 'DOM Extract' },
      { stage: 'vision_inference', value: metrics.vision_inference_ms, label: 'Vision Inference' },
      { stage: 'plan_response', value: metrics.plan_response_ms, label: 'Planner' },
      { stage: 'action_execution', value: metrics.action_execution_ms, label: 'Action Execution' },
    ];

    for (const { stage, value, label } of checks) {
      const threshold = THRESHOLDS[stage];
      if (value >= threshold) {
        alerts.push(`${label}: ${value}ms >= ${threshold}ms threshold`);
      }
    }

    if (metrics.total_step_ms >= 2000) {
      alerts.push(`Total step: ${metrics.total_step_ms}ms >= 2000ms threshold`);
    }

    return alerts;
  }

  /** Reset all marks and stage timers. Call between agent steps. */
  reset(): void {
    this.marks = [];
    this.stageStarts = {};
    this.stepStart = null;
  }

  // ---- Private helpers ----

  private aggregateMarks(): Partial<Record<Stage, number>> {
    const sum = {} as Record<Stage, number>;
    for (const stage of Object.keys(THRESHOLDS) as Stage[]) {
      sum[stage] = 0;
    }
    for (const mark of this.marks) {
      const stage = mark.name as Stage;
      if (stage in sum) {
        sum[stage] += mark.durationMs;
      }
    }
    return sum as Partial<Record<Stage, number>>;
  }

  private computeTotal(grouped: Partial<Record<Stage, number>>): number {
    let total = 0;
    for (const val of Object.values(grouped)) {
      total += val;
    }
    return Math.round(total * 100) / 100;
  }
}

interface PerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}
