// src/components/PrivacyLedger.tsx
//
// Two views over the same privacy story:
//   Detections — what is on the page right now
//   Audit log  — what has already happened
//
// Styling is inline rather than Tailwind: this panel is mounted inside the
// popup, which ships its own stylesheet and does not load Tailwind.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PrivacyLogEntry } from '../types';
import {
  fetchEntries,
  fetchDetections,
  highlightElement,
  copySelector,
  clearLedger,
  downloadLedger,
  summarise,
  summariseDetections,
  toneOf,
  labelOf,
  type Detection,
  type LedgerTone,
} from '../lib/ledgerClient';

// Colour carries meaning, not decoration. Red is something we stopped,
// green is something we let through, amber is something that needs a look.
const TONE: Record<LedgerTone, { fg: string; bg: string; bar: string }> = {
  blocked: { fg: '#820710', bg: 'rgba(130,7,16,0.08)', bar: '#cf222e' },
  clean: { fg: '#1a7f37', bg: 'rgba(26,127,55,0.08)', bar: '#2da44e' },
  warning: { fg: '#9a6700', bg: 'rgba(154,103,0,0.08)', bar: '#d0ab00' },
};

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const POLL_MS = 1000;

type View = 'detections' | 'log' | 'heatmap';
type SortKey = 'type' | 'confidence' | 'selector';

function clockTime(ms: number) {
  return new Date(ms).toLocaleTimeString([], {
    hour12: false,
    minute: '2-digit',
    second: '2-digit',
  });
}

