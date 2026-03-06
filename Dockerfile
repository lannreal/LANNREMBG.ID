# ── Base: Node.js + Python dalam satu image ──────────────────────
FROM node:20-slim

# Install Python + pip + dependencies untuk rembg
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-dev \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    && rm -rf /var/lib/apt/lists/*

# Install rembg + onnxruntime
RUN pip3 install --break-system-packages rembg onnxruntime

# Pre-download model u2netp saat build agar tidak download saat runtime
RUN python3 -c "from rembg import new_session; new_session('u2netp'); print('Model u2netp ready')" || \
    echo "Model will be downloaded on first request"

# Set working directory
WORKDIR /app

# Copy package.json dulu (cache layer)
COPY package.json ./
RUN npm install --production

# Copy semua file project
COPY . .

# Buat folder yang diperlukan
RUN mkdir -p uploads outputs data

# Verify python3 + rembg works
RUN python3 -c "import rembg; print('rembg OK')"

# Expose port (Railway akan set PORT otomatis)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"

# Jalankan server
CMD ["node", "server.js"]