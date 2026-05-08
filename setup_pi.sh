#!/bin/bash
# PiAI Setup Script — run once on a fresh Raspberry Pi 4
# Usage: bash setup_pi.sh
# Or one-line install (once repo is public):
#   curl -sSL https://raw.githubusercontent.com/hatchatcha9/MessageAI/master/setup_pi.sh | bash

set -e

PIAI_DIR="$HOME/piai"
REPO_URL="https://github.com/hatchatcha9/MessageAI.git"

echo "========================================"
echo "  PiAI Setup"
echo "  Platform: $(uname -m) / $(cat /proc/device-tree/model 2>/dev/null | tr -d '\0' || echo 'Unknown')"
echo "========================================"

# ── 1. System packages ────────────────────────────────────────────────────────
echo ""
echo "[1/8] Installing system dependencies..."
sudo apt-get update -qq
sudo apt-get install -y \
    python3 python3-pip python3-venv \
    portaudio19-dev \
    libsndfile1 \
    alsa-utils \
    libasound2-dev \
    git \
    ffmpeg \
    libcamera-apps \
    v4l-utils \
    i2c-tools

# ── 2. Node.js v20 ────────────────────────────────────────────────────────────
echo ""
echo "[2/8] Checking Node.js..."
if ! command -v node &>/dev/null || [ "$(node -e 'console.log(+process.versions.node.split(\".\")[0])')" -lt 18 ]; then
    echo "    Installing Node.js v20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi
echo "    Node.js $(node --version) ✓"

# ── 3. WM8960 Audio HAT ───────────────────────────────────────────────────────
echo ""
echo "[3/8] Configuring WM8960 audio HAT..."

# Enable I2C and I2S in /boot/config.txt if not already
CONFIG=/boot/firmware/config.txt   # Pi OS Bookworm path
[ -f /boot/config.txt ] && CONFIG=/boot/config.txt   # older Pi OS

for line in "dtparam=i2c_arm=on" "dtparam=i2s=on" "dtoverlay=wm8960-soundcard"; do
    grep -qF "$line" "$CONFIG" || echo "$line" | sudo tee -a "$CONFIG" > /dev/null && echo "    Added: $line"
done

# Create ALSA config for WM8960 HAT
sudo tee /etc/asound.conf > /dev/null << 'ALSA'
pcm.!default {
    type asym
    playback.pcm {
        type plug
        slave.pcm "hw:wm8960soundcard,0"
    }
    capture.pcm {
        type plug
        slave.pcm "hw:wm8960soundcard,0"
    }
}
ctl.!default {
    type hw
    card wm8960soundcard
}
ALSA

# Set WM8960 mixer levels (run after reboot, skip if card not present yet)
if aplay -l 2>/dev/null | grep -q wm8960; then
    amixer -c wm8960soundcard sset 'Headphone',0 80% 2>/dev/null || true
    amixer -c wm8960soundcard sset 'Speaker',0 80% 2>/dev/null || true
    amixer -c wm8960soundcard sset 'Capture',0 80% unmute 2>/dev/null || true
    echo "    WM8960 mixer levels set ✓"
else
    echo "    WM8960 not detected yet (normal before first reboot with overlay)"
fi

# ── 4. Pi Camera 3 ────────────────────────────────────────────────────────────
echo ""
echo "[4/8] Enabling Pi Camera 3..."

# Enable camera in config
grep -qF "camera_auto_detect=1" "$CONFIG" || echo "camera_auto_detect=1" | sudo tee -a "$CONFIG" > /dev/null
grep -qF "dtoverlay=imx708" "$CONFIG" || echo "dtoverlay=imx708" | sudo tee -a "$CONFIG" > /dev/null

# Add user to video group
sudo usermod -aG video "$USER"

# Test capture (skip if camera not available yet)
if libcamera-hello --list-cameras 2>/dev/null | grep -q "Available"; then
    echo "    Camera detected ✓"
