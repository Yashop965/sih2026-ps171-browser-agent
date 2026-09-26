// src/components/VlmIndicator.tsx
//
// #136: live on-device VLM indicator for the popup. #142: the pipeline now
// lives in the offscreen host (dedicated module worker), so the pill polls
// the service worker (VLM_STATUS) every few seconds instead of the broken
// content-script isolated-world pipeline. Renders a compact status pill:
// ready / loading / idle / unavailable, plus the last OCR outcome when the
// model is live. Pure status — the pixels never leave the device and no PII
// reaches the UI.
//
// Tints follow the popup design tokens (success / warning / error / muted)
// so it reads alongside the ResourceMonitor above it.

import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import '../lib/vision/florence2'; // types only (VisionStatus)

interface VlmStatus {
  state: 'idle' | 'loading' | 'ready' | 'unsupported' | 'failed' | 'unknown';
  backend?: string;
  model?: string;
  lastOcrAt?: number;
  lastOcrOk?: boolean;
  lastOcrDetail?: string;
  lastLoadError?: string;
  loadFailedAt?: number;
}

const POLL_MS = 3000;

function fmtAgo(ts?: number): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export default function VlmIndicator() {
  const [st, setSt] = useState<VlmStatus | null>(null);
  const [reachable, setReachable] = useState(true);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const poll = async () => {
      try {
        // #142: query the service worker (offscreen host) - the content
        // script's isolated-world pipeline can never load its ORT backend,
        // so VLM_STATUS via the content script was always "idle/failed".
        const res: any = await browser.runtime.sendMessage({ type: 'VLM_STATUS' });
        if (!mounted.current) return;
        if (res?.ok && res.status) {
          setSt(res.status);
          setReachable(true);
        } else {
          // Host unreachable (offscreen API missing, doc failed to open).
          setSt(null);
          setReachable(false);
        }
      } catch {
        if (mounted.current) setReachable(false);
      }
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, []);

  const base: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    borderRadius: 10,
    border: '1px solid var(--border-light)',
    background: 'var(--bg-secondary)',
    fontSize: 12,
    color: 'var(--text-secondary)',
    margin: '0 0 10px',
  };

  const dot = (color: string, pulse = false): React.CSSProperties => ({
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
    animation: pulse ? 'vlmPulse 1.4s ease-in-out infinite' : 'none',
    boxShadow: pulse ? `0 0 0 3px ${color}22` : 'none',
  });

  let content: React.ReactNode;
  if (!reachable) {
    content = (
      <>
        <span style={dot('var(--text-muted)')}></span>
        <span>VLM</span>
        <span style={{ opacity: 0.7 }}>host unreachable</span>
      </>
    );
  } else if (!st || st.state === 'unknown') {
    content = (
      <>
        <span style={dot('var(--text-muted)')}></span>
        <span>VLM</span>
        <span style={{ opacity: 0.7 }}>checking…</span>
      </>
    );
  } else {
    switch (st.state) {
      case 'ready':
        content = (
          <>
            <span style={dot('var(--success)', true)}></span>
            <strong style={{ color: 'var(--text-primary)' }}>VLM live</strong>
            <span>{st.backend ?? ''}</span>
            {st.lastOcrAt ? (
              <span style={{ opacity: 0.7 }}>
                · last OCR {st.lastOcrOk ? 'ok' : `failed (${st.lastOcrDetail ?? '?'})`}{' '}
                {fmtAgo(st.lastOcrAt)}
              </span>
            ) : (
              <span style={{ opacity: 0.7 }}>· no OCR run yet</span>
            )}
          </>
        );
        break;
      case 'loading':
        content = (
          <>
            <span style={dot('var(--warning)', true)}></span>
            <strong style={{ color: 'var(--text-primary)' }}>VLM loading</strong>
            <span style={{ opacity: 0.7 }}>on-device model ({st.backend ?? '…'})</span>
          </>
        );
        break;
      case 'unsupported':
        content = (
          <>
            <span style={dot('var(--error)')}></span>
            <strong style={{ color: 'var(--text-primary)' }}>VLM unavailable</strong>
            <span style={{ opacity: 0.7 }}>no WebGPU on this browser</span>
          </>
        );
        break;
      case 'failed':
        content = (
          <>
            <span style={dot('var(--error)')}></span>
            <strong style={{ color: 'var(--text-primary)' }}>VLM load failed</strong>
            <span style={{ opacity: 0.7 }}>
              {st.lastLoadError ? `${st.lastLoadError}` : 'model download/initialization error'}
            </span>
            {st.loadFailedAt ? (
              <span style={{ opacity: 0.5 }}>· {fmtAgo(st.loadFailedAt)}</span>
            ) : null}
          </>
        );
        break;
      default:
        // #142/#149: the host closes after each run ends, so 'idle' now
        // usually means "model not loaded right now" - not that no tab was
        // detected.
        content = (
          <>
            <span style={dot('var(--text-muted)')}></span>
            <span>VLM idle</span>
            <span style={{ opacity: 0.7 }}>
              loads on first vision check ({st.backend ?? 'auto'})
            </span>
          </>
        );
    }
  }

  return (
    <div style={base}>
      <style>{`@keyframes vlmPulse{0%,100%{opacity:1}50%{opacity:.45}}`}</style>
      {content}
    </div>
  );
}
