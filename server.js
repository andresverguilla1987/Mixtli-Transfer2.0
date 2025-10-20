// server.js
import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import { z } from 'zod';

/**
 * Mixtli Transfer Backend (Render-ready)
 * - CORS estricto por ALLOWED_ORIGINS (JSON array con https://... exacto).
 * - Límites por plan vía PLAN_LIMITS_JSON o FREE_/PRO_/PROMAX_.
 * - Header opcional x-mixtli-plan (ENABLE_PLAN_HEADER).
 * - Firmas S3/R2 con URL_TTL_SECONDS.
 */

const app = express();

// ---------- CORS (manual, sin paquete) ----------
const ALLOWED = (() => {
  try { return JSON.parse(process.env.ALLOWED_ORIGINS || '[]'); } catch { return []; }
})();

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-mixtli-token, x-mixtli-plan');
}

app.use((req, res, next) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end(); // preflight rápido
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(morgan('tiny'));

// ---------- Helpers ----------
function parseSize(input, fallback) {
  if (!input) return fallback;
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  const s = String(input).trim().toUpperCase();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/i);
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) ? n : fallback;
  }
  const val = parseFloat(m[1]);
  const unit = (m[2] || 'B').toUpperCase();
  const mult = { B:1, KB:1024, MB:1024**2, GB:1024**3, TB:1024**4 }[unit] || 1;
  return Math.floor(val * mult);
}

function bytesFromEnv(name, fallback) {
  return parseSize(process.env[name], fallback);
}

function jsonFromEnv(name, fallback) {
  try { return JSON.parse(process.env[name] || ''); } catch { return fallback; }
}

// ---------- S3 / R2 ----------
const S3_REGION = process.env.S3_REGION || 'auto';
const S3_ENDPOINT = process.env.S3_ENDPOINT;
const S3_FORCE_PATH_STYLE = String(process.env.S3_FORCE_PATH_STYLE || 'true') === 'true';
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID;
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY;
const BUCKET = process.env.S3_BUCKET;

if (!S3_ENDPOINT || !BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
  console.warn('[BOOT] Faltan variables S3/R2. Revisa S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY.');
}

const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  forcePathStyle: S3_FORCE_PATH_STYLE,
  credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
});

// ---------- Config de presign y planes ----------
const URL_TTL_SECONDS = parseInt(process.env.URL_TTL_SECONDS || String(5 * 24 * 60 * 60), 10); // 5 días

// Option A: PLAN_LIMITS_JSON='{"free":"4GB","pro":"200GB","promax":"300GB"}'
// Option B: FREE_MAX_FILE_BYTES / PRO_MAX_FILE_BYTES / PROMAX_MAX_FILE_BYTES
const PLAN_LIMITS = (() => {
  const json = jsonFromEnv('PLAN_LIMITS_JSON', null);
  if (json && typeof json === 'object') {
    return {
      free:   parseSize(json.free,   4   * 1024**3),
      pro:    parseSize(json.pro,    200 * 1024**3),
      promax: parseSize(json.promax, 300 * 1024**3),
    };
  }
  return {
    free:   bytesFromEnv('FREE_MAX_FILE_BYTES',   4   * 1024**3),
    pro:    bytesFromEnv('PRO_MAX_FILE_BYTES',    200 * 1024**3),
    promax: bytesFromEnv('PROMAX_MAX_FILE_BYTES', 300 * 1024**3),
  };
})();

const ENABLE_PLAN_HEADER = String(process.env.ENABLE_PLAN_HEADER || 'true') === 'true';
const DEFAULT_PLAN = String(process.env.DEFAULT_PLAN || 'free').toLowerCase();

function getPlanFromReq(req) {
  if (!ENABLE_PLAN_HEADER) return DEFAULT_PLAN;
  const p = String(req.headers['x-mixtli-plan'] || req.query.plan || DEFAULT_PLAN).toLowerCase();
  return ['free','pro','promax'].includes(p) ? p : DEFAULT_PLAN;
}

function getPlanLimit(req) {
  const plan = getPlanFromReq(req);
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
}

// ---------- Utils ----------
function safeKeyFrom(filename) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth()+1).padStart(2,'0');
  const dd = String(now.getUTCDate()).padStart(2,'0');
  const uuid = crypto.randomUUID();
  const clean = (filename || 'file').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-120) || 'file';
  return `uploads/${yyyy}/${mm}/${dd}/${uuid}-${clean}`;
}

// Acepta request hasta 400 GB para validar en backend
const PresignSchema = z.object({
  filename: z.string().min(1),
  size: z.number().int().positive().max(400 * 1024 * 1024 * 1024),
  contentType: z.string().min(1),
});

// ---------- Rutas ----------
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    limits: {
      free: PLAN_LIMITS.free,
      pro: PLAN_LIMITS.pro,
      promax: PLAN_LIMITS.promax,
      ttlSeconds: URL_TTL_SECONDS,
      headerEnabled: ENABLE_PLAN_HEADER,
      defaultPlan: DEFAULT_PLAN,
    },
  });
});

app.get('/api/diag', (req, res) => {
  res.json({
    origin: req.headers.origin || null,
    allowed: ALLOWED,
    method: req.method,
    path: req.path,
  });
});

app.post('/api/presign', async (req, res) => {
  try {
    const parsed = PresignSchema.parse(req.body || {});
    const limit = getPlanLimit(req);
    if (parsed.size > limit) {
      return res.status(400).json({
        error: `Archivo excede el límite del plan (${limit} bytes).`,
        limitBytes: limit,
      });
    }
    if (!BUCKET) {
      return res.status(500).json({ error: 'Config error: S3_BUCKET no definido' });
    }

    const key = safeKeyFrom(parsed.filename);
    const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: parsed.contentType });
    const putUrl = await getSignedUrl(s3, cmd, { expiresIn: URL_TTL_SECONDS });

    res.json({ key, putUrl, expiresIn: URL_TTL_SECONDS });
  } catch (err) {
    console.error('presign error', err);
    res.status(400).json({ error: String(err?.message || err) });
  }
});

app.get('/api/sign-get', async (req, res) => {
  try {
    const key = String(req.query.key || '');
    if (!key) return res.status(400).json({ error: 'Missing key' });
    if (!BUCKET) return res.status(500).json({ error: 'Config error: S3_BUCKET no definido' });

    const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const getUrl = await getSignedUrl(s3, cmd, { expiresIn: URL_TTL_SECONDS });
    res.json({ key, getUrl, expiresIn: URL_TTL_SECONDS });
  } catch (err) {
    console.error('sign-get error', err);
    res.status(400).json({ error: String(err?.message || err) });
  }
});

app.get('/', (_req, res) => res.type('text/plain').send('Mixtli Transfer Backend OK'));

// ---------- Listen ----------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Mixtli Transfer backend listening on :${PORT}`));
