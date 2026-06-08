#!/bin/bash
# frog Setup Script — run once on a fresh Raspberry Pi 4
# Usage: bash setup_pi.sh
# Or one-line install (once repo is public):
#   curl -sSL https://raw.githubusercontent.com/hatchatcha9/MessageAI/master/setup_pi.sh | bash

set -e

FROG_DIR="$HOME/frog"
REPO_URL="https://github.com/hatchatcha9/MessageAI.git"

echo "========================================"
echo "  frog Setup"
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

# ── 3. USB Sound Card (Sabrent AU-MMSA or similar tiny USB dongle) ───────────
echo ""
echo "[3/8] Configuring USB sound card..."

# USB audio needs no overlay — just set it as ALSA default
# Find the USB audio card index
USB_CARD=$(aplay -l 2>/dev/null | grep -i "usb\|USB Audio" | head -1 | grep -o 'card [0-9]*' | grep -o '[0-9]*')

if [ -n "$USB_CARD" ]; then
    echo "    Found USB audio at card $USB_CARD ✓"
    sudo tee /etc/asound.conf > /dev/null << ALSA
pcm.!default {
    type asym
    playback.pcm {
        type plug
        slave.pcm "hw:${USB_CARD},0"
    }
    capture.pcm {
        type plug
        slave.pcm "hw:${USB_CARD},0"
    }
}
ctl.!default {
    type hw
    card ${USB_CARD}
}
ALSA
    echo "    ALSA default set to USB card $USB_CARD ✓"
    # Unmute and set volume (try common control names — Sabrent uses Headphone, others use Speaker/Master)
    amixer -c "$USB_CARD" sset 'Headphone' 80% unmute 2>/dev/null || \
    amixer -c "$USB_CARD" sset 'Speaker' 80% unmute 2>/dev/null || true
    amixer -c "$USB_CARD" sset 'Mic' 80% unmute 2>/dev/null || \
    amixer -c "$USB_CARD" sset 'Microphone' 80% unmute 2>/dev/null || true
else
    echo "    USB audio card not found — plug it in and re-run if audio doesn't work"
fi

# ── 4. Arducam IMX708 Camera ──────────────────────────────────────────────────
echo ""
echo "[4/8] Enabling Arducam IMX708 camera..."

CONFIG=/boot/firmware/config.txt   # Pi OS Bookworm path
[ -f /boot/config.txt ] && CONFIG=/boot/config.txt   # older Pi OS

# IMX708 is auto-detected via camera_auto_detect; explicit overlay as fallback
grep -qF "camera_auto_detect=1" "$CONFIG" || echo "camera_auto_detect=1" | sudo tee -a "$CONFIG" > /dev/null
grep -qF "dtoverlay=imx708" "$CONFIG" || echo "dtoverlay=imx708" | sudo tee -a "$CONFIG" > /dev/null

# Add user to video group
sudo usermod -aG video "$USER"

if libcamera-hello --list-cameras 2>/dev/null | grep -q "Available"; then
    echo "    Arducam IMX708 detected ✓"
else
    echo "    Camera not detected yet (normal before first reboot)"
fi

# ── 4b. GeeekPi 3.5" Touchscreen ─────────────────────────────────────────────
echo ""
echo "[4b] Configuring GeeekPi 3.5\" touchscreen..."

# GeeekPi 3.5" HAT typically uses the MHS35 (ili9486) driver
# If screen shows no image after reboot, check: https://github.com/goodtft/LCD-show
grep -qF "dtoverlay=piscreen" "$CONFIG" || \
grep -qF "dtoverlay=tft35a"  "$CONFIG" || {
    echo "    Adding MHS35 display overlay (dtoverlay=tft35a,rotate=90)..."
    echo "dtoverlay=tft35a,rotate=90" | sudo tee -a "$CONFIG" > /dev/null
    echo "    Added ✓ (if screen is blank after reboot, try rotate=0/90/180/270)"
}

# Install Xorg + minimal window manager + Chromium for kiosk on Pi OS Lite
# Pi OS Lite has no desktop environment — we use startx + openbox directly
echo "    Installing Xorg + openbox + Chromium..."
sudo apt-get install -y xorg openbox chromium-browser x11-xserver-utils unclutter -q

