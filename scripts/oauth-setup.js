#!/usr/bin/env node
/**
 * frog OAuth Setup
 * Automates getting refresh tokens for Google Calendar and Spotify.
 *
 * Usage:
 *   node scripts/oauth-setup.js google
 *   node scripts/oauth-setup.js spotify
 *
 * Prerequisites: add CLIENT_ID + CLIENT_SECRET to .env first, then run this.
 * The script opens your browser, catches the OAuth callback, and writes the
 * refresh token directly to .env — no copy-pasting.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const { exec } = require('child_process');

const ENV_PATH = path.join(__dirname, '../.env');
const PORT     = 9876; // temporary port for catching the OAuth callback
const LOOPBACK = `http://127.0.0.1:${PORT}`; // Spotify requires 127.0.0.1, not localhost

const service = process.argv[2];
if (!['google', 'spotify'].includes(service)) {
    console.error('Usage: node scripts/oauth-setup.js [google|spotify]');
    process.exit(1);
}

// ─── .env helpers ────────────────────────────────────────────────────────────

function readEnv() {
    try { return fs.readFileSync(ENV_PATH, 'utf8'); }
    catch { return ''; }
}

function setEnvVar(key, value) {
    let content = readEnv();
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
    } else {
        content = content.trimEnd() + `\n${key}=${value}\n`;
    }
    fs.writeFileSync(ENV_PATH, content);
}

// ─── Browser open ─────────────────────────────────────────────────────────────

function openBrowser(url) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"`
              : process.platform === 'darwin' ? `open "${url}"`
              : `xdg-open "${url}"`;
    exec(cmd);
}

// ─── Local callback server ────────────────────────────────────────────────────

function waitForCallback(path, handler) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            const url = new URL(req.url, `http://localhost:${PORT}`);
            if (url.pathname !== path) {
                res.writeHead(404);
                res.end();
                return;
            }

            try {
                const result = await handler(url.searchParams);
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`
                    <html><body style="font-family:monospace;background:#111;color:#0f0;padding:40px">
                    <h2 style="color:#0f0">Done!</h2>
                    <p>${result}</p>
                    <p style="color:#888">You can close this tab.</p>
                    </body></html>
                `);
                server.close();
                resolve();
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'text/html' });
                res.end(`<pre style="color:red">${err.message}</pre>`);
                server.close();
                reject(err);
            }
        });

        server.listen(PORT, () => {
            console.log(`Waiting for OAuth callback on http://localhost:${PORT}${path} ...`);
        });

        server.on('error', reject);
    });
}

// ─── Google Calendar ──────────────────────────────────────────────────────────

async function setupGoogle() {
    const clientId     = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.error('\nMissing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env');
        console.error('Add them first:\n  GOOGLE_CLIENT_ID=...\n  GOOGLE_CLIENT_SECRET=...\n');
        process.exit(1);
    }

    const { google } = require('googleapis');
    const redirectUri  = `http://localhost:${PORT}/callback`;
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt:      'consent',
        scope:       ['https://www.googleapis.com/auth/calendar.readonly'],
    });

    console.log('\nOpening Google authorization in your browser...');
    openBrowser(authUrl);

    await waitForCallback('/callback', async (params) => {
        const code  = params.get('code');
        const error = params.get('error');

        if (error) throw new Error(`Google denied access: ${error}`);
        if (!code)  throw new Error('No code received from Google');

        const { tokens } = await oauth2Client.getToken(code);

        if (!tokens.refresh_token) {
            throw new Error('No refresh token returned — try revoking access at myaccount.google.com/permissions and re-running.');
        }

        setEnvVar('GOOGLE_REFRESH_TOKEN', tokens.refresh_token);
        console.log('\n✓ GOOGLE_REFRESH_TOKEN written to .env');
        console.log('  Restart the frog server to activate Google Calendar.\n');

        return 'Google Calendar authorized! GOOGLE_REFRESH_TOKEN written to .env.';
    });
}

// ─── Spotify ──────────────────────────────────────────────────────────────────

async function setupSpotify() {
    const clientId     = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.error('\nMissing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET in .env');
        console.error('Add them first:\n  SPOTIFY_CLIENT_ID=...\n  SPOTIFY_CLIENT_SECRET=...\n');
        process.exit(1);
    }

    const redirectUri = `${LOOPBACK}/callback`;
    const scopes = [
        'user-read-playback-state',
        'user-modify-playback-state',
        'user-read-currently-playing',
    ].join(' ');

    const authUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
        client_id:     clientId,
        response_type: 'code',
        redirect_uri:  redirectUri,
        scope:         scopes,
    });

    console.log('\nOpening Spotify authorization in your browser...');
    openBrowser(authUrl);

    await waitForCallback('/callback', async (params) => {
        const code  = params.get('code');
        const error = params.get('error');

        if (error) throw new Error(`Spotify denied access: ${error}`);
        if (!code)  throw new Error('No code received from Spotify');

        const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
            method:  'POST',
            headers: {
                'Authorization': `Basic ${credentials}`,
                'Content-Type':  'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                grant_type:   'authorization_code',
                code,
                redirect_uri: redirectUri,
            }),
        });

        const data = await tokenRes.json();
        if (data.error) throw new Error(`Spotify token error: ${data.error_description || data.error}`);

        setEnvVar('SPOTIFY_REFRESH_TOKEN', data.refresh_token);
        console.log('\n✓ SPOTIFY_REFRESH_TOKEN written to .env');
        console.log('  Restart the frog server to activate Spotify.\n');

        return 'Spotify authorized! SPOTIFY_REFRESH_TOKEN written to .env.';
    });
}

// ─── Run ──────────────────────────────────────────────────────────────────────

(async () => {
    try {
        if (service === 'google')  await setupGoogle();
        if (service === 'spotify') await setupSpotify();
    } catch (err) {
        console.error('\nError:', err.message);
        process.exit(1);
    }
})();
