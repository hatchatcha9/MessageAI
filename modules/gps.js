/**
 * GPS module for PiAI — reads NEO-6M GPS over serial (USB)
 *
 * On Pi, the NEO-6M shows up as /dev/ttyUSB0 or /dev/ttyACM0.
 * On Windows dev machine, GPS is not connected so all calls return null gracefully.
 *
 * Usage:
 *   const gps = require('./modules/gps');
 *   const loc = await gps.getLocation();   // { lat, lon, city, accuracy } or null
 *   await gps.start();   // begin background serial reading
 *   await gps.stop();
 */

const https = require('https');

// Last known fix — updated by the background serial reader
let _lastFix = null;
let _serialPort = null;
let _running = false;

// ---------- NMEA parsing ----------

function parseGGA(sentence) {
    // $GPGGA,time,lat,N/S,lon,E/W,fix,sats,hdop,alt,...
    const parts = sentence.split(',');
    if (parts.length < 10) return null;
    const fix = parseInt(parts[6]);
    if (!fix) return null; // 0 = no fix

    const lat = nmeaToDecimal(parts[2], parts[3]);
    const lon = nmeaToDecimal(parts[4], parts[5]);
    if (lat === null || lon === null) return null;

    return { lat, lon, sats: parseInt(parts[7]) || 0 };
}

function nmeaToDecimal(coord, dir) {
    if (!coord || !dir) return null;
    // Format: DDDMM.MMMM
    const dot = coord.indexOf('.');
    if (dot < 2) return null;
    const degrees = parseInt(coord.substring(0, dot - 2));
    const minutes = parseFloat(coord.substring(dot - 2));
    let decimal = degrees + minutes / 60;
    if (dir === 'S' || dir === 'W') decimal = -decimal;
    return Math.round(decimal * 1000000) / 1000000;
}

// ---------- Reverse geocode lat/lon → city name ----------

async function reverseGeocode(lat, lon) {
    return new Promise((resolve) => {
        const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10`;
        const req = https.get(url, { headers: { 'User-Agent': 'PiAI/1.0' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const addr = json.address || {};
                    const city = addr.city || addr.town || addr.village || addr.county || null;
                    const state = addr.state || null;
                    resolve(city ? (state ? `${city}, ${state}` : city) : null);
                } catch (e) {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    });
}

// ---------- Serial reader (Pi only) ----------

async function start() {
    if (_running) return;

    let SerialPort, ReadlineParser;
    try {
        ({ SerialPort } = require('serialport'));
        ({ ReadlineParser } = require('@serialport/parser-readline'));
    } catch (e) {
        console.log('[GPS] serialport not installed — GPS disabled. Run: npm install serialport @serialport/parser-readline');
        return;
    }

    // Auto-detect GPS port
    const { autoDetect } = require('@serialport/bindings-cpp');
    const ports = await SerialPort.list();
    const gpsPort = ports.find(p =>
        p.path.includes('USB') || p.path.includes('ACM') ||
        (p.manufacturer || '').toLowerCase().includes('u-blox') ||
        (p.manufacturer || '').toLowerCase().includes('prolific')
    );

    if (!gpsPort) {
        console.log('[GPS] No GPS serial port found. Ports:', ports.map(p => p.path).join(', ') || 'none');
        return;
    }

    console.log(`[GPS] Opening ${gpsPort.path} at 9600 baud...`);
    _serialPort = new SerialPort({ path: gpsPort.path, baudRate: 9600 });
    const parser = _serialPort.pipe(new ReadlineParser({ delimiter: '\r\n' }));

    _running = true;
    parser.on('data', async (line) => {
        if (!line.startsWith('$GPGGA') && !line.startsWith('$GNGGA')) return;
        const fix = parseGGA(line);
        if (!fix) return;

        // Only reverse-geocode if position changed significantly (>0.01 deg ≈ 1km)
        const changed = !_lastFix ||
            Math.abs(fix.lat - _lastFix.lat) > 0.01 ||
            Math.abs(fix.lon - _lastFix.lon) > 0.01;

        if (changed) {
            const city = await reverseGeocode(fix.lat, fix.lon);
            _lastFix = { ...fix, city };
            console.log(`[GPS] Fix: ${fix.lat}, ${fix.lon} — ${city || 'unknown city'} (${fix.sats} sats)`);
        } else {
            _lastFix = { ..._lastFix, lat: fix.lat, lon: fix.lon, sats: fix.sats };
        }
    });

    _serialPort.on('error', (err) => console.error('[GPS] Serial error:', err.message));
    console.log('[GPS] Background reader started.');
}

async function stop() {
    _running = false;
    if (_serialPort) {
        await new Promise(r => _serialPort.close(r));
        _serialPort = null;
    }
}

function getLocation() {
    return _lastFix;  // { lat, lon, city, sats } or null if no fix yet
}

function getLocationString() {
    if (!_lastFix) return null;
    return _lastFix.city || `${_lastFix.lat},${_lastFix.lon}`;
}

module.exports = { start, stop, getLocation, getLocationString };
