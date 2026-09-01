import { useSystemResources } from '../hooks/useSystemResources';

export default function ResourceMonitor() {
  const { jsHeapUsedMB, jsHeapTotalMB, jsHeapPercent, cpuCores, gpuAdapter, status } = useSystemResources();
  
  const getStatusColor = () => {
    switch (status) {
      case 'healthy': return '#2D5A27';
      case 'warning': return '#8B6914';
      case 'critical': return '#8B2E2E';
      default: return '#64748b';
    }
  };
  
  const statusColor = getStatusColor();
  const formattedGpu = gpuAdapter 
    ? gpuAdapter.length > 20 
      ? gpuAdapter.substring(0, 18) + '...' 
      : gpuAdapter
    : null;
  
  return (
    <div className="resource-monitor" title={`Memory: ${jsHeapUsedMB}MB / ${jsHeapTotalMB}MB | CPU: ${cpuCores} cores | Status: ${status}`}>
      {/* Header */}
      <div className="resource-header">
        <div className="resource-header-left">
          <div className="resource-icon-wrapper">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </div>
          <span className="resource-label">SYSTEM</span>
        </div>
        <span className={`resource-status resource-status-${status}`}>
          {status === 'healthy' ? (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : status === 'warning' ? (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          )}
        </span>
      </div>
      
      {/* Metrics Grid */}
      <div className="resource-metrics">
        {/* RAM Metric */}
        <div className="resource-row">
          <div className="metric-icon-wrapper">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="6" width="20" height="12" rx="2" />
              <line x1="6" y1="10" x2="6" y2="14" />
              <line x1="10" y1="10" x2="10" y2="14" />
              <line x1="14" y1="10" x2="14" y2="14" />
              <line x1="18" y1="10" x2="18" y2="14" />
            </svg>
          </div>
          <div className="metric-content">
            <div className="metric-label">RAM</div>
            <div className="metric-bar-container">
              <div className="metric-bar">
                <div 
                  className="metric-fill"
                  style={{ 
                    width: `${Math.min(jsHeapPercent, 100)}%`,
                    backgroundColor: statusColor,
                    boxShadow: `0 0 8px ${statusColor}40`
                  }}
                />
              </div>
              <div className="metric-value" style={{ color: statusColor }}>
                {jsHeapUsedMB}MB<span className="metric-total">/{jsHeapTotalMB}MB</span>
              </div>
            </div>
          </div>
        </div>
        
        {/* CPU Metric */}
        <div className="resource-row">
          <div className="metric-icon-wrapper">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="4" y="4" width="16" height="16" rx="2" />
              <rect x="9" y="9" width="6" height="6" />
              <line x1="9" y1="2" x2="9" y2="4" />
              <line x1="15" y1="2" x2="15" y2="4" />
              <line x1="9" y1="20" x2="9" y2="22" />
              <line x1="15" y1="20" x2="15" y2="22" />
              <line x1="2" y1="9" x2="4" y2="9" />
              <line x1="2" y1="15" x2="4" y2="15" />
              <line x1="20" y1="9" x2="22" y2="9" />
              <line x1="20" y1="15" x2="22" y2="15" />
            </svg>
          </div>
          <div className="metric-content">
            <div className="metric-label">CPU</div>
            <div className="metric-value">{cpuCores} cores</div>
          </div>
        </div>
        
        {/* GPU Metric (conditional) */}
        {formattedGpu && (
          <div className="resource-row">
            <div className="metric-icon-wrapper">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="6" width="20" height="12" rx="2" />
                <circle cx="8" cy="12" r="2" />
                <circle cx="16" cy="12" r="2" />
                <line x1="2" y1="10" x2="22" y2="10" />
                <line x1="2" y1="14" x2="22" y2="14" />
              </svg>
            </div>
            <div className="metric-content">
              <div className="metric-label">GPU</div>
              <div className="metric-value gpu-value">{formattedGpu}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
