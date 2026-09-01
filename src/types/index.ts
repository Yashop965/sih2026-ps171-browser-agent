export interface InteractiveElement {
  id: number;
  tag: string;
  role: string;
  label: string;
  name: string;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  isPassword: boolean;
}

export interface ARIAElement {
  role: string;
  name: string;
  expanded?: boolean;
  checked?: string;
  required?: boolean;
  disabled?: boolean;
  depth: number;
}

export type PIIType = 
  | 'AADHAAR'
  | 'PAN'
  | 'CREDIT_CARD'
  | 'IFSC'
  | 'PHONE'
  | 'EMAIL'
  | 'PASSWORD_FIELD'
  | 'API_KEY'
  | 'FACE_DETECTED'
  | 'TEXT_PASSWORD';

export interface DetectedPII {
  type: PIIType;
  value?: string;
  selector: string;
  confidence: number;
  isVerified?: boolean;
  redacted: boolean;
}

export interface SanitizedDOMSnapshot {
  url: string;
  title: string;
  timestamp: number;
  rawHtml: string;
  accessibilityTree: ARIAElement[];
  interactiveElements: InteractiveElement[];
  detectedPII: DetectedPII[];
}

export interface SanitizedPayload {
  url: string;
  title: string;
  timestamp: number;
  interactiveElements: InteractiveElement[];
  accessibilityTree: ARIAElement[];
  detectedPII: Omit<DetectedPII, 'value'>[];
  hasScreenshots: boolean;
}

export interface AgentAction {
  type: 'CLICK' | 'TYPE' | 'SCROLL' | 'NAVIGATE' | 'WAIT' | 'COMPLETE';
  targetId?: number;
  text?: string;
  url?: string;
  direction?: 'up' | 'down';
  amount?: number;
  condition?: string;
}

export interface ServerResponse {
  success: boolean;
  action: AgentAction | null;
  message?: string;
  error?: string;
  reasoning?: string;
}

export interface VisionResult {
  type: 'OCR' | 'GROUNDING' | 'DESCRIPTION';
  data: any;
  boundingBoxes?: BoundingBox[];
  text?: string;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  score: number;
}

export interface PrivacyLogEntry {
  timestamp: number;
  tabId: number;
  url: string;
  type: string;
  selector: string;
  confidence: number;
  verified: boolean;
  action: 'REDACTED' | 'SENT_TO_SERVER' | 'SERVER_RESPONSE' | 'EXECUTION' | 'SUCCESS' | 'FAILURE';
  payloadSize?: number;
  actionType?: string;
  error?: string;
}

export interface PerformanceMetrics {
  dom_extract_ms: number;
  vision_inference_ms: number;
  plan_response_ms: number;
  action_execution_ms: number;
  total_step_ms: number;
  memory_mb: number;
  marks: PerfMark[];
}

export interface PerfMark {
  name: Stage;
  timestamp: number;
  durationMs: number;
}

export type Stage =
  | 'dom_extract'
  | 'vision_inference'
  | 'plan_response'
  | 'action_execution';

/**
 * A privacy event surfaced in the UI.
 *
 * `detail` is rendered on screen, so it must describe what was found without
 * ever containing the value itself — putting a detected Aadhaar number or
 * password in here would display real PII inside the very panel meant to
 * prove none escaped.
 */
export interface PrivacyEvent {
  id: string;
  timestamp: Date;
  type: 'detected' | 'redacted';
  category: PIIType;
  detail: string;
  confidence: number;
}  
