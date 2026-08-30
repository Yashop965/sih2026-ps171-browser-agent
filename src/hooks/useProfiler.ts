/**
 * useProfiler — React hook for exposing profiler state to components.
 *
 * Creates a singleton Profiler, runs a rAF-driven refresh, and exposes
 * live metrics plus bottleneck alerts via React state.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Profiler } from '../lib/profiler';
import type { PerformanceMetrics } from '../types';

let _profiler: Profiler | null = null;

function getProfiler(): Profiler {
  if (!_profiler) {
    _profiler = new Profiler();
  }
  return _profiler;
}

export interface ProfilerState {
  metrics: PerformanceMetrics | null;
  alerts: string[];
  isRunning: boolean;
  start: (stage: 'dom_extract' | 'vision_inference' | 'plan_response' | 'action_execution') => void;
  end: (stage: 'dom_extract' | 'vision_inference' | 'plan_response' | 'action_execution') => void;
  report: () => void;
  reset: () => void;
}

export function useProfiler(): ProfilerState {
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null);
  const [alerts, setAlerts] = useState<string[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const rafRef = useRef<number | null>(null);
  const profilerRef = useRef<Profiler>(getProfiler());

  const tick = useCallback(() => {
    const m = profilerRef.current.report();
    setMetrics(m);
    const a = profilerRef.current.checkThresholds(m);
    setAlerts(a);
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    setIsRunning(true);
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setIsRunning(false);
    };
  }, [tick]);

  const start = useCallback(
    (stage: 'dom_extract' | 'vision_inference' | 'plan_response' | 'action_execution') => {
      profilerRef.current.start(stage);
    },
    []
  );

  const end = useCallback(
    (stage: 'dom_extract' | 'vision_inference' | 'plan_response' | 'action_execution') => {
      profilerRef.current.end(stage);
    },
    []
  );

  const report = useCallback(() => {
    profilerRef.current.report();
  }, []);

  const reset = useCallback(() => {
    profilerRef.current.reset();
  }, []);

  return { metrics, alerts, isRunning, start, end, report, reset };
}

/** Get the singleton profiler instance directly (for non-React code). */
export function getSharedProfiler(): Profiler {
  return getProfiler();
}
