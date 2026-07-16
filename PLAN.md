# frog — Raspberry Pi Voice AI Assistant
# 2-Hour Daily Work Plan

## Project State (updated 2026-07-16 — most of this plan is done; see notes inline)

**What works:**
- `server.js` — Express server with Claude, weather (OpenWeather), reminders (speaks aloud via pending-speech queue), news (NewsAPI), calendar, Spotify, GPS, camera, battery, todo, and DoorDash browsing (search/menu/cart) via `/api/food/*`
- `voice/voice_loop.py` — Whisper STT + Piper/Kokoro TTS, mic recording with speech/silence detection (thresholds now tunable via `settings.json` + `scripts/calibrate.py`, not hardcoded)
- `public/screen.html`, `calendar.html`, `spotify.html`, `settings.html`, `food.html` — pond/terrarium-themed 480×320 touchscreen UI
- Deployed to physical Pi hardware (Days 4/6/7 below are done)

**Still open:**
- Wake word is still `hey_jarvis` (openWakeWord built-in) — custom "Hey Frog" training is in progress in Colab (data generation + augmentation done, training not yet run). Paused 2026-07-16 mid-fix on a sample-rate issue. See Day 2 below for the exact resume point and notebook link.
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

## Day 2 — Wake Word "Hey Frog" 🟡 IN PROGRESS (paused 2026-07-16, resume here)
**Goal:** Replace press-Enter DEV_MODE with an always-on wake word.

`voice_loop.py` already has the plumbing done: `wait_for_wake_word()` looks for a `.onnx` file in `voice/wakeword/`, loads it via openwakeword if present, and falls back to tap-only otherwise (see `_find_wakeword_model()`). The only remaining step is producing that `.onnx` file.

**Notebook:** https://colab.research.google.com/drive/1FW7IP-l9RgvFLAl9_ScfgxhGFfBS0SOU (a copy of openWakeWord's `automatic_model_training.ipynb`, saved to Roman's Drive, target phrase set to "hey frog", T4 GPU runtime). Data generation (Step 1) and augmentation (Step 2) both completed successfully. Training (Step 3) has not run yet — one data-format issue was still being fixed when the session paused.

### What was fixed to get this far (all of it is baked into the notebook's cells already — just needs "Run all" or resuming from where it stopped)
The notebook is old enough that several of its pinned dependencies/upstream repos have drifted out of compatibility with current Colab (Python 3.12). In order, the fixes applied:
1. `piper-phonemize` has no Python 3.12 wheel on PyPI anymore → installed `piper-phonemize-fix` instead (same `piper_phonemize` import name, drop-in).
2. `torch_audiomentations==0.11.0` calls `torchaudio.set_audio_backend()`, removed in the newer torchaudio Colab ships → sed-patched that one line to a no-op in the installed package.
3. `piper-sample-generator` (cloned from `main`) was refactored into a package and no longer exposes a flat `generate_samples.py` → `git checkout ded9350` (last commit before the "Move to package" refactor) inside `piper-sample-generator/`.
4. The Debian-packaged system `pkg_resources` (used by the `pronouncing` package) hits multiple removed Python-2-era APIs (`pkgutil.ImpImporter`, `find_module`) on Python 3.12, and current setuptools (83.0.0) has dropped `pkg_resources` entirely → `pip install "setuptools==69.5.1"` (last version confirmed to still ship `pkg_resources` while being 3.12-compatible).
5. `generate_samples()` at the `ded9350` commit needs an explicit `model` argument that openwakeword's current `train.py` doesn't pass → patched `train.py` (regex over all 4 call sites) to inject `model="piper-sample-generator/models/en_US-libritts_r-medium.pt"`.
6. Missing the `piper` package itself (`from piper import PiperVoice, SynthesisConfig`) → `pip install piper-tts`.
7. **(in progress when paused)** The piper LibriTTS model synthesizes at 22050 Hz, not the 16000 Hz `augment_clips` expects → wrote a `fix_sr()` helper (cell just above the last one) that resamples any non-16kHz `.wav` under `my_custom_model/hey_frog/` in place via `scipy.signal.resample_poly`. **The function-definition cell was typed but its Ctrl+Enter run didn't actually fire (confirmed empty output) — the very next step is: run that cell, then run the cell below it that calls `fix_sr()` over all the files (~2-3 min for ~2000+ files), confirm "resampled: N" prints without error, then re-run Step 2 (augment_clips) and Step 3 (train_model, `--train_model`, 10,000 steps, not yet attempted).**

### Tasks
- [x] openwakeword integration + fallback logic already in `voice_loop.py`
- [x] Google sign-in completed, Colab notebook set up, GPU runtime connected
- [x] Step 1 (generate_clips) — done, ~1 min
- [x] Step 2 (augment_clips) — done as of the last successful run, but needs re-running after the sample-rate fix above
- [ ] Fix sample rate (22050→16000) on all generated clips — function written, not yet executed (see above)
- [ ] Step 3 (train_model, 10,000 steps) — not yet attempted
- [ ] Download the resulting `.onnx` from `my_custom_model/hey_frog/` and drop it into `voice/wakeword/` on this machine, then `scp` it to the Pi (`~/frog/voice/wakeword/` — see `setup_pi.sh` for the scp pattern used for `.env`)
- [ ] Test: say the wake word, pause, speak, get response

**Note on Colab session persistence:** the notebook autosaves to Drive continuously, so no code/progress is lost by closing the tab. The T4 runtime itself may disconnect after a period of inactivity — if so, just reconnect and re-run from the sample-rate-fix cell onward (Steps 1-2's outputs/files persist on the runtime's disk only until it's reset, so if the runtime *did* fully reset, cells 1 through the config cell would need re-running first, then generate_clips again — check by running `!ls my_custom_model/hey_frog/` first to see if the generated clips are still there).

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