export default function PrivacyLedger() {
  const [view, setView] = useState<View>('detections');

  const [entries, setEntries] = useState<PrivacyLogEntry[]>([]);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [sortKey, setSortKey] = useState<SortKey>('confidence');
  const [sortAsc, setSortAsc] = useState(false);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const seenCount = useRef(0);

  const load = useCallback(async () => {
    try {
      setEntries(await fetchEntries());
      setError(null);
    } catch {
      setError('Background worker is not responding. Reload the extension.');
    }

    // Detections come from the content script, which may not be present on
    // extension pages or a tab opened before the extension loaded. That is
    // a normal state, not an error worth shouting about.
    try {
      setDetections(await fetchDetections());
    } catch {
      setDetections([]);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // The background prepends, so new records arrive at the top. Only jump to
  // the top when something new lands and the reader is already near it.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || view !== 'log') return;
    if (entries.length > seenCount.current && el.scrollTop < 40) el.scrollTop = 0;
    seenCount.current = entries.length;
  }, [entries, view]);

  // Transient feedback for copy / highlight, cleared on its own.
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 1800);
    return () => clearTimeout(id);
  }, [note]);

  async function onExport() {
    setBusy(true);
    try {
      await downloadLedger(entries, detections);
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

  async function onRowClick(d: Detection) {
    const result = await highlightElement(d.selector);
    setNote(result.ok ? `Highlighted ${d.selector}` : result.error ?? 'Not found on page');
  }

  async function onCopy(e: React.MouseEvent, selector: string) {
    e.stopPropagation();
    setNote((await copySelector(selector)) ? 'Selector copied' : 'Copy failed');
  }

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(key !== 'confidence'); // confidence reads best high-first
    }
  }

  const stats = summarise(entries);
  const dStats = summariseDetections(detections);

  const visible = detections
    .filter((d) => !typeFilter || d.type === typeFilter)
    .slice()
    .sort((a, b) => {
      const dir = sortAsc ? 1 : -1;
      if (sortKey === 'confidence') return (a.confidence - b.confidence) * dir;
      return a[sortKey].localeCompare(b[sortKey]) * dir;
    });

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

  const tab = (v: View): React.CSSProperties => ({
    border: 'none',
    background: 'transparent',
    color: view === v ? '#D7DDE5' : '#5B6673',
    borderBottom: `1.5px solid ${view === v ? '#6FBF9B' : 'transparent'}`,
    padding: '4px 2px',
    marginRight: 14,
    fontSize: 12,
    cursor: 'pointer',
  });

  const th: React.CSSProperties = {
    textAlign: 'left',
    padding: '4px 6px',
    fontFamily: MONO,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: '#5B6673',
    cursor: 'pointer',
    userSelect: 'none',
    borderBottom: '1px solid #1E242D',
  };

  const td: React.CSSProperties = {
    padding: '6px',
    fontFamily: MONO,
    fontSize: 11,
    borderBottom: '1px solid #161B22',
  };

  function arrow(key: SortKey) {
    if (key !== sortKey) return '';
    return sortAsc ? ' ▲' : ' ▼';
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: '#ffffff',
        color: '#1f2328',
      }}
    >
      <header style={{ borderBottom: '1px solid #E0E0DC', padding: '8px 12px 0' }}>
        <div style={{ display: 'flex', alignItems: 'baseline' }}>
          <button onClick={() => setView('detections')} style={tab('detections')}>
            Detections{' '}
            <span style={{ fontFamily: MONO, fontSize: 11, color: '#8A8A8A' }}>
              {dStats.total}
            </span>
          </button>
          <button onClick={() => setView('heatmap')} style={tab('heatmap')}>
            Heatmap
          </button>
          <button onClick={() => setView('log')} style={tab('log')}>
            Audit log{' '}
            <span style={{ fontFamily: MONO, fontSize: 11, color: '#8A8A8A' }}>
              {stats.total}
            </span>
          </button>
        </div>
      </header>

      {view === 'detections' ? (
        <>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 5,
              padding: '8px 12px',
              borderBottom: '1px solid #1E242D',
            }}
          >
            {dStats.byType.length === 0 ? (
              <span style={{ fontFamily: MONO, fontSize: 11, color: '#5B6673' }}>
                {dStats.total === 0 ? 'nothing detected' : ''}
              </span>
            ) : (
              <>
                <button
                  onClick={() => setTypeFilter(null)}
                  style={{
                    border: '1px solid #2A323D',
                    background: typeFilter === null ? '#1B2129' : 'transparent',
                    color: typeFilter === null ? '#D7DDE5' : '#7C8695',
                    borderRadius: 3,
                    padding: '2px 7px',
                    fontFamily: MONO,
                    fontSize: 10,
                    cursor: 'pointer',
                  }}
                >
                  all {dStats.total}
                </button>
                {dStats.byType.map((t) => (
                  <button
                    key={t.type}
                    onClick={() =>
                      setTypeFilter(typeFilter === t.type ? null : t.type)
                    }
                    title={`${t.percent}% of detections on this page`}
                    style={{
                      border: '1px solid #2A323D',
                      background:
                        typeFilter === t.type ? '#1B2129' : 'transparent',
                      color: typeFilter === t.type ? '#E4837D' : '#7C8695',
                      borderRadius: 3,
                      padding: '2px 7px',
                      fontFamily: MONO,
                      fontSize: 10,
                      cursor: 'pointer',
                    }}
                  >
                    {t.type.toLowerCase()} {t.count}
                  </button>
                ))}
              </>
            )}
          </div>

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {visible.length === 0 ? (
              <p
                style={{
                  padding: '20px 12px',
                  fontSize: 12,
                  lineHeight: 1.6,
                  color: '#5B6673',
                }}
              >
                No PII found on this page. Anything the detector finds will
                appear here, with the element it came from.
              </p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th} onClick={() => toggleSort('type')}>
                      Type{arrow('type')}
                    </th>
                    <th
                      style={{ ...th, width: 52, textAlign: 'right' }}
                      onClick={() => toggleSort('confidence')}
                    >
                      Conf{arrow('confidence')}
                    </th>
                    <th style={th} onClick={() => toggleSort('selector')}>
                      Selector{arrow('selector')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((d, i) => (
                    <tr
                      key={`${d.selector}-${d.type}-${i}`}
                      onClick={() => onRowClick(d)}
                      title="Click to highlight this element on the page"
                      style={{ cursor: 'pointer' }}
                    >
                      <td style={{ ...td, color: '#E4837D' }}>
                        {d.type.toLowerCase()}
                        {d.verified && (
                          <span
                            title="Confirmed by a checksum, not just a pattern match"
                            style={{ color: '#6FBF9B', marginLeft: 4 }}
                          >
                            ✓
                          </span>
                        )}
                      </td>
                      <td
                        style={{
                          ...td,
                          textAlign: 'right',
                          color:
                            d.confidence >= 0.9 ? '#C3CBD6' : '#7C8695',
                        }}
                      >
                        {Math.round(d.confidence * 100)}%
                      </td>
                      <td
                        style={{
                          ...td,
                          color: '#7C8695',
                          maxWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <span title={d.selector}>{d.selector}</span>
                        <button
                          onClick={(e) => onCopy(e, d.selector)}
                          title="Copy selector"
                          style={{
                              border: 'none',
                              background: 'transparent',
                              color: '#8A8A8A',
                              cursor: 'pointer',
                              fontSize: 10,
                              padding: '0 0 0 6px',
                            }}
                        >
                          copy
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : (
        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto' }}>
          {error ? (
            <p style={{ padding: '20px 12px', fontSize: 12, color: '#9a6700' }}>
              {error}
            </p>
          ) : entries.length === 0 ? (
            <p
              style={{
                padding: '20px 12px',
                fontSize: 12,
                lineHeight: 1.6,
                color: '#656d76',
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
                      borderBottom: '1px solid #d0d7de',
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
                            title="Confirmed by a checksum"
                            style={{
                              fontFamily: MONO,
                              fontSize: 10,
                              color: '#1a7f37',
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
                            color: '#656d76',
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
                            color: '#1f2328',
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
                            color: '#9a6700',
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
                          color: '#656d76',
                        }}
                      >
                        {e.payloadSize !== undefined && (
                          <span>
                            {(e.payloadSize / 1024).toFixed(1)} KB
                          </span>
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
      )}

      <footer style={{ borderTop: '1px solid #1E242D', padding: '8px 12px' }}>
        {note && (
          <p
            style={{
              margin: '0 0 6px',
              fontFamily: MONO,
              fontSize: 10,
              color: '#7C8695',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {note}
          </p>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onExport} disabled={disabled} style={{ ...btn, flex: 1 }}>
            Export JSON
          </button>
          <button onClick={onClear} disabled={disabled} style={btn}>
            Clear
          </button>
        </div>
      </footer>
    </div>
  );
}