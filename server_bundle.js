// server_bundle.js
import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import { S3Client, PutObjectCommand, GetObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, GetObjectCommand as S3GetObject } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import { z } from 'zod';
import archiver from 'archiver'; // <-- AÑADIR EN package.json: "archiver": "^6.0.2"

/**
 * Mixtli Transfer Backend — v3.1
 * - Igual que v3.0 (multipart + single PUT)
 * - NUEVO: /api/bundle (stream ZIP) a partir de un manifiesto JSON en el bucket
 *   Manifiesto JSON (application/json) estructura:
 *   {
 *     "name": "combo-123.zip",  // opcional (default combo.zip)
 *     "items": [
 *        { "key": "uploads/.../file1.ext", "name": "fotito.png" }, // 'name' opcional
 *        { "key": "uploads/.../file2.ext" }
 *     ]
 *   }
 */

const app = express();
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
function bytesFromEnv(name, fallback) { return parseSize(process.env[name], fallback); }
function jsonFromEnv(name, fallback) { try { return JSON.parse(process.env[name] || ''); } catch { return fallback; } }

// ---------- CORS (manual) ----------
const ALLOWED = (() => { try { return JSON.parse(process.env.ALLOWED_ORIGINS || '[]'); } catch { return []; } })();
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-mixtli-token, x-mixtli-plan');
}
app.use((req, res, next) => { applyCors(req, res); if (req.method === 'OPTIONS') return res.status(204).end(); next(); });

// ---------- S3 / R2 ----------
const s3 = new S3Client({
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || 'true') === 'true',
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
});
const BUCKET = process.env.S3_BUCKET;
const URL_TTL_SECONDS = parseInt(process.env.URL_TTL_SECONDS || String(5 * 24 * 60 * 60), 10);

// ---------- Planes ----------
const PLAN_LIMITS = (() => {
  const json = jsonFromEnv('PLAN_LIMITS_JSON', null);
  if (json && typeof json === 'object') {
    return { free: parseSize(json.free, 4*1024**3), pro: parseSize(json.pro, 200*1024**3), promax: parseSize(json.promax, 300*1024**3) };
  }
  return {
    free:   bytesFromEnv('FREE_MAX_FILE_BYTES',   4   * 1024**3),
    pro:    bytesFromEnv('PRO_MAX_FILE_BYTES',    200 * 1024**3),
    promax: bytesFromEnv('PROMAX_MAX_FILE_BYTES', 300 * 1024**3),
  };
})();
const ENABLE_PLAN_HEADER = String(process.env.ENABLE_PLAN_HEADER || 'true') === 'true';
const DEFAULT_PLAN = String(process.env.DEFAULT_PLAN || 'free').toLowerCase();
function getPlanFromReq(req) { if (!ENABLE_PLAN_HEADER) return DEFAULT_PLAN; const p = String(req.headers['x-mixtli-plan'] || req.query.plan || DEFAULT_PLAN).toLowerCase(); return ['free','pro','promax'].includes(p) ? p : DEFAULT_PLAN; }
function getPlanLimit(req) { const plan = getPlanFromReq(req); return PLAN_LIMITS[plan] ?? PLAN_LIMITS.free; }

// ---------- Misc ----------
function safeKeyFrom(filename) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth()+1).padStart(2,'0');
  const dd = String(now.getUTCDate()).padStart(2,'0');
  const uuid = crypto.randomUUID();
  const clean = (filename || 'file').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-120) || 'file';
  return `uploads/${yyyy}/${mm}/${dd}/${uuid}-${clean}`;
}

// ---------- Schemas ----------
const PresignSchema = z.object({
  filename: z.string().min(1),
  size: z.number().int().positive().max(400 * 1024 * 1024 * 1024),
  contentType: z.string().min(1),
});

const BundleQuery = z.object({ m: z.string().min(1) }); // manifest key

// ---------- Rutas ya existentes (health, presign, sign-get, multipart...) ----------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), limits: { free: PLAN_LIMITS.free, pro: PLAN_LIMITS.pro, promax: PLAN_LIMITS.promax, ttlSeconds: URL_TTL_SECONDS }, defaultPlan: DEFAULT_PLAN });
});

app.post('/api/presign', async (req, res) => {
  try {
    const parsed = PresignSchema.parse(req.body || {});
    const limit = getPlanLimit(req);
    if (parsed.size > limit) {
      return res.status(400).json({ error: `Archivo excede el límite del plan (${limit} bytes).`, limitBytes: limit });
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

// ---------- Bundle ZIP (stream) ----------
app.get('/api/bundle', async (req, res) => {
  try {
    const { m } = BundleQuery.parse({ m: req.query.m });
    // Leer manifiesto directamente de S3
    const mObj = await s3.send(new S3GetObject({ Bucket: BUCKET, Key: m }));
    const manifestStr = await mObj.Body.transformToString();
    const manifest = JSON.parse(manifestStr);
    const name = (manifest && manifest.name) ? String(manifest.name) : 'combo.zip';
    const items = Array.isArray(manifest.items) ? manifest.items : [];

    if (items.length === 0) {
      return res.status(400).json({ error: 'Manifiesto vacío' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^a-zA-Z0-9._-]+/g,'-')}"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('warning', err => { console.warn('archiver warning', err); });
    archive.on('error', err => { throw err; });
    archive.pipe(res);

    for (const it of items) {
      const key = String(it.key);
      const filename = (it.name ? String(it.name) : key.split('/').pop()) || 'file';
      // Obtener stream del objeto (evita bajarlo a disco)
      const obj = await s3.send(new S3GetObject({ Bucket: BUCKET, Key: key }));
      archive.append(obj.Body, { name: filename });
    }

    archive.finalize();
  } catch (err) {
    console.error('bundle error', err);
    if (!res.headersSent) res.status(400).json({ error: String(err) });
  }
});

app.get('/', (_req, res) => res.type('text/plain').send('Mixtli Transfer Backend v3.1 (bundle) OK'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Mixtli Transfer backend listening on :${PORT}`));
