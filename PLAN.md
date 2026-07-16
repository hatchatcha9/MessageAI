# frog — Raspberry Pi Voice AI Assistant
# 2-Hour Daily Work Plan

## Project State (updated 2026-07-16 — most of this plan is done; see notes inline)

**What works:**
- `server.js` — Express server with Claude, weather (OpenWeather), reminders (speaks aloud via pending-speech queue), news (NewsAPI), calendar, Spotify, GPS, camera, battery, todo, and DoorDash browsing (search/menu/cart) via `/api/food/*`
- `voice/voice_loop.py` — Whisper STT + Piper/Kokoro TTS, mic recording with speech/silence detection (thresholds now tunable via `settings.json` + `scripts/calibrate.py`, not hardcoded)
- `public/screen.html`, `calendar.html`, `spotify.html`, `settings.html`, `food.html` — pond/terrarium-themed 480×320 touchscreen UI
- Deployed to physical Pi hardware (Days 4/6/7 below are done)

**Still open:**
- Wake word is still `hey_jarvis` (openWakeWord built-in) — a custom "Hey Frog" model needs training via openWakeWord's `automatic_model_training.ipynb` on Google Colab. Blocked on Google account sign-in in the automation browser — needs a human to complete the Colab login/training run, then drop the resulting `.onnx` into `voice/wakeword/`. See Day 2 below.
- DoorDash browser session currently shows an "Enter your delivery address / Sign in for saved address" prompt when adding items to cart (search + menu browsing work fine). Needs the DoorDash account re-confirmed/re-logged-in in the `browser-data/` Chrome profile — not something to do unattended since it may trigger OTP/2FA.
- Old SMS/DoorDash command flow still lives in `server.js` behind `TWILIO_ENABLED` (Day 5 cleanup below never got done — low priority, not blocking anything)

---

## Day 1 — Test & Fix Voice Loop ✅ DONE
**Goal:** Get a full working end-to-end voice conversation.
Thresholds are tunable via `settings.json` (`speechThreshold`, `silenceThreshold`) with `scripts/calibrate.py` to measure real mic RMS — no longer hardcoded.

### Tasks
- [ ] Start server: `cd C:\Users\hatch\projects\frog && node server.js`
- [ ] Run voice loop: `python voice/voice_loop.py`
- [ ] Press Enter, speak — check if speech is detected and transcribed
- [ ] If mic fails: run calibration to measure real RMS levels
  ```
  python -c "
  import sounddevice as sd, numpy as np
  with sd.InputStream(samplerate=16000, channels=1, dtype='int16', blocksize=1600) as s:
      for _ in range(30):
          c, _ = s.read(1600)
          print(f'RMS: {np.sqrt(np.mean(c.astype(np.float32)**2)):6.0f}', end='\r')
  "
  ```
- [ ] Tune `SPEECH_THRESHOLD` and `SILENCE_THRESHOLD` based on real mic levels
- [ ] Test weather: say "what's the weather in Draper" (OpenWeather key should be active)
- [ ] Test reminder: say "remind me in 1 minute to test something"
- [ ] Test news: say "what's in the news"
- [ ] Open screen.html in browser — verify it shows listening/thinking/speaking states

**Done when:** You can speak naturally, get a Kokoro voice response, and the screen updates.

---

## Day 2 — Wake Word "Hey Frog" 🔲 STILL OPEN (blocked)
**Goal:** Replace press-Enter DEV_MODE with an always-on wake word.

`voice_loop.py` already has the plumbing done: `wait_for_wake_word()` looks for a `.onnx` file in `voice/wakeword/`, loads it via openwakeword if present, and falls back to tap-only otherwise (see `_find_wakeword_model()`). The only remaining step is producing that `.onnx` file.

### Tasks
- [x] openwakeword integration + fallback logic already in `voice_loop.py`
- [ ] Train a custom "Hey Frog" model via openWakeWord's `automatic_model_training.ipynb` on Google Colab (free GPU): https://github.com/dscripka/openWakeWord#custom-models
  - **Blocked:** requires signing into a Google account in the browser to run the Colab notebook — needs to be done by a human, not headless/unattended (2026-07-16 attempt: no authenticated Google session available).
- [ ] Drop the resulting `.onnx` into `voice/wakeword/`
- [ ] Test: say the wake word, pause, speak, get response

**Done when:** You can trigger the assistant hands-free without pressing Enter.

---

## Day 3 — Rename + Reminder Voice Delivery ✅ DONE
**Goal:** Make reminders actually speak when they fire, and rename frog throughout.

Renaming is done (no "PiAI" left in code, only in this file's history above). Reminders push to a pending-speech queue (`pushPendingSpeech()` in `server.js`) that the voice loop polls and speaks — same mechanism ended up covering timers too (`[TIMER:]` command).

---

## Day 4 — Pi Setup Script
**Goal:** Write a one-command install script so you can get frog running on a fresh Pi the day hardware arrives.

### Tasks
- [ ] Create `scripts/install.sh` — installs everything from scratch:
  - `sudo apt update && sudo apt install -y nodejs npm python3-pip portaudio19-dev`
  - `npm install`
  - `pip install faster-whisper kokoro sounddevice numpy requests openwakeword`
  - Copies `.env.example` if no `.env` exists
  - Creates systemd services for `node server.js` and `python voice_loop.py`
- [ ] Create `.env.example` with placeholder keys
- [ ] Create `scripts/start.sh` — quick start without systemd (for dev/testing)
- [ ] Test install script on Windows WSL or a VM if possible

**Done when:** `curl -sSL [script] | bash` (or `./scripts/install.sh`) fully sets up frog on a fresh system.

---

## Day 5 — Code Cleanup + More Voice Features 🟡 MOSTLY DONE
**Goal:** Clean up dead code and add 2–3 more useful voice commands.

All five originally-suggested features shipped (`[MATH:]`, `[JOKE]`, `[DEFINE:]`, `[WIKI:]`, plus the timer from Day 3), well beyond the "pick 2" goal — plus calendar, Spotify, camera, GPS, battery, and todo, which weren't even on the original list. Cleanup item not done:
- [ ] Move SMS/DoorDash-specific logic into a `modules/doordash_sms.js` and guard it behind `TWILIO_ENABLED` (low priority — not blocking anything, `TWILIO_ENABLED=false` already keeps it dormant)

---

## Day 6 — Hardware Arrives (Pi Setup) ✅ DONE
`setup_pi.sh` exists and frog is deployed and running on the physical Pi.

---

## Day 7 — Hardware Polish ✅ DONE
Touchscreen, audio, and auto-start are working on the deployed Pi. Wake word on physical mic is still pending the same Colab blocker as Day 2.

---

## Running the Project

```bash
# Start server
cd C:\Users\hatch\projects\frog
node server.js

# Start voice loop (new terminal)
python voice/voice_loop.py              # female voice (Heart)
FROG_VOICE=male python voice/voice_loop.py  # male voice (Michael)

# Open screen UI
# Browser: http://localhost:3000/screen.html
```

## Environment Variables (.env)
```
ANTHROPIC_API_KEY=
OPENWEATHER_API_KEY=your-openweather-key
NEWS_API_KEY=your-newsapi-key
TWILIO_ENABLED=false
PORT=3000
```

## Hardware (ordered, arriving ~1-2 weeks)
- Pi 4 4GB, 3.5" touchscreen HAT, USB mic
- WM8960 audio HAT, NEO-6M GPS, Pi Camera 3
- PiSugar 3 Plus battery, case with fan
