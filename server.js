/**
 * LANNREMBG.ID — Backend Server
 * Node.js + Express + rembg + API Key System
 *
 * REQUIREMENTS:
 *   npm install express multer cors uuid bcryptjs jsonwebtoken
 *   pip install rembg onnxruntime
 *
 * USAGE:
 *   node server.js
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'lannrembg_secret_key_2024';

// ─── Free Tier Limit ─────────────────────────────────────────────────────────
const FREE_LIMIT = 100; // request per hari

// ─── Directories ─────────────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'users.json');

[UPLOAD_DIR, OUTPUT_DIR, DATA_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── Simple JSON "Database" ───────────────────────────────────────────────────
function readDB() {
    if (!fs.existsSync(DB_FILE)) return { users: [] };
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
    catch { return { users: [] }; }
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function findUser(email) { return readDB().users.find(u => u.email === email); }
function findByApiKey(key) { return readDB().users.find(u => u.apiKey === key); }
function findById(id) { return readDB().users.find(u => u.id === id); }

function saveUser(user) {
    const db = readDB();
    const idx = db.users.findIndex(u => u.id === user.id);
    if (idx >= 0) db.users[idx] = user;
    else db.users.push(user);
    writeDB(db);
}

// ─── Usage Helpers ────────────────────────────────────────────────────────────
function getDayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getUsageToday(user) {
    return (user.usage || {})[getDayKey()] || 0;
}

function incrementUsage(user) {
    const key = getDayKey();
    if (!user.usage) user.usage = {};
    user.usage[key] = (user.usage[key] || 0) + 1;
    user.totalRequests = (user.totalRequests || 0) + 1;
}

function addHistory(user, entry) {
    if (!user.history) user.history = [];
    user.history.push(entry);
    if (user.history.length > 100) user.history = user.history.slice(-100);
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use('/outputs', express.static(OUTPUT_DIR));

// ─── JWT Auth Middleware ──────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
    const header = req.headers['authorization'] || '';
    const token = header.replace('Bearer ', '');
    if (!token) return res.status(401).json({ success: false, error: 'Token tidak ada.' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userId = decoded.id;
        next();
    } catch {
        res.status(401).json({ success: false, error: 'Token tidak valid.' });
    }
}

// ─── API Key Middleware ───────────────────────────────────────────────────────
function apiKeyMiddleware(req, res, next) {
    const apiKey = req.headers['x-api-key'];

    // Jika tidak ada API key → izinkan sebagai "guest" (web UI langsung)
    if (!apiKey) { req.apiUser = null; return next(); }

    const user = findByApiKey(apiKey);
    if (!user) return res.status(401).json({ success: false, error: 'API key tidak valid.' });

    const used = getUsageToday(user);
    const limit = user.tier === 'pro' ? 500 : FREE_LIMIT; // pro: 500/hari, free: 100/hari
    if (used >= limit) {
        return res.status(429).json({
            success: false,
            error: `Limit ${limit} request/bulan tercapai. Upgrade ke Pro untuk lebih banyak request.`,
            used, limit
        });
    }

    req.apiUser = user;
    next();
}

// ─── Multer Config ────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.png';
        cb(null, `${uuidv4()}${ext}`);
    }
});

const fileFilter = (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Format tidak didukung. Gunakan JPG, PNG, atau WEBP.'), false);
};

const upload = multer({
    storage, fileFilter,
    limits: { fileSize: 15 * 1024 * 1024 }
});

// ─── Auth Routes ──────────────────────────────────────────────────────────────

// Register
app.post('/api/auth/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
        return res.status(400).json({ success: false, error: 'Semua field wajib diisi.' });
    if (password.length < 6)
        return res.status(400).json({ success: false, error: 'Password minimal 6 karakter.' });
    if (findUser(email))
        return res.status(400).json({ success: false, error: 'Email sudah terdaftar.' });

    const hash = await bcrypt.hash(password, 10);
    const apiKey = 'lannrembg_' + uuidv4().replace(/-/g, '');
    const user = {
        id: uuidv4(),
        name: name.trim(),
        email: email.toLowerCase().trim(),
        passwordHash: hash,
        apiKey,
        keyCreatedAt: new Date().toISOString(),
        tier: 'free',
        createdAt: new Date().toISOString(),
        usage: {},
        totalRequests: 0,
        history: []
    };

    saveUser(user);
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
        success: true, token,
        user: sanitizeUser(user)
    });
});

// Login
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    const user = findUser(email?.toLowerCase());
    if (!user) return res.status(400).json({ success: false, error: 'Email atau password salah.' });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(400).json({ success: false, error: 'Email atau password salah.' });

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: sanitizeUser(user) });
});

// Get Me + Dashboard Data
app.get('/api/auth/me', authMiddleware, (req, res) => {
    const user = findById(req.userId);
    if (!user) return res.status(404).json({ success: false, error: 'User tidak ditemukan.' });

    const limit = user.tier === 'pro' ? 500 : FREE_LIMIT; // pro: 500/hari, free: 100/hari
    res.json({
        success: true,
        user: sanitizeUser(user),
        usage: {
            today: getUsageToday(user),
            total: user.totalRequests || 0,
            limit
        },
        history: user.history || []
    });
});

// Regenerasi API Key
app.post('/api/auth/regen-key', authMiddleware, (req, res) => {
    const user = findById(req.userId);
    if (!user) return res.status(404).json({ success: false, error: 'User tidak ditemukan.' });

    user.apiKey = 'lannrembg_' + uuidv4().replace(/-/g, '');
    user.keyCreatedAt = new Date().toISOString();
    saveUser(user);
    res.json({ success: true, apiKey: user.apiKey, keyCreatedAt: user.keyCreatedAt });
});

// Delete Account
app.delete('/api/auth/delete', authMiddleware, (req, res) => {
    const db = readDB();
    db.users = db.users.filter(u => u.id !== req.userId);
    writeDB(db);
    res.json({ success: true });
});

// Sanitize user data (jangan kirim passwordHash)
function sanitizeUser(user) {
    const { passwordHash, ...safe } = user;
    return safe;
}

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: 'LANNREMBG.ID', time: new Date().toISOString() });
});

// ─── Debug: Test Python + rembg (buka di browser untuk cek) ───────────────────
app.get('/api/test-python', (req, res) => {
    exec('python3 -c "import rembg; print(\'rembg OK\')"', { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) {
            return res.json({ ok: false, error: stderr || err.message });
        }
        res.json({ ok: true, output: stdout.trim() });
    });
});

// ─── Remove Background Endpoint ──────────────────────────────────────────────
app.post('/api/remove-bg', apiKeyMiddleware, upload.single('image'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'Tidak ada file gambar.' });
    }

    const allowedModels = ['u2net', 'u2netp'];
    const model = allowedModels.includes(req.body.model) ? req.body.model : 'u2netp';

    // u2net hanya diblokir untuk API key FREE — web langsung bebas
    const isApiKeyFree = req.apiUser && req.apiUser.tier !== 'pro';
    if (model === 'u2net' && isApiKeyFree) {
        fs.unlink(req.file.path, () => { });
        return res.status(403).json({
            success: false,
            error: 'Model u2net hanya tersedia untuk API key Pro. Upgrade di api.html',
            upgrade: true
        });
    }

    // Cek limit API user jika ada API key
    if (req.apiUser) {
        const user = req.apiUser;
        const limit = user.tier === 'pro' ? 500 : FREE_LIMIT; // pro: 500/hari, free: 100/hari
        const used = getUsageToday(user);
        if (used >= limit) {
            fs.unlink(req.file.path, () => { });
            return res.status(429).json({ success: false, error: 'Limit request tercapai.' });
        }
    }

    const inputPath = req.file.path;
    const outputName = `result_${uuidv4()}.png`;
    const outputPath = path.join(OUTPUT_DIR, outputName);
    const startTime = Date.now();

    console.log(`[rembg] Processing: ${req.file.filename} | Model: ${model}${req.apiUser ? ' | API: ' + req.apiUser.email : ''}`);

    const runnerPath = path.join(__dirname, 'rembg_runner.py');
    const inputFixed = inputPath.replace(/\\/g, '/');
    const outputFixed = outputPath.replace(/\\/g, '/');
    const command = `python3 "${runnerPath}" "${inputFixed}" "${outputFixed}" "${model}"`;

    // Kirim header dulu agar Railway tidak timeout (keep-alive trick)
    res.setHeader('X-Accel-Buffering', 'no');

    exec(command, { timeout: 180000 }, (error, stdout, stderr) => {
        fs.unlink(inputPath, () => { });

        const duration = Date.now() - startTime;

        if (error) {
            console.error('[rembg] Error:', stderr || error.message);

            if (req.apiUser) {
                const user = findById(req.apiUser.id);
                if (user) {
                    addHistory(user, { time: new Date().toISOString(), model, success: false, duration });
                    saveUser(user);
                }
            }

            return res.status(500).json({
                success: false,
                error: 'Proses gagal: ' + (stderr || error.message).slice(0, 200)
            });
        }

        if (!fs.existsSync(outputPath)) {
            return res.status(500).json({ success: false, error: 'File output tidak terbuat.' });
        }

        const stats = fs.statSync(outputPath);
        const resultUrl = `/outputs/${outputName}`;

        console.log(`[rembg] Done: ${outputName} (${(stats.size / 1024).toFixed(1)} KB) | ${duration}ms`);

        if (req.apiUser) {
            const user = findById(req.apiUser.id);
            if (user) {
                incrementUsage(user);
                addHistory(user, {
                    time: new Date().toISOString(), model,
                    size: stats.size, duration, success: true
                });
                saveUser(user);
            }
        }

        setTimeout(() => {
            fs.unlink(outputPath, () => console.log(`[cleanup] ${outputName}`));
        }, 10 * 60 * 1000);

        res.json({
            success: true, resultUrl,
            filename: outputName, model,
            size: stats.size, duration
        });
    });
});

// ─── Error Handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE')
        return res.status(400).json({ success: false, error: 'File terlalu besar. Maks 15 MB.' });
    console.error('[error]', err.message);
    res.status(500).json({ success: false, error: err.message });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀  LANNREMBG.ID server running on http://localhost:${PORT}`);
    console.log(`📁  Uploads : ${UPLOAD_DIR}`);
    console.log(`📁  Outputs : ${OUTPUT_DIR}`);
    console.log(`🗄️   Database: ${DB_FILE}`);
    console.log(`\n  npm install bcryptjs jsonwebtoken`);
    console.log(`  pip install rembg onnxruntime\n`);

    // Startup check: pastikan python3 + rembg tersedia
    exec('python3 -c "import rembg; print(\'[startup] rembg OK\')"', { timeout: 10000 }, (err, stdout, stderr) => {
        if (err) {
            console.error('[startup] ⚠️  rembg TIDAK TERSEDIA:', stderr || err.message);
            console.error('[startup] Jalankan: pip install rembg onnxruntime');
        } else {
            console.log(stdout.trim());
        }
    });
});