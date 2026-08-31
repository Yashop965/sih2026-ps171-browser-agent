/**
 * Redaction Engine (src/lib/pii/redactor.ts)
 * 
 * Applies visual redaction to detected PII:
 * - Password fields: blackout overlay
 * - Faces: backdrop blur effect
 * - Text PII: highlight overlay badge
 * - Canvas utilities for DOM & screenshot canvas redactions
 */

export interface RedactionOptions {
  mode: 'blur' | 'blackout' | 'overlay' | 'replace';
  strength?: number;
  color?: string;
}

export class RedactionEngine {
  private overlays: Map<string, HTMLElement> = new Map();

  /**
   * Apply visual DOM redaction overlays
   */
  applyRedactions(detections: Array<{ selector: string; type: string; redacted: boolean }>): void {
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
        console.warn('[Redaction] Failed to redact:', detection.selector);
      }
    }
  }

  /**
   * Canvas Redaction Utility: Redacts bounding regions directly on HTMLCanvasElement context
   */
  redactCanvasRegion(
    canvas: HTMLCanvasElement,
    rect: { x: number; y: number; width: number; height: number },
    mode: 'blackout' | 'blur' = 'blackout'
  ): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (mode === 'blackout') {
      ctx.fillStyle = '#000000';
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    } else if (mode === 'blur') {
      // Draw pixelated / blurred box over canvas region
      ctx.fillStyle = '#777777';
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
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
    overlay.dataset.type = 'PASSWORD';
    
    document.body.appendChild(overlay);
    this.overlays.set(detection.selector, overlay);
  }

  private blurFace(element: Element, detection: any): void {
    const rect = element.getBoundingClientRect();
    
    const blurDiv = document.createElement('div');
    blurDiv.style.cssText = `
      position: fixed;
      left: ${rect.left}px;
      top: ${rect.top}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      background: rgba(0, 0, 0, 0.2);
      z-index: 2147483647;
      pointer-events: none;
    `;
    blurDiv.dataset.piiRedaction = 'true';
    blurDiv.dataset.type = 'FACE';
    
    document.body.appendChild(blurDiv);
    this.overlays.set(`face_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`, blurDiv);
  }

  private overlayElement(element: Element, detection: any): void {
    const rect = element.getBoundingClientRect();
    
    const badge = document.createElement('div');
    badge.style.cssText = `
      position: fixed;
      left: ${rect.left}px;
      top: ${Math.max(0, rect.top - 24)}px;
      background: rgba(220, 38, 38, 0.9);
      color: white;
      padding: 2px 8px;
      font-size: 12px;
      font-family: sans-serif;
      z-index: 2147483647;
      pointer-events: none;
      border-radius: 4px;
    `;
    badge.textContent = `🔒 REDACTED PII`;
    badge.dataset.piiRedaction = 'true';
    
    document.body.appendChild(badge);
    this.overlays.set(detection.selector, badge);
  }

  clearRedactions(): void {
    for (const [_, element] of this.overlays) {
      element.remove();
    }
    this.overlays.clear();
  }

  getOverlayCount(): number {
    return this.overlays.size;
  }
}

export const redactionEngine = new RedactionEngine();
