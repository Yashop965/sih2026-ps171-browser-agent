import { defineContentScript } from 'wxt/sandbox';

/**
 * Content Script - DOM Capture + PII Redaction
 * 
 * This script runs in the page context and:
 * 1. Captures DOM structure and accessibility tree
 * 2. Detects and redacts PII before sending to server
 * 3. Posts sanitized data to the background script
 */
defineContentScript({
  main(ctx) {
    console.log('[PII-Agent] Content script loaded');
    
    // Initialize PII detector
    const piiDetector = new PIIDetector();
    
    // Capture DOM snapshot with PII redaction
    function captureDOM(): SanitizedDOMSnapshot {
      const html = document.documentElement.outerHTML;
      const a11yTree = buildAccessibilityTree(document);
      const interactiveElements = captureInteractiveElements();
      
      return {
        url: window.location.href,
        title: document.title,
        timestamp: Date.now(),
        rawHtml: html,
        accessibilityTree: a11yTree,
        interactiveElements,
        detectedPII: piiDetector.scanDocument(),
      };
    }
    
    // Capture interactive elements for action targeting
    function captureInteractiveElements(): InteractiveElement[] {
      const selectors = [
        'button', 'a[href]', 'input', 'select', 'textarea',
        '[role="button"]', '[role="link"]', '[role="textbox"]',
        '[tabindex]:not([tabindex="-1"])',
        'details summary', 'summary'
      ].join(', ');
      
      const elements = document.querySelectorAll(selectors) as NodeListOf<HTMLElement>;
      const result: InteractiveElement[] = [];
      
      elements.forEach((el, index) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        
        result.push({
          id: index,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          label: el.textContent?.trim().slice(0, 50) || '',
          name: el.getAttribute('name') || el.getAttribute('id') || '',
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          isPassword: el.getAttribute('type') === 'password',
        });
      });
      
      return result;
    }
    
    // Build simplified accessibility tree
    function buildAccessibilityTree(root: HTMLElement): ARIAElement[] {
      const nodes: ARIAElement[] = [];
      
      function traverse(node: Node, depth: number = 0) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement;
          const role = el.getAttribute('role') || getDefaultRole(el.tagName);
          
          if (role && role !== 'presentation' && role !== 'none') {
            nodes.push({
              role,
              name: el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 100) || '',
              expanded: el.getAttribute('aria-expanded') === 'true',
              checked: el.getAttribute('aria-checked') || undefined,
              required: el.getAttribute('aria-required') === 'true',
              disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
              depth,
            });
          }
        }
        
        for (const child of node.childNodes) {
          traverse(child, depth + 1);
        }
      }
      
      traverse(root);
      return nodes;
    }
    
    function getDefaultRole(tag: string): string {
      const roleMap: Record<string, string> = {
        'BUTTON': 'button',
        'A': 'link',
        'INPUT': 'textbox',
        'SELECT': 'combobox',
        'TEXTAREA': 'textbox',
        'NAV': 'navigation',
        'MAIN': 'main',
        'HEADER': 'banner',
        'FOOTER': 'contentinfo',
        'ARTICLE': 'article',
        'SECTION': 'region',
        'DETAILS': 'group',
        'SUMMARY': 'button',
      };
      return roleMap[tag.toUpperCase()] || '';
    }
    
    // Expose to background via message passing
    ctx.addCommand('capturePage', captureDOM);
    
    // Listen for PII scrubbing requests
    ctx.addEventListener(window, 'message', (event) => {
      if (event.data?.type === 'SCRUB_PII') {
        const scrubbed = piiDetector.scrubHTML(event.data.html);
        event.source?.postMessage({ type: 'SCRUBBED', html: scrubbed });
      }
    });
  },
});

// PII Detection Engine
class PIIDetector {
  private static readonly PATTERNS: Record<string, RegExp> = {
    // Indian PII
    AADHAAR: /^\d{4}\s?\d{4}\s?\d{4}$/u,
    PAN: /^[A-Z]{5}\d{4}[A-Z]{1}$/u,
    IFSC: /^[A-Z]{4}0[A-Z0-9]{7}$/u,
    PHONE: /^\+?[1-9]\d{9,11}$/u,
    EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/u,
    
    // International PII
    CREDIT_CARD: /^\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}$/u,
    SSN: /^\d{3}-?\d{2}-?\d{4}$/u,
    
