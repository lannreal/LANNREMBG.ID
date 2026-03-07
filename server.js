/**
 * LANNREMBG.ID — Backend Server v2
 * Node.js + Express + MongoDB + rembg
 *
 * REQUIREMENTS:
 *   npm install express multer cors uuid bcryptjs jsonwebtoken mongoose
 *   pip install rembg onnxruntime
 *
 * ENV VARS:
 *   MONGODB_URI  = mongodb+srv://user:pass@cluster.mongodb.net/lannrembg
 *   JWT_SECRET   = your_secret
 *   PORT         = 3000
 *   ADMIN_KEY    = admin_secret_key (untuk akses dashboard)
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
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'lannrembg_secret_2024';
const ADMIN_KEY = process.env.ADMIN_KEY || 'lannrembg_admin_2024';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/lannrembg';

// ─── Directories ─────────────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');
[UPLOAD_DIR, OUTPUT_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ═══════════════════════════════════════════════════════════════════════════════
// MONGODB SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

// ── plans ─────────────────────────────────────────────────────────────────────
const planSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true }, // 'free' | 'pro'
    label: String,
    price: { type: Number, default: 0 },     // Rp per bulan
    dailyLimit: { type: Number, default: 100 },
    models: { type: [String], default: ['u2netp'] },
    maxFileMB: { type: Number, default: 5 },
    features: [String],
    isActive: { type: Boolean, default: true }
}, { timestamps: true });

// ── users ─────────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    passwordHash: { type: String, required: true },
    plan: { type: String, default: 'free' },  // ref ke plans.name
    isActive: { type: Boolean, default: true },
    lastLoginAt: Date,
    totalRequests: { type: Number, default: 0 }
}, { timestamps: true });

// ── api_keys ──────────────────────────────────────────────────────────────────
const apiKeySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    key: { type: String, required: true, unique: true },
    label: { type: String, default: 'Default' },
    isActive: { type: Boolean, default: true },
    lastUsedAt: Date,
    totalUsage: { type: Number, default: 0 }
}, { timestamps: true });

// ── usage ─────────────────────────────────────────────────────────────────────
const usageSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    apiKeyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ApiKey' },
    date: { type: String, required: true }, // "YYYY-MM-DD"
    count: { type: Number, default: 0 }
}, { timestamps: true });
usageSchema.index({ userId: 1, date: 1 }, { unique: true });

// ── request_logs ──────────────────────────────────────────────────────────────
const requestLogSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    apiKeyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ApiKey' },
    model: { type: String, default: 'u2netp' },
    fileSize: Number,   // bytes
    duration: Number,   // ms
    status: { type: Number, default: 200 },  // HTTP status
    error: String,
    ip: String,
    source: { type: String, default: 'web' }  // 'web' | 'api'
}, { timestamps: true });

const Plan = mongoose.model('Plan', planSchema);
const User = mongoose.model('User', userSchema);
const ApiKey = mongoose.model('ApiKey', apiKeySchema);
const Usage = mongoose.model('Usage', usageSchema);
const RequestLog = mongoose.model('RequestLog', requestLogSchema);

// ═══════════════════════════════════════════════════════════════════════════════
// MONGODB CONNECT + SEED PLANS
// ═══════════════════════════════════════════════════════════════════════════════
async function connectDB() {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('[db] MongoDB connected');

        // Seed default plans jika belum ada
        const count = await Plan.countDocuments();
        if (count === 0) {
            await Plan.insertMany([
                {
                    name: 'free', label: 'Gratis', price: 0,
                    dailyLimit: 100, models: ['u2netp'], maxFileMB: 5,
                    features: ['100 request/hari', 'Model Cepat (u2netp)', 'Maks 5MB/file']
                },
                {
                    name: 'pro', label: 'Pro', price: 49000,
                    dailyLimit: 500, models: ['u2netp', 'u2net'], maxFileMB: 15,
                    features: ['500 request/hari', 'Model HQ (u2net)', 'Maks 15MB/file', 'Priority queue']
                }
            ]);
            console.log('[db] Default plans seeded');
        }
    } catch (err) {
        console.error('[db] Connect error:', err.message);
        console.log('[db] Falling back to in-memory mode...');
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
function getDayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function getPlanConfig(planName) {
    const plan = await Plan.findOne({ name: planName || 'free' });
    return plan || { dailyLimit: 100, models: ['u2netp'], maxFileMB: 5 };
}

async function getUsageToday(userId) {
    const rec = await Usage.findOne({ userId, date: getDayKey() });
    return rec ? rec.count : 0;
}

async function incrementUsage(userId, apiKeyId) {
    const date = getDayKey();
    await Usage.findOneAndUpdate(
        { userId, date },
        { $inc: { count: 1 }, $setOnInsert: { apiKeyId } },
        { upsert: true }
    );
    await User.findByIdAndUpdate(userId, { $inc: { totalRequests: 1 } });
    if (apiKeyId) await ApiKey.findByIdAndUpdate(apiKeyId, {
        $inc: { totalUsage: 1 }, lastUsedAt: new Date()
    });
}

async function logRequest(data) {
    try { await RequestLog.create(data); }
    catch (e) { console.error('[log]', e.message); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════════
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use('/outputs', express.static(OUTPUT_DIR));

// JWT auth
function authMiddleware(req, res, next) {
    const token = (req.headers['authorization'] || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ success: false, error: 'Token tidak ada.' });
    try {
        req.userId = jwt.verify(token, JWT_SECRET).id;
        next();
    } catch {
        res.status(401).json({ success: false, error: 'Token tidak valid.' });
    }
}

// Admin key
function adminMiddleware(req, res, next) {
    const key = req.headers['x-admin-key'] || req.query.adminKey;
    if (key !== ADMIN_KEY) return res.status(403).json({ success: false, error: 'Admin akses ditolak.' });
    next();
}

// API key middleware
async function apiKeyMiddleware(req, res, next) {
    const rawKey = req.headers['x-api-key'];
    if (!rawKey) { req.apiUser = null; req.apiKeyDoc = null; return next(); }

    const keyDoc = await ApiKey.findOne({ key: rawKey, isActive: true });
    if (!keyDoc) return res.status(401).json({ success: false, error: 'API key tidak valid.' });

    const user = await User.findById(keyDoc.userId);
    if (!user || !user.isActive) return res.status(401).json({ success: false, error: 'Akun tidak aktif.' });

    const plan = await getPlanConfig(user.plan);
    const used = await getUsageToday(user._id);
    if (used >= plan.dailyLimit) {
        return res.status(429).json({
            success: false,
            error: `Limit ${plan.dailyLimit} request/hari tercapai.`,
            used, limit: plan.dailyLimit
        });
    }

    req.apiUser = user;
    req.apiKeyDoc = keyDoc;
    req.userPlan = plan;
    next();
}

// ─── Multer ───────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname) || '.png'}`)
});
const fileFilter = (req, file, cb) => {
    ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.mimetype)
        ? cb(null, true) : cb(new Error('Format tidak didukung. Gunakan JPG, PNG, atau WEBP.'), false);
};
const upload = multer({ storage, fileFilter, limits: { fileSize: 15 * 1024 * 1024 } });

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Register
app.post('/api/auth/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
        return res.status(400).json({ success: false, error: 'Semua field wajib diisi.' });
    if (password.length < 6)
        return res.status(400).json({ success: false, error: 'Password minimal 6 karakter.' });

    try {
        if (await User.findOne({ email: email.toLowerCase() }))
            return res.status(400).json({ success: false, error: 'Email sudah terdaftar.' });

        const user = await User.create({
            name: name.trim(), email: email.toLowerCase().trim(),
            passwordHash: await bcrypt.hash(password, 10),
            plan: 'free'
        });

        const apiKey = await ApiKey.create({
            userId: user._id,
            key: 'lannrembg_' + uuidv4().replace(/-/g, ''),
            label: 'Default'
        });

        const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ success: true, token, user: sanitize(user), apiKey: apiKey.key });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const user = await User.findOne({ email: req.body.email?.toLowerCase() });
        if (!user || !(await bcrypt.compare(req.body.password, user.passwordHash)))
            return res.status(400).json({ success: false, error: 'Email atau password salah.' });

        await User.findByIdAndUpdate(user._id, { lastLoginAt: new Date() });
        const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ success: true, token, user: sanitize(user) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Me + Dashboard Data
app.get('/api/auth/me', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ success: false, error: 'User tidak ditemukan.' });

        const plan = await getPlanConfig(user.plan);
        const apiKey = await ApiKey.findOne({ userId: user._id, isActive: true });
        const today = await getUsageToday(user._id);

        // History: last 20 request logs
        const history = await RequestLog.find({ userId: user._id })
            .sort({ createdAt: -1 }).limit(20).lean();

        res.json({
            success: true,
            user: sanitize(user),
            apiKey: apiKey ? { key: apiKey.key, createdAt: apiKey.createdAt, totalUsage: apiKey.totalUsage } : null,
            usage: { today, total: user.totalRequests, limit: plan.dailyLimit },
            plan: { name: plan.name, label: plan.label, dailyLimit: plan.dailyLimit, models: plan.models },
            history
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Regen API Key
app.post('/api/auth/regen-key', authMiddleware, async (req, res) => {
    try {
        const key = 'lannrembg_' + uuidv4().replace(/-/g, '');
        await ApiKey.updateMany({ userId: req.userId }, { isActive: false });
        const newKey = await ApiKey.create({ userId: req.userId, key, label: 'Default' });
        res.json({ success: true, apiKey: newKey.key, createdAt: newKey.createdAt });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Delete Account
app.delete('/api/auth/delete', authMiddleware, async (req, res) => {
    try {
        await Promise.all([
            User.findByIdAndDelete(req.userId),
            ApiKey.deleteMany({ userId: req.userId }),
            Usage.deleteMany({ userId: req.userId }),
            RequestLog.deleteMany({ userId: req.userId })
        ]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

function sanitize(user) {
    const u = user.toObject ? user.toObject() : { ...user };
    delete u.passwordHash;
    return u;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Dashboard overview
app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
    try {
        const today = getDayKey();
        const [
            totalUsers, totalKeys, usageToday, totalReqs,
            recentLogs, requestsLast7, userGrowth
        ] = await Promise.all([
            User.countDocuments(),
            ApiKey.countDocuments({ isActive: true }),
            Usage.aggregate([{ $match: { date: today } }, { $group: { _id: null, total: { $sum: '$count' } } }]),
            RequestLog.countDocuments(),
            RequestLog.find().sort({ createdAt: -1 }).limit(50)
                .populate('userId', 'name email plan').lean(),
            // Requests per hari 7 hari terakhir
            RequestLog.aggregate([
                { $match: { createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } },
                {
                    $group: {
                        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                        count: { $sum: 1 },
                        errors: { $sum: { $cond: [{ $gte: ['$status', 400] }, 1, 0] } }
                    }
                },
                { $sort: { _id: 1 } }
            ]),
            // User registrasi per hari 7 hari terakhir
            User.aggregate([
                { $match: { createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } },
                {
                    $group: {
                        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { _id: 1 } }
            ])
        ]);

        const avgDuration = await RequestLog.aggregate([
            { $match: { status: 200, duration: { $exists: true } } },
            { $group: { _id: null, avg: { $avg: '$duration' } } }
        ]);

        const planDist = await User.aggregate([
            { $group: { _id: '$plan', count: { $sum: 1 } } }
        ]);

        res.json({
            success: true,
            stats: {
                totalUsers,
                totalApiKeys: totalKeys,
                requestsToday: usageToday[0]?.total || 0,
                totalRequests: totalReqs,
                avgDuration: Math.round(avgDuration[0]?.avg || 0),
                planDistribution: planDist
            },
            requestsLast7,
            userGrowth,
            recentLogs
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// All users
app.get('/api/admin/users', adminMiddleware, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const search = req.query.search || '';

        const query = search
            ? { $or: [{ name: new RegExp(search, 'i') }, { email: new RegExp(search, 'i') }] }
            : {};

        const [users, total] = await Promise.all([
            User.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
            User.countDocuments(query)
        ]);

        // Attach API key per user
        const userIds = users.map(u => u._id);
        const keys = await ApiKey.find({ userId: { $in: userIds }, isActive: true }).lean();
        const keyMap = {};
        keys.forEach(k => keyMap[k.userId.toString()] = k);

        const result = users.map(u => ({
            ...u,
            passwordHash: undefined,
            apiKey: keyMap[u._id.toString()]?.key || null,
            apiKeyUsage: keyMap[u._id.toString()]?.totalUsage || 0
        }));

        res.json({ success: true, users: result, total, page, pages: Math.ceil(total / limit) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Change user plan
app.patch('/api/admin/users/:id/plan', adminMiddleware, async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.params.id, { plan: req.body.plan });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Toggle user active
app.patch('/api/admin/users/:id/toggle', adminMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        await User.findByIdAndUpdate(req.params.id, { isActive: !user.isActive });
        res.json({ success: true, isActive: !user.isActive });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Request logs
app.get('/api/admin/logs', adminMiddleware, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const filter = {};
        if (req.query.status) filter.status = parseInt(req.query.status);
        if (req.query.model) filter.model = req.query.model;
        if (req.query.source) filter.source = req.query.source;

        const [logs, total] = await Promise.all([
            RequestLog.find(filter)
                .populate('userId', 'name email plan')
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit).limit(limit).lean(),
            RequestLog.countDocuments(filter)
        ]);

        res.json({ success: true, logs, total, page, pages: Math.ceil(total / limit) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Plans CRUD
app.get('/api/admin/plans', adminMiddleware, async (req, res) => {
    const plans = await Plan.find().lean();
    res.json({ success: true, plans });
});

app.patch('/api/admin/plans/:name', adminMiddleware, async (req, res) => {
    try {
        await Plan.findOneAndUpdate({ name: req.params.name }, req.body);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Rate limit stats per user
app.get('/api/admin/rate-limits', adminMiddleware, async (req, res) => {
    try {
        const today = getDayKey();
        const usage = await Usage.find({ date: today })
            .populate('userId', 'name email plan').lean();

        const result = await Promise.all(usage.map(async u => {
            const plan = await getPlanConfig(u.userId?.plan);
            return {
                user: u.userId?.name, email: u.userId?.email,
                plan: u.userId?.plan, used: u.count,
                limit: plan?.dailyLimit || 100,
                pct: Math.round((u.count / (plan?.dailyLimit || 100)) * 100)
            };
        }));

        res.json({ success: true, rateLimits: result.sort((a, b) => b.pct - a.pct) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENDPOINT: REMOVE BACKGROUND
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/remove-bg', apiKeyMiddleware, upload.single('image'), async (req, res) => {
    if (!req.file)
        return res.status(400).json({ success: false, error: 'Tidak ada file gambar.' });

    const allowedModels = ['u2net', 'u2netp'];
    const model = allowedModels.includes(req.body.model) ? req.body.model : 'u2netp';

    // u2net hanya untuk API key Pro — web langsung bebas
    const isApiKeyFree = req.apiUser && req.userPlan?.name !== 'pro';
    if (model === 'u2net' && isApiKeyFree) {
        fs.unlink(req.file.path, () => { });
        return res.status(403).json({
            success: false,
            error: 'Model u2net hanya tersedia untuk API key Pro.',
            upgrade: true
        });
    }

    const inputPath = req.file.path;
    const outputName = `result_${uuidv4()}.png`;
    const outputPath = path.join(OUTPUT_DIR, outputName);
    const startTime = Date.now();
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const source = req.apiUser ? 'api' : 'web';

    console.log(`[rembg] ${model} | ${source} | ${req.apiUser?.email || 'guest'}`);
    res.setHeader('X-Accel-Buffering', 'no');

    const runnerPath = path.join(__dirname, 'rembg_runner.py');
    const cmd = `python3 "${runnerPath}" "${inputPath.replace(/\\/g, '/')}" "${outputPath.replace(/\\/g, '/')}" "${model}"`;

    exec(cmd, { timeout: 180000 }, async (error, stdout, stderr) => {
        fs.unlink(inputPath, () => { });
        const duration = Date.now() - startTime;
        const logBase = {
            userId: req.apiUser?._id || null,
            apiKeyId: req.apiKeyDoc?._id || null,
            model, duration, ip: clientIp, source
        };

        if (error) {
            console.error('[rembg] Error:', stderr || error.message);
            await logRequest({ ...logBase, status: 500, error: (stderr || error.message).slice(0, 200) });
            return res.status(500).json({ success: false, error: 'Proses gagal: ' + (stderr || error.message).slice(0, 200) });
        }

        if (!fs.existsSync(outputPath)) {
            await logRequest({ ...logBase, status: 500, error: 'Output file not created' });
            return res.status(500).json({ success: false, error: 'File output tidak terbuat.' });
        }

        const stats = fs.statSync(outputPath);
        await logRequest({ ...logBase, status: 200, fileSize: req.file.size });

        if (req.apiUser) {
            await incrementUsage(req.apiUser._id, req.apiKeyDoc?._id);
        }

        setTimeout(() => fs.unlink(outputPath, () => { }), 10 * 60 * 1000);

        res.json({ success: true, resultUrl: `/outputs/${outputName}`, model, size: stats.size, duration });
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', time: new Date().toISOString() });
});

app.get('/api/test-python', (req, res) => {
    exec('python3 -c "import rembg; print(\'rembg OK\')"', { timeout: 15000 }, (err, stdout, stderr) => {
        res.json(err ? { ok: false, error: stderr || err.message } : { ok: true, output: stdout.trim() });
    });
});

app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE')
        return res.status(400).json({ success: false, error: 'File terlalu besar. Maks 15 MB.' });
    console.error('[error]', err.message);
    res.status(500).json({ success: false, error: err.message });
});

// ═══════════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════════
connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`\n🚀  LANNREMBG.ID v2 → http://localhost:${PORT}`);
        console.log(`🗄️   MongoDB     → ${MONGODB_URI}`);
        console.log(`🔑  Admin Key   → ${ADMIN_KEY}\n`);
    });
});