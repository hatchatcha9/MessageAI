#!/bin/sh
# Start Xvfb for headed Chrome (bypasses Cloudflare Turnstile detection).
# Falls back gracefully to headless if Xvfb isn't available or fails to start.

# Xvfb disabled — headed Chrome on virtual display crashes under Railway's
# containerized environment (SIGSEGV in compositor). Using headless + stealth
# plugin + in-context API for CF-protected pages instead.
echo "[Startup] Running in headless mode"

exec node server.js
