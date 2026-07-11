#!/usr/bin/env python3
"""
frog Voice Loop
- Listens for wake word "Hey Jarvis" (or press Enter in dev mode)
- Records speech until silence
- Sends to frog server for processing
- Speaks the response aloud

Requirements: see requirements.txt
Run: python voice_loop.py
"""

import os
import sys
import time
import json
import wave
import struct
import tempfile
import threading
import requests
import numpy as np
import sounddevice as sd
from faster_whisper import WhisperModel

# Non-blocking Enter key detection (works on Windows + Linux)
_enter_flag = threading.Event()
def _stdin_reader():
    while True:
        try:
            sys.stdin.readline()
            _enter_flag.set()
        except Exception:
            break
_stdin_thread = threading.Thread(target=_stdin_reader, daemon=True)
_stdin_thread.start()

def _enter_pressed():
    if _enter_flag.is_set():
        _enter_flag.clear()
        return True
    return False

# ---------- Pi detection ----------
IS_PI = sys.platform == 'linux' and os.path.exists('/proc/device-tree/model')

# ---------- Load settings from server (with env var overrides) ----------
SERVER_URL = os.getenv("FROG_SERVER_URL", "http://localhost:3000")
VOICE_ENDPOINT = f"{SERVER_URL}/api/voice"

def _load_settings():
    """
    Pull settings from server (settings.json), then apply any env var overrides on top.
    Env vars always win when explicitly set — this ensures calibrate.py writes take effect.
    """
    defaults = {
        "voice": "female",
        "speechThreshold": 200,
        "silenceThreshold": 80,
        "silenceDuration": 1.5,
    }
    try:
        r = requests.get(f"{SERVER_URL}/api/settings", timeout=3)
        if r.status_code == 200:
            srv = r.json()
            defaults.update({k: v for k, v in srv.items() if v is not None})
    except Exception:
        pass  # server not up yet, use defaults

    # Env vars override server settings when explicitly set (e.g. after calibrate.py runs)
    if os.getenv("FROG_VOICE"):        defaults["voice"]            = os.getenv("FROG_VOICE").lower()
    if os.getenv("SPEECH_THRESHOLD"):  defaults["speechThreshold"]  = int(os.getenv("SPEECH_THRESHOLD"))
    if os.getenv("SILENCE_THRESHOLD"): defaults["silenceThreshold"] = int(os.getenv("SILENCE_THRESHOLD"))
    if os.getenv("SILENCE_DURATION"):  defaults["silenceDuration"]  = float(os.getenv("SILENCE_DURATION"))
    return defaults

_settings = _load_settings()

SAMPLE_RATE        = 16000
CHANNELS           = 2  # USB audio devices are typically stereo; mixed to mono before processing
SPEECH_THRESHOLD   = _settings["speechThreshold"]
SILENCE_THRESHOLD  = _settings["silenceThreshold"]
SILENCE_DURATION   = _settings["silenceDuration"]
MAX_RECORD_SECONDS = 8
WHISPER_MODEL      = os.getenv("WHISPER_MODEL_PATH", "tiny.en") if IS_PI else "base.en"   # on Pi, env var can point to /dev/shm cache
DEV_MODE           = os.getenv("DEV_MODE", "false").lower() == "true"

