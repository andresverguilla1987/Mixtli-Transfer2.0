import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { z } from 'zod';
import Busboy from 'busboy';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const {
  PORT = 10000,
  S3_ENDPOINT,
  S3_BUCKET,
  S3_REGION = 'auto',
  S3_ACCESS_KEY,
  S3_SECRET_KEY,
  S3_FORCE_PATH_STYLE = 'true',
  ALLOWED_ORIGINS = '[]',
  MAX_UPLOAD_MB = '200',
  PUBLIC_BASE_URL = '',
  LINK_EXPIRY_DAYS = '7'
} = process.env;

const allowedOrigins = (() => {
  try { const arr = JSON.parse(ALLOWED_ORIGINS); return Array.isArray(arr) ? arr : []; }
  catch { return []; }
})();

const app = express();
app.use(express.json());

// CORS for browser->backend
app.use((req, res, next) => {
  if (['/api/health','/api/ping','/api/debug/env'].includes(req.path)) return next();
  return cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('CORS: origin not allowed'));
    },
    methods: ['GET','POST','OPTIONS'],
    allowedHeaders: ['Content-Type'],
    maxAge: 86400
  })(req, res, next);
});

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'Mixtli Transfer', ts: new Date().toISOString() }));
app.get('/api/ping', (_req, res) => res.json({ pong: true }));
app.get('/api/debug/env', (_req, res) => {
  res.json({ ok:true, env: {
    S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_FORCE_PATH_STYLE,
    PUBLIC_BASE_URL, ALLOWED_ORIGINS: allowedOrigins,
    HAS_KEYS: Boolean(S3_ACCESS_KEY && S3_SECRET_KEY),
    ACCESS_KEY_LEN: S3_ACCESS_KEY ? S3_ACCESS_KEY.length : 0,
    SECRET_KEY_LEN: S3_SECRET_KEY ? S3_SECRET_KEY.length : 0,
  }});
});

const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  forcePathStyle: S3_FORCE_PATH_STYLE === 'true',
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
});

const safeName = (s) => (s || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
const rnd = (n=4) => crypto.randomBytes(n).toString('hex');

// Presign (sigue disponible)
app.post('/api/presign', async (req, res) => {
  try {
    const { filename, contentType } = z.object({
      filename: z.string().min(1),
      contentType: z.string().default('application/octet-stream')
    }).parse(req.body || {});

    const key = `${rnd(4)}/${Date.now()}-${safeName(filename)}`;
    const put = new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, ContentType: contentType });
    const url = await getSignedUrl(s3, put, { expiresIn: 15 * 60 });
    const publicUrl = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL.replace(/\/$/,'')}/${key}` : '';

    res.json({ ok: true, method: 'PUT', url, key, publicUrl, expiresInSeconds: 900 });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'Bad Request' });
  }
});

// PROXY UPLOAD: navegador -> backend -> R2 (evita CORS de bucket)
app.post('/api/upload', (req, res) => {
  const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: parseInt(MAX_UPLOAD_MB,10)*1024*1024 } });
  let fileInfo = { filename: '', mime: 'application/octet-stream' };
  let chunks = [];

  bb.on('file', (_name, stream, info) => {
    fileInfo = { filename: info.filename || 'file', mime: info.mimeType || 'application/octet-stream' };
    stream.on('data', d => chunks.push(d));
    stream.on('limit', () => { stream.unpipe(); stream.resume(); });
  });

  bb.on('finish', async () => {
    try {
      if (!chunks.length) return res.status(400).json({ ok:false, error:'No file' });
      const buf = Buffer.concat(chunks);
      const key = `${rnd(4)}/${Date.now()}-${safeName(fileInfo.filename)}`;
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET, Key: key, Body: buf, ContentType: fileInfo.mime
      }));

      const publicUrl = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL.replace(/\/$/,'')}/${key}` : '';
      res.json({ ok:true, key, publicUrl, size: buf.length, contentType: fileInfo.mime });
    } catch (e) {
      res.status(500).json({ ok:false, error: e.message || 'Upload failed' });
    }
  });

  req.pipe(bb);
});

app.use((_req,res) => res.status(404).json({ ok:false, error:'Not Found' }));

app.listen(PORT, () => console.log('Mixtli backend v2.2-proxy-upload on :' + PORT));
