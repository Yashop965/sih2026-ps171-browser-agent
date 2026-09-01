// src/lib/visualization.ts
// Convert PII detections into visual coordinates for the heatmap

export interface FieldMarker {
  id: string;
  type: string;
  x: number; // percentage (0-100)
  y: number; // percentage (0-100)
  confidence: number;
  verified: boolean;
}

/**
 * Parse selector like "element#12" or "input[name='firstname']" 
 * and return visual representation
 */
export function parseSelector(selector: string): { id?: number; tag?: string; attr?: string } {
  const elementMatch = selector.match(/^element#(\d+)$/);
  if (elementMatch) {
    return { id: parseInt(elementMatch[1], 10) };
  }
  
  const tagMatch = selector.match(/^(\w+)\[/);
  if (tagMatch) {
    return { tag: tagMatch[1] };
  }
  
  return {};
}

/**
 * Convert detection data to visual markers
 * Positions are relative percentages based on typical form layouts
 */
export function detectionsToMarkers(
  detections: Array<{ type: string; selector: string; confidence: number; verified: boolean }>,
  pageHeight: number = 800
): FieldMarker[] {
  return detections.map((d, i) => {
    const parsed = parseSelector(d.selector);
    
    // Calculate relative position based on element ID or index
    let yPercent: number;
    if (parsed.id) {
      // Element IDs are typically 1-50 for forms
      yPercent = Math.min(95, Math.max(5, (parsed.id / 50) * 90));
    } else {
      // Fallback: distribute based on index
      yPercent = Math.min(95, Math.max(5, ((i + 1) / Math.max(detections.length, 1)) * 90));
    }
    
    // X position based on type (some types tend to be on left/right)
    let xPercent = 50;
    if (d.type === 'EMAIL' || d.type === 'PHONE') xPercent = 30;
    else if (d.type === 'CREDIT_CARD' || d.type === 'AADHAAR') xPercent = 70;
    else if (d.type === 'PAN' || d.type === 'IFSC') xPercent = 50;
    
    return {
      id: `${d.selector}-${d.type}`,
      type: d.type,
      x: xPercent,
      y: yPercent,
      confidence: d.confidence,
      verified: d.verified,
    };
  });
}

/**
 * Get color for PII type
 */
export function getMarkerColor(type: string, verified: boolean): string {
  if (!verified) return '#9a6700'; // amber for unverified
  
  switch (type) {
    case 'AADHAAR':
    case 'PAN':
    case 'CREDIT_CARD':
      return '#cf222e'; // red for sensitive
    case 'EMAIL':
    case 'PHONE':
      return '#0969da'; // blue for contact
    case 'PASSWORD_FIELD':
      return '#820710'; // dark red for passwords
    default:
      return '#1a7f37'; // green for others
  }
}

/**
 * Get icon for PII type
 */
export function getMarkerIcon(type: string): string {
  switch (type) {
    case 'AADHAAR':
      return '🇮🇳';
    case 'PAN':
      return '🅿️';
    case 'CREDIT_CARD':
    case 'DEBIT_CARD':
      return '💳';
    case 'EMAIL':
      return '📧';
    case 'PHONE':
      return '📱';
    case 'PASSWORD_FIELD':
      return '🔒';
    case 'IFSC':
      return '🏦';
    default:
      return '📍';
  }
}
