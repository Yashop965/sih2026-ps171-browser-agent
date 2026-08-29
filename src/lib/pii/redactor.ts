/**
 * Redaction Engine
 * 
 * Applies visual redaction to detected PII:
 * - Password fields: blackout overlay
 * - Faces: blur effect
 * - Text PII: highlight with privacy badge
 */

export interface RedactionOptions {
  mode: 'blur' | 'blackout' | 'overlay' | 'replace';
  strength?: number; // 0-1 for blur
  color?: string;    // For blackout/overlay
}

export class RedactionEngine {
  private overlays: Map<string, HTMLElement> = new Map();

  /**
   * Apply redaction to all detected PII elements
   */
  applyRedactions(detections: Array<{ selector: string; type: string; redacted: boolean }>): void {
    // Clear previous redactions
    this.clearRedactions();

    for (const detection of detections) {
      if (!detection.redacted) continue;
      
      try {
        const element = document.querySelector(detection.selector);
        if (!element) continue;

        switch (detection.type) {
          case 'PASSWORD_FIELD':
          case 'PASSWORD_VALUE':
          case 'API_KEY':
            this.blackoutElement(element, detection);
            break;
          case 'FACE':
            this.blurFace(element, detection);
            break;
          default:
            this.overlayElement(element, detection);
        }
      } catch (e) {
        console.warn('[Redaction] Failed to redact:', detection.selector, e);
      }
    }
  }

  private blackoutElement(element: Element, detection: any): void {
    const rect = element.getBoundingClientRect();
    
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      left: ${rect.left}px;
      top: ${rect.top}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      background: #000;
      z-index: 2147483647;
      pointer-events: none;
    `;
    overlay.dataset.piiRedaction = 'true';
    overlay.dataset.type = detection.type;
    
    document.body.appendChild(overlay);
    this.overlays.set(detection.selector, overlay);
  }

  private blurFace(element: Element, detection: any): void {
    const rect = element.getBoundingClientRect();
    
    // Create blur overlay
    const blurDiv = document.createElement('div');
    blurDiv.style.cssText = `
      position: fixed;
      left: ${rect.left}px;
      top: ${rect.top}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      z-index: 2147483647;
      pointer-events: none;
    `;
    blurDiv.dataset.piiRedaction = 'true';
    blurDiv.dataset.type = 'FACE';
    
    document.body.appendChild(blurDiv);
    this.overlays.set(`face_${Date.now()}`, blurDiv);
  }

  private overlayElement(element: Element, detection: any): void {
    const rect = element.getBoundingClientRect();
    
    const badge = document.createElement('div');
    badge.style.cssText = `
      position: fixed;
      left: ${rect.left}px;
      top: ${rect.top - 24}px;
      background: rgba(220, 38, 38, 0.9);
      color: white;
      padding: 2px 8px;
      font-size: 12px;
      font-family: sans-serif;
      z-index: 2147483647;
      pointer-events: none;
      border-radius: 4px;
    `;
    badge.textContent = `🔒 ${detection.type}`;
    badge.dataset.piiRedaction = 'true';
    
    document.body.appendChild(badge);
    this.overlays.set(detection.selector, badge);
  }

  clearRedactions(): void {
    for (const [key, element] of this.overlays) {
      element.remove();
    }
    this.overlays.clear();
  }

  getOverlayCount(): number {
    return this.overlays.size;
  }
}

export const redactionEngine = new RedactionEngine();
