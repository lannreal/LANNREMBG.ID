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

# Symlink python3 → python
RUN ln -s /usr/bin/python3 /usr/bin/python

# Install rembg + onnxruntime (CPU)
RUN pip3 install --break-system-packages rembg onnxruntime

# Pre-download model u2netp (~4MB) saat build agar tidak download saat runtime
RUN python3 -c "from rembg import new_session; new_session('u2netp')" || true

# Set working directory
WORKDIR /app

# Copy package.json dulu (cache layer)
COPY package.json ./
RUN npm install --production

# Copy semua file project
COPY . .

# Buat folder yang diperlukan
RUN mkdir -p uploads outputs data

# Expose port (Railway akan set PORT otomatis)
EXPOSE 3000

# Jalankan server
CMD ["node", "server.js"]