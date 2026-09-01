import { useSystemResources } from '../hooks/useSystemResources';

export default function ResourceMonitor() {
  const { jsHeapUsedMB, jsHeapTotalMB, jsHeapPercent, cpuCores, gpuAdapter, status } = useSystemResources();
  
  const getStatusColor = () => {
    switch (status) {
      case 'healthy': return '#10b981';
      case 'warning': return '#f59e0b';
      case 'critical': return '#ef4444';
      default: return '#64748b';
    }
  };
  
  const statusColor = getStatusColor();
  
  return (
    <div className="resource-monitor" title={`Memory: ${jsHeapUsedMB}MB / ${jsHeapTotalMB}MB | CPU: ${cpuCores} cores | Status: ${status}`}>
      <div className="resource-header">
        <span className="resource-icon">⚡</span>
        <span className="resource-label">System</span>
        <span className={`resource-status resource-status-${status}`}>
          {status === 'healthy' ? '✓' : status === 'warning' ? '!' : '✗'}
        </span>
      </div>
      
      <div className="resource-metrics">
        <div className="resource-row">
          <span className="metric-label">🧠 RAM</span>
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
          <span className="metric-label">🖥️ CPU</span>
          <span className="metric-value">{cpuCores} cores</span>
        </div>
        
        {gpuAdapter && (
          <div className="resource-row">
            <span className="metric-label">🎮 GPU</span>
            <span className="metric-value">{gpuAdapter.substring(0, 20)}{gpuAdapter.length > 20 ? '...' : ''}</span>
          </div>
        )}
      </div>
    </div>
  );
}
