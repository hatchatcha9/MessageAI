/**
 * Camera module for PiAI — Pi Camera 3 via libcamera-still + Claude Vision
 *
 * On Pi: captures a JPEG with libcamera-still, sends to Claude Vision API.
 * On Windows dev machine: returns a placeholder message gracefully.
 *
 * Usage:
 *   const camera = require('./modules/camera');
 *   const desc = await camera.describe();         // describe what the camera sees
 *   const desc = await camera.describeWith(prompt); // custom prompt
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IS_PI = process.platform === 'linux' && fs.existsSync('/dev/video0') ||
              fs.existsSync('/proc/device-tree/model') &&
              fs.readFileSync('/proc/device-tree/model', 'utf8').includes('Raspberry');

const CAPTURE_PATH = path.join(os.tmpdir(), 'piai_capture.jpg');

// ---------- Capture ----------

function capture() {
    return new Promise((resolve, reject) => {
        if (!IS_PI) {
            reject(new Error('No camera hardware detected (not running on Pi)'));
            return;
        }
        execFile('libcamera-still', [
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

module.exports = { describe, describeWith, capture, IS_PI };