else
    echo "    Camera not detected yet (normal before first reboot)"
fi

# ── 5. Clone / update repo ────────────────────────────────────────────────────
echo ""
echo "[5/8] Setting up project..."
if [ -d "$PIAI_DIR/.git" ]; then
    echo "    Pulling latest..."
    git -C "$PIAI_DIR" pull --rebase
else
    git clone "$REPO_URL" "$PIAI_DIR"
fi
cd "$PIAI_DIR"

# ── 6. Node dependencies ──────────────────────────────────────────────────────
echo ""
echo "[6/8] Installing Node.js dependencies..."
npm install --omit=dev
npm install serialport @serialport/parser-readline  # GPS support

# ── 7. Python voice loop ──────────────────────────────────────────────────────
echo ""
echo "[7/8] Setting up Python environment..."
python3 -m venv voice/venv
source voice/venv/bin/activate

pip install --upgrade pip -q
pip install -r voice/requirements.txt

# Uncomment openwakeword for wake word support
pip install openwakeword -q && echo "    openwakeword installed ✓" || echo "    openwakeword install failed (non-fatal)"

# Pre-download Whisper model (tiny.en for Pi — faster than base.en)
echo "    Downloading Whisper tiny.en model..."
python3 -c "from faster_whisper import WhisperModel; WhisperModel('tiny.en', device='cpu', compute_type='int8')" \
    && echo "    Whisper ready ✓"

deactivate

# ── 8. Environment & services ─────────────────────────────────────────────────
echo ""
echo "[8/8] Finalizing..."

# Create .env if not present
if [ ! -f "$PIAI_DIR/.env" ]; then
    cp "$PIAI_DIR/.env.example" "$PIAI_DIR/.env"
    echo ""
    echo "  *** .env created — EDIT IT NOW: nano $PIAI_DIR/.env ***"
    echo ""
fi

# Systemd — server
sudo tee /etc/systemd/system/piai-server.service > /dev/null << EOF
[Unit]
Description=PiAI Server
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$PIAI_DIR
ExecStart=/usr/bin/node $PIAI_DIR/server.js
Restart=on-failure
RestartSec=5
EnvironmentFile=$PIAI_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

# Systemd — voice loop
sudo tee /etc/systemd/system/piai-voice.service > /dev/null << EOF
[Unit]
Description=PiAI Voice Loop
After=piai-server.service sound.target
Requires=piai-server.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$PIAI_DIR
ExecStart=$PIAI_DIR/voice/venv/bin/python $PIAI_DIR/voice/voice_loop.py
Restart=on-failure
RestartSec=10
Environment=DEV_MODE=false
EnvironmentFile=$PIAI_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable piai-server piai-voice
echo "    Services installed and enabled on boot ✓"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "========================================"
echo "  Setup Complete!"
echo "========================================"
echo ""
echo "  NEXT STEPS:"
echo "  1. Edit .env:        nano $PIAI_DIR/.env"

# Check if reboot needed (new overlays added)
NEEDS_REBOOT=0
grep -qF "dtoverlay=wm8960-soundcard" "$CONFIG" && NEEDS_REBOOT=1

if [ "$NEEDS_REBOOT" -eq 1 ]; then
    echo "  2. REBOOT REQUIRED:  sudo reboot"
    echo "     (needed for WM8960 audio HAT + camera overlay)"
    echo "  3. After reboot:     sudo systemctl start piai-server piai-voice"
else
    echo "  2. Start services:   sudo systemctl start piai-server piai-voice"
fi

echo ""
echo "  Screen UI:   http://$(hostname -I | awk '{print $1}'):3000/screen.html"
echo "  Debug logs:  http://$(hostname -I | awk '{print $1}'):3000/debug.html"
echo "  Settings:    http://$(hostname -I | awk '{print $1}'):3000/settings.html"
echo ""
echo "  Service logs:"
echo "    sudo journalctl -u piai-server -f"
echo "    sudo journalctl -u piai-voice -f"
echo ""
