import React from 'react';
import type { PerformanceMetrics } from '../types';

interface LatencyHUDProps {
  metrics: PerformanceMetrics | null;
  isVisible: boolean;
}

const LatencyHUD: React.FC<LatencyHUDProps> = ({ metrics, isVisible }) => {
  if (!isVisible || !metrics) return null;

  return (
    <div className="latency-hud">
      <div style={{ color: '#64748b', marginBottom: '4px', fontWeight: 600 }}>📊 Performance</div>
      <div><span style={{ color: '#94a3b8' }}>DOM:</span> <span style={{ color: '#10b981' }}>{metrics.dom_ms}ms</span></div>
      <div><span style={{ color: '#94a3b8' }}>Vision:</span> <span style={{ color: '#6366f1' }}>{metrics.vision_ms}ms</span></div>
      <div><span style={{ color: '#94a3b8' }}>Planner:</span> <span style={{ color: '#f59e0b' }}>{metrics.planner_ms}ms</span></div>
      <div style={{ borderTop: '1px solid #334155', marginTop: '4px', paddingTop: '4px' }}>
        <span style={{ color: '#94a3b8' }}>Total:</span>{' '}
        <span style={{ color: '#ef4444', fontWeight: 600 }}>{metrics.total_ms}ms</span>
      </div>
      <div><span style={{ color: '#94a3b8' }}>RAM:</span> <span style={{ color: '#06b6d4' }}>{metrics.ram_mb}MB</span></div>
    </div>
  );
};

export default LatencyHUD;
