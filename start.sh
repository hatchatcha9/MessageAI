#!/bin/sh
# Start Xvfb for headed Chrome (bypasses Cloudflare Turnstile detection).
# Falls back gracefully to headless if Xvfb isn't available or fails to start.

if command -v Xvfb >/dev/null 2>&1; then
    # Basic screen — no GLX/render extensions needed for headless Chrome under Xvfb
    Xvfb :99 -screen 0 1280x720x24 -ac -nolisten tcp >/dev/null 2>&1 &
    XVFB_PID=$!
    sleep 2

    # Verify Xvfb is actually running before setting DISPLAY
    if kill -0 $XVFB_PID 2>/dev/null; then
        export DISPLAY=:99
        echo "[Startup] Xvfb running on :99 — Chrome will use headed mode"
    else
        echo "[Startup] Xvfb failed to start — falling back to headless mode"
    fi
else
    echo "[Startup] Xvfb not installed — running headless"
fi

exec node server.js
