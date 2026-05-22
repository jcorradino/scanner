# Scanner

A command-line accessibility auditing tool that crawls a list of URLs with a headless browser, runs [axe-core](https://github.com/dequelabs/axe-core) against each page, captures annotated screenshots of every violation, persists results to MongoDB, and renders a browsable HTML report.

## Features

- Single `scanner` CLI that orchestrates scanning and report generation end-to-end.
- Headless scanning with Puppeteer at a 1400×1000 viewport.
- Auto-scrolls each page to force lazy-loaded content to render before auditing.
- Runs axe-core with a curated rule set (best-practice and noisy rules are disabled — see `scan.js` for the full list).
- Outlines each violating node in red and saves a per-node PNG screenshot to `scan-<scanID>/`.
- Stores raw violation data in the `axeResults` collection of a MongoDB `scanner` database, keyed by a generated `scanID`.
- Prints a quick summary report (occurrences and total node counts per rule) at the end of a scan.
- Generates a standalone Tailwind-styled HTML report from any stored `scanID`.

## Requirements

- Node.js (with npm)
- A MongoDB Atlas (or compatible) cluster
- Chromium dependencies for Puppeteer (installed automatically on most platforms via `npm install`)

## Installation

```bash
npm install
```

Create a `.env` file in the project root with your MongoDB credentials:

```
dbuser=<username>
dbpass=<password>
dbloc=<cluster-host>/?retryWrites=true&w=majority
```

The connection string is assembled as `mongodb+srv://${dbuser}:${dbpass}@${dbloc}` and the database name is hard-coded to `scanner`.

To use the `scanner` command globally, link the package once:

```bash
npm link
```

Without `npm link`, you can still invoke it via `npx scanner ...` or `npm run scanner -- ...`.

## Usage

The CLI exposes three subcommands. `run` is the default, so you can pass URLs straight to `scanner` and get a scan + report in one shot.

### Scan and report (default)

```bash
scanner https://example.com https://example.com/about
scanner run https://example.com -o ./reports
```

This runs the scan, then immediately generates the HTML report into `--output` (defaults to `./reports`).

### Scan only

```bash
scanner scan https://example.com https://example.com/about
```

Prints a `scanID` at the end that you can pass to `report` later.

### Report only

```bash
scanner report <scanID> -o ./reports
```

URLs can be passed as separate arguments or as a single comma-separated string — both forms are accepted.

### What happens during a scan

1. A `scanID` of the form `<timestamp>-<hash>` is generated.
2. For each URL, the page is loaded, scrolled to the bottom, and audited with axe-core.
3. Annotated screenshots of every violating node are written to `scan-<scanID>/page<N>-issue<M>-node<K>.png`.
4. One document per URL is inserted into the `axeResults` MongoDB collection.
5. A quick text summary is printed to stdout.

### About the HTML report

The HTML file is written to `<outputDir>/scan-report-<scanID>.html` and references screenshots via the relative path `../scan-<scanID>/...`. Keep your `reports/` directory as a sibling of the `scan-<scanID>/` directory (both at the project root by default) so the image links resolve.

## Project layout

```
bin/scanner.js   CLI entry point (the `scanner` command)
scan.js          Scanning library — exports scanUrls(urls)
report.js        Reporting library — exports generateHtmlReport(scanID, outputDir)
db.js            MongoDB connection helper (reads credentials from .env)
package.json     Dependencies and bin registration
```

`scan.js` and `report.js` are plain modules and can be required from your own scripts if you want to embed scanning/reporting in another workflow.

## Notes

- The axe ruleset in `scan.js` deliberately disables a large set of best-practice and landmark/structural rules to keep results focused on higher-signal violations. Edit the `axe.configure` call to change the rules in effect.
- Each scanned URL launches and closes a fresh Puppeteer browser.
- Scans write `scan-<scanID>/` to the current working directory, so run the CLI from the project root if you want the report's relative image paths to work without adjustment.
