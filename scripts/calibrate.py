#!/usr/bin/env python3
"""
frog Mic Calibration Tool
Measures your microphone's ambient noise floor and speech level, then writes
optimal SPEECH_THRESHOLD and SILENCE_THRESHOLD to .env.

Usage:
    python scripts/calibrate.py          # interactive (guided prompts)
    python scripts/calibrate.py --auto   # non-interactive (ambient only, no speech sample needed)

Run this:
  - Once after first Pi boot
  - Any time you change your mic or move to a different environment
  - If frog misses your voice or triggers on background noise
"""

import os
import sys
import time
import argparse
import numpy as np

# ── Locate .env relative to this script (works from any cwd) ──────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
ENV_PATH = os.path.join(PROJECT_DIR, '.env')

def _check_deps():
    try:
        import sounddevice  # noqa: F401
    except ImportError:
        print("ERROR: sounddevice not installed.")
        print("  Run: pip install sounddevice numpy")
        sys.exit(1)

def _measure_rms(seconds=2.0, label=""):
    """Record audio for `seconds` and return (mean_rms, peak_rms)."""
    import sounddevice as sd

    sample_rate = 16000
    chunk_size = int(sample_rate * 0.1)   # 100ms chunks
    n_chunks = int(seconds / 0.1)
    rms_values = []

    if label:
        print(f"  {label}", end="", flush=True)

    with sd.InputStream(samplerate=sample_rate, channels=1, dtype='int16',
                        blocksize=chunk_size) as stream:
        for i in range(n_chunks):
            chunk, _ = stream.read(chunk_size)
            rms = float(np.sqrt(np.mean(chunk.astype(np.float32) ** 2)))
            rms_values.append(rms)
            if label and i % 5 == 0:
                print(".", end="", flush=True)

    if label:
        print()

    if not rms_values:
        return 0.0, 0.0

    mean_rms = float(np.mean(rms_values))
    peak_rms = float(np.percentile(rms_values, 95))  # 95th percentile as "peak"
    return mean_rms, peak_rms

def _read_env():
    """Read current .env into a dict."""
    env = {}
    if os.path.exists(ENV_PATH):
        with open(ENV_PATH, 'r') as f:
            for line in f:
                line = line.rstrip('\n')
                if '=' in line and not line.startswith('#'):
                    key, _, val = line.partition('=')
                    env[key.strip()] = val.strip()
    return env

def _post_thresholds_to_server(speech_threshold, silence_threshold):
    """Try to POST updated thresholds to the running frog server (best-effort)."""
    try:
        import urllib.request, json as _json
        port = os.getenv("FROG_SERVER_PORT", os.getenv("PORT", "3000"))
        payload = _json.dumps({
            "speechThreshold": speech_threshold,
            "silenceThreshold": silence_threshold,
        }).encode()
        req = urllib.request.Request(
            f"http://localhost:{port}/api/settings",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=3)
        print("  Thresholds also saved to server settings ✓")
    except Exception:
        pass  # Server not running — .env write is sufficient

def _write_thresholds(speech_threshold, silence_threshold):
    """Write SPEECH_THRESHOLD and SILENCE_THRESHOLD into .env, creating it if needed."""
    lines = []
    found_speech = False
    found_silence = False

    if os.path.exists(ENV_PATH):
        with open(ENV_PATH, 'r') as f:
            lines = f.readlines()

    new_lines = []
    for line in lines:
        key = line.split('=')[0].strip()
        if key == 'SPEECH_THRESHOLD':
            new_lines.append(f'SPEECH_THRESHOLD={speech_threshold}\n')
            found_speech = True
        elif key == 'SILENCE_THRESHOLD':
            new_lines.append(f'SILENCE_THRESHOLD={silence_threshold}\n')
            found_silence = True
        else:
            new_lines.append(line)

    if not found_speech:
        new_lines.append(f'SPEECH_THRESHOLD={speech_threshold}\n')
    if not found_silence:
        new_lines.append(f'SILENCE_THRESHOLD={silence_threshold}\n')

    with open(ENV_PATH, 'w') as f:
        f.writelines(new_lines)

