/**
 * PII Detection Module
 * 
 * Implements multi-layered detection for Indian and international PII:
 * - Aadhaar (12-digit with Verhoeff checksum)
 * - PAN (Permanent Account Number)
 * - Credit/Debit cards (Luhn algorithm)
 * - IFSC codes
 * - Phone numbers
 * - Email addresses
 * - Password fields and content
 * - Face detection (via Shape Detection API + fallback)
 */

export interface PIIDetection {
  type: PIIType;
  value?: string;
  selector: string;
  confidence: number;
  isVerified: boolean;
  redacted: boolean;
  metadata?: Record<string, any>;
}

import { validateAadhaar, validatePAN, validateCard } from './validators';

export type PIIType =
  | 'AADHAAR'
  | 'PAN'
  | 'CREDIT_CARD'
  | 'DEBIT_CARD'
  | 'IFSC'
  | 'PHONE'
  | 'EMAIL'
  | 'PASSWORD_FIELD'
  | 'PASSWORD_VALUE'
  | 'API_KEY'
  | 'FACE'
  | 'SSN'
  | 'TEXT_PASSWORD';

export class PIIManager {
  private static instance: PIIManager;
  private detections: PIIDetection[] = [];
  private faceDetector: any = null; // Use any for FaceDetector API

  static getInstance(): PIIManager {
    if (!PIIManager.instance) {
      PIIManager.instance = new PIIManager();
    }
    return PIIManager.instance;
  }

  constructor() {
    this.initFaceDetector();
  }

  private initFaceDetector(): void {
    // Try to use native FaceDetector API (Chrome/Edge)
    if ('FaceDetector' in window) {
      try {
        this.faceDetector = new (window as any).FaceDetector();
        console.log('[PII] FaceDetector API available');
      } catch (e) {
        console.warn('[PII] FaceDetector not available:', e);
      }
    }
  }

  /**
   * Synchronous DOM scan for immediate use (e.g., in content scripts)
   */
  scanDocument(): PIIDetection[] {
    this.detections = [];
    this.scanDOM();
    // Note: Face detection is async and skipped in sync mode
    return this.detections;
  }

  /**
   * Asynchronous DOM scan including fully awaited face detection
   */
  async scanDocumentAsync(): Promise<PIIDetection[]> {
    this.detections = [];
    this.scanDOM();
    await this.detectFaces();
    return this.detections;
  }

  private scanDOM(): void {
    // 1. Password fields
    document.querySelectorAll('input').forEach(input => {
      const type = input.getAttribute('type')?.toLowerCase() || 'text';
      const name = (input.getAttribute('name') || '').toLowerCase();
      const id = (input.getAttribute('id') || '').toLowerCase();
      
      if (type === 'password') {
        this.detections.push({
          type: 'PASSWORD_FIELD',
          selector: this.getElementSelector(input),
          confidence: 0.99,
          isVerified: true,
          redacted: true,
          metadata: { tagName: input.tagName, hasValue: !!input.value },
        });
      }
      
      // Check for password-like values even in non-password fields
      if (input.value && this.isLikelyPassword(input.value)) {
        this.detections.push({
          type: 'PASSWORD_VALUE',
          value: this.maskValue(input.value),
          selector: this.getElementSelector(input),
          confidence: 0.85,
          isVerified: false,
          redacted: true,
        });
      }
    });

    // 2. Text content scanning - ONLY in specific contexts
    // Scan labels, headings, paragraphs, spans, and divs but NOT table cells by default
    document.querySelectorAll('label, h1, h2, h3, h4, h5, h6, p, strong, b, em, span, div').forEach(el => {
      const text = el.textContent || '';
      if (text.length > 10 && text.length < 500) { // Only scan reasonable length text
        this.scanTextContent(el, text);
      }
    });

    // Only scan actual input/select/textarea elements, not text content
    const interactiveElements = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
    interactiveElements.forEach(el => {
      const input = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      if (input.value) {
        this.scanValue(input, input.value);
      }
    });

    // 4. Select elements
    document.querySelectorAll('select').forEach(select => {
      const selected = select.options[select.selectedIndex];
      if (selected?.value) {
        this.scanValue(select, selected.value);
      }
    });
  }

