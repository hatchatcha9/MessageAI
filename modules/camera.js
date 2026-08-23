/**
 * Camera module for frog — Pi Camera 3 via rpicam-still + Claude Vision
 *
 * On Pi: captures a JPEG with rpicam-still, sends to Claude Vision API.
 * On Windows dev machine: returns a placeholder message gracefully.
 *
 * Usage:
 *   const camera = require('./modules/camera');
 *   const desc = await camera.describe();         // describe what the camera sees
 *   const desc = await camera.describeWith(prompt); // custom prompt
 */

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IS_PI = process.platform === 'linux' && fs.existsSync('/dev/video0') ||
              fs.existsSync('/proc/device-tree/model') &&
              fs.readFileSync('/proc/device-tree/model', 'utf8').includes('Raspberry');

const CAPTURE_PATH = path.join(os.tmpdir(), 'frog_capture.jpg');

// Photos taken via capturePhoto() (voice "[CAMERA]" command or the camera app's shutter
// button) are kept permanently here for the gallery — unlike capture()/describeWith()'s
// CAPTURE_PATH above, which is a scratch file deleted right after each Vision API call.
const PHOTOS_DIR = path.join(__dirname, '..', 'public', 'camera-photos');
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

// ---------- Live preview stream ----------
// The camera hardware only allows one process to hold it open at a time, so a still
// capture (capture()/capturePhoto()) must stop any running live stream first, and only
// one live-view viewer is supported at once — fine for this single-kiosk device.
let _streamProc = null;

function stopStream() {
    if (_streamProc) {
        try { _streamProc.kill('SIGTERM'); } catch {}
        _streamProc = null;
    }
}

// Pipes a live MJPEG feed from rpicam-vid into an Express response as
// multipart/x-mixed-replace, which a plain <img> tag can display natively with no
// client-side JS beyond setting src. rpicam-vid's own `--codec mjpeg` output is just a
// bare, undelimited sequence of JPEG frames back to back — this function does the
// frame-boundary splitting itself (JPEG SOI marker 0xFFD8 → EOI marker 0xFFD9) and wraps
// each complete frame in the multipart boundary format the browser expects.
function attachStream(res) {
    if (!IS_PI) { res.status(503).end(); return; }
    stopStream();

    const boundary = 'frogcamstream';
    res.writeHead(200, {
        'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`,
        'Cache-Control': 'no-cache, private',
        'Pragma': 'no-cache',
        'Connection': 'close',
    });

    const proc = spawn('rpicam-vid', [
        '--codec', 'mjpeg',
        '--width', '640',
        '--height', '480',
        '--framerate', '12',
        '--timeout', '0', // run until killed
        '--nopreview',
        '--inline',
        '-o', '-',
    ]);
    _streamProc = proc;

    let buf = Buffer.alloc(0);
    proc.stdout.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
            const start = buf.indexOf(Buffer.from([0xff, 0xd8]));
            if (start === -1) { buf = Buffer.alloc(0); break; }
            const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
            if (end === -1) {
                if (start > 0) buf = buf.slice(start); // drop leading garbage, keep partial frame
                break;
            }
            const frame = buf.slice(start, end + 2);
            buf = buf.slice(end + 2);
            try {
                res.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
                res.write(frame);
                res.write('\r\n');
            } catch (e) { /* client disconnected — req.on('close') in server.js handles cleanup */ }
        }
    });
    proc.on('error', () => { if (_streamProc === proc) _streamProc = null; try { res.end(); } catch {} });
    proc.on('exit', () => { if (_streamProc === proc) _streamProc = null; try { res.end(); } catch {} });
}

// ---------- Capture ----------

function capture() {
    return new Promise((resolve, reject) => {
        if (!IS_PI) {
            reject(new Error('No camera hardware detected (not running on Pi)'));
            return;
        }
        stopStream(); // free the camera device if a live-preview stream is running
        execFile('rpicam-still', [
            '--output', CAPTURE_PATH,
            '--width',  '1280',
            '--height', '720',
            '--timeout', '500',   // 500ms capture
            '--nopreview',
            '--encoding', 'jpg',
            '-q', '85',
        ], { timeout: 10000 }, (err) => {
            if (err) { reject(err); return; }
            resolve(CAPTURE_PATH);
        });
    });
}

// ---------- Describe with Claude Vision ----------

async function describeWith(anthropic, prompt = 'Describe what you see in this image concisely, in 1-2 sentences of natural spoken English.') {
    if (!IS_PI) {
        return "I don't have a camera connected yet. The Pi Camera will be available when the hardware arrives.";
    }

    let imagePath;
    try {
        imagePath = await capture();
    } catch (e) {
        console.error('[Camera] Capture error:', e.message);
        return "I couldn't capture an image. Make sure the camera ribbon is connected.";
    }

    try {
        const imageData = fs.readFileSync(imagePath);
        const base64 = imageData.toString('base64');

        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',  // fast + cheap for vision
            max_tokens: 150,
            messages: [{
                role: 'user',
                content: [
                    {
                        type: 'image',
                        source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
                    },
                    { type: 'text', text: prompt },
                ],
            }],
        });

        return response.content[0].text.trim();
    } catch (e) {
        console.error('[Camera] Vision API error:', e.message);
        return "I had trouble analyzing the image. Please try again.";
    } finally {
        try { fs.unlinkSync(imagePath); } catch {}
    }
}

// Shorthand used by server command handler
async function describe(anthropic) {
    return describeWith(anthropic, 'Describe what you see in 1-2 sentences of natural spoken English. Be specific about objects, people, and setting.');
}

// ---------- Permanent capture (voice "[CAMERA]" command + camera app shutter) ----------

function capturePhoto() {
    return new Promise((resolve, reject) => {
        if (!IS_PI) {
            reject(new Error('No camera hardware detected (not running on Pi)'));
            return;
        }
        stopStream(); // free the camera device if a live-preview stream is running
        const filename = `photo-${Date.now()}.jpg`;
        const outPath = path.join(PHOTOS_DIR, filename);
        execFile('rpicam-still', [
            '--output', outPath,
            '--width', '1280',
            '--height', '720',
            '--timeout', '800',
            '--nopreview',
            '--encoding', 'jpg',
            '-q', '85',
        ], { timeout: 12000 }, (err) => {
            if (err) { reject(err); return; }
            resolve({ filename, url: `/camera-photos/${filename}`, timestamp: Date.now() });
        });
    });
}

function listPhotos() {
    if (!fs.existsSync(PHOTOS_DIR)) return [];
    return fs.readdirSync(PHOTOS_DIR)
        .filter(f => /^photo-\d+\.jpg$/.test(f))
        .map(f => ({
            filename: f,
            url: `/camera-photos/${f}`,
            timestamp: parseInt(f.slice('photo-'.length, -'.jpg'.length), 10) || 0,
        }))
        .sort((a, b) => b.timestamp - a.timestamp);
}

module.exports = { describe, describeWith, capture, capturePhoto, listPhotos, attachStream, stopStream, IS_PI };
