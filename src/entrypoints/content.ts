import { defineContentScript } from 'wxt/sandbox';
import { browser } from 'wxt/browser';
import { extract, getPageContext } from '../lib/dom';
import { executeWithRetry, type Action } from '../lib/actions';

// Messages the background worker can send us.
type AgentRequest =
    | { type: 'EXTRACT' }
    | { type: 'EXECUTE'; action: Action }
    | { type: 'PING' };

function isAgentRequest(msg: unknown): msg is AgentRequest {
    if (typeof msg !== 'object' || msg === null || !('type' in msg)) return false;
    const t = (msg as { type: unknown }).type;
    return t === 'EXTRACT' || t === 'EXECUTE' || t === 'PING';
}

export default defineContentScript({
    matches: ['<all_urls>'],
    main() {
        console.log('[agent] content script loaded on', location.href);

        // Returning a promise is the polyfill's async pattern. Returning
        // undefined means "not mine" — the message is left for other
        // listeners in the extension instead of being answered with a bogus
        // error, which would break anything else using runtime messaging.
        browser.runtime.onMessage.addListener((message: unknown) => {
            if (!isAgentRequest(message)) return;

            if (message.type === 'EXTRACT') {
                return Promise.resolve({
                    ok: true,
                    elements: extract(),
                    context: getPageContext(),
                });
            }

            if (message.type === 'EXECUTE') {
                return executeWithRetry(message.action);
            }

            if (message.type === 'PING') {
                return Promise.resolve({ ok: true, url: location.href });
            }

            return;
        });

        // Dev-only console hook for manual testing from DevTools.
        // import.meta.env.DEV is false in production builds, so this whole
        // block is dead-code-eliminated and never ships.
        if (import.meta.env.DEV) {
            (window as unknown as Record<string, unknown>).__agent = {
                extract,
                execute: executeWithRetry,
                context: getPageContext,
            };
        }
    },
});