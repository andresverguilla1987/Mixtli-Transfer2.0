import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { z } from 'zod';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const env = process.env;
const {
  PORT = 10000,
  S3_ENDPOINT,
  S3_BUCKET,
  S3_REGION = 'auto',
  S3_ACCESS_KEY,
  S3_SECRET_KEY,
  S3_FORCE_PATH_STYLE = 'true',
  ALLOWED_ORIGINS = '[]',
  MAX_UPLOAD_MB = '50',
  LINK_EXPIRY_DAYS = '7',
  PUBLIC_BASE_URL = '',
} = env;

const safeTrim = (s) => (typeof s === 'string' ? s.trim() : s);

// Parse CORS origins
let allowedOrigins = [];
try {
  allowedOrigins = JSON.parse(ALLOWED_ORIGINS);
  if (!Array.isArray(allowedOrigins)) throw new Error('ALLOWED_ORIGINS must be a JSON array');
} catch (e) {
  console.error('[CORS] Invalid ALLOWED_ORIGINS:', ALLOWED_ORIGINS, e.message);
  allowedOrigins = [];
}

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('CORS: Origin not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-mixtli-token'],
  maxAge: 86400,
};

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  if (req.path === '/api/health' || req.path === '/salud' || req.path === '/api/ping' || req.path === '/api/debug/env') return next();
  return cors(corsOptions)(req, res, next);
});

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'Mixtli Transfer', ts: new Date().toISOString() }));
app.get('/salud', (req, res) => res.send('OK'));
app.get('/api/ping', (req, res) => res.json({ pong: true }));

// Debug endpoint to verify env quickly (redacted secrets)
app.get('/api/debug/env', (req, res) => {
  res.json({
    ok: true,
    env: {
      S3_ENDPOINT: safeTrim(S3_ENDPOINT),
      S3_BUCKET: S3_BUCKET,
      S3_REGION: S3_REGION,
      S3_FORCE_PATH_STYLE: S3_FORCE_PATH_STYLE,
      PUBLIC_BASE_URL: safeTrim(PUBLIC_BASE_URL),
      ALLOWED_ORIGINS: allowedOrigins,
      HAS_KEYS: Boolean(S3_ACCESS_KEY && S3_SECRET_KEY),
      ACCESS_KEY_LEN: S3_ACCESS_KEY ? S3_ACCESS_KEY.length : 0,
      SECRET_KEY_LEN: S3_SECRET_KEY ? S3_SECRET_KEY.length : 0,
    }
  });
});

const s3 = new S3Client({
  region: S3_REGION,
  endpoint: safeTrim(S3_ENDPOINT),
  forcePathStyle: S3_FORCE_PATH_STYLE === 'true',
  credentials: { accessKeyId: safeTrim(S3_ACCESS_KEY), secretAccessKey: safeTrim(S3_SECRET_KEY) },
});

const rnd = (len=8) => crypto.randomBytes(len).toString('hex');

const PresignSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().default('application/octet-stream'),
});

app.post('/api/presign', async (req, res) => {
  try {
    const { filename, contentType } = PresignSchema.parse(req.body || {});

    // Validate obvious endpoint mistakes early
    if (!S3_ENDPOINT || !/^https?:\/\//i.test(S3_ENDPOINT.trim())) {
      throw new Error('S3_ENDPOINT missing or invalid (must start with http/https). Current: ' + S3_ENDPOINT);
    }
    if (!S3_BUCKET) throw new Error('S3_BUCKET missing');
    if (!S3_ACCESS_KEY || !S3_SECRET_KEY) throw new Error('Missing S3_ACCESS_KEY or S3_SECRET_KEY');

    // sanitize filename
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `${rnd(4)}/${Date.now()}-${safeName}`;
    const maxBytes = parseInt(MAX_UPLOAD_MB, 10) * 1024 * 1024;

    const putCmd = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      ContentType: contentType,
    });

    const url = await getSignedUrl(s3, putCmd, { expiresIn: 15 * 60 });

    let publicUrl = '';
    if (PUBLIC_BASE_URL && /^https?:\/\//i.test(PUBLIC_BASE_URL.trim())) {
      publicUrl = `${PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`;
    }

    res.json({
      ok: true,
      method: 'PUT',
      url,
      headers: { 'Content-Type': contentType },
      key,
      maxBytes,
      expiresInSeconds: 15 * 60,
      linkExpiryDays: parseInt(LINK_EXPIRY_DAYS, 10),
      publicUrl,
    });
  } catch (err) {
    console.error('[presign error]', err);
    let msg = err && err.message ? err.message : 'Bad Request';
    // Better hint for "Invalid URL"
    if (String(msg).includes('Invalid URL')) {
      msg += ' — Revisa S3_ENDPOINT (sin el nombre del bucket y sin espacios)';
    }
    return res.status(400).json({ ok: false, error: msg });
  }
});

app.post('/api/presign-get', async (req, res) => {
  try {
    const { key } = z.object({ key: z.string().min(3) }).parse(req.body || {});
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const getCmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
    const url = await getSignedUrl(s3, getCmd, { expiresIn: 10 * 60 });
    res.json({ ok: true, url, expiresInSeconds: 600 });
  } catch (err) {
    console.error('[presign-get error]', err);
    return res.status(400).json({ ok: false, error: err.message || 'Bad Request' });
  }
});

app.use((req, res) => res.status(404).json({ ok: false, error: 'Not Found' }));

app.listen(PORT, () => {
  console.log(`Mixtli Transfer backend listening on :${PORT}`);
});
