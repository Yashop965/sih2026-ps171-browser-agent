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
  blocked: { fg: '#8B2E2E', bg: 'rgba(139,46,46,0.08)', bar: '#8B2E2E' },
  clean: { fg: '#2D5A27', bg: 'rgba(45,90,39,0.08)', bar: '#2D5A27' },
  warning: { fg: '#8B6914', bg: 'rgba(139,105,20,0.08)', bar: '#8B6914' },
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
    border: '1px solid #D0CDC6',
    background: 'transparent',
    color: disabled ? '#9A9A9A' : '#6B6B6B',
    borderRadius: 1,
    padding: '6px 8px',
    fontSize: 10,
    cursor: disabled ? 'default' : 'pointer',
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
  };

  const tab = (v: View): React.CSSProperties => ({
    border: 'none',
    background: 'transparent',
    color: view === v ? '#0D0D0D' : '#9A9A9A',
    borderBottom: `1px solid ${view === v ? '#0D0D0D' : 'transparent'}`,
    padding: '6px 2px',
    marginRight: 16,
    fontSize: 10,
    cursor: 'pointer',
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
  });

  const th: React.CSSProperties = {
    textAlign: 'left',
    padding: '6px 8px',
    fontFamily: MONO,
    fontSize: 9,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: '#9A9A9A',
    cursor: 'pointer',
    userSelect: 'none',
    borderBottom: '1px solid #E8E6E1',
  };

  const td: React.CSSProperties = {
    padding: '6px 8px',
    fontFamily: MONO,
    fontSize: 10,
    borderBottom: '1px solid #F0EFEC',
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
      <header style={{ borderBottom: '1px solid #E8E6E1', padding: '8px 12px 0' }}>
        <div style={{ display: 'flex', alignItems: 'baseline' }}>
          <button onClick={() => setView('detections')} style={tab('detections')}>
            Detections{' '}
            <span style={{ fontFamily: MONO, fontSize: 10, color: '#9A9A9A' }}>
              {dStats.total}
            </span>
          </button>
          <button onClick={() => setView('heatmap')} style={tab('heatmap')}>
            Heatmap
          </button>
          <button onClick={() => setView('log')} style={tab('log')}>
            Audit log{' '}
            <span style={{ fontFamily: MONO, fontSize: 10, color: '#9A9A9A' }}>
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
              gap: 6,
              padding: '10px 12px',
              borderBottom: '1px solid #E8E6E1',
              background: '#F8F7F4',
            }}
          >
            {dStats.byType.length === 0 ? (
              <span style={{ fontFamily: MONO, fontSize: 10, color: '#9A9A9A' }}>
                {dStats.total === 0 ? 'nothing detected' : ''}
              </span>
            ) : (
              <>
                <button
                  onClick={() => setTypeFilter(null)}
                  style={{
                    border: '1px solid #D0CDC6',
                    background: typeFilter === null ? '#0D0D0D' : 'transparent',
                    color: typeFilter === null ? '#FFFFFF' : '#6B6B6B',
                    borderRadius: 1,
                    padding: '4px 8px',
                    fontFamily: MONO,
                    fontSize: 9,
                    cursor: 'pointer',
                    letterSpacing: '0.04em',
                    textTransform: 'uppercase',
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
                      border: '1px solid #D0CDC6',
                      background:
                        typeFilter === t.type ? '#0D0D0D' : 'transparent',
                      color: typeFilter === t.type ? '#FFFFFF' : '#6B6B6B',
                      borderRadius: 1,
                      padding: '4px 8px',
                      fontFamily: MONO,
                      fontSize: 9,
                      cursor: 'pointer',
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
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
      ) : view === 'heatmap' ? (
        <div style={{ flex: 1, position: 'relative', background: '#F8F7F4', overflow: 'hidden', minHeight: 300 }}>
          {/* Stats bar */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 16px',
            borderBottom: '1px solid #E8E6E1',
            background: '#ffffff',
            fontSize: 10,
            fontFamily: MONO,
            color: '#6B6B6B',
          }}>
            <span>
              <strong style={{ color: '#0D0D0D' }}>{detections.length}</strong> total fields
              {dStats.verified > 0 && (
                <span style={{ marginLeft: 12 }}>
                  <span style={{ color: '#8B2E2E' }}>{dStats.verified}</span> verified
                </span>
              )}
            </span>
            <span style={{ color: '#9A9A9A' }}>
              {dStats.byType.slice(0, 3).map(t => `${t.type}: ${t.count}`).join(' · ')}
            </span>
          </div>

          {/* Heatmap canvas */}
          <div
            style={{
              flex: 1,
              position: 'relative',
              background: '#ffffff',
              overflow: 'hidden',
            }}
          >
            {/* Grid pattern background */}
            <div style={{
              position: 'absolute',
              inset: 0,
              backgroundImage: 'linear-gradient(rgba(0,0,0,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.03) 1px, transparent 1px)',
              backgroundSize: '40px 40px',
            }} />

            {detections.length > 0 ? (
              <>
                {/* Render all detections as a scatter plot */}
                {detections.map((d, i) => {
                  // Distribute across canvas using golden ratio spiral for even distribution
                  const angle = i * 2.399963; // Golden angle
                  const radius = Math.sqrt(i / detections.length) * 0.45;
                  const x = 50 + radius * Math.cos(angle) * 100;
                  const y = 50 + radius * Math.sin(angle) * 100;

                  // Size based on confidence
                  const size = 8 + (d.confidence * 12);
                  const color = d.verified ? '#8B2E2E' : '#8B6914';

                  return (
                    <div
                      key={`heatmap-${d.selector}-${i}`}
                      onClick={() => onRowClick(d)}
                      title={`${d.type}: ${d.selector} (${Math.round(d.confidence * 100)}%)`}
                      style={{
                        position: 'absolute',
                        left: `${x}%`,
                        top: `${y}%`,
                        transform: `translate(-50%, -50%)`,
                        width: size,
                        height: size,
                        borderRadius: '50%',
                        background: d.verified ? 'rgba(139, 46, 46, 0.15)' : 'rgba(139, 105, 20, 0.15)',
                        border: `1.5px solid ${color}`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                        zIndex: 5,
                      }}
                      onMouseEnter={(e) => {
                        const el = e.currentTarget as HTMLElement;
                        el.style.transform = 'translate(-50%, -50%) scale(1.5)';
                        el.style.zIndex = '20';
                        el.style.boxShadow = `0 0 16px ${color}60`;
                      }}
                      onMouseLeave={(e) => {
                        const el = e.currentTarget as HTMLElement;
                        el.style.transform = 'translate(-50%, -50%) scale(1)';
                        el.style.zIndex = '5';
                        el.style.boxShadow = 'none';
                      }}
                    >
                      {/* Inner dot - smaller for high count */}
                      <div style={{
                        width: Math.max(3, size * 0.35),
                        height: Math.max(3, size * 0.35),
                        borderRadius: '50%',
                        background: color,
                      }} />
                    </div>
                  );
                })}

                {/* Cluster indicator for large datasets */}
                {detections.length > 50 && (
                  <div style={{
                    position: 'absolute',
                    bottom: 12,
                    right: 12,
                    background: '#0D0D0D',
                    color: '#FFFFFF',
                    padding: '6px 10px',
                    borderRadius: 1,
                    fontSize: 9,
                    fontFamily: MONO,
                    zIndex: 10,
                  }}>
                    {detections.length} fields
                  </div>
                )}
              </>
            ) : (
              <div style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                textAlign: 'center',
                color: '#9A9A9A',
              }}>
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ marginBottom: 12, opacity: 0.4 }}>
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 8v4l3 3" />
                </svg>
                <div style={{ fontFamily: MONO, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>No fields detected</div>
                <div style={{ fontSize: 10, color: '#B0B0B0' }}>Visit a page with PII to see detection heatmap</div>
              </div>
            )}

            {/* Legend */}
            {detections.length > 0 && (
              <div style={{
                position: 'absolute',
                top: 12,
                left: 12,
                background: '#ffffff',
                border: '1px solid #E8E6E1',
                borderRadius: 1,
                padding: '10px 14px',
                fontSize: 10,
                fontFamily: MONO,
                zIndex: 10,
              }}>
                <div style={{ marginBottom: 8, color: '#9A9A9A', textTransform: 'uppercase', letterSpacing: '0.1em', fontSize: 9, fontWeight: 600 }}>Legend</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#8B2E2E' }} />
                  <span style={{ color: '#0D0D0D', fontSize: 9 }}>Verified</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#8B6914' }} />
                  <span style={{ color: '#0D0D0D', fontSize: 9 }}>Pattern match</span>
                </div>
              </div>
            )}
          </div>
        </div>
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