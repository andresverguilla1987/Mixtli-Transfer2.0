import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { z } from 'zod';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ----------- Env -----------
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
  PUBLIC_BASE_URL = '', // optional: e.g. https://cdn.example.com/bucket
} = process.env;

// Parse ALLOWED_ORIGINS (JSON array)
let allowedOrigins = [];
try {
  allowedOrigins = JSON.parse(ALLOWED_ORIGINS);
  if (!Array.isArray(allowedOrigins)) throw new Error('ALLOWED_ORIGINS must be a JSON array');
} catch (e) {
  console.error('Invalid ALLOWED_ORIGINS:', e.message);
  allowedOrigins = [];
}

// CORS setup: strict
const corsOptions = {
  origin(origin, cb) {
    // Allow same-origin or tools without origin (curl/postman)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('CORS: Origin not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-mixtli-token'],
  maxAge: 86400,
  credentials: false,
};

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  // Quick health for Netlify/Render probes before CORS blocks
  if (req.path === '/api/health' || req.path === '/salud' || req.path === '/api/ping') return next();
  return cors(corsOptions)(req, res, next);
});

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'Mixtli Transfer', ts: new Date().toISOString() }));
app.get('/salud', (req, res) => res.send('OK'));
app.get('/api/ping', (req, res) => res.json({ pong: true }));

// S3 Client
const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  forcePathStyle: S3_FORCE_PATH_STYLE === 'true',
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
});

// Utility to make a random key prefix
const rnd = (len=8) => crypto.randomBytes(len).toString('hex');

const PresignSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().default('application/octet-stream'),
});

app.post('/api/presign', async (req, res) => {
  try {
    const { filename, contentType } = PresignSchema.parse(req.body || {});

    // sanitize filename (basic)
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `${rnd(4)}/${Date.now()}-${safeName}`;

    const maxBytes = parseInt(process.env.MAX_UPLOAD_MB || '50', 10) * 1024 * 1024;

    const putCmd = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      ContentType: contentType,
      // Optional: set object size constraints on client side only
    });

    // URL valid for short time (15 min)
    const url = await getSignedUrl(s3, putCmd, { expiresIn: 15 * 60 });

    // Compute a public URL if provided (bucket must be public or served by a CDN)
    let publicUrl = '';
    if (PUBLIC_BASE_URL) {
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
      linkExpiryDays: parseInt(process.env.LINK_EXPIRY_DAYS || '7', 10),
      publicUrl,
    });
  } catch (err) {
    console.error('presign error', err);
    return res.status(400).json({ ok: false, error: err.message || 'Bad Request' });
  }
});

// Optional endpoint to build a time-limited GET (if bucket not public)
app.post('/api/presign-get', async (req, res) => {
  try {
    const { key } = z.object({ key: z.string().min(3) }).parse(req.body || {});
    // Import here to avoid top-level import for brevity
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const getCmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
    const url = await getSignedUrl(s3, getCmd, { expiresIn: 10 * 60 });
    res.json({ ok: true, url, expiresInSeconds: 600 });
  } catch (err) {
    console.error('presign-get error', err);
    return res.status(400).json({ ok: false, error: err.message || 'Bad Request' });
  }
});

// Fallback
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not Found' }));

app.listen(PORT, () => {
  console.log(`Mixtli Transfer backend listening on :${PORT}`);
});
