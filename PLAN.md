# frog — Raspberry Pi Voice AI Assistant
# 2-Hour Daily Work Plan

## Project State (as of 2026-05-08)

**What works:**
- `server.js` — Express server with Claude, weather (OpenWeather), reminders (in-memory), news (NewsAPI), DoorDash food ordering
- `voice/voice_loop.py` — Whisper STT + Kokoro TTS, mic recording with speech/silence detection
- `public/screen.html` — 480×320 touchscreen UI (idle/listening/thinking/speaking states via SSE)

**Known issues:**
- Mic thresholds untested — `SPEECH_THRESHOLD=200`, `SILENCE_THRESHOLD=80` (ambient RMS is 0–69)
- Wake word is `hey_jarvis` placeholder — needs replacing with "Hey Frog" or similar
- Reminders fire but don't speak aloud — callback only `console.log`s
- All code still says "PiAI" internally — needs renaming to "frog"
- Old SMS/DoorDash code still lives in server.js alongside voice code

---

## Day 1 — Test & Fix Voice Loop ✅ / 🔲
**Goal:** Get a full working end-to-end voice conversation.

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

## Day 2 — Wake Word "Hey Frog"
**Goal:** Replace press-Enter DEV_MODE with an always-on wake word.

### Tasks
- [ ] Install openwakeword: `pip install openwakeword`
- [ ] Test openwakeword's built-in models — `hey_jarvis` is the best available built-in
- [ ] Decide: use `hey_jarvis` temporarily OR train/download a custom "hey frog" model
  - Custom model option: https://github.com/dscripka/openWakeWord#custom-models
  - Built-in option: ship with `hey_jarvis` and swap later on Pi
- [ ] Update `voice_loop.py`: set `DEV_MODE=false` default when openwakeword is available
- [ ] Add a short audio cue (beep or "I'm listening") when wake word fires
- [ ] Test: say the wake word, pause, speak, get response

**Done when:** You can trigger the assistant hands-free without pressing Enter.

---

## Day 3 — Rename + Reminder Voice Delivery
**Goal:** Make reminders actually speak when they fire, and rename frog throughout.

### Rename tasks
- [ ] In `server.js`: rename "PiAI" → "frog" in all log messages and comments
- [ ] In `voice/voice_loop.py`: rename "PiAI" → "frog" in all print statements
- [ ] In `public/screen.html`: rename any "PiAI" references
- [ ] In `package.json`: update description

### Reminder voice delivery
Currently `reminders.js` fires a callback that only `console.log`s. It needs to trigger the voice loop to speak.

**Approach:** Add a `/api/reminder-fired` endpoint to the server. The reminder callback POSTs to it. The voice loop polls this endpoint and speaks the reminder message.

- [ ] In `server.js`: add a reminder queue + `/api/reminder-fired` GET endpoint that returns pending reminders
- [ ] Update reminder callback in `processCommands` to push to the queue instead of console.log
- [ ] In `voice/voice_loop.py`: add a background thread that polls `/api/reminder-fired` every 5 seconds and calls `speak()` when a reminder is pending
- [ ] Test: set a 1-minute reminder, wait, hear it spoken aloud

**Done when:** Reminders speak themselves out loud without user input.

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

## Day 5 — Code Cleanup + More Voice Features
**Goal:** Clean up dead code and add 2–3 more useful voice commands.

### Cleanup
- [ ] Move SMS/DoorDash-specific logic into a `modules/doordash_sms.js` and guard it behind `TWILIO_ENABLED`
- [ ] Clean the voice system prompt — remove SMS command hints that don't apply to voice
- [ ] Remove the old `PLAN.md` SMS content (this file replaces it)

### New voice features (pick 2)
- [ ] **Define word** — "define serendipity" → dictionary lookup (free API: dictionaryapi.dev)
- [ ] **Timer** — "set a 5 minute timer" → same as reminder but says "your timer is done"
- [ ] **Joke** — "tell me a joke" → Claude tells a short spoken joke
- [ ] **Wikipedia summary** — "tell me about black holes" → Wikipedia API first paragraph
- [ ] **Math** — "what is 15 percent of 47 dollars" → Claude calculates and answers

**Done when:** Voice assistant has at least 2 new useful commands and code is cleaner.

---

## Day 6 — Hardware Arrives (Pi Setup)
*Expected: ~1 week after ordering. Adjust date when parts arrive.*

### Tasks
- [ ] Flash Raspberry Pi OS Lite (64-bit) to CM4 eMMC using `rpiboot` + Raspberry Pi Imager
- [ ] Run `./scripts/install.sh` on the Pi
- [ ] Copy `.env` from Windows dev machine to Pi
- [ ] Test voice loop on Pi hardware (same steps as Day 1)
- [ ] Tune performance: switch Whisper model to `tiny.en` if `base.en` is too slow on Pi

**Done when:** frog runs on the actual Pi and responds via the physical speaker + mic.

---

## Day 7 — Hardware Polish
**Goal:** Make frog production-ready on the Pi.

### Tasks
- [ ] Configure correct audio device (USB mic, WM8960 audio HAT)
- [ ] Set default audio input/output in `/etc/asound.conf`
- [ ] Test wake word on physical mic (may need threshold tuning)
- [ ] Connect touchscreen — test screen.html at Pi's IP in Chromium kiosk mode
- [ ] Enable auto-start on boot via systemd
- [ ] Test GPS module if hardware arrived (`modules/gps.js`)

**Done when:** Pi boots, frog starts automatically, wake word works, screen shows states.

---

## Running the Project

```bash
# Start server
cd C:\Users\hatch\projects\frog
node server.js

# Start voice loop (new terminal)
python voice/voice_loop.py              # female voice (Heart)
PIAI_VOICE=male python voice/voice_loop.py  # male voice (Michael)

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
