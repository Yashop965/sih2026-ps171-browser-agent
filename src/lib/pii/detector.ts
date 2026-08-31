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
  private faceDetector: FaceDetector | null = null;

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
   * Scan document for PII
   */
  scanDocument(): PIIDetection[] {
    this.detections = [];
    
    // Scan DOM
    this.scanDOM();
    
    // Scan for faces if FaceDetector available
    this.detectFaces();
    
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

    // 2. Text content scanning
    document.querySelectorAll('div, span, p, td, th, label, strong, b').forEach(el => {
      const text = el.textContent || '';
      this.scanTextContent(el, text);
    });

    // 3. Input values (non-password)
    document.querySelectorAll('input:not([type="password"])').forEach(input => {
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
    const patterns: [RegExp, PIIType, number][] = [
      [/(\\d{4}\\s?\\d{4}\\s?\\d{4})/g, 'AADHAAR', 0.7],
      [/([A-Z]{5}\\d{4}[A-Z]{1})/g, 'PAN', 0.8],
      [/(\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4})/g, 'CREDIT_CARD', 0.7],
      [/^([A-Z]{4}0[A-Z0-9]{7})$/, 'IFSC', 0.85],
      [/([+]?[\\d\\s-]{10,13})/g, 'PHONE', 0.6],
      /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,})/g, 'EMAIL', 0.95],
      /(api[_-]?key|apikey|access[_-]?token)\\s*[:=]\\s*([^\\s,;]+)/gi, 'API_KEY', 0.8],
    ];

    for (const pattern of patterns) {
      const regex = pattern[0];
      const piiType = pattern[1];
      const baseConfidence = pattern[2];

      const matches = text.match(regex);
      if (matches) {
        for (const match of matches) {
          const isExact = typeof pattern[3] === 'undefined' || pattern[3];
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
    const checks: Array<[RegExp, PIIType, number]> = [
      [/^(\d{12})$/, 'AADHAAR', 0.7],
      /^([A-Z]{5}\d{4}[A-Z]{1})$/, 'PAN', 0.8,
      [/^(\d{16})$/, 'CREDIT_CARD', 0.7],
      /^([A-Z]{4}0[A-Z0-9]{7})$/, 'IFSC', 0.85,
      [/^(\+?[1-9]\d{10})$/, 'PHONE', 0.6],
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
        this.verifyPII(detection, match[1]);
      }
    }
  }

  private verifyPII(detection: PIIDetection, rawValue: string): void {
    let isVerified = false;
    
    switch (detection.type) {
      case 'AADHAAR':
        isVerified = this.verhoeffCheck(rawValue.replace(/\s/g, ''));
        break;
      case 'PAN':
        isVerified = this.validatePAN(rawValue);
        break;
      case 'CREDIT_CARD':
      case 'DEBIT_CARD':
        isVerified = this.luhnCheck(rawValue.replace(/[\s-]/g, ''));
        break;
    }
    
    detection.isVerified = isVerified;
    if (isVerified) {
      detection.confidence = Math.min(detection.confidence + 0.15, 0.99);
      detection.redacted = true;
    }
  }

  private async detectFaces(): Promise<void> {
    if (!this.faceDetector) return;
    
    const images = document.querySelectorAll('img');
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
  }

  // Verhoeff checksum algorithm for Aadhaar validation
  private verhoeffCheck(digits: string): boolean {
    if (digits.length !== 12) return false;
    if (!/^\d{12}$/.test(digits)) return false;
    
    const d = [
      [0,1,2,3,4,5,6,7,8,9],
      [1,2,3,4,0,6,7,8,9,5],
      [2,3,4,0,1,7,8,9,5,6],
      [3,4,0,1,2,8,9,5,6,7],
      [4,0,1,2,3,9,5,6,7,8],
      [5,9,8,7,6,0,4,3,2,1],
      [6,5,9,8,7,1,0,4,3,2],
      [7,6,5,9,8,2,1,0,4,3],
      [8,7,6,5,9,3,2,1,0,4],
      [9,8,7,6,5,4,3,2,1,0],
    ];
    
    const p = [
      [0,1,2,3,4,5,6,7,8,9],
      [1,2,3,4,0,6,7,8,9,5],
      [2,3,4,0,1,7,8,9,5,6],
      [3,4,0,1,2,8,9,5,6,7],
      [4,0,1,2,3,9,5,6,7,8],
      [5,0,9,8,7,4,3,2,1,6],
      [6,0,8,7,5,2,1,3,4,9],
      [7,0,5,6,8,3,4,2,9,1],
      [8,0,3,4,5,9,6,1,2,7],
      [9,0,2,1,3,8,7,4,6,5],
    ];
    
    let checksum = 0;
    const reversed = digits.split('').reverse().map(Number);
    
    for (let i = 0; i < reversed.length - 1; i++) {
      checksum = d[checksum][p[i % 8][reversed[i]]];
    }
    
    return checksum === reversed[reversed.length - 1];
  }

  // PAN validation
  private validatePAN(pan: string): boolean {
    if (!/^[A-Z]{5}\d{4}[A-Z]{1}$/.test(pan)) return false;
    
    const chars = pan.split('');
    const entityTypes = ['C', 'P', 'H', 'F', 'C', 'T', 'A', 'J', 'G', 'L'];
    if (!entityTypes.includes(chars[2])) return false;
    
    return true;
  }

  // Luhn algorithm for card validation
  private luhnCheck(number: string): boolean {
    if (number.length < 13 || number.length > 19) return false;
    
    let sum = 0;
    let isEven = false;
    
    for (let i = number.length - 1; i >= 0; i--) {
      let digit = parseInt(number[i], 10);
      
      if (isEven) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      
      sum += digit;
      isEven = !isEven;
    }
    
    return sum % 10 === 0;
  }

  private maskValue(value: string): string {
    return '•'.repeat(Math.min(value.length, 8));
  }

  private maskCard(card: string): string {
    const digits = card.replace(/[\s-]/g, '');
    return `${digits.slice(0, 4)} **** **** ${digits.slice(-4)}`;
  }

  private isLikelyPassword(value: string): boolean {
    // Heuristic: passwords are usually mixed case with special chars
    const hasUpper = /[A-Z]/.test(value);
    const hasLower = /[a-z]/.test(value);
    const hasDigit = /\d/.test(value);
    const hasSpecial = /[^a-zA-Z0-9]/.test(value);
    
    const strength = [hasUpper, hasLower, hasDigit, hasSpecial].filter(Boolean).length;
    return strength >= 3 && value.length >= 8;
  }

  private getElementSelector(element: Element): string {
    if (element.id) return `#${element.id}`;
    
    const classes = element.className;
    if (classes && typeof classes === 'string') {
      const classList = classes.trim().split(/\s+/).slice(0, 2);
      if (classList.length > 0) {
        return `${element.tagName.toLowerCase()}.${classList.join('.')}`;
      }
    }
    
    // Use XPath as fallback
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
