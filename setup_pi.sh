#!/bin/bash
# PiAI Setup Script — run once on a fresh Raspberry Pi 4
# Usage: curl -sSL <url> | bash
#    or: bash setup_pi.sh

set -e

PIAI_DIR="$HOME/piai"
REPO_URL="https://github.com/your-username/piai"  # TODO: update when repo is pushed

echo "========================================"
echo "  PiAI Setup"
echo "========================================"

# ── System packages ──────────────────────────────────────────────────────────
echo "[1/7] Installing system dependencies..."
sudo apt-get update -qq
sudo apt-get install -y \
    python3 python3-pip python3-venv \
    nodejs npm \
    portaudio19-dev \
    libsndfile1 \
    espeak \
    git \
    ffmpeg

# ── Node.js (ensure v18+) ─────────────────────────────────────────────────────
echo "[2/7] Checking Node.js version..."
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo "    Upgrading Node.js to v20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi
echo "    Node.js $(node --version) ✓"

# ── Clone / update repo ───────────────────────────────────────────────────────
echo "[3/7] Setting up project directory..."
if [ -d "$PIAI_DIR/.git" ]; then
    echo "    Pulling latest changes..."
    git -C "$PIAI_DIR" pull
else
    echo "    Cloning repo to $PIAI_DIR..."
    git clone "$REPO_URL" "$PIAI_DIR"
fi

cd "$PIAI_DIR"

# ── Node dependencies ─────────────────────────────────────────────────────────
echo "[4/7] Installing Node.js dependencies..."
npm install --omit=dev

# ── Python virtualenv ─────────────────────────────────────────────────────────
echo "[5/7] Setting up Python environment..."
python3 -m venv voice/venv
source voice/venv/bin/activate

pip install --upgrade pip -q
pip install -r voice/requirements.txt

# Kokoro needs extra steps on Pi (ARM)
echo "    Installing Kokoro TTS..."
pip install kokoro -q || {
    echo "    Kokoro pip install failed, trying with --extra-index-url..."
    pip install kokoro --extra-index-url https://download.pytorch.org/whl/cpu -q
}

echo "    Downloading Whisper base.en model..."
python3 -c "from faster_whisper import WhisperModel; WhisperModel('base.en', device='cpu', compute_type='int8')" && echo "    Whisper ready ✓"

deactivate

# ── .env file ─────────────────────────────────────────────────────────────────
echo "[6/7] Configuring environment..."
if [ ! -f "$PIAI_DIR/.env" ]; then
    cat > "$PIAI_DIR/.env" << 'EOF'
# Fill in your API keys
ANTHROPIC_API_KEY=
OPENWEATHER_API_KEY=
NEWS_API_KEY=
PORT=3000
ENCRYPTION_KEY=
EOF
    echo ""
    echo "  *** Created .env — EDIT IT before starting: nano $PIAI_DIR/.env ***"
    echo ""
else
    echo "    .env already exists, skipping."
fi

# ── Systemd services ──────────────────────────────────────────────────────────
echo "[7/7] Installing systemd services..."

# Server service
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

# Voice loop service
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
echo "    Services installed and enabled on boot."

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "========================================"
echo "  PiAI Setup Complete!"
echo "========================================"
echo ""
echo "  Next steps:"
echo "  1. Edit .env:  nano $PIAI_DIR/.env"
echo "  2. Start:      sudo systemctl start piai-server piai-voice"
echo "  3. Status:     sudo systemctl status piai-server piai-voice"
echo "  4. Screen UI:  http://$(hostname -I | awk '{print $1}'):3000/screen.html"
echo ""
echo "  Logs:"
echo "    sudo journalctl -u piai-server -f"
echo "    sudo journalctl -u piai-voice -f"
echo ""
