const DEFAULT_NOISE_PATTERNS = [
    /google-analytics\.com/i,
    /googletagmanager\.com/i,
    /doubleclick\.net/i,
    /facebook\.com\/tr/i,
    /connect\.facebook\.net/i,
    /hotjar\.com/i,
    /segment\.(io|com)/i,
    /mixpanel\.com/i,
    /amplitude\.com/i,
    /heap(analytics)?\.com/i,
    /fullstory\.com/i,
    /logrocket\.com/i,
    /newrelic\.com/i,
    /nr-data\.net/i,
    /datadoghq\.com/i,
    /sentry\.io/i,
    /bugsnag\.com/i,
    /optimizely\.com/i,
    /\/beacon(\?|$|\/)/i,
    /\/collect(\?|$|\/)/i,
    /\/ping(\?|$|\/)/i,
];

function isNoisyRequest(req, patterns = DEFAULT_NOISE_PATTERNS) {
    let type;
    try { type = req.resourceType(); } catch (_) { type = ''; }
    if (type === 'websocket' || type === 'eventsource') return true;
    const url = req.url ? req.url() : '';
    return patterns.some(re => re.test(url));
}

// Installed via page.evaluateOnNewDocument so the MutationObserver and the
// secondary in-page fetch/XHR counter are present from document start on
// every navigation. Without this, the first wave of requests/mutations is
// missed and a streaming page can appear "stable" the instant we look.
const TRACKING_INIT_SCRIPT = `
(() => {
  if (window.__scannerTracking) return;
  const state = {
    inflight: 0,
    lastMutationAt: Date.now(),
    mutationCount: 0,
  };
  Object.defineProperty(window, '__scannerTracking', { value: state, writable: false, configurable: false });

  const attach = () => {
    if (!document || !document.documentElement) {
      setTimeout(attach, 0);
      return;
    }
    try {
      const obs = new MutationObserver((records) => {
        state.mutationCount += records.length;
        state.lastMutationAt = Date.now();
      });
      obs.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    } catch (_) {}
  };
  attach();

  try {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function patchedFetch() {
        state.inflight++;
        let p;
        try { p = origFetch.apply(this, arguments); }
        catch (e) { state.inflight--; throw e; }
        return Promise.resolve(p).finally(() => { state.inflight--; });
      };
    }
  } catch (_) {}

  try {
    const X = window.XMLHttpRequest;
    if (X && X.prototype) {
      const origSend = X.prototype.send;
      X.prototype.send = function patchedSend() {
        let counted = false;
        try {
          state.inflight++;
          counted = true;
          this.addEventListener('loadend', () => {
            if (counted) { counted = false; state.inflight--; }
          });
        } catch (_) {}
        try { return origSend.apply(this, arguments); }
        catch (e) {
          if (counted) { counted = false; state.inflight--; }
          throw e;
        }
      };
    }
  } catch (_) {}

  try {
    if (document.fonts && typeof document.fonts.ready === 'object') {
      // Touch .ready so the browser kicks off font loading bookkeeping early;
      // we read .status (sync) in the snapshot, never await .ready.
      void document.fonts.ready;
    }
  } catch (_) {}
})();
`;

// Pure, synchronous decision — easy to unit-test offline.
// Page is "stable" when no protocol requests are in-flight, no in-page
// fetch/XHR is in-flight, no busy/loading affordance is visible, fonts
// are loaded, and both the DOM and the network have been quiet for at
// least quietMs.
function isStable(snapshot, quietMs) {
    if (!snapshot) return false;
    if ((snapshot.netInflight | 0) > 0) return false;
    if ((snapshot.inPageInflight | 0) > 0) return false;
    if (snapshot.busy) return false;
    if (snapshot.fontsReady === false) return false;
    const now = typeof snapshot.now === 'number' ? snapshot.now : Date.now();
    const sinceMutation = now - (snapshot.lastMutationAt || 0);
    const sinceNet = now - (snapshot.lastNetActivityAt || 0);
    if (sinceMutation < quietMs) return false;
    if (sinceNet < quietMs) return false;
    return true;
}

async function readSnapshot(page, protocolState) {
    const inPage = await page.evaluate(() => {
        const s = window.__scannerTracking || { inflight: 0, lastMutationAt: Date.now() };
        let busy = false;
        try {
            if (document.querySelector('[aria-busy="true"]')) busy = true;
            if (!busy && document.querySelector('[role="progressbar"]:not([aria-hidden="true"])')) busy = true;
            if (!busy && document.querySelector(
                '.skeleton, .skeleton-loader, .spinner, .loading-spinner, [data-loading="true"]'
            )) busy = true;
        } catch (_) {}
        let fontsReady = true;
        try {
            if (document.fonts && typeof document.fonts.status === 'string') {
                fontsReady = document.fonts.status === 'loaded';
            }
        } catch (_) {}
        return {
            inPageInflight: s.inflight | 0,
            lastMutationAt: s.lastMutationAt || Date.now(),
            now: Date.now(),
            busy,
            fontsReady,
        };
    });
    return {
        ...inPage,
        netInflight: protocolState.netInflight,
        lastNetActivityAt: protocolState.lastNetActivityAt,
    };
}

function createProtocolState() {
    return { netInflight: 0, lastNetActivityAt: Date.now() };
}

function attachProtocolListeners(page, protocolState, patterns = DEFAULT_NOISE_PATTERNS) {
    const bump = () => { protocolState.lastNetActivityAt = Date.now(); };
    const onRequest = (req) => {
        if (isNoisyRequest(req, patterns)) return;
        protocolState.netInflight++;
        bump();
    };
    const onSettled = (req) => {
        if (isNoisyRequest(req, patterns)) return;
        protocolState.netInflight = Math.max(0, protocolState.netInflight - 1);
        bump();
    };
    page.on('request', onRequest);
    page.on('requestfinished', onSettled);
    page.on('requestfailed', onSettled);
}

async function installTrackingInitScript(page) {
    await page.evaluateOnNewDocument(TRACKING_INIT_SCRIPT);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForFullyLoaded(page, protocolState, opts = {}) {
    const timeoutMs = opts.timeoutMs;
    const quietMs = opts.quietMs ?? 400;
    const pollMs = opts.pollMs ?? 100;
    const startTs = Date.now();
    const deadline = startTs + timeoutMs;
    let lastSnap = null;
    while (Date.now() < deadline) {
        try {
            lastSnap = await readSnapshot(page, protocolState);
        } catch (_) {
            // Page might be mid-navigation/closed; brief wait and retry until cap.
            await delay(pollMs);
            continue;
        }
        if (isStable(lastSnap, quietMs)) {
            return { stable: true, timedOut: false, elapsedMs: Date.now() - startTs, snapshot: lastSnap };
        }
        await delay(pollMs);
    }
    return { stable: false, timedOut: true, elapsedMs: Date.now() - startTs, snapshot: lastSnap };
}

module.exports = {
    DEFAULT_NOISE_PATTERNS,
    TRACKING_INIT_SCRIPT,
    isNoisyRequest,
    isStable,
    readSnapshot,
    createProtocolState,
    attachProtocolListeners,
    installTrackingInitScript,
    waitForFullyLoaded,
};
