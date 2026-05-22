const fs = require('fs');
const path = require('path');
const { program } = require('commander'); // For command-line argument parsing
const connectDB = require('./db'); // MongoDB connection

// Generates the HTML report from scan results and screenshots
async function generateHtmlReport(scanID, outputDir) {
    const scanResults = await fetchScanResults(scanID); // Fetch the results from DB
    const htmlContent = generateHtmlContent(scanResults, scanID); // Generate HTML content based on the results

    // Define the output file path
    const outputPath = path.join(outputDir, `scan-report-${scanID}.html`);

    // Write the HTML content to the file
    fs.writeFileSync(outputPath, htmlContent, 'utf8');
    console.log(`HTML report saved to ${outputPath}`);

    process.exit(1);
}

// Fetch scan results from your MongoDB based on scanID
async function fetchScanResults(scanID) {
    const db = await connectDB();
    const collection = db.collection('axeResults');
    const results = await collection.find({ scanID: scanID }).toArray();
    return results; // Return the scan results as an array
}

function escapeHtml(str = '') {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Generates HTML content based on the scan results
function generateHtmlContent(scanResults, scanID) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Accessibility Scan Report</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 text-gray-800 antialiased p-6">
  <h1 class="text-3xl font-bold mb-6">Accessibility Scan Report</h1>

  ${scanResults.map(page => `
    <details open class="mb-4 border border-gray-200 rounded-lg overflow-hidden">
      <summary class="cursor-pointer bg-gray-100 px-4 py-2 text-lg font-medium hover:bg-gray-200 focus:outline-none">
        Page: <a href="${page.url}" target="_blank" class="text-blue-600 hover:underline">${page.url}</a>
      </summary>
      <div class="p-4 bg-white">
        ${page.issues.map((issue, idx) => {
          const safeId   = escapeHtml(issue.id);
          const safeDesc = escapeHtml(issue.description);
          return `
          <details open class="mb-3 border border-gray-200 rounded-md">
            <summary class="cursor-pointer px-3 py-2 bg-gray-100 hover:bg-gray-200 font-semibold focus:outline-none">
              Issue ${idx + 1}: ${safeId} – ${safeDesc}
            </summary>
            <div class="p-3 space-y-4">
              ${issue.nodes.map((node, nidx) => `
                <div class="space-y-2">
                  <p class="text-sm"><code class="bg-gray-100 px-1 rounded">${node.target}</code></p>
                  <img
                    src="../scan-${scanID}/page${page.pageID}-issue${idx + 1}-node${nidx + 1}.png"
                    alt="Screenshot of issue"
                    class="max-w-full border rounded shadow-sm"
                  />
                </div>
              `).join('')}
            </div>
          </details>`;
        }).join('')}
      </div>
    </details>
  `).join('')}

</body>
</html>`;
}


// Command-line argument handling
program
    .version('1.0.0')
    .description('Generate Accessibility Scan Report')
    .option('-s, --scanID <scanID>', 'Scan ID for the report')  // Use the provided scanID
    .option('-o, --outputDir <outputDir>', 'Directory to save the report', './reports') // Output directory for the report
    .parse(process.argv);

const { scanID, outputDir } = program.opts();

// Ensure a scanID is provided
if (!scanID) {
    console.log('Please provide a scanID using the -s flag.');
    process.exit(1);
}

// Run the report generation
generateHtmlReport(scanID, outputDir);
