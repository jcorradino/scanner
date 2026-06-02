// Live smoke test (manual): exercises navigation + waitForFullyLoaded.
// Spins up a local http server so we can drive a slow response. Not part of `npm test`.
const http = require('node:http');
const puppeteer = require('puppeteer');
const {
    createProtocolState,
    attachProtocolListeners,
    installTrackingInitScript,
    waitForFullyLoaded,
} = require('../loading');

function startServer() {
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            if (req.url === '/static') {
                res.writeHead(200, { 'content-type': 'text/html' });
                res.end(`<!doctype html><html><body><h1>static</h1></body></html>`);
                return;
            }
            if (req.url === '/slow') {
                res.writeHead(200, { 'content-type': 'text/html' });
                res.end(`<!doctype html><html><body>
<div id="r">init</div>
<script>
  fetch('/api/slow').then(r => r.text()).then(t => {
    const d = document.createElement('div'); d.id='late'; d.textContent=t;
    document.body.appendChild(d);
  });
</script>
</body></html>`);
                return;
            }
            if (req.url === '/api/slow') {
                setTimeout(() => {
                    res.writeHead(200, { 'content-type': 'text/plain' });
                    res.end('late-data');
                }, 1800);
                return;
            }
            if (req.url === '/hostile') {
                res.writeHead(200, { 'content-type': 'text/html' });
                res.end(`<!doctype html><html><body>
<div id="x"></div>
<script>
  setInterval(() => {
    const e = document.getElementById('x');
    if (e) e.setAttribute('data-t', String(Date.now()));
  }, 50);
</script>
</body></html>`);
                return;
            }
            res.writeHead(404); res.end();
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

async function navigate(page, url, timeoutMs) {
    const ps = createProtocolState();
    attachProtocolListeners(page, ps);
    ps.netInflight = 0; ps.lastNetActivityAt = Date.now();
    await page.goto(url, { waitUntil: 'load' });
    return waitForFullyLoaded(page, ps, { timeoutMs });
}

(async () => {
    const server = await startServer();
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await installTrackingInitScript(page);

    const fast = await navigate(page, `${base}/static`, 8000);
    console.log(`static: stable=${fast.stable} elapsedMs=${fast.elapsedMs}`);
    if (!fast.stable || fast.elapsedMs > 1500) {
        console.error(`FAIL: static should settle fast`);
        await browser.close(); server.close(); process.exit(1);
    }

    const slow = await navigate(page, `${base}/slow`, 8000);
    console.log(`slow: stable=${slow.stable} elapsedMs=${slow.elapsedMs}`);
    if (!slow.stable || slow.elapsedMs < 1800) {
        console.error(`FAIL: slow should settle AFTER ~1800ms`);
        await browser.close(); server.close(); process.exit(1);
    }

    const hostile = await navigate(page, `${base}/hostile`, 1500);
    console.log(`hostile: stable=${hostile.stable} timedOut=${hostile.timedOut} elapsedMs=${hostile.elapsedMs}`);
    if (hostile.stable || !hostile.timedOut) {
        console.error(`FAIL: hostile should time out`);
        await browser.close(); server.close(); process.exit(1);
    }

    await browser.close();
    server.close();
    console.log('all live smoke checks passed');
})().catch(e => { console.error(e); process.exit(1); });