# Add user to tty/input groups for Xorg without root
sudo usermod -aG tty,input "$USER"

# Create openbox autostart: launches Chromium in kiosk mode when X starts
mkdir -p "$HOME/.config/openbox"
cat > "$HOME/.config/openbox/autostart" << 'OPENBOX'
# Disable screen blanking and power management
xset s off
xset s noblank
xset -dpms
unclutter -idle 0.5 -root &

# Wait for frog server to be ready, then launch kiosk
(
  until curl -sf http://localhost:3000/api/health >/dev/null 2>&1; do sleep 1; done
  chromium-browser \
    --kiosk \
    --noerrdialogs \
    --disable-infobars \
    --no-first-run \
    --disable-translate \
    --disable-features=TranslateUI \
    --check-for-update-interval=31536000 \
    http://localhost:3000/screen.html
) &
OPENBOX

# Create ~/.xinitrc so 'startx' launches openbox
cat > "$HOME/.xinitrc" << 'XINITRC'
exec openbox-session
XINITRC

# Create a systemd service that runs startx on boot (for Pi OS Lite, no display manager)
sudo tee /etc/systemd/system/frog-kiosk.service > /dev/null << EOF
[Unit]
Description=frog Kiosk (Xorg + Chromium)
After=frog-server.service network.target
Requires=frog-server.service

[Service]
Type=simple
User=$USER
Environment=HOME=/home/$USER
Environment=DISPLAY=:0
ExecStart=/bin/bash -c 'startx -- -nocursor 2>/tmp/xorg.log'
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable frog-kiosk
echo "    Kiosk service installed (startx → openbox → Chromium) ✓"

# ── 4c. PiSugar 3 Plus ────────────────────────────────────────────────────────
echo ""
echo "[4c] Installing PiSugar 3 Plus battery service..."

if command -v pisugar-server &>/dev/null || systemctl list-units --all 2>/dev/null | grep -q pisugar; then
    echo "    pisugar-server already installed ✓"
else
    echo "    Downloading and installing pisugar-server..."
    curl -sSL https://cdn.pisugar.com/release/install.sh | sudo bash
    if command -v pisugar-server &>/dev/null || systemctl list-units --all 2>/dev/null | grep -q pisugar; then
        echo "    pisugar-server installed ✓"
    else
        echo "    pisugar-server install failed — battery commands will return null (non-fatal)"
    fi
fi

# Ensure I2C is enabled (PiSugar uses I2C)
grep -qF "dtparam=i2c_arm=on" "$CONFIG" || echo "dtparam=i2c_arm=on" | sudo tee -a "$CONFIG" > /dev/null
sudo modprobe i2c-dev 2>/dev/null || true
echo "    I2C enabled ✓"

# ── 5. Clone / update repo ────────────────────────────────────────────────────
echo ""
echo "[5/8] Setting up project..."
if [ -d "$FROG_DIR/.git" ]; then
    echo "    Pulling latest..."
    git -C "$FROG_DIR" pull --rebase
else
    git clone "$REPO_URL" "$FROG_DIR"
fi
cd "$FROG_DIR"

# ── 5b. GPS port fix (USB NEO-6M → /dev/ttyUSB0) ─────────────────────────────
echo ""
echo "[5b] Fixing GPS port for USB module..."
GPS_FILE="$FROG_DIR/modules/gps.js"
if grep -q "ttyAMA0" "$GPS_FILE" 2>/dev/null; then
    sed -i 's|/dev/ttyAMA0|/dev/ttyUSB0|g' "$GPS_FILE"
    echo "    GPS port: /dev/ttyAMA0 → /dev/ttyUSB0 ✓"
else
    echo "    GPS port already set to ttyUSB0 ✓"
fi
# Add user to dialout group for serial/USB device access
sudo usermod -aG dialout "$USER"
echo "    Added $USER to dialout group ✓"

# ── 6. Node dependencies ──────────────────────────────────────────────────────
echo ""
echo "[6/8] Installing Node.js dependencies..."
# Skip Playwright browser download — not needed on Pi (TWILIO_ENABLED=false)
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev
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

