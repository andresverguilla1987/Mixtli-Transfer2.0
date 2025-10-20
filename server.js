import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import { z } from 'zod';

/**
 * Mixtli Transfer Backend (Drop-in for Render)
 * - All behavior controlled via ENV (no code edits after this)
 * - Per-plan max size via PLAN_LIMITS_JSON or FREE_/PRO_/PROMAX_ envs
 * - Optional 'x-mixtli-plan' header (enable/disable via ENABLE_PLAN_HEADER)
 * - TTL via URL_TTL_SECONDS
 * - CORS via ALLOWED_ORIGINS (JSON array)
 */

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(morgan('tiny'));

// ---------- Helpers ----------
function parseSize(input, fallback) {
  if (!input) return fallback;
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  const s = String(input).trim().toUpperCase();
  // Accept bytes or human like "4GB", "200 GB", "1024MB"
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

// ---------- CORS ----------
const allowed = (() => {
  try { return JSON.parse(process.env.ALLOWED_ORIGINS || '[]'); } catch { return []; }
})();

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // allow SSR/curl
    if (allowed.includes(origin)) return cb(null, true);
    return cb(new Error('CORS: Origin not allowed'));
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','x-mixtli-token','x-mixtli-plan'],
  credentials: false,
  maxAge: 86400,
}));

// ---------- S3 / R2 ----------
const s3 = new S3Client({
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || 'true') === 'true',
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
});

const BUCKET = process.env.S3_BUCKET;
const URL_TTL_SECONDS = parseInt(process.env.URL_TTL_SECONDS || String(5 * 24 * 60 * 60), 10); // default 5d

// ---------- Plan limits from ENV ----------
// Option A: single JSON var
//   PLAN_LIMITS_JSON='{"free":"4GB","pro":"200GB","promax":"300GB"}'
// Option B: individual envs (used as fallback if JSON not set)
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

// ---------- Misc helpers ----------
function safeKeyFrom(filename) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth()+1).padStart(2,'0');
  const dd = String(now.getUTCDate()).padStart(2,'0');
  const uuid = crypto.randomUUID();
  const clean = (filename || 'file').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-120) || 'file';
  return `uploads/${yyyy}/${mm}/${dd}/${uuid}-${clean}`;
}

// Accept request up to 400 GB for validation purposes
const PresignSchema = z.object({
  filename: z.string().min(1),
  size: z.number().int().positive().max(400 * 1024 * 1024 * 1024),
  contentType: z.string().min(1),
});

// ---------- Routes ----------
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
    }
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
    const key = safeKeyFrom(parsed.filename);
    const putCmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: parsed.contentType });
    const putUrl = await getSignedUrl(s3, putCmd, { expiresIn: URL_TTL_SECONDS });
    res.json({ key, putUrl, expiresIn: URL_TTL_SECONDS });
  } catch (err) {
    console.error('presign error', err);
    res.status(400).json({ error: String(err) });
  }
});

app.get('/api/sign-get', async (req, res) => {
  try {
    const key = String(req.query.key || '');
    if (!key) return res.status(400).json({ error: 'Missing key' });
    const getCmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const getUrl = await getSignedUrl(s3, getCmd, { expiresIn: URL_TTL_SECONDS });
    res.json({ key, getUrl, expiresIn: URL_TTL_SECONDS });
  } catch (err) {
    console.error('sign-get error', err);
    res.status(400).json({ error: String(err) });
  }
});

app.get('/', (_req, res) => res.type('text/plain').send('Mixtli Transfer Backend OK'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Mixtli Transfer backend listening on :${PORT}`));
