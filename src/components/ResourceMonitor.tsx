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
  
  return (
    <div className="resource-monitor" title={`Memory: ${jsHeapUsedMB}MB / ${jsHeapTotalMB}MB | CPU: ${cpuCores} cores | Status: ${status}`}>
      <div className="resource-header">
        <svg className="resource-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
        <span className="resource-label">System</span>
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
      
      <div className="resource-metrics">
        <div className="resource-row">
          <svg className="metric-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="6" width="20" height="12" rx="2" />
            <line x1="6" y1="10" x2="6" y2="14" />
            <line x1="10" y1="10" x2="10" y2="14" />
            <line x1="14" y1="10" x2="14" y2="14" />
            <line x1="18" y1="10" x2="18" y2="14" />
          </svg>
          <span className="metric-label">RAM</span>
          <div className="metric-bar">
            <div 
              className="metric-fill"
              style={{ 
                width: `${Math.min(jsHeapPercent, 100)}%`,
                backgroundColor: statusColor 
              }}
            />
          </div>
          <span className="metric-value">{jsHeapUsedMB}MB</span>
        </div>
        
        <div className="resource-row">
          <svg className="metric-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
          <span className="metric-label">CPU</span>
          <span className="metric-value">{cpuCores} cores</span>
        </div>
        
        {gpuAdapter && (
          <div className="resource-row">
            <svg className="metric-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="6" width="20" height="12" rx="2" />
              <circle cx="8" cy="12" r="2" />
              <circle cx="16" cy="12" r="2" />
              <line x1="2" y1="10" x2="22" y2="10" />
              <line x1="2" y1="14" x2="22" y2="14" />
            </svg>
            <span className="metric-label">GPU</span>
            <span className="metric-value">{gpuAdapter.substring(0, 20)}{gpuAdapter.length > 20 ? '...' : ''}</span>
          </div>
        )}
      </div>
    </div>
  );
}
