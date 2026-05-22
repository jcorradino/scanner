const puppeteer = require('puppeteer');
const axeCore = require('axe-core');
const connectDB = require('./db');
const { program } = require('commander');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Generates a unique scan ID based on the URL list
function generateScanID(urls) {
    const urlListHash = crypto.createHash('sha256').update(urls.join(',')).digest('hex').slice(0, 8);
    const timestamp = Date.now().toString();
    return `${timestamp}-${urlListHash}`;
}

// Runs axe-core on the provided URL, excluding best practice rules
async function runAxe(url, scanID, pageIndex) {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    await page.setViewport({ width: 1400, height: 1000 });
    await page.goto(url);

    await delay(2000);
    await scrollThroughPage(page);

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

// Simple delay function to wait for a specified time
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Scrolls through the entire page to ensure content is loaded
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

// Highlights and captures screenshots of violations
async function highlightAndCaptureIssues(page, violations, scanID, pageIndex) {
    let issueCount = 0;

    const scanDir = path.join(__dirname, `scan-${scanID}`);
    if (!fs.existsSync(scanDir)) {
        fs.mkdirSync(scanDir);
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

            // Scroll the element into view to focus it (instant scroll behavior)
            await page.evaluate((selector) => {
                const element = document.querySelector(selector);
                if (element) {
                    element.scrollIntoView({ behavior: 'instant', block: 'center' });
                }
            }, node.target);

            // Screenshot for each individual node within the violation
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

// Saves the scan results to a MongoDB collection
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

// Generates a quick report of the violations found in the scan
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

// Runs the scanning process for all provided URLs
async function scanUrls(urls) {
    const scanID = generateScanID(urls);

    let pageIndex = 0;
    let allViolations = [];

    for (const url of urls) {
        pageIndex++;
        console.log(`Scanning: ${url} (Page ${pageIndex})`);
        const results = await runAxe(url, scanID, pageIndex);
        allViolations = allViolations.concat(results.violations);
        await saveResults(url, results, scanID, pageIndex);
    }

    await generateQuickReport(scanID);

    console.log("Scan completed. Exiting process...");
    process.exit(0);
}

// Command-line argument handling
program
    .version('1.0.0')
    .description('Axe-core scanner for URLs')
    .option('-u, --urls <urls>', 'Comma-separated list of URLs to scan', (val) => val.split(','))
    .parse(process.argv);

const { urls } = program.opts();

if (!urls || urls.length === 0) {
    console.log('Please provide a list of URLs to scan.');
    process.exit(1);
}

scanUrls(urls);
