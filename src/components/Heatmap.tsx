// src/components/Heatmap.tsx
//
// Modern, clean heatmap visualization for PII detections
// Uses cards instead of dots, clear labels, and intuitive design

import { useState } from 'react';
import type { Detection } from '../lib/ledgerClient';

const TYPE_CONFIG: Record<string, { color: string; bg: string; icon: string; label: string }> = {
  'AADHAAR': { color: '#DC2626', bg: '#FEF2F2', icon: '🪪', label: 'Aadhaar Card' },
  'PAN': { color: '#D97706', bg: '#FFFBEB', icon: '💳', label: 'PAN Card' },
  'CREDIT_CARD': { color: '#DC2626', bg: '#FEF2F2', icon: '💳', label: 'Credit Card' },
  'EMAIL': { color: '#059669', bg: '#ECFDF5', icon: '📧', label: 'Email' },
  'PHONE': { color: '#2563EB', bg: '#EFF6FF', icon: '📱', label: 'Phone' },
  'IFSC': { color: '#7C3AED', bg: '#F5F3FF', icon: '🏦', label: 'Bank Account' },
  'PASSWORD_FIELD': { color: '#6B7280', bg: '#F3F4F6', icon: '🔒', label: 'Password Field' },
  'PASSWORD_VALUE': { color: '#991B1B', bg: '#FEF2F2', icon: '🔐', label: 'Password Value' },
  'SSN': { color: '#DC2626', bg: '#FEF2F2', icon: '🆔', label: 'SSN' },
};

interface HeatmapProps {
  detections: Detection[];
  onHighlight: (selector: string) => void;
}

