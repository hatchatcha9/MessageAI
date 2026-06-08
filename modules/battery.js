/**
 * Battery module for frog — PiSugar 3 Plus
 *
 * Reads battery level and charging status from the pisugar-server daemon,
 * which communicates with the PiSugar 3 Plus over I2C.
 *
 * On non-Pi or if pisugar-server is not installed, all calls return null gracefully.
 *
 * pisugar-server listens on TCP port 8423.
 * Install on Pi: curl https://cdn.pisugar.com/release/install.sh | sudo bash
 *
 * Usage:
 *   const battery = require('./modules/battery');
 *   const status = await battery.getStatus();
 *   // { percent: 85, charging: false, voltage: 4.1 } or null
 */

const net = require('net');
const fs  = require('fs');

const IS_PI = process.platform === 'linux' &&
    fs.existsSync('/proc/device-tree/model') &&
    fs.readFileSync('/proc/device-tree/model', 'utf8').includes('Raspberry');

const PISUGAR_HOST = '127.0.0.1';
const PISUGAR_PORT = 8423;
const TIMEOUT_MS   = 3000;

// Cache so we're not hammering the daemon every request
let _cache    = null;
let _cacheTs  = 0;
const CACHE_TTL = 30 * 1000; // refresh every 30s

// ---------- pisugar-server query ----------

function query(command) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        let data = '';

        sock.setTimeout(TIMEOUT_MS);

        sock.connect(PISUGAR_PORT, PISUGAR_HOST, () => {
            sock.write(command + '\n');
        });

        sock.on('data', (chunk) => {
            data += chunk.toString();
            // pisugar-server sends one line per command then closes
            if (data.includes('\n')) {
                sock.destroy();
                resolve(data.trim());
            }
        });

        sock.on('timeout', () => { sock.destroy(); resolve(null); });
        sock.on('error',   () => { sock.destroy(); resolve(null); });
        sock.on('close',   () => resolve(data.trim() || null));
    });
}

// Parse "battery: 85.23" → 85
function parsePercent(raw) {
    if (!raw) return null;
    const m = raw.match(/[\d.]+/);
    return m ? Math.round(parseFloat(m[0])) : null;
}

// Parse "battery_charging: true" → true
function parseBool(raw) {
    if (!raw) return null;
    return raw.includes('true');
}

// Parse "battery_voltage: 4123" (mV) → 4.123
function parseVoltage(raw) {
    if (!raw) return null;
    const m = raw.match(/[\d.]+/);
    if (!m) return null;
    const v = parseFloat(m[0]);
    // pisugar-server returns mV as an integer (e.g. 4123)
    return v > 10 ? Math.round(v / 1000 * 100) / 100 : Math.round(v * 100) / 100;
}

// ---------- Public API ----------

/**
 * Returns { percent, charging, voltage } or null if unavailable.
 * Results are cached for 30 seconds.
 */
async function getStatus() {
    if (!IS_PI) return null;

    const now = Date.now();
    if (_cache && now - _cacheTs < CACHE_TTL) return _cache;

    try {
        const [rawPct, rawChg, rawVolt] = await Promise.all([
            query('get battery'),
            query('get battery_charging'),
            query('get battery_voltage'),
        ]);

        const percent  = parsePercent(rawPct);
        const charging = parseBool(rawChg);
        const voltage  = parseVoltage(rawVolt);

        if (percent === null) {
            // pisugar-server responded but gave garbage — likely not installed
            return null;
        }

        _cache   = { percent, charging: charging ?? false, voltage };
        _cacheTs = now;
        return _cache;
    } catch (err) {
        console.error('[Battery] Error reading PiSugar:', err.message);
        return null;
    }
}

/**
 * Returns a spoken summary: "Battery is at 85%, charging."
 */
async function getSummary() {
    const s = await getStatus();
    if (!s) return 'Battery status unavailable.';

    const chargingStr = s.charging ? ', and charging' : '';
    const low = s.percent <= 15 ? ' Warning: battery is low.' : '';
    return `Battery is at ${s.percent} percent${chargingStr}.${low}`;
}

/**
 * Invalidate the cache (called after a known state change).
 */
function invalidateCache() {
    _cache   = null;
    _cacheTs = 0;
}

module.exports = { getStatus, getSummary, invalidateCache, IS_PI };
