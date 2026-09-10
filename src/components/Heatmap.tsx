// src/components/Heatmap.tsx
//
// Visual heatmap showing PII detections overlaid on a mini page representation
// Interactive: hover for details, click to highlight on page

import { useState, useCallback } from 'react';
import type { Detection } from '../lib/ledgerClient';

const TYPE_COLORS: Record<string, string> = {
  'AADHAAR': '#E63946',      // Red
  'PAN': '#F4A261',          // Orange
  'CREDIT_CARD': '#E76F51',  // Coral
  'EMAIL': '#457B9D',        // Blue
  'PHONE': '#2A9D8f',        // Teal
  'IFSC': '#6B8E23',         // Olive
  'PASSWORD_FIELD': '#9D4EDD', // Purple
  'PASSWORD_VALUE': '#7B2CBF', // Dark purple
};

const TYPE_LABELS: Record<string, string> = {
  'AADHAAR': 'Aadhaar',
  'PAN': 'PAN',
  'CREDIT_CARD': 'Card',
  'EMAIL': 'Email',
  'PHONE': 'Phone',
  'IFSC': 'IFSC',
  'PASSWORD_FIELD': 'Password',
  'PASSWORD_VALUE': 'Password',
};

interface HeatmapProps {
  detections: Detection[];
  onHighlight: (selector: string) => void;
}