    // Sensitive content
    PASSWORD_FIELD: /password|passwd|pwd|pin/i,
    API_KEY: /api[_-]?key|apikey|access[_-]?token/i,
  };
  
  scanDocument(): DetectedPII[] {
    const detections: DetectedPII[] = [];
    
    // Scan input values
    document.querySelectorAll('input').forEach(input => {
      const type = input.getAttribute('type')?.toLowerCase() || 'text';
      const name = input.getAttribute('name') || input.getAttribute('id') || '';
      
      if (type === 'password' || this.PATTERNS.PASSWORD_FIELD.test(name)) {
        detections.push({
          type: 'PASSWORD_FIELD',
          selector: this.getElementSelector(input),
          confidence: 0.99,
          redacted: true,
        });
      } else if (input.value) {
        for (const [piiType, pattern] of Object.entries(this.PATTERNS)) {
          if (piiType === 'PASSWORD_FIELD') continue;
          if (pattern.test(input.value)) {
            detections.push({
              type: piiType as PIIType,
              value: piiType === 'CREDIT_CARD' ? this.maskCard(input.value) : input.value.slice(0, 4) + '***',
              selector: this.getElementSelector(input),
              confidence: this.getConfidence(piiType, input.value),
              redacted: true,
            });
          }
        }
      }
    });
    
    // Scan text content for PII
    document.querySelectorAll('div, span, p, td, th, label').forEach(el => {
      const text = el.textContent || '';
      for (const [piiType, pattern] of Object.entries(this.PATTERNS)) {
        if (piiType === 'PASSWORD_FIELD') continue;
        const matches = text.match(pattern);
        if (matches) {
          detections.push({
            type: piiType as PIIType,
            value: piiType === 'CREDIT_CARD' ? this.maskCard(matches[0]) : matches[0].slice(0, 4) + '***',
            selector: this.getElementSelector(el),
            confidence: this.getConfidence(piiType, matches[0]),
            redacted: true,
          });
        }
      }
    });
    
    // Run specialized validators
    this.validateAndRefine(detections);
    
    return detections;
  }
  
  scrubHTML(html: string): string {
    let scrubbed = html;
    
    // Redact password fields
    scrubbed = scrubbed.replace(/(<input[^>]*type=["']password["'][^>]*)>/g, '$1 data-pii-redacted="true">');
    scrubbed = scrubbed.replace(/(<input[^>]*name=["'][^"']*password[^"']*["'][^>]*)>/g, '$1 data-pii-redacted="true">');
    
    // Mask detected PII values in text content
    scrubbed = scrubbed.replace(
      /(\\d{4}\\s?\\d{4}\\s?\\d{4})/,
      'XXX XXX XXX'
    );
    
    scrubbed = scrubbed.replace(
      /([A-Z]{5}\\d{4}[A-Z]{1})/,
      'XXXXX9999X'
    );
    
    return scrubbed;
  }
  
  private validateAndRefine(detections: DetectedPII[]): void {
    // Aadhaar: Verhoeff checksum validation
    detections.forEach(d => {
      if (d.type === 'AADHAAR') {
        const digits = d.value?.replace(/\s/g, '') || '';
        d.isVerified = this.verhoeffCheck(digits);
        d.confidence = d.isVerified ? 0.98 : 0.3;
      }
      if (d.type === 'PAN') {
        d.isVerified = this.validatePAN(d.value || '');
        d.confidence = d.isVerified ? 0.95 : 0.2;
      }
      if (d.type === 'CREDIT_CARD') {
        const digits = d.value?.replace(/[\s-]/g, '') || '';
        d.isVerified = this.luhnCheck(digits);
        d.confidence = d.isVerified ? 0.97 : 0.3;
      }
    });
  }
  
  // Verhoeff algorithm for Aadhaar validation
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
  private validatePAN.pan: string): boolean {
    if (!/^[A-Z]{5}\d{4}[A-Z]{1}$/.test(pan)) return false;
    
    const chars = pan.split('');
    // Third character indicates entity type
    const entityTypes = ['C', 'P', 'H', 'F', 'C', 'T', 'A', 'J', 'G', 'L'];
    if (!entityTypes.includes(chars[2])) return false;
    
    return true;
  }
  
  // Luhn algorithm for credit cards
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
    const digits = card.replace(/\s|-/g, '');
    return digits.slice(0, 4) + ' **** **** ' + digits.slice(-4);
  }
  
  private getConfidence(type: string, value: string): number {
    const baseConfidence: Record<string, number> = {
      AADHAAR: 0.85,
      PAN: 0.90,
      CREDIT_CARD: 0.85,
      IFSC: 0.80,
      PHONE: 0.75,
      EMAIL: 0.95,
    };
    return baseConfidence[type] || 0.7;
  }
  
  private getElementSelector(element: Element): string {
    if (element.id) return `#${element.id}`;
    if (element.className && typeof element.className === 'string') {
      const classes = element.className.trim().split(/\s+/).slice(0, 2).join('.');
      return `${element.tagName.toLowerCase()}.${classes}`;
    }
    return element.tagName.toLowerCase();
  }
}
