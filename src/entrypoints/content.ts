declare const chrome: any;

import { defineContentScript } from 'wxt/sandbox';
import { extract, getPageContext } from '../lib/dom';
import { executeWithRetry, type Action } from '../lib/actions';

export default defineContentScript({
    matches: ['<all_urls>'],
    main() {
        console.log('[agent] content script loaded on', location.href);

        chrome.runtime.onMessage.addListener(
            (msg: any, _sender: any, sendResponse: any) => {
                if (msg?.type === 'EXTRACT') {
                    sendResponse({
                        ok: true,
                        elements: extract(),
                        context: getPageContext(),
                    });
                    return true;
                }

                if (msg?.type === 'EXECUTE') {
                    executeWithRetry(msg.action as Action).then(sendResponse);
                    return true;
                }

                if (msg?.type === 'PING') {
                    sendResponse({ ok: true, url: location.href });
                    return true;
                }

                return false;
            }
        );

        // Manual testing hook, dev builds only. Stripped from production so we
        // don't leave a callable agent surface on every page the user visits.
        if (import.meta.env.DEV) {
            (window as any).__agent = { extract, execute: executeWithRetry };
        }
    },
});