# Sanity check: if inverted, voice detection is broken (silence > speech doesn't make sense)
if SILENCE_THRESHOLD >= SPEECH_THRESHOLD:
    print(f"[frog] WARNING: SILENCE_THRESHOLD ({SILENCE_THRESHOLD}) >= SPEECH_THRESHOLD ({SPEECH_THRESHOLD}). "
          f"Adjusting SILENCE_THRESHOLD to {max(10, SPEECH_THRESHOLD // 2)}.")
    SILENCE_THRESHOLD = max(10, SPEECH_THRESHOLD // 2)

# Voice selection
VOICE_MALE   = "am_michael"
VOICE_FEMALE = "af_heart"
VOICE_GENDER = _settings["voice"]
KOKORO_VOICE = VOICE_MALE if VOICE_GENDER == "male" else VOICE_FEMALE

# ---------- Audio device detection ----------
def _find_audio_devices():
    """
    Find the best input and output devices.
    Priority: USB mic > WM8960 HAT > system default.
    On Pi, also look for 'snd_rpi_wm8960' or 'seeed' devices.
    """
    devices = sd.query_devices()
    input_dev  = None
    output_dev = None

    priority_input  = ['yeti', 'c-media', 'sabrent', 'usb', 'pnp', 'wm8960', 'seeed', 'respeaker', 'microphone', 'mic']
    priority_output = ['yeti', 'c-media', 'sabrent', 'usb', 'pnp', 'wm8960', 'seeed', 'respeaker', 'realtek']

    def score(name, priorities):
        name = name.lower()
        for i, kw in enumerate(priorities):
            if kw in name:
                return len(priorities) - i
        return 0

    best_in_score, best_out_score = 0, 0
    for i, d in enumerate(devices):
        if d['max_input_channels'] > 0:
            s = score(d['name'], priority_input)
            if s > best_in_score:
                best_in_score = s
                input_dev = i
        if d['max_output_channels'] > 0:
            s = score(d['name'], priority_output)
            if s > best_out_score:
                best_out_score = s
                output_dev = i

    return input_dev, output_dev

INPUT_DEVICE, OUTPUT_DEVICE = _find_audio_devices()
if INPUT_DEVICE is not None:
    sd.default.device[0] = INPUT_DEVICE
    print(f"[frog] Input device:  {sd.query_devices(INPUT_DEVICE)['name']}")

# Output: on Windows use Sound Mapper; on Pi use the detected USB device
_sound_mapper = next(
    (i for i, d in enumerate(sd.query_devices())
     if 'microsoft sound mapper' in d['name'].lower() and d['max_output_channels'] > 0),
    None
)
if _sound_mapper is not None:
    sd.default.device[1] = _sound_mapper
elif OUTPUT_DEVICE is not None:
    sd.default.device[1] = OUTPUT_DEVICE
print(f"[frog] Output device: {sd.query_devices(sd.default.device[1])['name']}")

# ---------- Vosk live transcription (optional, Pi only) ----------
_vosk_rec = None
_vosk_last_partial = ''  # last partial seen — readable from main loop after record_until_silence returns

def _init_vosk():
    global _vosk_rec
    if _vosk_rec is not None:
        return _vosk_rec
    model_path = os.path.expanduser('~/vosk-models/small-en')
    if not IS_PI or not os.path.exists(model_path):
        return None
    try:
        import os as _os
        from vosk import Model, KaldiRecognizer, SetLogLevel
        SetLogLevel(-1)  # suppress Vosk's verbose LOG output
        _vosk_rec = KaldiRecognizer(Model(model_path), SAMPLE_RATE)
        print("[frog] Vosk live transcription ready.")
    except Exception as e:
        print(f"[frog] Vosk unavailable: {e}")
        _vosk_rec = None
    return _vosk_rec

print("[frog] Loading Whisper model...")
whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8", cpu_threads=4, num_workers=1)
print(f"[frog] Whisper '{WHISPER_MODEL}' ready.")

# Init Vosk eagerly at startup so the first recording isn't delayed
_init_vosk()

if IS_PI:
    import subprocess
    PIPER_BIN   = os.path.expanduser('~/piper/piper')
    PIPER_MODEL = os.path.expanduser('~/piper-voices/en_US-amy-medium.onnx')
    print(f"[frog] TTS: piper ready. Model: {PIPER_MODEL}")
else:
    print("[frog] Loading Kokoro TTS...")
    from kokoro import KPipeline
    _kokoro = KPipeline(lang_code='a')
    print(f"[frog] Kokoro ready. Voice: {KOKORO_VOICE}")

# ---------- Audio cue ----------
def _play_beep(freq=880, duration=0.07, volume=0.25):
    """Play a short confirmation beep using numpy + sounddevice."""
    try:
        rate = 24000
        t = np.linspace(0, duration, int(rate * duration), endpoint=False)
        tone = np.sin(2 * np.pi * freq * t).astype(np.float32)
        # Short fade in/out to avoid clicks
        fade = int(rate * 0.01)
        tone[:fade] *= np.linspace(0, 1, fade)
        tone[-fade:] *= np.linspace(1, 0, fade)
        sd.play(tone * volume, samplerate=rate)
        sd.wait()
    except Exception:
        pass  # Non-critical — silently skip if audio fails

# ---------- TTS ----------
# ── Stop signal — polled by a background thread, checked instantly in recording loop ──
_stop_event = threading.Event()

def _stop_poll_thread():
    """Background thread: polls /api/voice/stop every 150ms and sets _stop_event."""
    while True:
        try:
            res = requests.get(f"{SERVER_URL}/api/voice/stop", timeout=0.5)
            if res.status_code == 200 and res.json().get("stop", False):
                _stop_event.set()
        except Exception:
            pass
        time.sleep(0.15)

threading.Thread(target=_stop_poll_thread, daemon=True).start()

def check_stop_signal():
    """Check and clear the stop event. Non-blocking."""
    if _stop_event.is_set():
        _stop_event.clear()
        return True
    return False

def speak(text):
    """Convert text to speech and play it."""
    print(f"[frog] Speaking: {text[:80]}...")
    sd.stop()  # cut off any audio still playing before starting new speech
    try:
        if IS_PI:
            # Use piper TTS binary then play with aplay (bypasses sounddevice resampling issues)
            with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
                wav_path = f.name
            subprocess.run(
                [PIPER_BIN, '--model', PIPER_MODEL, '--output_file', wav_path],
                input=text.encode(), check=True, capture_output=True
            )
            with wave.open(wav_path, 'rb') as wf:
                src_rate = wf.getframerate()
                data = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16)
            os.unlink(wav_path)
            # Resample mono→48kHz stereo (device native rate) and write temp WAV for aplay
            n_out = int(len(data) * 48000 / src_rate)
            resampled = np.interp(np.linspace(0, len(data) - 1, n_out), np.arange(len(data)), data).astype(np.int16)
            stereo = np.column_stack([resampled, resampled])
            with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
                play_path = f.name
            with wave.open(play_path, 'wb') as wf:
                wf.setnchannels(2); wf.setsampwidth(2); wf.setframerate(48000)
                wf.writeframes(stereo.tobytes())
            dur = len(resampled) / 48000
            print(f"[frog] Playing {dur:.1f}s on 'USB PnP Audio Device: Audio (hw:2,0)'")
            _stop_event.clear()
            proc = subprocess.Popen(['aplay', '-D', 'hw:Device,0', play_path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            while proc.poll() is None:
                if check_stop_signal():
                    proc.terminate()
                    print("[frog] Stopped by user.")
                    break
                time.sleep(0.1)
            os.unlink(play_path)
            print("[frog] Done speaking")
            return
        else:
            # Use Kokoro TTS (Windows dev machine)
            sample_rate = 24000
            chunks = []
            for _, _, chunk in _kokoro(text, voice=KOKORO_VOICE, speed=1.0):
                chunks.append(chunk)
            if not chunks:
                print("[frog] WARN: Kokoro returned no audio chunks")
                return
            audio = np.concatenate(chunks)

        # Clear stop event after generation, right before playback
        _stop_event.clear()
        out_dev = sd.query_devices(sd.default.device[1])['name']
        print(f"[frog] Playing {len(audio)/sample_rate:.1f}s on '{out_dev}'")
        # Play in small blocks so we can interrupt mid-sentence
        block = int(sample_rate * 0.2)  # 200ms blocks
        i = 0
        while i < len(audio):
            if check_stop_signal():
                print("[frog] Stopped by user.")
                sd.stop()
                return
            sd.play(audio[i:i + block], samplerate=sample_rate)
            sd.wait()
            i += block
        print("[frog] Done speaking")
    except Exception as e:
        print(f"[frog] TTS error: {e}")

def _play_wav(path):
    import wave
    with wave.open(path, 'rb') as wf:
        rate = wf.getframerate()
        data = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16)
    sd.play(data.astype(np.float32) / 32768.0, samplerate=rate)
    sd.wait()

# ---------- STT ----------
def transcribe(audio_np):
    """Run Whisper on a numpy int16 audio array. Returns text string."""
    audio_f32 = audio_np.astype(np.float32) / 32768.0
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        wav_path = f.name
    _save_wav(wav_path, audio_np)
    segments, _ = whisper.transcribe(wav_path, language="en", beam_size=1, vad_filter=False)
    text = " ".join(s.text for s in segments).strip()
    os.unlink(wav_path)
    return text

def _save_wav(path, audio_np):
    # audio_np is always mono at this point (mixed down in record_until_silence)
    with wave.open(path, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(audio_np.tobytes())

# ---------- Recording ----------
def record_until_silence():
    """Record from microphone. Waits for speech, then stops after silence."""
    _stop_event.clear()  # discard any stale stop signals from previous interactions
    print("[frog] Listening... (speak now)")
    frames = []
    silent_chunks = 0
    speech_detected = False
    chunk_size = int(SAMPLE_RATE * 0.1)        # 100ms chunks
    silence_chunks_needed = int(SILENCE_DURATION / 0.1)
    max_chunks = int(MAX_RECORD_SECONDS / 0.1)

    global _vosk_last_partial
    vosk = _init_vosk()
    if vosk:
        vosk.Reset()
    _vosk_last_partial = ''

    def _post_partial(text):
        try:
            requests.post(f"{SERVER_URL}/api/screen/state",
                          json={"state": "listening", "userText": text}, timeout=0.3)
        except Exception:
            pass

    try:
        with sd.InputStream(samplerate=SAMPLE_RATE, channels=CHANNELS, dtype='int16',
                            blocksize=chunk_size) as stream:
            for _ in range(max_chunks):
                try:
                    chunk, _ = stream.read(chunk_size)
                except Exception as e:
                    print(f"[frog] Audio read error (mic disconnected?): {e}")
                    break
                if chunk.ndim > 1:
                    chunk = chunk.mean(axis=1).astype(np.int16)
                frames.append(chunk.copy())
                rms = np.sqrt(np.mean(chunk.astype(np.float32) ** 2))

                # Post RMS in background thread so it never blocks audio
                threading.Thread(
                    target=lambda r=rms: requests.post(
                        f"{SERVER_URL}/api/voice/rms",
                        json={"rms": round(float(r), 1)}, timeout=0.3),
                    daemon=True).start()

                # Check stop signal every chunk (~100ms) for immediate response
                if check_stop_signal():
                    print("[frog] Recording stopped by user.")
                    return None

                # Feed every chunk to Vosk — even pre-speech, so it has context ready
                if vosk:
                    if vosk.AcceptWaveform(chunk.tobytes()):
                        result = json.loads(vosk.Result()).get('text', '').strip()
                        if result and speech_detected and result != _vosk_last_partial:
                            _vosk_last_partial = result
                            threading.Thread(target=_post_partial, args=(result,), daemon=True).start()
                    else:
                        partial = json.loads(vosk.PartialResult()).get('partial', '').strip()
                        if partial and speech_detected and partial != _vosk_last_partial:
                            _vosk_last_partial = partial
                            threading.Thread(target=_post_partial, args=(partial,), daemon=True).start()

                if not speech_detected:
                    if rms >= SPEECH_THRESHOLD:
                        speech_detected = True
                        silent_chunks = 0
                        print("[frog] Speech detected, recording...")
                else:
                    if rms < SILENCE_THRESHOLD:
                        silent_chunks += 1
                        if silent_chunks >= silence_chunks_needed:
                            break
                    else:
                        # Decay instead of reset — occasional noise spikes don't restart the countdown
                        silent_chunks = max(0, silent_chunks - 1)
    except Exception as e:
        print(f"[frog] Recording stream error: {e}")
        return None

    if not speech_detected or not frames:
        return None

    audio = np.concatenate(frames, axis=0).flatten()
    return audio

# ---------- Server ----------
def stream_and_speak(text, user_text=None):
    """
    Stream Claude's response sentence-by-sentence from the server SSE endpoint.
    Speaks each sentence immediately as it arrives instead of waiting for the full reply.
    Returns the full response text.
    """
    import urllib.parse
    url = f"{SERVER_URL}/api/voice/stream?message={urllib.parse.quote(text)}"
    full_response = []
    try:
        with requests.get(url, stream=True, timeout=30) as r:
            r.raise_for_status()
            for raw_line in r.iter_lines():
                if not raw_line:
                    continue
                line = raw_line.decode('utf-8') if isinstance(raw_line, bytes) else raw_line
                if not line.startswith('data: '):
                    continue
                try:
                    data = json.loads(line[6:])
                except Exception:
                    continue

                if data.get('type') == 'sentence':
                    sentence = data['text'].strip()
                    if sentence:
                        full_response.append(sentence)
                        set_screen_state('speaking', user_text=user_text, ai_text=' '.join(full_response))
                        speak(sentence)
                        if check_stop_signal():
                            break

                elif data.get('type') == 'done':
                    remaining = data.get('remaining', '').strip()
                    if remaining:
                        full_response.append(remaining)
                        set_screen_state('speaking', user_text=user_text, ai_text=' '.join(full_response))
                        speak(remaining)
                    break

                elif data.get('type') == 'error':
                    speak("Sorry, something went wrong.")
                    break

    except requests.exceptions.ConnectionError:
        speak("I can't reach the server.")
    except Exception as e:
        print(f"[frog] Stream error: {e}")
        speak("Something went wrong.")

    return ' '.join(full_response)


def send_to_server(text):
    """Send transcribed text to frog server, return response text. (fallback)"""
    try:
        res = requests.post(VOICE_ENDPOINT, json={"message": text}, timeout=30)
        res.raise_for_status()
        return res.json().get("response", "Sorry, I didn't get a response.")
    except requests.exceptions.ConnectionError:
        return "I can't reach the server. Make sure frog is running."
    except Exception as e:
        print(f"[frog] Server error: {e}")
        return "Something went wrong talking to the server."

def set_screen_state(state, user_text=None, ai_text=None):
    """Push state update to the screen UI."""
    try:
        payload = {"state": state}
        if user_text: payload["userText"] = user_text
        if ai_text:   payload["aiText"]   = ai_text
        requests.post(f"{SERVER_URL}/api/screen/state", json=payload, timeout=2)
    except Exception:
        pass  # Screen updates are best-effort

def check_pending_speech():
    """Poll server for any server-initiated speech (fired reminders, etc.)."""
    try:
        res = requests.get(f"{SERVER_URL}/api/pending", timeout=2)
        if res.status_code == 200:
            data = res.json()
            if data and data.get("text"):
                return data["text"]
    except Exception:
        pass
    return None

def check_touch_trigger():
    """Poll server for a tap-to-speak trigger from the screen UI."""
    try:
        res = requests.get(f"{SERVER_URL}/api/voice/trigger", timeout=0.5)
        if res.status_code == 200:
            return res.json().get("triggered", False)
    except Exception:
        pass
    return False

# Low battery warning — track last warning time to avoid spamming
_last_battery_warn = 0

def check_battery_warning():
    """Speak a low battery warning if Pi battery is ≤15% and we haven't warned in 10 minutes."""
    global _last_battery_warn
    if not IS_PI:
        return
    now = time.time()
    if now - _last_battery_warn < 600:  # 10-minute cooldown
        return
    try:
        res = requests.get(f"{SERVER_URL}/api/status", timeout=3)
        if res.status_code == 200:
            data = res.json()
            bat = data.get("battery")
            if bat and bat.get("percent", 100) <= 15 and not bat.get("charging", False):
                _last_battery_warn = now
                speak(f"Warning: battery is at {bat['percent']} percent. Please charge soon.")
    except Exception:
        pass

# ---------- Wake Word ----------
def wait_for_wake_word():
    """
    In DEV_MODE: just press Enter.
    On Pi: uses openwakeword to detect 'hey pi'.
    """
    if DEV_MODE:
        # Poll for pending speech every 2s while waiting for Enter
        import select, sys
        print("\n[frog] Press Enter to speak (or Ctrl+C to quit)...", end='', flush=True)
        while True:
            pending = check_pending_speech()
            if pending:
                print()  # newline after the prompt
                return ("pending", pending)
            if check_touch_trigger():
                print()
                _play_beep()
                return ("user", None)
            # Non-blocking check for Enter key (Windows-compatible via threading)
            if _enter_pressed():
                _play_beep()
                return ("user", None)
            time.sleep(0.5)

    if IS_PI:
        # On Pi: poll for screen tap trigger (tap the screen UI to speak)
        print("[frog] Waiting for screen tap...")
        while True:
            if check_touch_trigger():
                print("[frog] Touch trigger detected!")
                _play_beep()
                return ("user", None)
            pending = check_pending_speech()
            if pending:
                return ("pending", pending)
            time.sleep(0.3)
    try:
        from openwakeword.model import Model
        import openwakeword
        _oww_models_dir = os.path.join(os.path.dirname(openwakeword.__file__), "resources", "models")
        _jarvis_path = os.path.join(_oww_models_dir, "hey_jarvis_v0.1.onnx")
        oww = Model(wakeword_model_paths=[_jarvis_path])
        print("[frog] Waiting for wake word 'Hey Jarvis'...")
        chunk_size = 1280
        _poll_counter = 0
        with sd.InputStream(samplerate=16000, channels=CHANNELS, dtype='int16', blocksize=chunk_size) as stream:
            while True:
                chunk, _ = stream.read(chunk_size)
                if chunk.ndim > 1:
                    chunk = chunk.mean(axis=1).astype(np.int16)
                oww.predict(chunk.flatten())
                scores = oww.prediction_buffer.get("hey_jarvis_v0.1", [0])
                if scores and scores[-1] > 0.3:
                    print("[frog] Wake word detected!")
                    _play_beep()
                    return ("user", None)
                _poll_counter += 1
                if _poll_counter % 6 == 0:
                    if check_touch_trigger():
                        print("[frog] Touch trigger detected!")
                        _play_beep()
                        return ("user", None)
                    pending = check_pending_speech()
                    if pending:
                        return ("pending", pending)
    except ImportError:
        print("[frog] openwakeword not installed, falling back to Enter key.")
        input("[frog] Press Enter to speak...")
        return ("user", None)

# ---------- Conversation window ----------
def wait_for_tap(timeout=30):
    """
    After a response, stay tap-ready for `timeout` seconds.
    Returns True if user tapped (keep chatting), False if timed out (go to wake word).
    """
    print(f"[frog] Conversation window open ({timeout}s) — tap mic or say 'Hey Jarvis'")
    deadline = time.time() + timeout
    while time.time() < deadline:
        if check_touch_trigger():
            print("[frog] Tap detected — continuing conversation")
            _play_beep()
            return True
        pending = check_pending_speech()
        if pending:
            return ("pending", pending)
        time.sleep(0.2)
    print("[frog] Conversation window closed — back to wake word")
    return False

# ---------- Single-instance lock ----------
import atexit
_LOCK_FILE = os.path.join(tempfile.gettempdir(), 'frog_voice.lock')

def _pid_alive(pid):
    """Cross-platform check whether a PID is running."""
    try:
        if sys.platform == 'win32':
            import ctypes
            SYNCHRONIZE = 0x00100000
            handle = ctypes.windll.kernel32.OpenProcess(SYNCHRONIZE, False, pid)
            if handle == 0:
                return False
            ctypes.windll.kernel32.CloseHandle(handle)
            return True
        else:
            os.kill(pid, 0)
            return True
    except Exception:
        return False

def _acquire_lock():
    if os.path.exists(_LOCK_FILE):
        try:
            with open(_LOCK_FILE) as f:
                old_pid = int(f.read().strip())
            if _pid_alive(old_pid):
                print(f"[frog] ERROR: Another instance is already running (PID {old_pid}). Exiting.")
                sys.exit(1)
        except (OSError, ValueError):
            pass  # stale lock — safe to continue
    with open(_LOCK_FILE, 'w') as f:
        f.write(str(os.getpid()))
    atexit.register(lambda: os.unlink(_LOCK_FILE) if os.path.exists(_LOCK_FILE) else None)

# ---------- Main Loop ----------
def main():
    _acquire_lock()
    print("\n========================================")
    print("  frog Voice Assistant")
    print("========================================")
    if DEV_MODE:
        print("  Mode: Development (press Enter to speak)")
    else:
        print("  Mode: Wake word ('Hey Jarvis')")
    print(f"  Server: {SERVER_URL}")
    print("========================================\n")

    speak("frog is ready.")

    in_conversation = False

    while True:
        try:
            set_screen_state('idle')

            # After a response, stay tap-ready for 30s before requiring wake word
            if in_conversation:
                result = wait_for_tap(timeout=30)
                if result is False:
                    in_conversation = False
                    trigger = wait_for_wake_word()
                elif isinstance(result, tuple):
                    trigger = result  # pending reminder
                else:
                    trigger = ("user", None)  # tap
            else:
                trigger = wait_for_wake_word()

            if isinstance(trigger, tuple) and trigger[0] == "pending":
                pending_text = trigger[1]
                print(f"[frog] Reminder: {pending_text}")
                set_screen_state('speaking', ai_text=pending_text)
                speak(pending_text)
                set_screen_state('idle')
                continue

            set_screen_state('listening')
            time.sleep(0.4)  # let speaker echo decay before recording
            audio = record_until_silence()

            if audio is None:
                set_screen_state('idle')
                in_conversation = False
                continue

            set_screen_state('thinking', user_text=_vosk_last_partial)
            print("[frog] Processing speech...")
            text = transcribe(audio)

            if not text:
                set_screen_state('idle')
                continue

            print(f"[frog] You said: {text}")
            set_screen_state('thinking', user_text=text)
            response = stream_and_speak(text, user_text=text)
            print(f"[frog] Response: {response[:100]}...")
            set_screen_state('idle', ai_text=response)
            check_battery_warning()
            in_conversation = True  # stay tap-ready after responding

        except KeyboardInterrupt:
            print("\n[frog] Shutting down.")
            break
        except Exception as e:
            print(f"[frog] Error: {e}")
            time.sleep(1)

if __name__ == "__main__":
    main()
