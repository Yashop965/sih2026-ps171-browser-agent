import React from 'react';
import { usePIIDetector } from '../hooks/usePIIDetector';
import type { PrivacyEvent } from '../types';

const PrivacyLedger: React.FC = () => {
  const { events } = usePIIDetector();

  if (events.length === 0) return null;

  return (
    <div className="privacy-ledger">
      <h3 style={{ marginBottom: '8px', color: '#f8fafc' }}>🔒 Privacy Ledger</h3>
      {events.slice(0, 10).map((event) => (
        <div key={event.id} className={`ledger-entry ${event.type}`}>
          <div style={{ fontWeight: 600, color: '#e2e8f0' }}>{event.category}</div>
          <div style={{ color: '#94a3b8' }}>{event.detail}</div>
          <div style={{ color: '#64748b', fontSize: 10 }}>
            {new Date(event.timestamp).toLocaleTimeString()} • {(event.confidence * 100).toFixed(0)}%
          </div>
        </div>
      ))}
      {events.length > 10 && (
        <div style={{ color: '#64748b', fontSize: 11, textAlign: 'center', marginTop: '8px' }}>
          +{events.length - 10} more events
        </div>
      )}
    </div>
  );
};

export default PrivacyLedger;
