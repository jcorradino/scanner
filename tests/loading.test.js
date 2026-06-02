const test = require('node:test');
const assert = require('node:assert/strict');

const { isStable, isNoisyRequest, DEFAULT_NOISE_PATTERNS } = require('../loading');

const QUIET = 400;

function baseSnapshot(overrides = {}) {
    const now = 10_000;
    return {
        netInflight: 0,
        inPageInflight: 0,
        busy: false,
        fontsReady: true,
        lastMutationAt: now - QUIET - 1,
        lastNetActivityAt: now - QUIET - 1,
        now,
        ...overrides,
    };
}

test('isStable: all-quiet snapshot is stable', () => {
    assert.equal(isStable(baseSnapshot(), QUIET), true);
});

test('isStable: protocol inflight > 0 blocks', () => {
    assert.equal(isStable(baseSnapshot({ netInflight: 1 }), QUIET), false);
});

test('isStable: in-page inflight > 0 blocks', () => {
    assert.equal(isStable(baseSnapshot({ inPageInflight: 2 }), QUIET), false);
});

test('isStable: busy=true blocks', () => {
    assert.equal(isStable(baseSnapshot({ busy: true }), QUIET), false);
});

test('isStable: fontsReady=false blocks', () => {
    assert.equal(isStable(baseSnapshot({ fontsReady: false }), QUIET), false);
});

test('isStable: recent mutation (within quiet window) blocks', () => {
    const now = 10_000;
    const snap = baseSnapshot({ now, lastMutationAt: now - (QUIET - 50) });
    assert.equal(isStable(snap, QUIET), false);
});

test('isStable: recent network activity (within quiet window) blocks', () => {
    const now = 10_000;
    const snap = baseSnapshot({ now, lastNetActivityAt: now - (QUIET - 50) });
    assert.equal(isStable(snap, QUIET), false);
});

test('isStable: mutation exactly quietMs ago is allowed', () => {
    const now = 10_000;
    const snap = baseSnapshot({ now, lastMutationAt: now - QUIET, lastNetActivityAt: now - QUIET });
    assert.equal(isStable(snap, QUIET), true);
});

test('isStable: null/undefined snapshot is not stable', () => {
    assert.equal(isStable(null, QUIET), false);
    assert.equal(isStable(undefined, QUIET), false);
});

test('isNoisyRequest: filters websocket and eventsource by resourceType', () => {
    const wsReq = { resourceType: () => 'websocket', url: () => 'https://example.com/x' };
    const esReq = { resourceType: () => 'eventsource', url: () => 'https://example.com/y' };
    assert.equal(isNoisyRequest(wsReq), true);
    assert.equal(isNoisyRequest(esReq), true);
});

test('isNoisyRequest: filters known analytics/telemetry hosts', () => {
    const cases = [
        'https://www.google-analytics.com/g/collect?v=2',
        'https://www.googletagmanager.com/gtm.js?id=GTM-X',
        'https://stats.g.doubleclick.net/g/collect',
        'https://www.facebook.com/tr?id=1',
        'https://script.hotjar.com/modules.html',
        'https://api.segment.io/v1/p',
        'https://api.mixpanel.com/track',
        'https://api2.amplitude.com/2/httpapi',
        'https://heapanalytics.com/h',
        'https://rs.fullstory.com/rec',
        'https://r.logrocket.com/i',
        'https://bam.nr-data.net/1/abc',
        'https://o123.ingest.sentry.io/api/1/store/',
        'https://notify.bugsnag.com/',
        'https://cdn.optimizely.com/datafiles/x.json',
        'https://example.com/api/beacon?x=1',
    ];
    for (const u of cases) {
        const req = { resourceType: () => 'fetch', url: () => u };
        assert.equal(isNoisyRequest(req), true, `expected noisy: ${u}`);
    }
});

test('isNoisyRequest: real app traffic is not noisy', () => {
    const cases = [
        'https://example.com/api/users',
        'https://cdn.example.com/main.js',
        'https://example.com/index.html',
        'https://example.com/data.json',
    ];
    for (const u of cases) {
        const req = { resourceType: () => 'fetch', url: () => u };
        assert.equal(isNoisyRequest(req), false, `expected not noisy: ${u}`);
    }
});

test('DEFAULT_NOISE_PATTERNS is a non-empty array of RegExp', () => {
    assert.ok(Array.isArray(DEFAULT_NOISE_PATTERNS));
    assert.ok(DEFAULT_NOISE_PATTERNS.length > 0);
    for (const p of DEFAULT_NOISE_PATTERNS) {
        assert.ok(p instanceof RegExp);
    }
});
