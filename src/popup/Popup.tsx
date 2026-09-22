import { useState, useCallback, useEffect, useRef } from 'react';
import { browser } from 'wxt/browser';
import './Popup.css';
import PrivacyLedger from '../components/PrivacyLedger';
import ResourceMonitor from '../components/ResourceMonitor';
import { PROVIDERS, ProviderKey } from '../lib/providerConfig';

// #134: task-history shape (persisted under this key in browser.storage.local).
const RECENT_TASKS_KEY = 'sih_recent_tasks';
const RECENT_TASKS_CAP = 8;

interface RecentTask {
  task: string;
  startUrl: string;
  startedAt: number;
  status: 'complete' | 'stalled' | 'failed' | 'stopped' | 'running' | 'unknown';
}

function Popup() {
  const [isRunning, setIsRunning] = useState(false);
  const [task, setTask] = useState('');
  const [startUrl, setStartUrl] = useState('');
  const [step, setStep] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [latency, setLatency] = useState<number | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ProviderKey>('custom');
  const [providerKey, setProviderKey] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [healthStatus, setHealthStatus] = useState<'checking' | 'healthy' | 'unhealthy'>('checking');
  const [serverLatency, setServerLatency] = useState<number>(0);
  const [logsCollapsed, setLogsCollapsed] = useState(false);
  const [copyFlash, setCopyFlash] = useState(false);

  // #134 task history: recent prompts cached in storage, reusable with one
  // click. Newest first; each entry remembers its start URL + the final
  // status of its last run.
  const [recentTasks, setRecentTasks] = useState<RecentTask[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const activeTaskRef = useRef<string | null>(null);
  // #134: the most recently mirrored runner state (used by the status-sync
  // effect to stamp a terminal status onto the active recent-task entry).
  const mirrorRef = useRef<any>(null);

  // Load saved state from browser.storage
  useEffect(() => {
    browser.storage.local.get(['task', 'startUrl', 'providerKey', 'apiKey', RECENT_TASKS_KEY]).then((result) => {
      if (result.task) setTask(result.task);
      if (result.startUrl) setStartUrl(result.startUrl);
      if (result.providerKey) setSelectedProvider(result.providerKey as ProviderKey);
      if (result.apiKey) setProviderKey(result.apiKey);
      if (Array.isArray(result[RECENT_TASKS_KEY])) {
        setRecentTasks(result[RECENT_TASKS_KEY] as RecentTask[]);
      }
      setHydrated(true);
    });
  }, []);

  // Save task to browser.storage whenever it changes
  useEffect(() => {
    if (task) {
      browser.storage.local.set({ task });
    }
  }, [task]);

  // Save start URL to browser.storage whenever it changes (multi-page tasks
  // need a starting point; empty means "run on the current tab").
  useEffect(() => {
    if (startUrl) {
      browser.storage.local.set({ startUrl });
    }
  }, [startUrl]);

  // Health check function
  const checkHealth = useCallback(async () => {
    const start = performance.now();
    try {
      const serverUrl = import.meta.env.VITE_SERVER_URL || 'http://localhost:8000';
      const response = await fetch(`${serverUrl}/health`, {
        signal: AbortSignal.timeout(3000)
      });
      const latency = Math.round(performance.now() - start);
      setServerLatency(latency);
      setHealthStatus(response.ok ? 'healthy' : 'unhealthy');
    } catch {
      setServerLatency(0);
      setHealthStatus('unhealthy');
    }
  }, []);

  // Check health on mount and periodically
  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, 10000); // Check every 10 seconds
    return () => clearInterval(interval);
  }, [checkHealth]);

  // ── SW-owned task runner (issues #71, #69) ───────────────────────────────
  // The agent loop now runs in the service worker (src/lib/agentRunner.ts,
  // driven through the shipped SessionManager). The popup is a thin view: it
  // sends START_TASK / STOP_TASK and mirrors the runner's TASK_PROGRESS
  // broadcasts into local UI state. Closing the popup no longer aborts a run.
  const mirrorTaskState = useCallback((state: any) => {
    if (!state) return;
    mirrorRef.current = state; // #134: keep the latest runner state for the history status-sync
    setStep(state.step ?? 0);
    setIsRunning(state.running === true);
    const raw = Array.isArray(state.logs) ? state.logs : [];
    // Runner logs are chronological; keep the WHOLE run (Bug D: the Copy
    // button needs every entry, not just the last 50). Stored newest-first.
    setLogs([...raw].reverse());
  }, []);

  // Bug D: copy the complete activity log (oldest → newest) to the clipboard.
  const copyFullLog = useCallback(async () => {
    const text = [...logs].reverse().join('\n'); // logs are newest-first
    try {
      await navigator.clipboard.writeText(text);
      setCopyFlash(true);
      setTimeout(() => setCopyFlash(false), 1500);
    } catch {
      // clipboard may be unavailable in some contexts; no-op
    }
  }, [logs]);

  // Subscribe to runner progress + restore the last state on mount so a
  // reopened popup shows the running / previous run instead of a blank UI.
  useEffect(() => {
    const listener = (msg: any) => {
      if (msg?.type === 'TASK_PROGRESS' && msg.state) mirrorTaskState(msg.state);
    };
    browser.runtime.onMessage.addListener(listener);
    browser.runtime
      .sendMessage({ type: 'GET_TASK_STATE' })
      .then((state: any) => {
        if (state && state.status !== 'idle') mirrorTaskState(state);
      })
      .catch(() => {});
    return () => browser.runtime.onMessage.removeListener(listener);
  }, [mirrorTaskState]);

  const handleStart = useCallback(async () => {
    if (!task.trim()) return;
    setLogs([]);
    setStep(0);
    setIsRunning(true);
    setLatency(null);
    const started = performance.now();
    const taskId = task.trim();
    activeTaskRef.current = taskId;

    // #134: record this prompt into the recent-tasks cache (deduped, newest
    // first, capped). Runs persist even if the popup closes.
    setRecentTasks((prev) => {
      const rest = prev.filter((t) => t.task !== taskId);
      return [
        { task: taskId, startUrl: startUrl.trim(), startedAt: Date.now(), status: 'running' as const },
        ...rest,
      ].slice(0, RECENT_TASKS_CAP);
    });

    const res: any = await browser.runtime.sendMessage({
      type: 'START_TASK',
      task: task.trim(),
      startUrl: startUrl.trim(),
    });
    if (!res?.ok) {
      setLogs([`⚠️ Could not start task (${res?.error ?? 'unknown'})`]);
      setIsRunning(false);
      activeTaskRef.current = null;
      return;
    }
    setLatency(Math.round(performance.now() - started));
  }, [task, startUrl]);

  // #134: when the active run reaches a terminal status, stamp it onto the
  // matching recent-task entry so the history shows the outcome, not just
  // "was started". Persists the updated list to storage too.
  useEffect(() => {
    const active = activeTaskRef.current;
    if (!active) return;
    const terminal: Record<string, RecentTask['status']> = {
      complete: 'complete',
      stalled: 'stalled',
      failed: 'failed',
      stopped: 'stopped',
    };
    const mirror = mirrorRef.current;
    if (mirror && terminal[mirror.status] && !mirror.running) {
      setRecentTasks((prev) => {
        const next = prev.map((t) =>
          t.task === active ? { ...t, status: terminal[mirror.status] } : t,
        );
        browser.storage.local.set({ [RECENT_TASKS_KEY]: next });
        return next;
      });
      activeTaskRef.current = null;
    }
  }, [isRunning, step, logs]);

  // Issue #70: stop the SW-owned runner. The runner notices it at the top of
  // the next step and aborts any in-flight /plan request.
  const handleStop = useCallback(async () => {
    await browser.runtime.sendMessage({ type: 'STOP_TASK' });
  }, []);

  // #134: one-click reuse of a cached prompt - fill the input + start-URL and
  // kick off the run. Reuses handleStart's logic so the new entry is recorded
  // into the history consistently.
  const runRecentTask = useCallback(
    async (entry: RecentTask) => {
      setTask(entry.task);
      setStartUrl(entry.startUrl || '');
      // The state is set before this tick; start explicitly with the
      // entry's values so we don't race on the re-render.
      setLogs([]);
      setStep(0);
      setIsRunning(true);
      setLatency(null);
      activeTaskRef.current = entry.task;
      setRecentTasks((prev) => {
        const rest = prev.filter((t) => t.task !== entry.task);
        const next = [
          { ...entry, startedAt: Date.now(), status: 'running' as const },
          ...rest,
        ].slice(0, RECENT_TASKS_CAP);
        browser.storage.local.set({ [RECENT_TASKS_KEY]: next });
        return next;
      });
      const res: any = await browser.runtime.sendMessage({
        type: 'START_TASK',
        task: entry.task,
        startUrl: entry.startUrl || '',
      });
      if (!res?.ok) {
        setLogs([`⚠️ Could not start task (${res?.error ?? 'unknown'})`]);
        setIsRunning(false);
        activeTaskRef.current = null;
      }
    },
    []
  );

  const clearTaskHistory = useCallback(() => {
    setRecentTasks([]);
    browser.storage.local.set({ [RECENT_TASKS_KEY]: [] });
  }, []);

  const timeAgo = (ts: number) => {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };


  return (
    <div className="popup">
      <header className="popup-header">
        <h1 className="popup-title">SIH2026 PS171</h1>
        <p className="popup-subtitle">Browser Agent</p>
        {/* Status Indicator */}
        <div className="status-indicator" title={healthStatus === 'healthy' ? `Server OK (${serverLatency}ms)` : healthStatus === 'checking' ? 'Checking...' : 'Server Offline'}>
          <span className={`status-dot ${healthStatus === 'healthy' ? 'healthy' : healthStatus === 'checking' ? 'checking' : 'unhealthy'}`}></span>
          <span className="status-text">{healthStatus === 'healthy' ? 'Live' : healthStatus === 'checking' ? 'Check...' : 'Dead'}</span>
          {serverLatency > 0 && <span className="status-latency">{serverLatency}ms</span>}
        </div>
      </header>

      <div className="popup-body">
        {/* Resource Monitor - at top for visibility */}
        <ResourceMonitor />
        
        {/* Provider Selection */}
        <div className="provider-section">
          <label className="input-label">LLM Provider</label>
          <div className="provider-row">
            <select
              className="provider-select"
              value={selectedProvider}
              onChange={(e) => setSelectedProvider(e.target.value as ProviderKey)}
            >
              {Object.values(PROVIDERS).map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label}
                </option>
              ))}
            </select>
            <button className="settings-button" onClick={() => setShowSettings(!showSettings)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
          {showSettings && (
            <div className="provider-settings">
              <input
                type="password"
                className="api-key-input"
                placeholder="Enter API key..."
                value={providerKey}
                onChange={(e) => setProviderKey(e.target.value)}
              />
              <button
                className="save-key-button"
                onClick={() => {
                  browser.storage.local.set({ providerKey: selectedProvider, apiKey: providerKey });
                  setShowSettings(false);
                }}
              >Save</button>
            </div>
          )}
        </div>

        {/* Task Input */}
        <div className="task-input-section">
          <label className="input-label">Task Description</label>
          <textarea
            className="task-textarea"
            placeholder="e.g., Go to the signup page, fill the form, and submit. Or: navigate to example.com/pricing and click the Pro plan..."
            value={task}
            onChange={(e) => setTask(e.target.value)}
            rows={3}
          />
          <label className="input-label">Start URL (optional)</label>
          <input
            className="api-key-input"
            placeholder="e.g. https://example.com/signup — leave blank to use the current tab"
            value={startUrl}
            onChange={(e) => setStartUrl(e.target.value)}
          />
        </div>

        {/* Recent tasks - #134: cached prompts, one-click re-run */}
        {hydrated && recentTasks.length > 0 && (
          <div className="recent-tasks-section">
            <div className="recent-tasks-header">
              <span className="input-label recent-tasks-label">Recent</span>
              <button
                type="button"
                className="recent-tasks-clear"
                onClick={clearTaskHistory}
                title="Clear task history"
              >
                Clear
              </button>
            </div>
            <ul className="recent-tasks-list">
              {recentTasks.slice(0, 5).map((t) => (
                <li key={t.startedAt + t.task} className={`recent-task recent-task-${t.status}`}>
                  <button
                    type="button"
                    className="recent-task-body"
                    onClick={() => runRecentTask(t)}
                    title="Re-run this task"
                  >
                    <span className="recent-task-text">{t.task}</span>
                    <span className="recent-task-meta">
                      {t.status === 'complete' ? '✓' : t.status === 'stalled' ? '⏸' : t.status === 'failed' ? '✕' : t.status === 'stopped' ? '⏹' : '…'}{' '}
                      {timeAgo(t.startedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Controls */}
        <div className="controls">
          {isRunning ? (
            <button
              className={`start-button running stop-button`}
              onClick={handleStop}
              title="Stop the running task"
            >
              ⏹ Stop Agent
            </button>
          ) : (
            <button
              className={`start-button`}
              onClick={handleStart}
              disabled={!task}
            >
              Start Agent
            </button>
          )}
          {step > 0 && (
            <div className="step-indicator">Step {step} of task execution</div>
          )}
          {latency !== null && (
            <div className="latency-display">Latency: {latency}ms</div>
          )}
        </div>

        {/* Activity Log - Collapsible */}
        <div className={`log-section ${logsCollapsed ? 'collapsed' : ''}`}>
          <div className="log-header" onClick={() => setLogsCollapsed(!logsCollapsed)}>
            <span className="log-title">Activity Log</span>
            <span className="log-header-actions" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="copy-log-btn"
                onClick={copyFullLog}
                disabled={logs.length === 0}
                title="Copy the full activity log"
              >
                {copyFlash ? 'Copied ✓' : 'Copy'}
              </button>
            </span>
            <svg className="log-toggle" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points={logsCollapsed ? "9 18 15 12 9 6" : "15 18 9 12 9 6"} />
            </svg>
          </div>
          {!logsCollapsed && (
            <div className="log-container">
              {logs.length === 0 ? (
                <div className="log-entry log-empty">No activity yet</div>
              ) : (
                // Display the most recent ~60 so the panel stays scrollable;
                // the Copy button always has the FULL log.
                [...logs].slice(0, 60).map((log, i) => (
                  <div key={i} className="log-entry">{log}</div>
                ))
              )}
            </div>
          )}
        </div>

        <div className="ledger-container">
          <PrivacyLedger />
        </div>
      </div>

      <footer className="popup-footer">
        <span>Privacy-first • On-device inference</span>
      </footer>
    </div>
  );
}

export default Popup;