# ── 7b. Mic auto-calibration ──────────────────────────────────────────────────
echo ""
echo "[7b] Calibrating microphone thresholds..."
echo "     (This measures your USB mic's noise floor to set speech detection levels)"

CALIBRATE_PY="$FROG_DIR/scripts/calibrate.py"
if [ -f "$CALIBRATE_PY" ]; then
    CALIBRATE_OUTPUT=$(cd "$FROG_DIR" && voice/venv/bin/python "$CALIBRATE_PY" --auto 2>&1)
    CALIBRATE_EXIT=$?
    echo "$CALIBRATE_OUTPUT" | grep -E "SPEECH_THRESHOLD|SILENCE_THRESHOLD|Calibration|ambient|✓|WARNING|default" || true
    if [ $CALIBRATE_EXIT -eq 0 ]; then
        echo "    Mic calibration complete ✓"
    else
        echo "    Mic calibration exited with code $CALIBRATE_EXIT — defaults written to .env (non-fatal)"
    fi
else
    echo "    calibrate.py not found — using default thresholds (SPEECH=300, SILENCE=100)"
    echo "    Run 'python scripts/calibrate.py' after setup to calibrate manually."
fi

# ── 8. Environment & services ─────────────────────────────────────────────────
echo ""
echo "[8/8] Finalizing..."

# Create .env if not present
if [ ! -f "$FROG_DIR/.env" ]; then
    cp "$FROG_DIR/.env.example" "$FROG_DIR/.env"
    echo ""
    echo "  *** .env created — EDIT IT NOW: nano $FROG_DIR/.env ***"
    echo ""
fi

# Systemd — server
sudo tee /etc/systemd/system/frog-server.service > /dev/null << EOF
[Unit]
Description=frog Server
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$FROG_DIR
ExecStart=/usr/bin/node $FROG_DIR/server.js
Restart=on-failure
RestartSec=5
EnvironmentFile=$FROG_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

# Systemd — voice loop
sudo tee /etc/systemd/system/frog-voice.service > /dev/null << EOF
[Unit]
Description=frog Voice Loop
After=frog-server.service sound.target
Requires=frog-server.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$FROG_DIR
ExecStart=$FROG_DIR/voice/venv/bin/python $FROG_DIR/voice/voice_loop.py
Restart=on-failure
RestartSec=10
Environment=DEV_MODE=false
EnvironmentFile=$FROG_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable frog-server frog-voice frog-kiosk
echo "    Services installed and enabled on boot ✓"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "========================================"
echo "  Setup Complete!"
echo "========================================"
echo ""
PI_IP=$(hostname -I | awk '{print $1}')
PI_USER=$(whoami)
echo "  NEXT STEPS:"
echo "  1. Copy your .env from your Windows machine to this Pi:"
echo "     Git Bash / WSL:  scp /c/Users/hatch/projects/frog/.env ${PI_USER}@${PI_IP}:${FROG_DIR}/.env"
echo "     PowerShell:      scp C:\Users\hatch\projects\frog\.env ${PI_USER}@${PI_IP}:${FROG_DIR}/.env"
echo "     Then verify:     head -3 ${FROG_DIR}/.env"
echo "     (No scp? Edit manually:  nano ${FROG_DIR}/.env)"
echo ""

# A reboot is always needed: camera overlay, touchscreen overlay, group changes
echo "  2. REBOOT REQUIRED:  sudo reboot"
echo "     (needed for camera + touchscreen + I2C + group membership)"
echo "  3. After reboot:     sudo systemctl start frog-server frog-voice"
echo "  NOTE: If touchscreen is blank after reboot, try editing $CONFIG"
echo "        and changing 'rotate=90' to 0, 180, or 270."

echo ""
echo "  Screen UI:   http://$(hostname -I | awk '{print $1}'):3000/screen.html"
echo "  Debug logs:  http://$(hostname -I | awk '{print $1}'):3000/debug.html"
echo "  Settings:    http://$(hostname -I | awk '{print $1}'):3000/settings.html"
echo ""
echo "  Service logs:"
echo "    sudo journalctl -u frog-server -f"
echo "    sudo journalctl -u frog-voice -f"
echo ""
