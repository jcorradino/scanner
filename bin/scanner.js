#!/usr/bin/env node

const { program } = require('commander');
const { scanUrls } = require('../scan');
const { generateHtmlReport } = require('../report');

const DEFAULT_OUTPUT_DIR = './reports';

function expandUrls(urls) {
    return urls.flatMap(u => u.split(',')).map(u => u.trim()).filter(Boolean);
}

async function runScan(urls) {
    const expanded = expandUrls(urls);
    if (expanded.length === 0) {
        console.error('No URLs provided.');
        process.exit(1);
    }
    return scanUrls(expanded);
}

async function runReport(scanID, outputDir) {
    return generateHtmlReport(scanID, outputDir);
}

program
    .name('scanner')
    .version('1.0.0')
    .description('Accessibility scanner powered by axe-core + Puppeteer');

program
    .command('scan <urls...>')
    .description('Scan one or more URLs and store violations in MongoDB')
    .action(async (urls) => {
        try {
            const scanID = await runScan(urls);
            console.log(`\nScan complete. scanID: ${scanID}`);
            process.exit(0);
        } catch (err) {
            console.error(err);
            process.exit(1);
        }
    });

program
    .command('report <scanID>')
    .description('Generate an HTML report for an existing scanID')
    .option('-o, --output <dir>', 'output directory', DEFAULT_OUTPUT_DIR)
    .action(async (scanID, opts) => {
        try {
            await runReport(scanID, opts.output);
            process.exit(0);
        } catch (err) {
            console.error(err);
            process.exit(1);
        }
    });

program
    .command('run <urls...>', { isDefault: true })
    .description('Scan URLs and immediately generate an HTML report (default)')
    .option('-o, --output <dir>', 'output directory', DEFAULT_OUTPUT_DIR)
    .action(async (urls, opts) => {
        try {
            const scanID = await runScan(urls);
            console.log(`\nScan complete. scanID: ${scanID}`);
            console.log('Generating HTML report...');
            await runReport(scanID, opts.output);
            process.exit(0);
        } catch (err) {
            console.error(err);
            process.exit(1);
        }
    });

program.parse(process.argv);
