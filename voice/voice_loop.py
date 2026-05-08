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

# ---------- Config ----------
SERVER_URL = os.getenv("PIAI_SERVER_URL", "http://localhost:3000")
VOICE_ENDPOINT = f"{SERVER_URL}/api/voice"
SAMPLE_RATE = 16000
CHANNELS = 1
SPEECH_THRESHOLD  = 200      # RMS above this = speech detected
SILENCE_THRESHOLD = 80       # RMS below this (after speech) = silence
SILENCE_DURATION  = 1.5      # seconds of silence after speech to stop
MAX_RECORD_SECONDS = 30      # max recording length
WHISPER_MODEL = "base.en"    # tiny.en = fastest, base.en = better accuracy
DEV_MODE = os.getenv("DEV_MODE", "true").lower() == "true"  # press Enter instead of wake word

# Voice selection — switch by setting PIAI_VOICE env var to "male" or "female"
VOICE_MALE   = "am_michael"
VOICE_FEMALE = "af_heart"
VOICE_GENDER = os.getenv("PIAI_VOICE", "female").lower()
KOKORO_VOICE = VOICE_MALE if VOICE_GENDER == "male" else VOICE_FEMALE

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

# ---------- Wake Word ----------
def wait_for_wake_word():
    """
    In DEV_MODE: just press Enter.
    On Pi: uses openwakeword to detect 'hey pi'.
    """
    if DEV_MODE:
        input("\n[PiAI] Press Enter to speak (or Ctrl+C to quit)...")
        return

    try:
        from openwakeword.model import Model
        oww = Model(wakeword_models=["hey_jarvis"], inference_framework="onnx")
        # hey_jarvis is the closest available model; swap for custom "hey_pi" model later
        print("[PiAI] Waiting for wake word 'Hey Pi'...")
        chunk_size = 1280
        with sd.InputStream(samplerate=16000, channels=1, dtype='int16', blocksize=chunk_size) as stream:
            while True:
                chunk, _ = stream.read(chunk_size)
                oww.predict(chunk.flatten())
                scores = oww.prediction_buffer.get("hey_jarvis", [0])
                if scores and scores[-1] > 0.5:
                    print("[PiAI] Wake word detected!")
                    return
    except ImportError:
        print("[PiAI] openwakeword not installed, falling back to Enter key.")
        input("[PiAI] Press Enter to speak...")

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
            wait_for_wake_word()
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
            # thinking + speaking states are set by the server via /api/voice
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
