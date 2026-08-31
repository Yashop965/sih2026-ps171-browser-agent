/**
 * PII Detection Module (src/lib/pii/detector.ts)
 * 
 * Implements multi-layered detection & blacklisting for Indian and international PII:
 * - Password Blacklisting (auto-blacklists inputs by type or name/id/label patterns)
 * - Aadhaar (12-digit with Verhoeff checksum)
 * - PAN (Permanent Account Number)
 * - Credit/Debit cards (Luhn algorithm)
 * - IFSC codes
 * - Phone numbers
 * - Email addresses
 * - Face detection (Native FaceDetector API with fallback architecture)
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
  private faceDetector: any = null;
  private faceDetectorSupported: boolean = false;

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
    // Feature detection guard — check window.FaceDetector before instantiating
    if (typeof window !== 'undefined' && 'FaceDetector' in window) {
      try {
        this.faceDetector = new (window as any).FaceDetector();
        this.faceDetectorSupported = true;
        console.log('[PII] Native FaceDetector API supported');
      } catch (e) {
        this.faceDetectorSupported = false;
        console.warn('[PII] Native FaceDetector initialization failed:', e);
      }
    } else {
      this.faceDetectorSupported = false;
    }
  }

  /**
   * Synchronous DOM scan for PII and password blacklisting
   */
  scanDocument(): PIIDetection[] {
    this.detections = [];
    this.scanDOM();
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
    const SENSITIVE_PATTERN = /password|passwd|pwd|pin|secret/i;

    // 1. Password & Sensitive Input Auto-Blacklisting
    if (typeof document !== 'undefined') {
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea').forEach(input => {
        const type = input.getAttribute('type')?.toLowerCase() || 'text';
        const name = (input.getAttribute('name') || '').toLowerCase();
        const id = (input.getAttribute('id') || '').toLowerCase();
        const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();
        const placeholder = (input.getAttribute('placeholder') || '').toLowerCase();

        const isSensitiveType = type === 'password' || type === 'hidden';
        const isSensitiveName =
          SENSITIVE_PATTERN.test(name) ||
          SENSITIVE_PATTERN.test(id) ||
          SENSITIVE_PATTERN.test(ariaLabel) ||
          SENSITIVE_PATTERN.test(placeholder);

        if (isSensitiveType || isSensitiveName) {
          // ALWAYS blacklist password/sensitive fields
          this.detections.push({
            type: 'PASSWORD_FIELD',
            selector: this.getElementSelector(input),
            confidence: 0.99,
            isVerified: true,
            redacted: true,
            metadata: { tagName: input.tagName, isSensitiveType, isSensitiveName },
          });
        } else if (input.value && this.isLikelyPassword(input.value)) {
          this.detections.push({
            type: 'PASSWORD_VALUE',
            value: '[REDACTED_PASSWORD]',
            selector: this.getElementSelector(input),
            confidence: 0.90,
            isVerified: true,
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
      document.querySelectorAll<HTMLInputElement>('input:not([type="password"])').forEach(input => {
        if (input.value) {
          this.scanValue(input, input.value);
        }
      });
    }
  }

  private scanTextContent(element: Element, text: string): void {
    const patterns: [RegExp, PIIType, number][] = [
      [/\b(\d{4}\s?\d{4}\s?\d{4})\b/g, 'AADHAAR', 0.7],
      [/\b([A-Z]{5}\d{4}[A-Z]{1})\b/g, 'PAN', 0.8],
      [/\b(\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})\b/g, 'CREDIT_CARD', 0.7],
      [/\b([A-Z]{4}0[A-Z0-9]{7})\b/g, 'IFSC', 0.85],
      [/\b([+]?[\d\s-]{10,13})\b/g, 'PHONE', 0.6],
      [/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g, 'EMAIL', 0.95],
      [/(api[_-]?key|apikey|access[_-]?token)\s*[:=]\s*([^\s,;]+)/gi, 'API_KEY', 0.8],
    ];

    for (const [regex, piiType, baseConfidence] of patterns) {
      regex.lastIndex = 0;
      const matches = text.match(regex);
      if (matches) {
        for (const match of matches) {
          const detection: PIIDetection = {
            type: piiType,
            value: piiType === 'CREDIT_CARD' ? this.maskCard(match) : match.slice(0, 4) + '***',
            selector: this.getElementSelector(element),
            confidence: baseConfidence,
            isVerified: false,
            redacted: false,
          };
          this.detections.push(detection);
          this.verifyPII(detection, match);
        }
      }
    }
  }

  private scanValue(element: Element, value: string): void {
    const checks: Array<[RegExp, PIIType, number]> = [
      [/^(\d{12})$/, 'AADHAAR', 0.7],
      [/^([A-Z]{5}\d{4}[A-Z]{1})$/, 'PAN', 0.8],
      [/^(\d{16})$/, 'CREDIT_CARD', 0.7],
      [/^([A-Z]{4}0[A-Z0-9]{7})$/, 'IFSC', 0.85],
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
      default:
        isVerified = detection.confidence > 0.8;
    }
    detection.isVerified = isVerified;
    if (isVerified) {
      detection.confidence = Math.min(detection.confidence + 0.15, 0.99);
      detection.redacted = true;
    }
  }

  public async detectFaces(): Promise<void> {
    if (typeof document === 'undefined') return;

    const images = document.querySelectorAll('img');
    for (const img of Array.from(images)) {
      if (this.faceDetectorSupported && this.faceDetector) {
        try {
          const faces = await this.faceDetector.detect(img);
          for (const face of faces) {
            this.detections.push({
              type: 'FACE',
              selector: this.getElementSelector(img),
              confidence: 0.95,
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
          this.fallbackFaceDetection(img);
        }
      } else {
        // Fallback interface for browsers without native FaceDetector (e.g., Firefox)
        this.fallbackFaceDetection(img);
      }
    }
  }

  private fallbackFaceDetection(img: HTMLImageElement): void {
    // Heuristic face fallback: check image class/alt/title attributes for face/avatar keywords
    const altText = (img.getAttribute('alt') || '').toLowerCase();
    const titleText = (img.getAttribute('title') || '').toLowerCase();
    const classText = (img.className || '').toLowerCase();

    const faceKeywords = ['avatar', 'profile', 'user-photo', 'face', 'portrait', 'headshot'];
    const isLikelyFace = faceKeywords.some(
      kw => altText.includes(kw) || titleText.includes(kw) || classText.includes(kw)
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

  private verhoeffCheck(digits: string): boolean {
    if (digits.length !== 12 || !/^\d{12}$/.test(digits)) return false;
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

  private validatePAN(pan: string): boolean {
    if (!/^[A-Z]{5}\d{4}[A-Z]{1}$/.test(pan)) return false;
    const entityTypes = ['C', 'P', 'H', 'F', 'C', 'T', 'A', 'J', 'G', 'L'];
    return entityTypes.includes(pan[2]);
  }

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

  private maskCard(card: string): string {
    const digits = card.replace(/[\s-]/g, '');
    return `${digits.slice(0, 4)} **** **** ${digits.slice(-4)}`;
  }

  private isLikelyPassword(value: string): boolean {
    const hasUpper = /[A-Z]/.test(value);
    const hasLower = /[a-z]/.test(value);
    const hasDigit = /\d/.test(value);
    const hasSpecial = /[^a-zA-Z0-9]/.test(value);
    const strength = [hasUpper, hasLower, hasDigit, hasSpecial].filter(Boolean).length;
    return strength >= 3 && value.length >= 8;
  }

  private getElementSelector(element: Element): string {
    if (element.id) return `#${element.id}`;
    if (element.className && typeof element.className === 'string') {
      const classList = element.className.trim().split(/\s+/).slice(0, 2);
      if (classList.length > 0) {
        return `${element.tagName.toLowerCase()}.${classList.join('.')}`;
      }
    }
    return element.tagName.toLowerCase();
  }

  getDetections(): PIIDetection[] {
    return this.detections;
  }

  clear(): void {
    this.detections = [];
  }
}

export const piiManager = PIIManager.getInstance();