export default function Heatmap({ detections, onHighlight }: HeatmapProps) {
  const [selectedType, setSelectedType] = useState<string | null>(null);

  if (detections.length === 0) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        padding: '60px 20px',
        textAlign: 'center',
        background: '#FAFAFA',
      }}>
        <div style={{
          width: 80,
          height: 80,
          borderRadius: '50%',
          background: '#E5E7EB',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 20,
          fontSize: 36,
        }}>
          🔍
        </div>
        <h3 style={{ fontSize: 18, fontWeight: 600, color: '#111827', marginBottom: 8 }}>
          No Detections Yet
        </h3>
        <p style={{ fontSize: 14, color: '#6B7280', maxWidth: 300 }}>
          Start the agent to detect PII on the page. Detected items will appear here.
        </p>
      </div>
    );
  }

  // Group by type
  const byType = detections.reduce((acc, d) => {
    if (!acc[d.type]) acc[d.type] = [];
    acc[d.type].push(d);
    return acc;
  }, {} as Record<string, Detection[]>);

  const total = detections.length;
  const verified = detections.filter(d => d.verified).length;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: '#FFFFFF',
    }}>
      {/* Header with summary */}
      <div style={{
        padding: '20px 24px',
        borderBottom: '1px solid #E5E7EB',
        background: '#FAFAFA',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
        }}>
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: '#111827', margin: 0 }}>
              Detections
            </h2>
            <p style={{ fontSize: 13, color: '#6B7280', margin: '4px 0 0' }}>
              {total} total · {verified} verified
            </p>
          </div>
          <button
            onClick={() => setSelectedType(null)}
            style={{
              padding: '8px 16px',
              fontSize: 13,
              border: '1px solid #D1D5DB',
              borderRadius: 8,
              background: '#FFFFFF',
              color: '#374151',
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            Show All
          </button>
        </div>

        {/* Type filter chips */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button
            onClick={() => setSelectedType(null)}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              border: '1px solid',
              borderColor: selectedType === null ? '#111827' : '#D1D5DB',
              borderRadius: 20,
              background: selectedType === null ? '#111827' : '#FFFFFF',
              color: selectedType === null ? '#FFFFFF' : '#374151',
              cursor: 'pointer',
              fontWeight: 500,
              transition: 'all 0.15s ease',
            }}
          >
            All ({total})
          </button>
          {Object.entries(byType).map(([type, items]) => {
            const config = TYPE_CONFIG[type] || { color: '#6B7280', bg: '#F3F4F6', icon: '📋', label: type };
            return (
              <button
                key={type}
                onClick={() => setSelectedType(selectedType === type ? null : type)}
                style={{
                  padding: '6px 14px',
                  fontSize: 12,
                  border: '1px solid',
                  borderColor: selectedType === type ? config.color : '#D1D5DB',
                  borderRadius: 20,
                  background: selectedType === type ? config.bg : '#FFFFFF',
                  color: selectedType === type ? config.color : '#374151',
                  cursor: 'pointer',
                  fontWeight: 500,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  transition: 'all 0.15s ease',
                }}
              >
                <span>{config.icon}</span>
                <span>{config.label}</span>
                <span style={{
                  background: selectedType === type ? config.color : '#E5E7EB',
                  color: selectedType === type ? '#FFFFFF' : '#6B7280',
                  padding: '2px 8px',
                  borderRadius: 10,
                  fontSize: 11,
                  fontWeight: 600,
                }}>
                  {items.length}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Content area */}
      <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        {(() => {
          const typesToShow = selectedType ? [selectedType] : Object.keys(byType);
          
          return typesToShow.map(type => {
            const items = byType[type];
            const config = TYPE_CONFIG[type] || { color: '#6B7280', bg: '#F3F4F6', icon: '📋', label: type };
            const verifiedCount = items.filter(d => d.verified).length;
            const avgConfidence = Math.round(items.reduce((sum, d) => sum + d.confidence, 0) / items.length * 100);

            return (
              <div key={type} style={{ marginBottom: 24 }}>
                {/* Type header card */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '16px 20px',
                  background: config.bg,
                  borderRadius: 12,
                  border: `1px solid ${config.color}20`,
                  marginBottom: 12,
                }}>
                  <div style={{
                    width: 44,
                    height: 44,
                    borderRadius: 10,
                    background: config.color,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 22,
                  }}>
                    {config.icon}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{
                      fontSize: 16,
                      fontWeight: 600,
                      color: '#111827',
                    }}>
                      {config.label}
                    </div>
                    <div style={{
                      fontSize: 13,
                      color: '#6B7280',
                      marginTop: 2,
                    }}>
                      {items.length} detected · {verifiedCount} verified · {avgConfidence}% avg confidence
                    </div>
                  </div>
                  <div style={{
                    padding: '6px 12px',
                    background: '#FFFFFF',
                    borderRadius: 8,
                    fontSize: 13,
                    fontWeight: 600,
                    color: config.color,
                    border: `1px solid ${config.color}30`,
                  }}>
                    {Math.round((verifiedCount / items.length) * 100)}% verified
                  </div>
                </div>

                {/* Detection cards */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {items.map((detection, index) => (
                    <div
                      key={`${detection.selector}-${index}`}
                      onClick={() => onHighlight(detection.selector)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '12px 16px',
                        background: '#FFFFFF',
                        border: '1px solid #E5E7EB',
                        borderRadius: 10,
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                        boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                      }}
                      onMouseEnter={e => {
                        (e.currentTarget as HTMLDivElement).style.borderColor = config.color;
                        (e.currentTarget as HTMLDivElement).style.boxShadow = `0 4px 12px ${config.color}20`;
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLDivElement).style.borderColor = '#E5E7EB';
                        (e.currentTarget as HTMLDivElement).style.boxShadow = '0 1px 2px rgba(0,0,0,0.05)';
                      }}
                    >
                      {/* Selector */}
                      <div style={{
                        flex: 1,
                        fontFamily: 'monospace',
                        fontSize: 12,
                        color: '#374151',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {detection.selector}
                      </div>

                      {/* Confidence badge */}
                      <div style={{
                        padding: '4px 10px',
                        borderRadius: 6,
                        background: detection.confidence >= 0.9 ? '#DCfce7' : detection.confidence >= 0.7 ? '#fef9c3' : '#fee2e2',
                        fontSize: 11,
                        fontWeight: 600,
                        color: detection.confidence >= 0.9 ? '#166534' : detection.confidence >= 0.7 ? '#854d0e' : '#991b1b',
                      }}>
                        {Math.round(detection.confidence * 100)}%
                      </div>

                      {/* Verified badge */}
                      {detection.verified && (
                        <div style={{
                          padding: '4px 10px',
                          borderRadius: 6,
                          background: '#DCfce7',
                          fontSize: 11,
                          fontWeight: 600,
                          color: '#166534',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                        }}>
                          <span>✓</span> Verified
                        </div>
                      )}

                      {/* Action icon */}
                      <div style={{ color: '#9CA3AF', fontSize: 18 }}>
                        →
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          });
        })()}
      </div>

      {/* Footer */}
      <div style={{
        padding: '12px 24px',
        borderTop: '1px solid #E5E7EB',
        background: '#FAFAFA',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontSize: 12,
        color: '#6B7280',
      }}>
        <span>Click any item to highlight on page</span>
        <span>{detections.filter(d => d.verified).length} of {detections.length} verified</span>
      </div>
    </div>
  );
}
