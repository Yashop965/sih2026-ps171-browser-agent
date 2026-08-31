/**
 * Advanced Privacy & Security Unit Tests (Issue #11)
 * 
 * Tests for:
 * 1. Password field auto-blacklisting (types & name/id/label patterns)
 * 2. Outbound payload security scanner (scanOutboundPayload)
 * 3. FaceDetector feature check and unsupported browser fallback
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { isPasswordField, scanOutboundPayload } from '../src/lib/privacy';
import { PIIManager } from '../src/lib/pii/detector';

describe('Issue #11 - Advanced Privacy & Password Blacklisting', () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    globalThis.document = dom.window.document;
    globalThis.window = dom.window as any;
  });

  describe('isPasswordField - Blacklisting', () => {
    it('should detect input type="password"', () => {
      const el = dom.window.document.createElement('input');
      el.setAttribute('type', 'password');
      expect(isPasswordField(el as any)).toBe(true);
    });

    it('should detect input type="hidden"', () => {
      const el = dom.window.document.createElement('input');
      el.setAttribute('type', 'hidden');
      expect(isPasswordField(el as any)).toBe(true);
    });

    it('should detect name/id containing password, pin, secret, passwd, pwd', () => {
      const keywords = ['user_password', 'user_pin', 'app_secret', 'usr_passwd', 'user_pwd'];
      for (const kw of keywords) {
        const el = dom.window.document.createElement('input');
        el.setAttribute('type', 'text');
        el.setAttribute('name', kw);
        expect(isPasswordField(el as any)).toBe(true);
      }
    });

    it('should not blacklist standard text inputs like username', () => {
      const el = dom.window.document.createElement('input');
      el.setAttribute('type', 'text');
      el.setAttribute('name', 'username');
      expect(isPasswordField(el as any)).toBe(false);
    });
  });

  describe('Outbound Payload Scanner', () => {
    it('should allow safe sanitized payloads', () => {
      const safePayload = {
        url: 'https://example.com',
        title: 'Safe Page',
        interactiveElements: [{ id: 1, role: 'button', label: 'Submit' }],
        detectedPII: [{ type: 'EMAIL', confidence: 0.95, verified: true }]
      };
      const result = scanOutboundPayload(safePayload);
      assert(result.safe === true);
      expect(result.violations).toHaveLength(0);
    });

    it('should block transmission if payload contains unredacted password values', () => {
      const unsafePayload = {
        url: 'https://example.com',
        interactiveElements: [
          { id: 1, role: 'textbox', value: 'my_secret_password_123' }
        ]
      };
      const result = scanOutboundPayload(unsafePayload);
      expect(result.safe).toBe(false);
      expect(result.violations).toContain('UNREDACTED_PASSWORD_VALUE_DETECTED');
    });

    it('should block transmission if payload contains raw verified 12-digit Aadhaar', () => {
      // 12-digit number passing Verhoeff checksum: 100000000009
      const unsafePayload = {
        url: 'https://example.com',
        text: 'Aadhaar: 100000000009'
      };
      const result = scanOutboundPayload(unsafePayload);
      expect(result.safe).toBe(false);
      expect(result.violations).toContain('RAW_VERIFIED_AADHAAR_DETECTED');
    });
  });

  describe('FaceDetector Unsupported Browser Fallback', () => {
    it('should not throw when window.FaceDetector is missing', () => {
      // Ensure FaceDetector is undefined in window
      delete (globalThis.window as any).FaceDetector;
      expect(() => new PIIManager()).not.toThrow();
    });

    it('should execute fallback face detection on img elements when FaceDetector is missing', async () => {
      delete (globalThis.window as any).FaceDetector;
      const img = dom.window.document.createElement('img');
      img.setAttribute('alt', 'User profile avatar');
      dom.window.document.body.appendChild(img);

      const manager = new PIIManager();
      const detections = await manager.scanDocumentAsync();

      const faceDetections = detections.filter(d => d.type === 'FACE');
      expect(faceDetections.length).toBeGreaterThan(0);
      expect(faceDetections[0].metadata?.fallback).toBe(true);
    });
  });
});

function assert(condition: boolean) {
  expect(condition).toBe(true);
}
