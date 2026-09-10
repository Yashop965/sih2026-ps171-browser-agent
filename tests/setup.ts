/**
 * Vitest setup file - mocks browser extension globals
 */

// Mock browser extension API to prevent polyfill initialization errors
globalThis.browser = {
  storage: {
    local: {
      get: async (keys: string | string[] | object | null) => ({}),
      set: async (items: object) => {},
      clear: async () => {},
      getBytesInUse: async () => 0,
      remove: async () => {},
    },
    sync: {
      get: async () => ({}),
      set: async () => {},
      clear: async () => {},
      getBytesInUse: async () => 0,
      remove: async () => {},
    },
    managed: {
      get: async () => ({}),
      set: async () => {},
      clear: async () => {},
      getBytesInUse: async () => 0,
      remove: async () => {},
    },
  },
  runtime: {
    id: 'test-extension-id',
    sendMessage: async () => {},
    onMessage: { addListener: () => {}, removeListener: () => {} },
  },
  tabs: {
    query: async () => [],
    getCurrent: async () => ({ id: 1, url: 'about:blank' }),
    update: async () => {},
    create: async () => ({ id: 1, url: 'about:blank' }),
    executeScript: async () => [],
  },
  extension: {
    inIncognitoContext: false,
    getURL: (path: string) => `chrome-extension://test/${path}`,
  },
  commands: {
    onAdded: { addListener: () => {}, removeListener: () => {} },
  },
  windows: {
    create: async () => ({ id: 1 }),
    getAll: async () => [],
    getCurrent: async () => ({ id: 1 }),
    update: async () => {},
    remove: async () => {},
  },
  bookmarks: {
    getTree: async () => [],
    search: async () => [],
    create: async () => ({}),
    remove: async () => {},
    move: async () => ({}),
    update: async () => ({}),
    getChildren: async () => [],
    getRecent: async () => [],
  },
  history: {
    search: async () => [],
    deleteUrl: async () => {},
    deleteAll: async () => {},
    deleteRange: async () => {},
  },
  contextMenus: {
    create: async () => 1,
    remove: async () => {},
    removeAll: async () => {},
    update: async () => ({}),
    onClicked: { addListener: () => {}, removeListener: () => {} },
  },
  notifications: {
    create: async () => 'id',
    clear: async () => true,
    getAll: async () => ({}),
    onUpdate: { addListener: () => {}, removeListener: () => {} },
    onClicked: { addListener: () => {}, removeListener: () => {} },
  },
  permissions: {
    contains: async () => true,
    getAll: async () => ([] as string[]),
    request: async () => true,
    remove: async () => true,
  },
  i18n: {
    getMessage: (message: string) => message,
    getAcceptLanguages: async () => ['en'],
  },
  idle: {
    queryState: async () => 'active',
    onStateChanged: { addListener: () => {}, removeListener: () => {} },
  },
  sessions: {
    getDevices: async () => [],
    getRecentlyClosed: async () => [],
    restore: async () => ({}),
  },
  webNavigation: {
    getAllFrames: async () => [],
    getFrame: async () => null,
  },
  webRequest: {
    handlerBehaviorChanged: async () => {},
  },
  pageAction: {
    show: async () => {},
    hide: async () => {},
    setIcon: async () => {},
    setPopup: async () => {},
    getTitle: async () => '',
    getPopup: async () => '',
  },
  browserAction: {
    enable: async () => {},
    disable: async () => {},
    setBadgeText: async () => {},
    getBadgeText: async () => '',
    setBadgeBackgroundColor: async () => {},
    getBadgeBackgroundColor: async () => [],
    setIcon: async () => {},
    setTitle: async () => {},
    getTitle: async () => '',
    setPopup: async () => {},
    getPopup: async () => '',
    openPopup: async () => {},
  },
};

// Also mock chrome for backward compatibility
(globalThis as any).chrome = globalThis.browser;
