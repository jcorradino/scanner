const puppeteer = require('puppeteer');
const axeCore = require('axe-core');
const connectDB = require('./db');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
    createProtocolState,
    attachProtocolListeners,
    installTrackingInitScript,
    waitForFullyLoaded,
} = require('./loading');

const DEFAULT_SETTLE_TIMEOUT_MS = 8000;

function generateScanID(urls) {
    const urlListHash = crypto.createHash('sha256').update(urls.join(',')).digest('hex').slice(0, 8);
    const timestamp = Date.now().toString();
    return `${timestamp}-${urlListHash}`;
}

async function runAxe(url, scanID, pageIndex, opts = {}) {
    const settleTimeoutMs = opts.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    const protocolState = createProtocolState();
    attachProtocolListeners(page, protocolState);
    await installTrackingInitScript(page);

    await page.setViewport({ width: 1400, height: 1000 });
    // Reset network bookkeeping at navigation start so a long idle period
    // before goto() doesn't trick the quiet-window check.
    protocolState.netInflight = 0;
    protocolState.lastNetActivityAt = Date.now();
    await page.goto(url, { waitUntil: 'load' });

    let res = await waitForFullyLoaded(page, protocolState, { timeoutMs: settleTimeoutMs });
    if (res.timedOut) {
        console.warn(`page did not settle within ${settleTimeoutMs}ms — auditing best-effort state (${url})`);
    }
    await scrollThroughPage(page);
    // Catch the lazy-loaded wave that scrolling kicked off.
    const postScrollCap = Math.min(3000, settleTimeoutMs);
    res = await waitForFullyLoaded(page, protocolState, { timeoutMs: postScrollCap });
    if (res.timedOut) {
        console.warn(`page did not settle within ${postScrollCap}ms after scroll — auditing best-effort state (${url})`);
    }

    await page.evaluate(axeCore.source);

    await page.evaluate(() => {
        axe.configure({
            rules: [
                { id: 'accesskeys', enabled: false },
                { id: 'aria-allowed-role', enabled: false },
                { id: 'aria-dialog-name', enabled: false },
                { id: 'aria-text', enabled: false },
                { id: 'aria-treeitem-name', enabled: false },
                { id: 'empty-heading', enabled: false },
                { id: 'frame-tested', enabled: false },
                { id: 'frame-title-unique', enabled: false },
                { id: 'heading-order', enabled: false },
                { id: 'image-redundant-alt', enabled: false },
                { id: 'label-title-only', enabled: false },
                { id: 'landmark-banner-is-top-level', enabled: false },
                { id: 'landmark-complementary-is-top-level', enabled: false },
                { id: 'landmark-contentinfo-is-top-level', enabled: false },
                { id: 'landmark-main-is-top-level', enabled: false },
                { id: 'landmark-no-duplicate-banner', enabled: false },
                { id: 'landmark-no-duplicate-contentinfo', enabled: false },
                { id: 'landmark-no-duplicate-main', enabled: false },
                { id: 'landmark-one-main', enabled: false },
                { id: 'landmark-unique', enabled: false },
                { id: 'meta-viewport-large', enabled: false },
                { id: 'meta-viewport', enabled: false },
                { id: 'page-has-heading-one', enabled: false },
                { id: 'presentation-role-conflict', enabled: false },
                { id: 'region', enabled: false },
                { id: 'scope-attr-valid', enabled: false },
                { id: 'skip-link', enabled: false },
                { id: 'tabindex', enabled: false },
                { id: 'table-duplicate-name', enabled: false }
            ]
        });
    });

    const results = await page.evaluate(() => {
        return axe.run();
    });

    if (results.violations.length === 0) {
        console.log(`No violations found on page ${url}.`);
    } else {
        await highlightAndCaptureIssues(page, results.violations, scanID, pageIndex);
    }

    await browser.close();
    return results;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function scrollThroughPage(page) {
    const scrollDelay = 1000;
    let previousHeight = await page.evaluate('document.body.scrollHeight');

    while (true) {
        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
        await delay(scrollDelay);

        const currentHeight = await page.evaluate('document.body.scrollHeight');
        if (currentHeight === previousHeight) {
            break;
        }
        previousHeight = currentHeight;
    }
}

async function highlightAndCaptureIssues(page, violations, scanID, pageIndex) {
    let issueCount = 0;

    const scanDir = path.join(process.cwd(), `scan-${scanID}`);
    if (!fs.existsSync(scanDir)) {
        fs.mkdirSync(scanDir, { recursive: true });
    }

    for (const violation of violations) {
        issueCount++;

        await page.evaluate(() => {
            const elements = document.querySelectorAll('*');
            elements.forEach(element => {
                element.style.border = '';
            });
        });

        for (const nodeIndex in violation.nodes) {
            const node = violation.nodes[nodeIndex];

            await page.evaluate((selector) => {
                const element = document.querySelector(selector);
                if (element) {
                    element.style.border = '5px solid red';
                }
            }, node.target);

            await page.evaluate((selector) => {
                const element = document.querySelector(selector);
                if (element) {
                    element.scrollIntoView({ behavior: 'instant', block: 'center' });
                }
            }, node.target);

            const screenshotPath = path.join(scanDir, `page${pageIndex}-issue${issueCount}-node${parseInt(nodeIndex) + 1}.png`);
            await page.screenshot({ path: screenshotPath });
            console.log(`Screenshot saved: ${screenshotPath}`);

            await page.evaluate((selector) => {
                const element = document.querySelector(selector);
                if (element) {
                    element.style.border = '';
                }
            }, node.target);
        }
    }
}

async function saveResults(url, results, scanID, pageIndex) {
    const db = await connectDB();
    const collection = db.collection('axeResults');
    const resultDoc = {
        url: url,
        timestamp: new Date(),
        issues: results.violations,
        scanID: scanID,
        pageID: pageIndex,
    };
    await collection.insertOne(resultDoc);
    console.log(`Results for ${url} saved to database under scanID ${scanID}, pageID ${pageIndex}`);
}

async function generateQuickReport(scanID) {
    const db = await connectDB();
    const collection = db.collection('axeResults');
    const violations = await collection.find({ scanID: scanID }).toArray();

    const issueCounts = {};
    const issueNodeCounts = {};

    violations.forEach(doc => {
        doc.issues.forEach(violation => {
            if (issueCounts[violation.id]) {
                issueCounts[violation.id]++;
            } else {
                issueCounts[violation.id] = 1;
            }

            const nodeCount = violation.nodes.length;
            if (issueNodeCounts[violation.id]) {
                issueNodeCounts[violation.id] += nodeCount;
            } else {
                issueNodeCounts[violation.id] = nodeCount;
            }
        });
    });

    console.log("Quick Report:");
    for (const [issueID, count] of Object.entries(issueCounts)) {
        const nodeCount = issueNodeCounts[issueID];
        console.log(`${issueID}: ${count} occurrence(s), Total nodes: ${nodeCount}`);
    }
}

async function scanUrls(urls, opts = {}) {
    const scanID = generateScanID(urls);

    let pageIndex = 0;

    for (const url of urls) {
        pageIndex++;
        console.log(`Scanning: ${url} (Page ${pageIndex})`);
        const results = await runAxe(url, scanID, pageIndex, opts);
        await saveResults(url, results, scanID, pageIndex);
    }

    await generateQuickReport(scanID);

    return scanID;
}

module.exports = { scanUrls, DEFAULT_SETTLE_TIMEOUT_MS };
