// server_multipart.js
import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import { S3Client, PutObjectCommand, GetObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import { z } from 'zod';

/**
 * Mixtli Transfer Backend — v3.0 (Multipart + Single PUT)
 * - CORS manual por ALLOWED_ORIGINS (JSON exacto).
 * - Límites por plan (PLAN_LIMITS_JSON o FREE_/PRO_/PROMAX_).
 * - Header opcional x-mixtli-plan (ENABLE_PLAN_HEADER).
 * - URL_TTL_SECONDS para presign.
 * - NUEVO: /api/multipart/* para archivos >5GB o resumibles.
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

const MpCreateSchema = z.object({
  filename: z.string().min(1),
  size: z.number().int().positive().max(5 * 1024 * 1024 * 1024 * 1024), // 5TB theoretical
  contentType: z.string().min(1),
  partSize: z.number().int().positive().optional(), // bytes (frontend sugerirá 16MB)
});

const MpPartUrlSchema = z.object({
  uploadId: z.string().min(1),
  key: z.string().min(1),
  partNumber: z.number().int().positive().max(10000),
});

const MpCompleteSchema = z.object({
  uploadId: z.string().min(1),
  key: z.string().min(1),
  parts: z.array(z.object({ ETag: z.string().min(1), PartNumber: z.number().int().positive().max(10000) })).min(1),
});

const MpAbortSchema = z.object({ uploadId: z.string().min(1), key: z.string().min(1) });

// ---------- Rutas ----------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), limits: { free: PLAN_LIMITS.free, pro: PLAN_LIMITS.pro, promax: PLAN_LIMITS.promax, ttlSeconds: URL_TTL_SECONDS }, defaultPlan: DEFAULT_PLAN });
});

// Single PUT (igual que antes)
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

// ---------- Multipart ----------
const ENABLE_MULTIPART = String(process.env.ENABLE_MULTIPART || 'true') === 'true';
const DEFAULT_PART_SIZE = parseSize(process.env.MULTIPART_PART_SIZE, 16 * 1024 * 1024); // 16MB

app.post('/api/multipart/create', async (req, res) => {
  try {
    if (!ENABLE_MULTIPART) return res.status(403).json({ error: 'Multipart deshabilitado' });
    const parsed = MpCreateSchema.parse(req.body || {});
    const limit = getPlanLimit(req);
    if (parsed.size > limit) {
      return res.status(400).json({ error: `Archivo excede el límite del plan (${limit} bytes).`, limitBytes: limit });
    }
    const key = safeKeyFrom(parsed.filename);
    const create = new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key, ContentType: parsed.contentType });
    const out = await s3.send(create);
    res.json({ uploadId: out.UploadId, key, partSize: parsed.partSize || DEFAULT_PART_SIZE });
  } catch (err) {
    console.error('multipart create error', err);
    res.status(400).json({ error: String(err) });
  }
});

app.post('/api/multipart/part-url', async (req, res) => {
  try {
    if (!ENABLE_MULTIPART) return res.status(403).json({ error: 'Multipart deshabilitado' });
    const parsed = MpPartUrlSchema.parse(req.body || {});
    const cmd = new UploadPartCommand({ Bucket: BUCKET, Key: parsed.key, UploadId: parsed.uploadId, PartNumber: parsed.partNumber, Body: new Uint8Array(0) });
    // Body no viaja, solo se firma la URL; el cliente hará PUT con el chunk real.
    const url = await getSignedUrl(s3, cmd, { expiresIn: URL_TTL_SECONDS });
    res.json({ url });
  } catch (err) {
    console.error('multipart part-url error', err);
    res.status(400).json({ error: String(err) });
  }
});

app.post('/api/multipart/complete', async (req, res) => {
  try {
    if (!ENABLE_MULTIPART) return res.status(403).json({ error: 'Multipart deshabilitado' });
    const parsed = MpCompleteSchema.parse(req.body || {});
    const cmd = new CompleteMultipartUploadCommand({
      Bucket: BUCKET,
      Key: parsed.key,
      UploadId: parsed.uploadId,
      MultipartUpload: { Parts: parsed.parts.map(p => ({ ETag: p.ETag, PartNumber: p.PartNumber })) },
    });
    const out = await s3.send(cmd);
    res.json({ ok: true, key: parsed.key, location: out.Location || null });
  } catch (err) {
    console.error('multipart complete error', err);
    res.status(400).json({ error: String(err) });
  }
});

app.post('/api/multipart/abort', async (req, res) => {
  try {
    if (!ENABLE_MULTIPART) return res.status(403).json({ error: 'Multipart deshabilitado' });
    const parsed = MpAbortSchema.parse(req.body || {});
    const cmd = new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: parsed.key, UploadId: parsed.uploadId });
    await s3.send(cmd);
    res.json({ ok: true });
  } catch (err) {
    console.error('multipart abort error', err);
    res.status(400).json({ error: String(err) });
  }
});

app.get('/', (_req, res) => res.type('text/plain').send('Mixtli Transfer Backend v3.0 (multipart) OK'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Mixtli Transfer backend listening on :${PORT}`));