  private scanTextContent(element: Element, text: string): void {
    // Skip if text is mostly numeric (likely prices, codes, etc.)
    const numericMatches = text.match(/\d+/g);
    if (numericMatches && numericMatches.length > 2) {
      const numericRatio = numericMatches.join('').length / text.length;
      if (numericRatio > 0.7 && text.length < 50) {
        // Skip text that's mostly numbers and short (likely prices/codes)
        return;
      }
    }

    // Skip if in a table cell without context (but allow if it has labels)
    const tagName = element.tagName.toLowerCase();
    if ((tagName === 'td' || tagName === 'th') && element.parentElement) {
      const parent = element.parentElement;
      const parentTag = parent.tagName.toLowerCase();
      // Only skip if parent is a plain table (not a form or specific context)
      if (parentTag === 'table' && !parent.getAttribute('data-pii-context')) {
        // Check if cell has any text that looks like PII context
        const cellText = element.textContent?.toLowerCase() || '';
        const hasPIIContext = /phone|mobile|number|contact|email|address/i.test(cellText);
        if (!hasPIIContext) {
          return;
        }
      }
    }

    const patterns: [RegExp, PIIType, number][] = [
      [/([A-Z]{5}\d{4}[A-Z]{1})/g, 'PAN', 0.8],
      [/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, 'EMAIL', 0.95],
      [/(\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})/g, 'CREDIT_CARD', 0.7],
      [/([+]?[1-9][\d]{10,12})/g, 'PHONE', 0.6],
    ];

