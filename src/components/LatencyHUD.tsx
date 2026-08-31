import React from 'react';
import { useProfiler } from '../hooks/useProfiler';
import type { Stage, PerformanceMetrics } from '../types';

interface LatencyHUDProps {
  isVisible: boolean;
}

const STAGE_CONFIG: Array<{ key: Stage; metricKey: keyof PerformanceMetrics; label: string; color: string; threshold: number }> = [
  { key: 'dom_extract', metricKey: 'dom_extract_ms', label: 'DOM', color: '#10b981', threshold: 10 },
  { key: 'vision_inference', metricKey: 'vision_inference_ms', label: 'Vision', color: '#6366f1', threshold: 1000 },
  { key: 'plan_response', metricKey: 'plan_response_ms', label: 'Planner', color: '#f59e0b', threshold: 500 },
  { key: 'action_execution', metricKey: 'action_execution_ms', label: 'Action', color: '#ec4899', threshold: 100 },
];

const LatencyHUD: React.FC<LatencyHUDProps> = ({ isVisible }) => {
  const { metrics, alerts, reset } = useProfiler();

  if (!isVisible) return null;

  return (
    <div style={{
      background: '#0f172a',
      border: '1px solid #1e293b',
      borderRadius: 8,
      padding: '8px 12px',
      fontFamily: 'ui-monospace, monospace',
      fontSize: 13,
      minWidth: 220,
      boxShadow: '0 4px 12px rgba(0,0,0,.4)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontWeight: 600, color: '#64748b' }}>📊 Performance</span>
        <button onClick={reset} style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px' }} title="Reset profiler">↺</button>
      </div>

      {STAGE_CONFIG.map(({ key, metricKey, label, color, threshold }) => {
        const value = metrics ? (metrics[metricKey] as number) : 0;
        const over = value >= threshold;
        return (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
            <span style={{ color: '#94a3b8' }}>{label}:</span>
            <span style={{ color: over ? '#ef4444' : color, fontWeight: over ? 600 : 400 }}>
              {value.toFixed(1)}ms
            </span>
            <span style={{ color: '#475569', fontSize: 11, marginLeft: 4 }}>&lt;{threshold}ms</span>
          </div>
        );
      })}

      {metrics && (
        <>
          <div style={{ borderTop: '1px solid #334155', margin: '6px 0' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
            <span style={{ color: '#94a3b8' }}>Total:</span>
            <span style={{ color: '#ef4444', fontWeight: 600 }}>
              {metrics.total_step_ms.toFixed(1)}ms
            </span>
            <span style={{ color: '#475569', fontSize: 11, marginLeft: 4 }}>&lt;2000ms</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
            <span style={{ color: '#94a3b8' }}>RAM:</span>
            <span style={{ color: '#06b6d4' }}>{metrics.memory_mb.toFixed(1)} MB</span>
          </div>
        </>
      )}

      {alerts.length > 0 && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {alerts.map((a, i) => (
            <div key={i} style={{ color: '#f87171', fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>
              ⚠ {a}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default LatencyHUD;