export default function Heatmap({ detections, onHighlight }: HeatmapProps) {
  const [hoveredDetection, setHoveredDetection] = useState<Detection | null>(null);
  const [selectedType, setSelectedType] = useState<string | null>(null);

  if (detections.length === 0) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        padding: '40px 20px',
        textAlign: 'center',
      }}>
        <div style={{
          width: 60,
          height: 60,
          borderRadius: '50%',
          background: '#F0EFEC',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 16,
        }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#9A9A9A" strokeWidth="1.5">
            <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
            <path d="M12 6v6l4 2" />
          </svg>
        </div>
        <p style={{ fontSize: 13, color: '#6B6B6B', marginBottom: 8 }}>No detections yet</p>
        <p style={{ fontSize: 11, color: '#9A9A9A' }}>Start the agent to detect PII on the page</p>
      </div>
    );
  }

  // Group by type
  const byType = detections.reduce((acc, d) => {
    acc[d.type] = acc[d.type] || [];
    acc[d.type].push(d);
    return acc;
  }, {} as Record<string, Detection[]>);

  // Calculate heatmap positions (simplified grid layout)
  const totalDetections = detections.length;
  const columns = Math.ceil(Math.sqrt(totalDetections * 1.5));
  const rows = Math.ceil(totalDetections / columns);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: '#ffffff',
    }}>
      {/* Header with stats */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid #E8E6E1',
        background: '#F8F7F4',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 10,
        }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#0D0D0D', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
            {totalDetections} Detections
          </span>
          <span style={{ fontSize: 10, color: '#6B6B6B' }}>
            {Object.keys(byType).length} types
          </span>
        </div>

        {/* Filter buttons */}
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
        }}>
          <button
            onClick={() => setSelectedType(null)}
            style={{
              padding: '4px 10px',
              fontSize: 9,
              border: '1px solid #D0CDC6',
              borderRadius: 2,
              background: selectedType === null ? '#0D0D0D' : 'transparent',
              color: selectedType === null ? '#FFFFFF' : '#6B6B6B',
              cursor: 'pointer',
              fontFamily: 'monospace',
              letterSpacing: '0.04em',
            }}
          >
            ALL
          </button>
          {Object.entries(byType).map(([type, typeDetections]) => (
            <button
              key={type}
              onClick={() => setSelectedType(selectedType === type ? null : type)}
              style={{
                padding: '4px 10px',
                fontSize: 9,
                border: '1px solid #D0CDC6',
                borderRadius: 2,
                background: selectedType === type ? TYPE_COLORS[type] || '#0D0D0D' : 'transparent',
                color: selectedType === type ? '#FFFFFF' : '#6B6B6B',
                cursor: 'pointer',
                fontFamily: 'monospace',
                letterSpacing: '0.04em',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <span style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: TYPE_COLORS[type] || '#0D0D0D',
                display: 'inline-block',
              }} />
              {TYPE_LABELS[type] || type} ({typeDetections.length})
            </button>
          ))}
        </div>
      </div>

      {/* Heatmap visualization */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: 16,
        background: '#fafafa',
      }}>
        {/* Page representation */}
        <div style={{
          position: 'relative',
          background: '#ffffff',
          border: '1px solid #E8E6E1',
          borderRadius: 4,
          padding: 20,
          minHeight: 300,
        }}>
          {/* Grid background */}
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundImage: 'linear-gradient(rgba(0,0,0,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.03) 1px, transparent 1px)',
            backgroundSize: '20px 20px',
            borderRadius: 4,
            pointerEvents: 'none',
          }} />

          {/* Heatmap dots */}
          <div style={{
            position: 'relative',
            zIndex: 1,
          }}>
            {detections.map((detection, index) => {
              const color = TYPE_COLORS[detection.type] || '#8B6914';
              const size = detection.verified ? 16 : 12;
              const opacity = 0.6 + detection.confidence * 0.4;
              const isSelected = selectedType === null || selectedType === detection.type;
              const isHovered = hoveredDetection?.selector === detection.selector;

              // Distribute across the area
              const col = index % columns;
              const row = Math.floor(index / columns);
              const x = 20 + col * 50;
              const y = 20 + row * 40;

              return (
                <div
                  key={`${detection.selector}-${index}`}
                  onClick={() => isSelected && onHighlight(detection.selector)}
                  onMouseEnter={() => setHoveredDetection(detection)}
                  onMouseLeave={() => setHoveredDetection(null)}
                  title={`${TYPE_LABELS[detection.type] || detection.type}: ${detection.selector} (${Math.round(detection.confidence * 100)}% confidence)`}
                  style={{
                    position: 'absolute',
                    left: x,
                    top: y,
                    width: size,
                    height: size,
                    borderRadius: '50%',
                    background: color,
                    opacity: isSelected ? opacity : 0.2,
                    cursor: isSelected ? 'pointer' : 'default',
                    transition: 'all 0.2s ease',
                    transform: isHovered ? 'scale(1.3)' : 'scale(1)',
                    boxShadow: isHovered
                      ? `0 0 12px ${color}80, 0 0 24px ${color}40`
                      : `0 0 6px ${color}40`,
                    border: `2px solid ${color}`,
                  }}
                />
              );
            })}
          </div>

          {/* Legend */}
          <div style={{
            position: 'absolute',
            bottom: 12,
            right: 12,
            background: 'rgba(255,255,255,0.95)',
            border: '1px solid #E8E6E1',
            borderRadius: 4,
            padding: '8px 12px',
            fontSize: 9,
            fontFamily: 'monospace',
          }}>
            <div style={{ fontWeight: 600, marginBottom: 6, color: '#0D0D0D' }}>LEGEND</div>
            {Object.entries(TYPE_COLORS).slice(0, 6).map(([type, color]) => (
              <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <span style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: color,
                  display: 'inline-block',
                }} />
                <span style={{ color: '#6B6B6B' }}>{TYPE_LABELS[type] || type}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Hover details */}
        {hoveredDetection && (
          <div style={{
            marginTop: 12,
            padding: 12,
            background: '#ffffff',
            border: '1px solid #E8E6E1',
            borderRadius: 4,
            fontSize: 11,
          }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 8,
            }}>
              <span style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: TYPE_COLORS[hoveredDetection.type] || '#8B6914',
                display: 'inline-block',
              }} />
              <span style={{ fontWeight: 600, color: '#0D0D0D' }}>
                {TYPE_LABELS[hoveredDetection.type] || hoveredDetection.type}
              </span>
              {hoveredDetection.verified && (
                <span style={{
                  marginLeft: 'auto',
                  fontSize: 9,
                  color: '#2D5A27',
                  background: 'rgba(45,90,39,0.1)',
                  padding: '2px 6px',
                  borderRadius: 2,
                }}>
                  ✓ VERIFIED
                </span>
              )}
            </div>
            <div style={{ color: '#6B6B6B', fontFamily: 'monospace', fontSize: 10 }}>
              Selector: {hoveredDetection.selector}
            </div>
            <div style={{ color: '#6B6B6B', fontFamily: 'monospace', fontSize: 10, marginTop: 4 }}>
              Confidence: {Math.round(hoveredDetection.confidence * 100)}%
            </div>
            <button
              onClick={() => onHighlight(hoveredDetection.selector)}
              style={{
                marginTop: 8,
                padding: '4px 12px',
                fontSize: 10,
                border: '1px solid #0D0D0D',
                borderRadius: 2,
                background: 'transparent',
                color: '#0D0D0D',
                cursor: 'pointer',
                fontFamily: 'monospace',
              }}
            >
              Highlight on Page
            </button>
          </div>
        )}
      </div>

      {/* Footer stats */}
      <div style={{
        padding: '10px 16px',
        borderTop: '1px solid #E8E6E1',
        background: '#F8F7F4',
        display: 'flex',
        justifyContent: 'space-between',
        fontSize: 10,
        color: '#6B6B6B',
        fontFamily: 'monospace',
      }}>
        <span>Click dots to highlight • Hover for details</span>
        <span>{detections.filter(d => d.verified).length} verified</span>
      </div>
    </div>
  );
}