def run_interactive():
    """Full interactive calibration: ambient + speech sample."""
    _check_deps()
    print()
    print("=" * 50)
    print("  frog Mic Calibration")
    print("=" * 50)
    print()
    print("This measures your mic to set speech detection levels.")
    print(f"Results will be written to: {ENV_PATH}")
    print()

    # --- Step 1: Ambient noise ---
    input("Step 1/2 — STAY QUIET. Press Enter to measure ambient noise...")
    print()
    ambient_mean, ambient_peak = _measure_rms(seconds=3.0, label="Measuring ambient noise")
    print(f"  Ambient: avg={ambient_mean:.0f}  peak={ambient_peak:.0f}")
    print()

    # --- Step 2: Speech sample ---
    input("Step 2/2 — Get ready to SPEAK. Press Enter, then talk normally for 3 seconds...")
    print()
    speech_mean, speech_peak = _measure_rms(seconds=3.0, label="Measuring speech level")
    print(f"  Speech:  avg={speech_mean:.0f}  peak={speech_peak:.0f}")
    print()

    # --- Calculate thresholds ---
    # SILENCE_THRESHOLD: comfortably above ambient peak
    silence_threshold = int(ambient_peak * 1.5 + 10)
    # SPEECH_THRESHOLD: midpoint between ambient and speech, biased toward ambient
    speech_threshold = int(ambient_peak + (speech_mean - ambient_peak) * 0.4)
    # Clamp to sane ranges
    silence_threshold = max(30, min(silence_threshold, 500))
    speech_threshold = max(silence_threshold + 20, min(speech_threshold, 2000))

    print(f"  SILENCE_THRESHOLD = {silence_threshold}")
    print(f"  SPEECH_THRESHOLD  = {speech_threshold}")
    print()

    _write_thresholds(speech_threshold, silence_threshold)
    _post_thresholds_to_server(speech_threshold, silence_threshold)
    print(f"  Written to {ENV_PATH} ✓")
    print()
    print("Calibration complete! Changes take effect immediately (no restart needed if server is running).")
    print()

def run_auto():
    """
    Non-interactive calibration: ambient only (no speech sample needed).
    Used by setup_pi.sh. Sets conservative thresholds based on ambient floor.
    """
    _check_deps()
    import sounddevice as sd

    print("  Auto-calibrating microphone (ambient measurement)...")

    # Wait a moment for audio subsystem to settle
    time.sleep(0.5)

    # Find USB audio device (or fall back to any input device)
    devices = sd.query_devices()
    input_devices = [d for d in devices if d['max_input_channels'] > 0]

    if not input_devices:
        print("  WARNING: No input audio devices found. Mic may not be plugged in yet.")
        print("  Using safe defaults: SPEECH_THRESHOLD=300, SILENCE_THRESHOLD=100")
        _write_thresholds(300, 100)
        return

    usb_idx = None
    for i, d in enumerate(devices):
        name = d['name'].lower()
        if d['max_input_channels'] > 0 and any(kw in name for kw in ['usb', 'c-media', 'sabrent', 'microphone', 'mic']):
            usb_idx = i
            break

    if usb_idx is not None:
        sd.default.device[0] = usb_idx
        print(f"  Using input: {devices[usb_idx]['name']}")
    else:
        print(f"  No USB mic found, using default input: {input_devices[0]['name']}")

    try:
        ambient_mean, ambient_peak = _measure_rms(seconds=2.0)
    except Exception as e:
        print(f"  Mic measurement failed: {e}")
        print("  Using safe defaults: SPEECH_THRESHOLD=300, SILENCE_THRESHOLD=100")
        _write_thresholds(300, 100)
        return  # Fallback succeeded — exit 0 is appropriate

    # Conservative auto thresholds
    silence_threshold = int(max(ambient_peak * 2.0, ambient_mean * 3.0) + 15)
    speech_threshold  = int(silence_threshold * 3)

    silence_threshold = max(40, min(silence_threshold, 300))
    speech_threshold  = max(silence_threshold + 50, min(speech_threshold, 1500))

    _write_thresholds(speech_threshold, silence_threshold)
    _post_thresholds_to_server(speech_threshold, silence_threshold)
    print(f"  Ambient avg={ambient_mean:.0f} peak={ambient_peak:.0f}")
    print(f"  SPEECH_THRESHOLD={speech_threshold}, SILENCE_THRESHOLD={silence_threshold} written to .env ✓")
    print("  Run 'python scripts/calibrate.py' for a full interactive calibration anytime.")

def main():
    parser = argparse.ArgumentParser(description='frog mic calibration')
    parser.add_argument('--auto', action='store_true',
                        help='Non-interactive: measure ambient only, write conservative thresholds')
    args = parser.parse_args()

    if args.auto:
        run_auto()
    else:
        run_interactive()

if __name__ == '__main__':
    main()
