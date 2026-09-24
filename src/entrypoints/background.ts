import { defineBackground } from 'wxt/sandbox';
import { PrivacyAuditLedger } from '../lib/pii/audit';
import { sessionManager } from '../lib/sessionManager';
import { PrivacyLedger, type PrivacyLogEntry } from '../lib/pii/privacyLedger';
import { AgentRunner, emptyTaskState, type AgentTaskState, type ChecklistItem } from '../lib/agentRunner';
import { withPortRetry } from '../lib/portRetry';
import { visionConfirm, type VisionConfirmItem } from '../lib/visionConfirm';
import { loadProfile } from '../lib/userProfile';
import { emptyHandoff, harvestToHandoff, mergeHandoff, type TabHandoff, type OpenTabInfo } from '../lib/tabHandoff';
import { loadOutboundAllowlist } from '../lib/outboundAllowlist';

/**
 * Background Service Worker
 *
 * Handles:
 * - Message routing between content scripts and server
 * - Privacy pipeline: sanitize → firewall → transmit
 * - Privacy ledger management (legacy + new audit ledger)
 * - Action execution
 * - Image capture for vision processing
 */
export default defineBackground({
  main() {
    console.log('[PII-Agent] Background service worker started');

    // Issue #72: the ledgers were in-SW singletons, recreated empty on every
    // idle-termination / reload - so a judge who reloaded the extension saw a
    // blank "tamper-proof" audit trail. Persist to browser.storage.local:
    // hydrate the last snapshot at SW start, then write-through on every
    // change (fire-and-forget; storage.local survives SW death and holds the
    // SHA-256 export inputs across sessions).
    const PRIVACY_LEDGER_KEY = 'sih_privacy_ledger';
    const AUDIT_LEDGER_KEY = 'sih_audit_ledger';

    const persistPrivacyLedger = async (entries: PrivacyLogEntry[]) => {
      try {
        await browser.storage.local.set({ [PRIVACY_LEDGER_KEY]: entries });
      } catch {
        // Swallowed: durability is best-effort, never block the live loop.
      }
    };
    const persistAuditLedger = async (entries: any[]) => {
      try {
        await browser.storage.local.set({ [AUDIT_LEDGER_KEY]: entries });
      } catch {
        // best-effort, as above
      }
    };

    const privacyLedger = new PrivacyLedger([], persistPrivacyLedger);
    const auditLedger = new PrivacyAuditLedger([], persistAuditLedger);
    const agentState = new AgentState();

    // ─── Issue #75: MV3 service-worker keepalive for long ops ────────────────
    // A long in-flight op (Florence-2 first-time init + a vision capture can
    // outlive the ~30s MV3 idle timeout) used to die with the SW, so the
    // request caller got silence instead of a result. We track how many long
    // ops are in flight; while >0 a recurring 25s keepalive alarm keeps the
    // SW warm. When the count hits 0 the alarm is cleared so we don't hold
    // the SW alive forever.
    let longOpsInFlight = 0;
    const KEEPALIVE_ALARM = 'sih_sw_keepalive';
    const KEEPALIVE_PERIOD_MIN = 0.5; // ~30s

    const beginLongOp = () => {
      longOpsInFlight++;
      browser.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
    };
    const endLongOp = () => {
      longOpsInFlight = Math.max(0, longOpsInFlight - 1);
      if (longOpsInFlight === 0) {
        browser.alarms.clear(KEEPALIVE_ALARM);
      }
    };
    // The alarm's own firing is what keeps the SW warm; it just reports and
    // re-arms. No-op if nothing is in flight (the alarm would have been
    // cleared already).
    browser.alarms.onAlarm.addListener((alarm: { name?: string }) => {
      if (alarm.name !== KEEPALIVE_ALARM) return;
      console.log('[keepalive] SW keepalive tick -', longOpsInFlight, 'long op(s) in flight');
    });


    // ─── Issue #71: SW-owned task runner ─────────────────────────────────────
    // The agent loop now lives here, not in the popup. The popup is a thin
    // view that subscribes to TASK_PROGRESS broadcasts. Closing the popup no
    // longer aborts a run; the state survives until the SW itself restarts.
    let activeTask: AgentTaskState = emptyTaskState();
    let stopFlag = { stopped: false };
    let abortController = new AbortController();
    // #143 P2: resolves the runner's outbound-gate pause when the popup's
    // CONFIRM / DISMISS / STOP reaches the SW. At most one gate pause is in
    // flight at a time (the loop is serial), so a single resolver is enough.
    let outboundConfirmResolver:
      | ((d: { confirmed: boolean; dismissed?: boolean; stopRequested?: boolean }) => void)
      | null = null;
    const resetOutboundGate = (): void => {
      outboundConfirmResolver = null;
    };

    // Persist the live task state so a SW restart can still surface "what
    // happened" (best-effort; the run itself dies with the SW by design).
    const TASK_STATE_KEY = 'sih_agent_task_state';
    const persistTaskState = async (state: AgentTaskState) => {
      activeTask = state;
      try {
        await browser.storage.local.set({ [TASK_STATE_KEY]: state });
      } catch {
        /* best-effort */
      }
    };
    const broadcastProgress = (state: AgentTaskState) => {
      persistTaskState(state);
      try {
        browser.runtime.sendMessage({ type: 'TASK_PROGRESS', state }).catch(() => {});
      } catch {
        /* no listeners - fine */
      }
    };

    // Rehydrate the last task snapshot so the popup shows the previous run's
    // result instead of a blank "idle".
    (async () => {
      try {
        const snap = await browser.storage.local.get(TASK_STATE_KEY);
        if (snap[TASK_STATE_KEY]) activeTask = snap[TASK_STATE_KEY];
      } catch {
        /* first launch */
      }
    })();

    // Narrow channels the runner uses - each delegates to the existing
    // content/background plumbing.

    // ─── #141 P1: cross-tab target (SWITCH_TAB) ──────────────────────────────
    // The channels above used to hard-query the *active* web tab of the
    // current window. That is the SINGLE-TAB assumption. P1 keeps that as the
    // DEFAULT (so existing single-tab tasks behave byte-identically) but makes
    // the target a per-run value: currentTargetTab. A SWITCH_TAB action
    // (handled in executeChannel below) activates another open web tab and
    // repoints the target - one tab driven at a time, never parallel. The
    // task-scoped handoff below carries label/value pairs harvested (on
    // device) from a tab as <FIELD_N> tokens; the runner resolves the token
    // back to its value at write time, so harvested data never reaches the
    // planner LLM.
    let currentTargetTab: { tabId: number; windowId: number } | null = null;
    let taskHandoff: TabHandoff = emptyHandoff();
    const resetCrossTabState = (): void => {
      currentTargetTab = null;
      taskHandoff = emptyHandoff();
    };

    // Resolve which tab to drive next. When currentTargetTab is set (after a
    // SWITCH_TAB) that tab IS the target, even if the user meanwhile clicked
    // elsewhere - the agent owns the focus it moved. Otherwise (task start,
    // or a target that got closed) fall back to the active web tab, exactly
    // as before P1.
    const driveTab = async (): Promise<number | undefined> => {
      if (currentTargetTab) {
        try {
          const t = await browser.tabs.get(currentTargetTab.tabId);
          if (t && t.url && (t.url.startsWith('http://') || t.url.startsWith('https://'))) {
            return t.id;
          }
        } catch {
          /* target closed - fall through to the active-tab default */
        }
        currentTargetTab = null;
      }
      const [active] = await browser.tabs.query({ active: true, currentWindow: true });
      const isWeb = (u?: string) => !!u && (u.startsWith('http://') || u.startsWith('https://'));
      return active?.id && isWeb(active.url) ? active.id : undefined;
    };

    // Harvest the target tab's labeled value pairs (HARVEST_FIELDS - content
    // script, DOM-local, capped, password-excluded) into the task handoff.
    // MERGED (not replaced) so a multi-source task keeps values from every
    // tab it has read - last-wins would clobber tab A when tab B is harvested.
    // Best-effort: a chrome:// page or a closed port just yields no fields.
    const harvestTabIntoHandoff = async (tabId: number): Promise<void> => {
      const { ok, value } = await withPortRetry(
        async () => await browser.tabs.sendMessage(tabId, { type: 'HARVEST_FIELDS' }),
        (v: any) => v === undefined,
      );
      if (!ok || !value?.fields?.length) return;
      let sourceUrl = '';
      try {
        sourceUrl = (await browser.tabs.get(tabId)).url || '';
      } catch {
        sourceUrl = '';
      }
      taskHandoff = mergeHandoff(taskHandoff, harvestToHandoff(value.fields, sourceUrl));
    };

    // The runner's open-tab provider: live web tabs of the task's window,
    // url + title only (no DOM, no PII). The planner uses this to pick a
    // SWITCH_TAB target by hint. Capped so dense multi-tab windows stay
    // bounded in the /plan payload.
    const openTabsProvider = async (): Promise<OpenTabInfo[]> => {
      // windowId 0 (a raced tabs.get during a hop) is not a real window -
      // fall back to the active tab's window so the open-tab list isn't
      // silently empty on the next plan call.
      const windowId =
        (currentTargetTab?.windowId && currentTargetTab.windowId > 0
          ? currentTargetTab.windowId
          : undefined) ??
        (await browser.tabs.query({ active: true, currentWindow: true }))?.[0]?.windowId ??
        undefined;
      const tabs = windowId !== undefined
        ? await browser.tabs.query({ windowId })
        : await browser.tabs.query({ currentWindow: true });
      return tabs
        .filter((t) => t.id !== undefined && t.url?.startsWith('http'))
        .slice(0, 10)
        .map((t) => ({ tabId: t.id as number, url: t.url || '', title: t.title || '' }));
    };

    const extractChannel = async (): Promise<any> => {
      const tabId = await driveTab();
      if (tabId === undefined) return { ok: false, error: 'No active tab' };
      // After a navigating CLICK/KEY the content port drops and the content
      // script re-injects on the new page; there is a brief window where
      // sendMessage rejects with "Receiving end does not exist" (or resolves
      // undefined - no listener yet). Retry that transient so a not-yet-
      // attached content script doesn't hard-fail the whole run (symmetric
      // with how executeChannel treats the same error as a "page navigated"
      // success). See src/lib/portRetry.ts.
      const { ok, value, error } = await withPortRetry(
        async () => await browser.tabs.sendMessage(tabId, { type: 'capturePage' }),
        (v: any) => v === undefined,
      );
      if (!ok || !value) return { ok: false, error: error };
      const snapshot: any = value;
      for (const pii of snapshot.detectedPII || []) {
        privacyLedger.log({
          timestamp: Date.now(), tabId, url: snapshot.url || '', type: pii.type || 'PII',
          selector: pii.selector || '', confidence: pii.confidence || 1,
          verified: Boolean(pii.isVerified), action: 'DETECTED',
        });
      }
      return {
        ok: true,
        elements: snapshot.interactiveElements || [],
        context: snapshot.context,
        url: snapshot.url || '',
        title: snapshot.title || '',
      };
    };

    const executeChannel = async (action: any): Promise<any> => {
      // #141 P1: SWITCH_TAB - hop the agent's target to another open web tab.
      // Harvests the LEAVING tab's labeled values into the task handoff first
      // (on device; the planner later sees only <FIELD_N> tokens), activates
      // the target, and waits for it to be usable. One tab driven at a time.
      if (action?.type === 'SWITCH_TAB') {
        const from = await driveTab();
        if (from !== undefined) await harvestTabIntoHandoff(from);
        let next: number | undefined;
        if (typeof action.tabId === 'number') {
          try {
            const t = await browser.tabs.get(action.tabId);
            if (t?.url && (t.url.startsWith('http://') || t.url.startsWith('https://'))) next = t.id;
          } catch {
            next = undefined;
          }
        }
        if (next === undefined && typeof action.urlHint === 'string' && action.urlHint) {
          const hint = action.urlHint.toLowerCase();
          const tabs = await openTabsProvider();
          const hit =
            tabs.find((t) => t.url.toLowerCase().includes(hint)) ||
            tabs.find((t) => t.title.toLowerCase().includes(hint));
          next = hit?.tabId;
        }
        if (next === undefined) {
          // No explicit target: settle on the active web tab (a no-op hop if
          // already there - never a failure, so a planner that emits a bare
          // SWITCH_TAB just re-grounds the run).
          next = from;
        }
        if (next === undefined) return { ok: false, error: 'no web tab to switch to' };
        try {
          await browser.tabs.update(next, { active: true });
          const target = await browser.tabs.get(next);
          currentTargetTab = { tabId: next, windowId: target?.windowId ?? 0 };
          // #141: track the tab's own session - SessionManager was built for
          // multi-site tasks; the runner's task session (tabId -1) stays the
          // loop's budget owner, these are the per-tab views. Update the
          // active one if the task already visited this tab, otherwise open
          // a fresh one. Bookkeeping only - a failure here never fails the hop.
          try {
            const existing = sessionManager.getSessionForTab(next);
            if (existing) {
              await sessionManager.updateSession(existing.sessionId, target?.url || '');
            } else {
              await sessionManager.startSession(
                next,
                target?.windowId ?? 0,
                target?.url || '',
                `cross-tab hop in task: ${'(' + (target?.title || 'untitled') + ')'}`,
              );
            }
          } catch {
            /* session bookkeeping is best-effort */
          }
          // A background tab is not mid-navigation, but give its content
          // script a beat so the next EXTRACT finds the port attached.
          await waitForTabLoad(next, 3_000);
          privacyLedger.log({
            timestamp: Date.now(), tabId: next, url: target?.url || '', type: 'EXECUTION',
            selector: 'SWITCH_TAB', confidence: 1, verified: true, action: 'SUCCESS',
          });
          return { ok: true, note: 'tab switched - will re-extract the new tab' };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      }

      const tabId = await driveTab();
      if (tabId === undefined) return { ok: false, error: 'No web tab found' };
      try {
        const result: any = await browser.tabs.sendMessage(tabId, { type: 'EXECUTE', action });
        privacyLedger.log({
          timestamp: Date.now(), tabId, url: '', type: 'EXECUTION',
          selector: action?.targetId?.toString() || '', confidence: 1,
          verified: result?.ok === true,
          action: result?.ok ? 'SUCCESS' : 'FAILURE',
          error: result?.error,
        });
        return result;
      } catch (e) {
        const msg = String(e);
        // A click/submit that NAVIGATES the tab disconnects the content port
        // before it can reply (#86). The action likely worked - the next
        // EXTRACT re-plans on the new page. Do NOT report it as a failure.
        const navigated =
          /disconnect|Receiving end does not exist|Could not establish connection|No recipient|closed/i.test(msg);
        if (navigated) {
          privacyLedger.log({
            timestamp: Date.now(), tabId, url: '', type: 'EXECUTION',
            selector: action?.targetId?.toString() || '', confidence: 1,
            verified: true, action: 'SUCCESS',
          });
          return { ok: true, note: 'page navigated - will re-extract the new page' };
        }
        return { ok: false, error: msg };
      }
    };

    const navigateChannel = async (url: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        let target = url;
        try {
          const parsed = new URL(url, 'http://invalid');
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { ok: false, error: `refused protocol: ${parsed.protocol}` };
          }
          target = parsed.href;
        } catch {
          return { ok: false, error: 'invalid url' };
        }
        const tabId = await driveTab();
        if (tabId === undefined) return { ok: false, error: 'No web tab found' };
        await browser.tabs.update(tabId, { url: target });
        await waitForTabLoad(tabId, 10_000);
        // #141: a navigation inside the task re-asserts the target so a later
        // tabs.query fallback can't drift the run onto another tab.
        const moved = await browser.tabs.get(tabId).catch(() => null);
        currentTargetTab = { tabId, windowId: moved?.windowId ?? 0 };
        privacyLedger.log({
          timestamp: Date.now(), tabId, url: target, type: 'EXECUTION',
          selector: 'NAVIGATE', confidence: 1, verified: true, action: 'SUCCESS',
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    };

    // #132: nudge the agent-cursor into "breathing" mode around the LLM wait,
    // so the multi-second planner round-trip reads as the agent *thinking*
    // rather than the cursor sitting frozen. Best-effort fire-and-forget: it
    // targets the active web tab's content script and never blocks the plan.
    const setCursorThinking = (on: boolean) => {
      void driveTab()
        .then((id) => (id === undefined ? null : browser.tabs.sendMessage(id, { type: 'CURSOR_THINKING', on })))
        .catch(() => {});
    };

    const fetchPlan = async (payload: unknown, signal?: AbortSignal): Promise<any> => {
      const serverUrl = import.meta.env.VITE_SERVER_URL || 'http://localhost:8000';
      setCursorThinking(true);
      try {
        const response = await fetch(`${serverUrl}/plan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal,
        });
        if (!response.ok) return null; // runner logs the non-OK path as an abort/offline
        return await response.json();
      } catch {
        // AbortError (Stop pressed mid-request) or a network failure. Either
        // way there is no plan to act on this step; the loop stops/re-checks.
        return null;
      } finally {
        setCursorThinking(false);
      }
    };

    // #100 optional confirm: OCR the visible screen on-device and match the
    // open goals. Screenshot stays local (SW capture -> content Florence-2
    // OCR -> text back); only the OCR string moves, never the pixels. Any
    // failure returns null so the runner falls back to the deterministic
    // backstop loop - this can't make a task worse.
    const confirmGoal = async (input: {
      url: string;
      title: string;
      openItems: ChecklistItem[];
    }): Promise<{ confirmed: boolean; detail?: string; unavailableReason?: string } | null> => {
      try {
        const tabId = await driveTab();
        if (tabId === undefined) return null;
        const { ok, value } = await withPortRetry(
          async () => await browser.tabs.sendMessage(tabId, { type: 'VISION_OCR' }),
          (v: any) => v === undefined,
        );
        if (!ok || !value) {
          // No answer from the content script (chrome:// page, script not
          // injected, …) - unavailable, and the runner should say so once.
          return { confirmed: false, detail: 'unavailable', unavailableReason: 'content script unreachable' };
        }
        if (!value.ok) {
          // "empty ocr" means the model RAN and read nothing - a verdict
          // (goal not on screen), not an availability failure.
          const err = String(value.error ?? 'model unavailable');
          if (err === 'empty ocr') {
            return { confirmed: false, detail: 'OCR returned no text' };
          }
          return { confirmed: false, detail: 'unavailable', unavailableReason: err };
        }
        const ocrText: string = value.text ?? '';
        const items: VisionConfirmItem[] = input.openItems.map((i) => ({
          id: i.id,
          description: i.description,
        }));
        const verdict = visionConfirm(ocrText, items);
        // Only confirm when EVERY open goal is matched; a partial match keeps
        // the deterministic loop running.
        return { confirmed: verdict.confirmed, detail: verdict.detail };
      } catch {
        return null;
      }
    };

    // Start (or restart) the SW-owned runner for a task.
    const startTask = async (message: any, sender: browser.runtime.MessageSender) => {
      // A popup-originated message has no sender.tab, so resolve the active
      // web tab to target. The runner's channels re-resolve the active tab per
      // call, so it always acts on the page the user is looking at.
      let windowId = sender.tab?.windowId ?? 0;
      try {
        const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.id !== undefined) {
          windowId = activeTab.windowId ?? windowId;
        }
      } catch {
        /* keep the sender-derived window */
      }

      // Stop any previous run before starting a new one.
      stopFlag = { stopped: false };
      abortController = new AbortController();
      // #141: a new run starts cross-tab-clean - no stale target tab, no
      // previous task's harvested values (a fresh run must not type values
      // it never read this task).
      resetCrossTabState();

      // #102: load the on-device user profile so the planner can reference the
      // user's own constants by token. Never egressed raw - the outbound guard
      // masks to tokens and the runner resolves back to the real value only
      // at execution time. Absent / empty => feature off, unchanged behaviour.
      const profile = await loadProfile();

      const runner = new AgentRunner({
        extract: extractChannel,
        execute: executeChannel,
        navigate: navigateChannel,
        fetchPlan,
        delay: (ms) => new Promise((r) => setTimeout(r, ms)),
        sessionManager,
        tabId: -1, // bookkeeping id; the channels resolve the live tab
        windowId,
        task: message.task || '',
        startUrl: message.startUrl,
        onProgress: broadcastProgress,
        isStopped: () => stopFlag.stopped,
        abortSignal: abortController.signal,
        // #100: optional on-device vision confirm. Returns null when the
        // model isn't ready; the deterministic backstop carries the loop.
        confirmGoal,
        // #102: local user profile (on-device constants the agent can fill).
        profile: Object.keys(profile).length ? profile : undefined,
        // #141 P1: cross-tab orchestrator. The planner sees the live open-tab
        // list (url+title) and the token+label handoff (values never cross);
        // SWITCH_TAB hops the run between open tabs, one driven at a time.
        openTabs: openTabsProvider,
        crossTabMemory: () => taskHandoff,
        // #143 P2: outbound-send gate. Pauses the run for a human before a
        // send-classified action on a user opt-in outbound domain. The
        // allowlist is on-device; empty => gate off (zero behaviour change).
        outboundGate: {
          allowlist: loadOutboundAllowlist,
          destination: async () => {
            const tabId = await driveTab();
            if (tabId === undefined) return { url: '', title: '' };
            try {
              const t = await browser.tabs.get(tabId);
              return { url: t?.url || '', title: t?.title || '' };
            } catch {
              return { url: '', title: '' };
            }
          },
          awaitConfirmation: async (_staged) => {
            // Pause the loop until the popup resolves the gate. A new run (or
            // a STOP) resets the resolver so a stale pause can't leak.
            return await new Promise<{
              confirmed: boolean;
              dismissed?: boolean;
              stopRequested?: boolean;
            }>((resolve) => {
              outboundConfirmResolver = (d) => resolve(d);
            });
          },
        },
      });
      runner.run().catch((e) => {
        console.error('[agent-runner] unhandled loop error:', e);
        broadcastProgress({
          ...emptyTaskState(),
          status: 'failed',
          logs: [`${new Date().toLocaleTimeString()}: Run error: ${e instanceof Error ? e.message : String(e)}`],
          lastUpdate: Date.now(),
        });
      });
    };

    // Hydrate after construction (non-blocking: the SW keeps running even if
    // storage hasn't loaded yet - the live loop never waits on the audit
    // trail). Runs after the ledgers exist so it can call hydrate() on them.
    (async () => {
      let privacyInitial: PrivacyLogEntry[] = [];
      let auditInitial: any[] = [];
      try {
        const snap = await browser.storage.local.get([PRIVACY_LEDGER_KEY, AUDIT_LEDGER_KEY]);
        privacyInitial = (snap[PRIVACY_LEDGER_KEY] as PrivacyLogEntry[]) || [];
        auditInitial = (snap[AUDIT_LEDGER_KEY] as any[]) || [];
      } catch {
        // first launch / storage unavailable - start empty.
      }
      privacyLedger.hydrate(privacyInitial);
      auditLedger.hydrate(auditInitial);
    })();

    // Listen for messages from content scripts
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log('[PII-Agent] Received message:', message.type);

      switch (message.type) {
        case 'VISION_EXTRACT':
          // Request vision-enhanced extraction from content script.
          // Issue #75: this can be a long op (Florence-2 first-time model
          // init + capture) that would outlive the MV3 idle timeout, so hold
          // the SW warm for its duration.
          (async () => {
            beginLongOp();
            try {
              const tabId = sender.tab?.id;
              if (!tabId) { sendResponse({ ok: false, error: 'No tab ID' }); return; }
              const result: any = await browser.tabs.sendMessage(tabId, { type: 'VISION_EXTRACT' });
              sendResponse(result);
            } catch (e) {
              sendResponse({ ok: false, error: String(e) });
            } finally {
              endLongOp();
            }
          })();
          return true;

        case 'EXTRACT':
          // Extract DOM and log PII to ledger
          (async () => {
            try {
              // Always target a real web tab, never the extension's own
              // pages (the popup can be driven as a tab via CDP). See
              // resolveWebTab.
              const tabId = await resolveWebTab(sender);
              if (!tabId) { sendResponse({ error: 'No web tab found', ok: false }); return; }
              const snapshot: any = await browser.tabs.sendMessage(tabId, { type: 'capturePage' });
              if (!snapshot) { sendResponse({ ok: false, error: 'No snapshot' }); return; }
              // Log PII detections
              for (const pii of snapshot.detectedPII || []) {
                privacyLedger.log({
                  timestamp: Date.now(),
                  tabId,
                  url: snapshot.url || '',
                  type: pii.type || 'PII',
                  selector: pii.selector || '',
                  confidence: pii.confidence || 1,
                  verified: Boolean(pii.isVerified),
                  action: 'DETECTED',
                });
              }
              sendResponse({
                ok: true,
                elements: snapshot.interactiveElements || [],
                // Forward page geometry + scroll affordance (issue #59). The
                // popup was previously dropping this, so the planner never
                // knew the page was taller than the viewport.
                context: snapshot.context,
                // Forward where the agent IS. Without these the server's
                // /plan fell back to url="http://localhost", so a planner
                // could never issue a meaningful NAVIGATE or know which page
                // it was looking at. (Autonomy / multi-page support.)
                url: snapshot.url || '',
                title: snapshot.title || '',
              });
            } catch (e) {
              sendResponse({ ok: false, error: String(e) });
            }
          })();
          return true;

        case 'EXECUTE':
          // Execute action and log to ledger
          (async () => {
            // Resolve the target web tab BEFORE the try so the catch block can
            // also reference it when logging a navigation-triggered disconnect.
            // resolveWebTab always targets a real http(s) tab - never the
            // extension's own pages.
            const tabId = await resolveWebTab(sender);
            if (!tabId) { sendResponse({ error: 'No web tab found', ok: false }); return; }
            try {
              const action = message.action;
              const result: any = await browser.tabs.sendMessage(tabId, { type: 'EXECUTE', action });
              // Log execution to ledger
              privacyLedger.log({
                timestamp: Date.now(),
                tabId,
                url: '',
                type: 'EXECUTION',
                selector: action?.targetId?.toString() || '',
                confidence: 1,
                verified: result?.ok === true,
                action: result?.ok ? 'SUCCESS' : 'FAILURE',
                error: result?.error,
              });
              sendResponse(result);
            } catch (e) {
              const msg = String(e);
              // A click/submit that NAVIGATES the tab disconnects the content
              // message channel before it can reply. The action likely worked
              // (the page moved on) - do not report that as a failure, or the
              // planner will think the click failed and retry-loop. The next
              // EXTRACT will see the new page and re-plan correctly.
              const navigated =
                /disconnect|Receiving end does not exist|Could not establish connection|No recipient|closed/i.test(msg);
              if (navigated) {
                privacyLedger.log({
                  timestamp: Date.now(),
                  tabId,
                  url: '',
                  type: 'EXECUTION',
                  selector: message.action?.targetId?.toString() || '',
                  confidence: 1,
                  verified: true,
                  action: 'SUCCESS',
                });
                sendResponse({ ok: true, note: 'page navigated - will re-extract the new page' });
              } else {
                sendResponse({ ok: false, error: msg });
              }
            }
          })();
          return true;

        case 'NAVIGATE_TAB':
          // Multi-page autonomy: navigate the active tab WITHOUT going through
          // the content script. A NAVIGATE run in-page would call
          // location.assign(), which unloads the page and kills the content
          // script before it can return a response. browser.tabs.update runs
          // in the service worker (which survives the page load), then we wait
          // for the new document to finish loading so the next EXTRACT sees the
          // fresh DOM instead of the half-loaded page.
          (async () => {
            try {
              // Target a real web tab, never the extension's own pages.
              const tabId = await resolveWebTab(sender);
              if (!tabId) { sendResponse({ ok: false, error: 'No web tab found' }); return; }
              const target = message.url;
              // Only http(s) - refuse javascript: and other dangerous schemes.
              let url = target;
              try {
                const parsed = new URL(target, 'http://invalid');
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                  sendResponse({ ok: false, error: `refused protocol: ${parsed.protocol}` });
                  return;
                }
                url = parsed.href;
              } catch {
                sendResponse({ ok: false, error: 'invalid url' });
                return;
              }
              await browser.tabs.update(tabId, { url });
              // Wait for the new page to settle (bounded) so the agent does not
              // re-extract a half-rendered DOM. Falls through on timeout.
              await waitForTabLoad(tabId, 10_000);
              privacyLedger.log({
                timestamp: Date.now(),
                tabId,
                url,
                type: 'EXECUTION',
                selector: 'NAVIGATE',
                confidence: 1,
                verified: true,
                action: 'SUCCESS',
              });
              sendResponse({ ok: true, url });
            } catch (e) {
              sendResponse({ ok: false, error: String(e) });
            }
          })();
          return true;

        case 'GET_PRIVACY_LEDGER':
          sendResponse(privacyLedger.getEntries());
          return true;

        case 'GET_AUDIT_LOG':
          sendResponse(auditLedger.getEntries());
          return true;

        case 'CLEAR_LEDGER':
          privacyLedger.clear();
          auditLedger.clear();
          sendResponse({ success: true });
          return true;

        case 'CAPTURE_SCREENSHOT':
          return captureScreenshot(message, sender);

        case 'START_SESSION':
          return handleStartSession(message, sender);

        case 'UPDATE_SESSION':
          return handleUpdateSession(message, sender);

        case 'COMPLETE_SESSION':
          return handleCompleteSession(message, sender);

        case 'GET_SESSION':
          return handleGetSession(message, sender);

        case 'START_TASK':
          // Issue #71/#69: spawn the SW-owned runner. Fire-and-forget; the
          // runner reports progress via TASK_PROGRESS broadcasts.
          // #143: a new run clears any stale gate pause from a prior run.
          resetOutboundGate();
          startTask(message, sender);
          sendResponse({ ok: true, running: true });
          return true;

        case 'STOP_TASK':
          stopFlag.stopped = true;
          abortController.abort();
          // #143: a STOP released while the run is paused at the outbound gate
          // resolves the pause as "stop requested" so the loop breaks cleanly.
          if (outboundConfirmResolver) {
            const r = outboundConfirmResolver;
            resetOutboundGate();
            r({ confirmed: false, stopRequested: true });
          }
          sendResponse({ ok: true });
          return true;

        case 'GET_TASK_STATE':
          sendResponse(activeTask);
          return true;

        // #143 P2: the popup's outbound-gate buttons. Each resolves the runner's
        // in-flight pause exactly once. Confirm -> execute the single send step;
        // dismiss -> skip just that step (completed work preserved, run ends
        // 'complete'); both are no-ops when no gate pause is in flight.
        case 'CONFIRM_OUTBOUND':
          if (outboundConfirmResolver) {
            const r = outboundConfirmResolver;
            resetOutboundGate();
            r({ confirmed: true });
            sendResponse({ ok: true, confirmed: true });
          } else {
            sendResponse({ ok: false, error: 'no outbound gate in flight' });
          }
          return true;

        case 'DISMISS_OUTBOUND':
          if (outboundConfirmResolver) {
            const r = outboundConfirmResolver;
            resetOutboundGate();
            r({ confirmed: false, dismissed: true });
            sendResponse({ ok: true, dismissed: true });
          } else {
            sendResponse({ ok: false, error: 'no outbound gate in flight' });
          }
          return true;

        default:
          sendResponse({ error: `Unknown message type: ${message.type}` });
          return true;
      }
    });

    // Track tab lifecycle
    browser.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
      if (changeInfo.url) {
        const session = sessionManager.getSessionForTab(tabId);
        if (session) {
          await sessionManager.updateSession(session.sessionId, changeInfo.url);
        }
      }
    });

    browser.tabs.onRemoved.addListener((tabId) => {
      // Find and mark session as completed
      for (const session of sessionManager.getActiveSessions()) {
        if (session.tabId === tabId) {
          sessionManager.completeSession(session.sessionId, 'Tab closed');
          break;
        }
      }
    });

    // Handle actions returned from server
    browser.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
      if (message.type === 'ACTION_RESULT') {
        agentState.lastActionResult = message.result;
      }
    });
  },
});

async function captureScreenshot(
  message: ScreenshotMessage,
  sender: browser.runtime.MessageSender
): Promise<{ dataUrl?: string; error?: string }> {
  try {
    const dataUrl = await browser.tabs.captureVisibleTab(sender.tab?.windowId);
    return { dataUrl };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Resolve the tab the agent should act on: a real web page, never the
 * extension's own pages (popup, devtools, chrome://, chrome-extension://).
 *
 * Why: the popup UI is usually a sender without a tab, so we fall back to the
 * active web tab. But if the popup itself is open AS A TAB (e.g. driven via
 * CDP), that active tab IS the extension page - acting on it would make the
 * agent extract/click its own UI instead of the page the user is looking at.
 * We therefore only accept a sender tab that is a real web URL; otherwise we
 * scan the sender's window (or the current window) for an active web tab.
 */
async function resolveWebTab(sender: browser.runtime.MessageSender): Promise<number | undefined> {
  const isWeb = (u?: string) => !!u && (u.startsWith('http://') || u.startsWith('https://'));

  // 1) Sender tab, if it is a real web page (typical content-script sender).
  if (sender.tab?.id && isWeb(sender.tab?.url)) {
    return sender.tab.id;
  }

  // 2) Active web tab in the sender's window.
  const inWindow = sender.tab?.windowId
    ? { windowId: sender.tab.windowId }
    : { currentWindow: true };
  const [active] = await browser.tabs.query({ active: true, ...inWindow });
  if (active?.id && isWeb(active.url)) {
    return active.id;
  }

  // 3) Any web tab in that window (e.g. a background tab the user is on).
  const tabs = await browser.tabs.query({ ...inWindow });
  const web = tabs.find((t) => isWeb(t.url));
  return web?.id;
}

/**
 * Resolve when a tab finishes loading a (new) document, or after a timeout.
 *
 * This is what a NAVIGATE waits on before the agent re-extracts: without it,
 * the next EXTRACT would read a half-rendered DOM and the planner would act on
 * nothing. We watch tabs.onUpdated for status === 'complete' and race it
 * against a hard deadline so a stuck page (or a same-document hash change that
 * never fires a fresh load) can't wedge the whole run.
 *
 * Returns true when we observed a load-complete, false when we timed out.
 */
async function waitForTabLoad(tabId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  // 1) Fast path: the tab is already fully loaded (e.g. navigating to the
  //    same URL, or the new page finished before we started listening).
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.status === 'complete') return true;
  } catch {
    // Tab may have been closed mid-navigation; fall through to the timeout.
  }

  return new Promise<boolean>((resolve) => {
    const listener = (_id: number, changeInfo: { status?: string; url?: string }) => {
      if (_id !== tabId) return;
      if (changeInfo.status === 'complete') {
        cleanup();
        resolve(true);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, Math.max(0, deadline - Date.now()));

    function cleanup() {
      clearTimeout(timer);
      try {
        browser.tabs.onUpdated.removeListener(listener);
      } catch {
        /* already removed / SW shutting down - safe to ignore */
      }
    }

    browser.tabs.onUpdated.addListener(listener);
  });
}

// Types
interface ScreenshotMessage {
  type: 'CAPTURE_SCREENSHOT';
}


class AgentState {
  currentTask: string | null = null;
  lastActionResult: any = null;
  stepCount: number = 0;
}

// ─── Session Handlers ────────────────────────────────────────────────────────

async function handleStartSession(
  message: any,
  sender: browser.runtime.MessageSender
): Promise<any> {
  const tabId = sender.tab?.id;
  if (!tabId) return { error: 'No tab ID' };

  const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
  const windowId = sender.tab?.windowId || activeTab?.windowId;

  const sessionId = await sessionManager.startSession(
    tabId,
    windowId || 0,
    message.url || activeTab?.url || '',
    message.taskDescription || '',
    message.maxSteps || 50
  );

  return { success: true, sessionId };
}

async function handleUpdateSession(
  message: any,
  sender: browser.runtime.MessageSender
): Promise<any> {
  const tabId = sender.tab?.id;
  if (!tabId) return { error: 'No tab ID' };

  const session = sessionManager.getSessionForTab(tabId);
  if (!session) return { error: 'No active session for this tab' };

  await sessionManager.updateSession(session.sessionId, message.url || session.currentUrl);

  return { success: true };
}

async function handleCompleteSession(
  message: any,
  sender: browser.runtime.MessageSender
): Promise<any> {
  const tabId = sender.tab?.id;
  if (!tabId) return { error: 'No tab ID' };

  const session = sessionManager.getSessionForTab(tabId);
  if (!session) return { error: 'No active session for this tab' };

  sessionManager.completeSession(session.sessionId, message.summary);

  return { success: true };
}

async function handleGetSession(
  message: any,
  sender: browser.runtime.MessageSender
): Promise<any> {
  const tabId = sender.tab?.id;
  if (!tabId) return { error: 'No tab ID' };

  const session = sessionManager.getSessionForTab(tabId);
  if (!session) return { error: 'No active session for this tab' };

  return { success: true, session };
}