    for (const pattern of patterns) {
      const regex = pattern[0];
      const piiType = pattern[1];
      const baseConfidence = pattern[2];

      const matches = text.match(regex);
      if (matches) {
        for (const match of matches) {
          const detection: PIIDetection = {
            type: piiType,
            value: piiType === 'CREDIT_CARD' ? this.maskCard(match) : match.slice(0, 4) + '***',
            selector: this.getElementSelector(element),
            confidence: baseConfidence,
            isVerified: false,
            redacted: false, // Will be set after verification
          };

          this.detections.push(detection);

          // Verify with checksum
          this.verifyPII(detection, match);
        }
      }
    }
  }

  private scanValue(element: Element, value: string): void {
    // Skip if in price/cost context
    const selector = this.getElementSelector(element).toLowerCase();
    const parentLabels = this.getParentLabels(element).toLowerCase();

    // Don't flag if field name suggests it's not PII
    const nonPIIPatterns = ['price', 'cost', 'amount', 'fee', 'charge', 'rate', 'discount', 'coupon', 'pincode', 'zipcode', 'postal'];
    if (nonPIIPatterns.some(pattern => selector.includes(pattern) || parentLabels.includes(pattern))) {
      return;
    }

    const checks: Array<[RegExp, PIIType, number]> = [
      [/^\d{12}$/, 'AADHAAR', 0.7],
      [/^[A-Z]{5}\d{4}[A-Z]{1}$/, 'PAN', 0.8],
      [/^\d{16}$/, 'CREDIT_CARD', 0.7],
      [/^[A-Z]{4}0[A-Z0-9]{7}$/, 'IFSC', 0.85],
      [/^\+?[1-9]\d{10}$/, 'PHONE', 0.6],
      [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'EMAIL', 0.95],
    ];

    for (const [regex, piiType, confidence] of checks) {
      const match = value.match(regex);
      if (match) {
        const detection: PIIDetection = {
          type: piiType,
          value: piiType === 'CREDIT_CARD' ? this.maskCard(value) : value.slice(0, 4) + '***',
          selector: this.getElementSelector(element),
          confidence,
          isVerified: false,
          redacted: false,
        };
        
        this.detections.push(detection);
        // Pass full value for verification (regex doesn't use capture groups)
        this.verifyPII(detection, value);
      }
    }
  }

  private verifyPII(detection: PIIDetection, rawValue: string): void {
    let isVerified = false;
    
    switch (detection.type) {
      case 'AADHAAR':
        isVerified = validateAadhaar(rawValue);
        break;
      case 'PAN':
        isVerified = validatePAN(rawValue);
        break;
      case 'CREDIT_CARD':
      case 'DEBIT_CARD':
        isVerified = validateCard(rawValue);
        break;
    }
    
    detection.isVerified = isVerified;
    if (isVerified) {
      detection.confidence = Math.min(detection.confidence + 0.15, 0.99);
      detection.redacted = true;
    }
  }

  private async detectFaces(): Promise<void> {
    const images = Array.from(document.querySelectorAll('img'));

    // If native FaceDetector is available, use it
    if (this.faceDetector) {
      for (const img of images) {
        try {
          const faces = await this.faceDetector.detect(img as HTMLImageElement);
          for (const face of faces) {
            this.detections.push({
              type: 'FACE',
              selector: this.getElementSelector(img),
              confidence: 0.9,
              isVerified: true,
              redacted: true,
              metadata: {
                bounds: {
                  x: face.bounds.x,
                  y: face.bounds.y,
                  width: face.bounds.width,
                  height: face.bounds.height,
                },
              },
            });
          }
        } catch (e) {
          // Face detection failed, continue
        }
      }
      return;
    }

    // Fallback: heuristic detection based on image attributes
    for (const img of images) {
      const alt = (img.getAttribute('alt') || '').toLowerCase();
      const title = (img.getAttribute('title') || '').toLowerCase();
      const className = (img.getAttribute('class') || '').toLowerCase();

      const faceKeywords = ['avatar', 'profile', 'user-photo', 'face', 'portrait', 'headshot'];
      const isLikelyFace = faceKeywords.some(kw =>
        alt.includes(kw) || title.includes(kw) || className.includes(kw)
      );

      if (isLikelyFace) {
        this.detections.push({
          type: 'FACE',
          selector: this.getElementSelector(img),
          confidence: 0.65,
          isVerified: false,
          redacted: true,
          metadata: {
            fallback: true,
            method: 'attribute_heuristic',
            note: 'FaceDetector API unsupported on browser. Flagged via fallback heuristic.',
          },
        });
      }
    }
  }

  private maskValue(value: string): string {
    return '•'.repeat(Math.min(value.length, 8));
  }

  private maskCard(card: string): string {
    const digits = card.replace(/[\s-]/g, '');
    return `${digits.slice(0, 4)} **** **** ${digits.slice(-4)}`;
  }

  private isLikelyPassword(value: string): boolean {
    // Don't flag if field name/id suggests it's not a password
    const nonPasswordPatterns = ['phone', 'pin', 'code', 'otp', 'uuid', 'number', 'id', 'zip', 'postal'];
    const lowerValue = value.toLowerCase();
    if (nonPasswordPatterns.some(pattern => lowerValue.includes(pattern))) {
      return false;
    }

    // Require actual password-like characteristics:
    // 1. Must have at least 2 of: uppercase, lowercase, digit, special char
    const hasUpper = /[A-Z]/.test(value);
    const hasLower = /[a-z]/.test(value);
    const hasDigit = /\d/.test(value);
    const hasSpecial = /[^a-zA-Z0-9]/.test(value);

    const strength = [hasUpper, hasLower, hasDigit, hasSpecial].filter(Boolean).length;

    // Must have special char AND be at least 8 chars
    // This prevents flagging pure numeric PINs
    return hasSpecial && strength >= 2 && value.length >= 8;
  }

  /**
   * Get parent labels/context to determine if element is in a non-PII area
   */
  private getParentLabels(element: Element): string {
    let parent = element.parentElement;
    let labels = '';
    let depth = 0;
    while (parent && depth < 3) {
      labels += (parent.textContent || '').toLowerCase() + ' ';
      labels += (parent.getAttribute('aria-label') || '').toLowerCase() + ' ';
      labels += (parent.getAttribute('data-testid') || '').toLowerCase() + ' ';
      parent = parent.parentElement;
      depth++;
    }
    return labels;
  }

  private getElementSelector(element: Element): string {
    if (element.id) return `#${element.id}`;

    // Check for form-associated elements first
    const tagName = element.tagName.toLowerCase();
    const name = element.getAttribute('name');
    const type = element.getAttribute('type');

    if (tagName === 'input' && name) {
      return `input[name="${name}"]`;
    }
    if (tagName === 'input' && element.id) {
      return `#${element.id}`;
    }
    if ((tagName === 'select' || tagName === 'textarea') && name) {
      return `${tagName}[name="${name}"]`;
    }

    const classes = element.className;
    if (classes && typeof classes === 'string') {
      const classList = classes.trim().split(/\s+/).slice(0, 2);
      if (classList.length > 0) {
        return `${tagName}.${classList.join('.')}`;
      }
    }

    // Use XPath as fallback - but prefer specific selectors
    let xpath = '';
    let sibling = element;
    while (sibling.parentNode) {
      let pos = 1;
      let sib = sibling.previousSibling;
      while (sib) {
        if (sib.nodeType === Node.ELEMENT_NODE && sib.nodeName === sibling.nodeName) {
          pos++;
        }
        sib = sib.previousSibling;
      }
      xpath = `/${sibling.nodeName.toLowerCase()}[${pos}]${xpath}`;
      sibling = sibling.parentNode as Element;
    }
    return xpath || element.tagName.toLowerCase();
  }

  getDetections(): PIIDetection[] {
    return this.detections;
  }

  getSummary(): { total: number; byType: Record<string, number>; verified: number } {
    const byType: Record<string, number> = {};
    let verified = 0;
    
    for (const det of this.detections) {
      byType[det.type] = (byType[det.type] || 0) + 1;
      if (det.isVerified) verified++;
    }
    
    return {
      total: this.detections.length,
      byType,
      verified,
    };
  }

  clear(): void {
    this.detections = [];
  }
}

// Export singleton
export const piiManager = PIIManager.getInstance();
