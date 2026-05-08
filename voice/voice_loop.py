#!/usr/bin/env python3
"""
PiAI Voice Loop
- Listens for wake word "hey pi" (or press Enter in dev mode)
- Records speech until silence
- Sends to PiAI server for processing
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
SERVER_URL = os.getenv("PIAI_SERVER_URL", "http://localhost:3000")
VOICE_ENDPOINT = f"{SERVER_URL}/api/voice"

def _load_settings():
    """Pull settings.json from server; fall back to env vars / defaults."""
    defaults = {
        "voice": os.getenv("PIAI_VOICE", "female").lower(),
        "speechThreshold": int(os.getenv("SPEECH_THRESHOLD", "200")),
        "silenceThreshold": int(os.getenv("SILENCE_THRESHOLD", "80")),
        "silenceDuration": float(os.getenv("SILENCE_DURATION", "1.5")),
    }
    try:
        r = requests.get(f"{SERVER_URL}/api/settings", timeout=3)
        if r.status_code == 200:
            srv = r.json()
            defaults.update({k: v for k, v in srv.items() if v is not None})
    except Exception:
        pass  # server not up yet, use defaults
    return defaults

_settings = _load_settings()

SAMPLE_RATE        = 16000
CHANNELS           = 1
SPEECH_THRESHOLD   = _settings["speechThreshold"]
SILENCE_THRESHOLD  = _settings["silenceThreshold"]
SILENCE_DURATION   = _settings["silenceDuration"]
MAX_RECORD_SECONDS = 30
WHISPER_MODEL      = "tiny.en" if IS_PI else "base.en"   # faster model on Pi
DEV_MODE           = os.getenv("DEV_MODE", "true").lower() == "true"

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

    priority_input  = ['usb', 'wm8960', 'seeed', 'respeaker', 'microphone', 'mic']
    priority_output = ['wm8960', 'seeed', 'respeaker', 'usb', 'speaker', 'headphone']

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
    print(f"[PiAI] Input device:  {sd.query_devices(INPUT_DEVICE)['name']}")
if OUTPUT_DEVICE is not None:
    sd.default.device[1] = OUTPUT_DEVICE
    print(f"[PiAI] Output device: {sd.query_devices(OUTPUT_DEVICE)['name']}")

print("[PiAI] Loading Whisper model...")
whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
print(f"[PiAI] Whisper '{WHISPER_MODEL}' ready.")

print("[PiAI] Loading Kokoro TTS...")
from kokoro import KPipeline
_kokoro = KPipeline(lang_code='a')
print(f"[PiAI] Kokoro ready. Voice: {KOKORO_VOICE}")

# ---------- TTS ----------
def speak(text):
    """Convert text to speech and play it using Kokoro."""
    print(f"[PiAI] Speaking ({KOKORO_VOICE}): {text[:80]}...")
    try:
        chunks = []
        for _, _, audio in _kokoro(text, voice=KOKORO_VOICE, speed=1.0):
            chunks.append(audio)
        if chunks:
            audio = np.concatenate(chunks)
            sd.play(audio, samplerate=24000)
            sd.wait()
    except Exception as e:
        print(f"[PiAI] TTS error: {e}")

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
    segments, _ = whisper.transcribe(wav_path, language="en", beam_size=1)
    text = " ".join(s.text for s in segments).strip()
    os.unlink(wav_path)
    return text

def _save_wav(path, audio_np):
    with wave.open(path, 'wb') as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(audio_np.tobytes())

# ---------- Recording ----------
def record_until_silence():
    """Record from microphone. Waits for speech, then stops after silence."""
    print("[PiAI] Listening... (speak now)")
    frames = []
    silent_chunks = 0
    speech_detected = False
    chunk_size = int(SAMPLE_RATE * 0.1)        # 100ms chunks
    silence_chunks_needed = int(SILENCE_DURATION / 0.1)
    max_chunks = int(MAX_RECORD_SECONDS / 0.1)

    with sd.InputStream(samplerate=SAMPLE_RATE, channels=CHANNELS, dtype='int16', blocksize=chunk_size) as stream:
        for _ in range(max_chunks):
            chunk, _ = stream.read(chunk_size)
            frames.append(chunk.copy())
            rms = np.sqrt(np.mean(chunk.astype(np.float32) ** 2))

            if not speech_detected:
                if rms >= SPEECH_THRESHOLD:
                    speech_detected = True
                    silent_chunks = 0
                    print("[PiAI] Speech detected, recording...")
            else:
                if rms < SILENCE_THRESHOLD:
                    silent_chunks += 1
                    if silent_chunks >= silence_chunks_needed:
                        break
                else:
                    silent_chunks = 0

    if not speech_detected:
        return None

    audio = np.concatenate(frames, axis=0).flatten()
    return audio

# ---------- Server ----------
def send_to_server(text):
    """Send transcribed text to PiAI server, return response text."""
    try:
        res = requests.post(VOICE_ENDPOINT, json={"message": text}, timeout=30)
        res.raise_for_status()
        return res.json().get("response", "Sorry, I didn't get a response.")
    except requests.exceptions.ConnectionError:
        return "I can't reach the server. Make sure PiAI is running."
    except Exception as e:
        print(f"[PiAI] Server error: {e}")
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

# ---------- Wake Word ----------
def wait_for_wake_word():
    """
    In DEV_MODE: just press Enter.
    On Pi: uses openwakeword to detect 'hey pi'.
    """
    if DEV_MODE:
        # Poll for pending speech every 2s while waiting for Enter
        import select, sys
        print("\n[PiAI] Press Enter to speak (or Ctrl+C to quit)...", end='', flush=True)
        while True:
            pending = check_pending_speech()
            if pending:
                print()  # newline after the prompt
                return ("pending", pending)
            # Non-blocking check for Enter key (Windows-compatible via threading)
            if _enter_pressed():
                return ("user", None)
            time.sleep(0.5)

    try:
        from openwakeword.model import Model
        oww = Model(wakeword_models=["hey_jarvis"], inference_framework="onnx")
        print("[PiAI] Waiting for wake word 'Hey Pi'...")
        chunk_size = 1280
        with sd.InputStream(samplerate=16000, channels=1, dtype='int16', blocksize=chunk_size) as stream:
            while True:
                chunk, _ = stream.read(chunk_size)
                oww.predict(chunk.flatten())
                scores = oww.prediction_buffer.get("hey_jarvis", [0])
                if scores and scores[-1] > 0.5:
                    print("[PiAI] Wake word detected!")
                    return ("user", None)
                # Also poll for reminders while waiting for wake word
                pending = check_pending_speech()
                if pending:
                    return ("pending", pending)
    except ImportError:
        print("[PiAI] openwakeword not installed, falling back to Enter key.")
        input("[PiAI] Press Enter to speak...")
        return ("user", None)

# ---------- Main Loop ----------
def main():
    print("\n========================================")
    print("  PiAI Voice Assistant")
    print("========================================")
    if DEV_MODE:
        print("  Mode: Development (press Enter to speak)")
    else:
        print("  Mode: Wake word ('Hey Pi')")
    print(f"  Server: {SERVER_URL}")
    print("========================================\n")

    speak("PiAI is ready.")

    while True:
        try:
            set_screen_state('idle')
            trigger = wait_for_wake_word()  # ("user", None) or ("pending", text)

            if isinstance(trigger, tuple) and trigger[0] == "pending":
                # Server-initiated speech (fired reminder, etc.)
                pending_text = trigger[1]
                print(f"[PiAI] Reminder: {pending_text}")
                set_screen_state('speaking', ai_text=pending_text)
                speak(pending_text)
                set_screen_state('idle')
                continue

            set_screen_state('listening')
            audio = record_until_silence()

            if audio is None:
                print("[PiAI] No speech detected.")
                set_screen_state('idle')
                continue

            print("[PiAI] Processing speech...")
            text = transcribe(audio)

            if not text:
                print("[PiAI] No speech detected.")
                set_screen_state('idle')
                continue

            print(f"[PiAI] You said: {text}")
            response = send_to_server(text)
            print(f"[PiAI] Response: {response[:100]}...")
            speak(response)
            set_screen_state('idle')

        except KeyboardInterrupt:
            print("\n[PiAI] Shutting down.")
            break
        except Exception as e:
            print(f"[PiAI] Error: {e}")
            time.sleep(1)

if __name__ == "__main__":
    main()
