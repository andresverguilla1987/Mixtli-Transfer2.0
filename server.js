import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import { z } from 'zod';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(morgan('tiny'));

// -------- CORS estricto (ALLOWED_ORIGINS como JSON) --------
const allowed = (() => {
  try { return JSON.parse(process.env.ALLOWED_ORIGINS || '[]'); } catch { return []; }
})();

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);              // permitir curl/SSR
    if (allowed.includes(origin)) return cb(null, true);
    return cb(new Error('CORS: Origin not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-mixtli-token', 'x-mixtli-plan'], // <-- se añade el plan
  credentials: false,
  maxAge: 86400,
}));

// -------- S3 / R2 --------
const s3 = new S3Client({
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || 'true') === 'true',
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
});

const BUCKET = process.env.S3_BUCKET;
// 5 días por defecto (puedes sobreescribir con env)
const URL_TTL_SECONDS = parseInt(process.env.URL_TTL_SECONDS || String(5 * 24 * 60 * 60), 10);

// -------- Helpers --------
function safeKeyFrom(filename) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const uuid = crypto.randomUUID();
  const clean = (filename || 'file').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-120) || 'file';
  return `uploads/${yyyy}/${mm}/${dd}/${uuid}-${clean}`;
}

// Lee bytes de una env (si no existe, usa fallback)
function bytesFromEnv(name, fallback) {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

// Selecciona límite por plan desde header/query
function getPlanLimit(req) {
  const plan = String(req.headers['x-mixtli-plan'] || req.query.plan || '').toLowerCase();
  const limits = {
    // Si no están definidas en env, usar valores por defecto:
    // free: 4 GB, pro: 200 GB, promax: 300 GB
    free:   bytesFromEnv('FREE_MAX_FILE_BYTES',   4   * 1024 ** 3),
    pro:    bytesFromEnv('PRO_MAX_FILE_BYTES',    200 * 1024 ** 3),
    promax: bytesFromEnv('PROMAX_MAX_FILE_BYTES', 300 * 1024 ** 3),
  };
  // Si no mandan plan o no coincide, forzar FREE por seguridad
  return limits[plan] ?? limits.free;
}

// Acepta tamaños altos (hasta 400 GB) para validación de entrada
const PresignSchema = z.object({
  filename: z.string().min(1),
  size: z.number().int().positive().max(400 * 1024 * 1024 * 1024),
  contentType: z.string().min(1),
});

// -------- Rutas --------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
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
    const putCmd = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: parsed.contentType,
    });

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
