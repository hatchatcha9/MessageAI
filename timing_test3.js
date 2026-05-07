// Cache timing test: populates cache first, then measures response times using cached data
const crypto = require('crypto');
const https = require('https');
const querystring = require('querystring');

const AUTH_TOKEN = '95025b3d8971543a7a1b31de5f160471';
const BASE_URL = 'https://messageai-production.up.railway.app/api/twilio/webhook';
const LOGS_URL = 'https://messageai-production.up.railway.app/logs';
const CLEAR_URL = 'https://messageai-production.up.railway.app/api/clear';
const RESET_URL = 'https://messageai-production.up.railway.app/api/reset-session';

function computeSignature(url, params) {
    const sorted = Object.keys(params).sort();
    let str = url;
    for (const key of sorted) str += key + params[key];
    return crypto.createHmac('sha1', AUTH_TOKEN).update(str).digest('base64');
}

function sendMessage(body) {
    return new Promise((resolve, reject) => {
        const params = { Body: body, From: '+18018006072' };
        const sig = computeSignature(BASE_URL, params);
        const postData = querystring.stringify(params);
        const url = new URL(BASE_URL);
        const req = https.request({
            hostname: url.hostname, path: url.pathname, method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData), 'X-Twilio-Signature': sig }
        }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve()); });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

function getLogs(n = 300) {
    return new Promise((resolve, reject) => {
        https.get(`${LOGS_URL}?n=${n}`, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(d)); }).on('error', reject);
    });
}

function postJSON(urlStr, body) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(body);
        const url = new URL(urlStr);
        const req = https.request({ hostname: url.hostname, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve()); });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}
const clearAll = () => postJSON(CLEAR_URL, { phone: '+18018006072' });
const resetSession = () => postJSON(RESET_URL, { phone: '+18018006072' });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Poll until a new Sent line appears after a given timestamp (ms since epoch)
async function waitForSent(afterMs, maxWaitMs = 60000) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        await sleep(1500);
        const logs = await getLogs(100);
        for (const line of logs.split('\n').reverse()) {
            const m = line.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\].*\[Twilio\] Sent to \+18018006072 \((\d+) chars\)/);
            if (!m) continue;
            const ts = new Date(m[1].replace(' ', 'T') + 'Z').getTime();
            if (ts > afterMs + 500) { // +500ms buffer to skip instant ack
                return { ts, elapsed: ts - afterMs, chars: parseInt(m[2]), logTs: m[1] };
            }
        }
    }
    return { ts: Date.now(), elapsed: maxWaitMs, chars: 0, logTs: 'TIMEOUT' };
}

// Send message and wait for the SECOND Sent line (first=ack, second=real response)
async function timedStep(label, message) {
    console.log(`\n  Sending: "${message}"`);
    const sentAt = Date.now();
    await sendMessage(message);

    // Wait for ack (first response, usually <1s)
    const ack = await waitForSent(sentAt, 5000);
    const ackMs = ack.ts - sentAt;
    console.log(`  Ack: ${ackMs}ms (${ack.chars} chars) @ ${ack.logTs}`);

    // Wait for full response (second Sent line)
    const result = await waitForSent(ack.ts, 60000);
    const totalMs = result.ts - sentAt;
    console.log(`  Response: ${result.ts - ack.ts}ms after ack (${result.chars} chars) @ ${result.logTs}`);
    console.log(`  ✅ Total: ${(totalMs/1000).toFixed(1)}s`);
    return { label, ackMs, responseAfterAckMs: result.ts - ack.ts, totalMs };
}

// Single step: send and wait for ANY response (no ack expected)
async function timedStepNoAck(label, message) {
    console.log(`\n  Sending: "${message}"`);
    const sentAt = Date.now();
    await sendMessage(message);
    const result = await waitForSent(sentAt, 60000);
    const totalMs = result.ts - sentAt;
    console.log(`  Response: ${totalMs}ms (${result.chars} chars) @ ${result.logTs}`);
    console.log(`  ✅ Total: ${(totalMs/1000).toFixed(1)}s`);
    return { label, ackMs: 0, responseAfterAckMs: totalMs, totalMs };
}

async function runTest(label, clearCacheFirst) {
    console.log(`\n${'='.repeat(55)}`);
    console.log(`${label}`);
    console.log('='.repeat(55));

    if (clearCacheFirst) {
        console.log('Clearing ALL state (including caches)...');
        await clearAll();
        await sleep(1000);
    }

    const results = [];

    console.log('\n[STEP 1] Search');
    results.push(await timedStep('Search', 'I want a burger'));
    await sleep(500);

    console.log('\n[STEP 2] Select restaurant 1');
    results.push(await timedStep('Select + menu', '1'));
    await sleep(500);

    console.log('\n[STEP 3] Add item 1');
    results.push(await timedStep('Add item', 'add item 1'));

    console.log(`\n--- ${label} Summary ---`);
    for (const r of results) {
        console.log(`${r.label.padEnd(16)} ack=${r.ackMs}ms  result=${r.responseAfterAckMs}ms  total=${(r.totalMs/1000).toFixed(1)}s`);
    }
    return results;
}

(async () => {
    // Run 1: fresh (no cache) - establishes cache
    const r1 = await runTest('RUN 1: FRESH (no cache)', true);
    await sleep(2000);

    // Check if cache was populated
    const logs = await getLogs(50);
    const hasCacheHit = logs.includes('Cache hit') || logs.includes('Fast cache');
    console.log(`\nCache populated: ${hasCacheHit ? 'YES (already had cache)' : 'YES (just built from run 1)'}`);

    // Run 2: reset session but keep search/menu caches
    console.log('\n' + '='.repeat(55));
    console.log('RUN 2: CACHED (session reset, caches preserved)');
    console.log('='.repeat(55));
    console.log('Resetting session (keeping search+menu caches)...');
    await resetSession();
    await sleep(1000);

    const r2results = [];

    console.log('\n[STEP 1] Search (should be instant from cache)');
    r2results.push(await timedStep('Search (cached)', 'I want a burger'));
    await sleep(500);

    console.log('\n[STEP 2] Select restaurant 1 (should be instant from cache)');
    r2results.push(await timedStep('Select (cached)', '1'));
    await sleep(500);

    console.log('\n[STEP 3] Add item 1 (browser pre-warmed in background)');
    r2results.push(await timedStep('Add item', 'add item 1'));

    console.log('\n--- RUN 2: CACHED Summary ---');
    for (const r of r2results) {
        console.log(`${r.label.padEnd(20)} ack=${r.ackMs}ms  result=${r.responseAfterAckMs}ms  total=${(r.totalMs/1000).toFixed(1)}s`);
    }

    console.log('\n========== COMPARISON ==========');
    console.log('Step        | Fresh  | Cached');
    console.log('------------|--------|-------');
    for (let i = 0; i < r1.length; i++) {
        const fresh = (r1[i].totalMs/1000).toFixed(1) + 's';
        const cached = (r2results[i].totalMs/1000).toFixed(1) + 's';
        console.log(`${r1[i].label.padEnd(12)}| ${fresh.padEnd(7)}| ${cached}`);
    }

    // Print recent key logs
    const finalLogs = await getLogs(60);
    console.log('\n--- Recent key events ---');
    finalLogs.split('\n').filter(l => l.includes('[Twilio]') || l.includes('Cache hit') || l.includes('Fast cache') || l.includes('Pre-warm') || l.includes('Selected restaurant')).slice(-20).forEach(l => console.log(l));
})();
