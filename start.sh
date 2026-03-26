#!/bin/sh
# Start Xvfb virtual display so Chrome runs in headed mode.
# CF Turnstile fingerprints the browser via JS — headless Chrome fails those checks.
# Headed Chrome on Xvfb provides a real rendering surface that passes Turnstile.
# Previous crash (SIGSEGV) was caused by --disable-gpu in headed mode, which is now removed.

Xvfb :99 -screen 0 1280x720x24 -ac &
XVFB_PID=$!
sleep 2

if kill -0 $XVFB_PID 2>/dev/null; then
    echo "[Startup] Xvfb started on :99 — Chrome will run in headed mode (bypasses CF Turnstile)"
    export DISPLAY=:99
else
    echo "[Startup] Xvfb failed to start — falling back to headless mode"
fi

exec node server.js
