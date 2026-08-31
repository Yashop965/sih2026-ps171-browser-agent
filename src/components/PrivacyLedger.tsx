// src/components/PrivacyLedger.tsx
//
// Styling is inline rather than Tailwind: this panel is mounted inside the
// popup, which ships its own stylesheet and does not load Tailwind. Inline
// keeps it self-contained wherever it gets mounted.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PrivacyLogEntry } from '../types';
import {
  fetchEntries,
  clearLedger,
  downloadLedger,
  summarise,
  toneOf,
  labelOf,
  type LedgerTone,
} from '../lib/ledgerClient';

// Colour carries meaning, not decoration. Red is something we stopped,
// green is something we let through, amber is something that needs a look.
const TONE: Record<LedgerTone, { fg: string; bg: string; bar: string }> = {
  blocked: { fg: '#E4837D', bg: 'rgba(194,65,59,0.15)', bar: '#C2413B' },
  clean: { fg: '#6FBF9B', bg: 'rgba(63,143,111,0.15)', bar: '#3F8F6F' },
  warning: { fg: '#E0B25C', bg: 'rgba(201,146,46,0.15)', bar: '#C9922E' },
};

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const POLL_MS = 1000;

function clockTime(ms: number) {
  return new Date(ms).toLocaleTimeString([], {
    hour12: false,
    minute: '2-digit',
    second: '2-digit',
  });
}

export default function PrivacyLedger() {
  const [entries, setEntries] = useState<PrivacyLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const seenCount = useRef(0);

  const load = useCallback(async () => {
    try {
      setEntries(await fetchEntries());
      setError(null);
    } catch {
      setError('Background worker is not responding. Reload the extension.');
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // The background prepends, so new records arrive at the top. Only jump to
  // the top when something new lands and the reader is already near it —
  // scrolling them away from what they're reading would be worse.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (entries.length > seenCount.current && el.scrollTop < 40) el.scrollTop = 0;
    seenCount.current = entries.length;
  }, [entries]);

  async function onExport() {
    setBusy(true);
    try {
      await downloadLedger(entries);
    } finally {
      setBusy(false);
    }
  }

  async function onClear() {
    setBusy(true);
    try {
      await clearLedger();
      await load();
    } finally {
      setBusy(false);
    }
  }

  const stats = summarise(entries);
  const disabled = busy || entries.length === 0;

  const btn: React.CSSProperties = {
    border: '1px solid #2A323D',
    background: 'transparent',
    color: disabled ? '#4A525E' : '#C3CBD6',
    borderRadius: 4,
    padding: '6px 8px',
    fontSize: 11,
    cursor: disabled ? 'default' : 'pointer',
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: '#0E1116',
        color: '#D7DDE5',
      }}
    >
      <header style={{ borderBottom: '1px solid #1E242D', padding: '10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 13, fontWeight: 500 }}>
            Privacy ledger
          </h2>
          <span
            style={{
              marginLeft: 'auto',
              fontFamily: MONO,
              fontSize: 11,
              color: '#5B6673',
            }}
          >
            {stats.total} {stats.total === 1 ? 'record' : 'records'}
          </span>
        </div>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            columnGap: 12,
            rowGap: 4,
            marginTop: 8,
            fontFamily: MONO,
            fontSize: 11,
          }}
        >
          <span style={{ color: '#E4837D' }}>{stats.redacted} redacted</span>
          <span style={{ color: '#6FBF9B' }}>{stats.sent} sent</span>
          {stats.failed > 0 && (
            <span style={{ color: '#E0B25C' }}>{stats.failed} failed</span>
          )}
          <span style={{ color: '#5B6673' }}>
            {stats.verified} checksum-verified
          </span>
        </div>
      </header>

      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto' }}>
        {error ? (
          <p style={{ padding: '20px 12px', fontSize: 12, color: '#E0B25C' }}>
            {error}
          </p>
        ) : entries.length === 0 ? (
          <p
            style={{
              padding: '20px 12px',
              fontSize: 12,
              lineHeight: 1.6,
              color: '#5B6673',
            }}
          >
            Nothing recorded yet. Every detection, redaction and outbound
            payload will appear here as it happens.
          </p>
        ) : (
          <ol style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {entries.map((e, i) => {
              const tone = TONE[toneOf(e)];
              const seq = entries.length - i;

              return (
                <li
                  key={`${e.timestamp}-${i}`}
                  style={{
                    display: 'flex',
                    gap: 10,
                    borderBottom: '1px solid #161B22',
                    padding: '8px 12px',
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 2,
                      flexShrink: 0,
                      borderRadius: 2,
                      background: tone.bar,
                    }}
                  />

                  <span
                    style={{
                      width: 22,
                      flexShrink: 0,
                      textAlign: 'right',
                      fontFamily: MONO,
                      fontSize: 11,
                      color: '#48505C',
                    }}
                  >
                    {seq}
                  </span>

                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 6,
                      }}
                    >
                      <span
                        style={{
                          borderRadius: 3,
                          padding: '1px 6px',
                          fontFamily: MONO,
                          fontSize: 10,
                          textTransform: 'uppercase',
                          letterSpacing: '0.04em',
                          background: tone.bg,
                          color: tone.fg,
                        }}
                      >
                        {labelOf(e)}
                      </span>
                      <span
                        style={{
                          fontFamily: MONO,
                          fontSize: 10,
                          textTransform: 'uppercase',
                          letterSpacing: '0.04em',
                          color: '#7C8695',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {e.type}
                      </span>
                      {e.verified && (
                        <span
                          title="Confirmed by a checksum, not just a pattern match"
                          style={{
                            fontFamily: MONO,
                            fontSize: 10,
                            color: '#6FBF9B',
                          }}
                        >
                          ✓
                        </span>
                      )}
                      <span
                        style={{
                          marginLeft: 'auto',
                          flexShrink: 0,
                          fontFamily: MONO,
                          fontSize: 10,
                          color: '#48505C',
                        }}
                      >
                        {clockTime(e.timestamp)}
                      </span>
                    </div>

                    {e.selector && (
                      <p
                        style={{
                          margin: '4px 0 0',
                          fontFamily: MONO,
                          fontSize: 11,
                          color: '#C3CBD6',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {e.selector}
                      </p>
                    )}

                    {e.error && (
                      <p
                        style={{
                          margin: '4px 0 0',
                          fontSize: 11,
                          lineHeight: 1.4,
                          color: '#E0B25C',
                        }}
                      >
                        {e.error}
                      </p>
                    )}

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        marginTop: 4,
                        fontFamily: MONO,
                        fontSize: 10,
                        color: '#48505C',
                      }}
                    >
                      {e.payloadSize !== undefined && (
                        <span>{(e.payloadSize / 1024).toFixed(1)} KB</span>
                      )}
                      {e.actionType && <span>{e.actionType}</span>}
                      {e.confidence < 1 && (
                        <span style={{ marginLeft: 'auto' }}>
                          {Math.round(e.confidence * 100)}%
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <footer
        style={{
          display: 'flex',
          gap: 8,
          borderTop: '1px solid #1E242D',
          padding: '8px 12px',
        }}
      >
        <button onClick={onExport} disabled={disabled} style={{ ...btn, flex: 1 }}>
          Export JSON
        </button>
        <button onClick={onClear} disabled={disabled} style={btn}>
          Clear
        </button>
      </footer>
    </div>
  );
}