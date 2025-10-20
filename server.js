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

const allowed = (() => {
  try { return JSON.parse(process.env.ALLOWED_ORIGINS || '[]'); } catch { return []; }
})();

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowed.includes(origin)) return cb(null, true);
    return cb(new Error('CORS: Origin not allowed'));
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','x-mixtli-token'],
  credentials: false,
  maxAge: 86400,
}));

const s3 = new S3Client({
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || 'true') === 'true',
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
});

const BUCKET = process.env.S3_BUCKET;
const URL_TTL_SECONDS = parseInt(process.env.URL_TTL_SECONDS || '86400', 10); // 1 día por defecto
const MAX_FILE_BYTES = parseInt(process.env.MAX_FILE_BYTES || String(5*1024*1024*1024), 10); // 5GB por defecto

function safeKeyFrom(filename) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth()+1).padStart(2,'0');
  const dd = String(now.getUTCDate()).padStart(2,'0');
  const uuid = crypto.randomUUID();
  const clean = filename.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-120) || 'file';
  return `uploads/${yyyy}/${mm}/${dd}/${uuid}-${clean}`;
}

const PresignSchema = z.object({
  filename: z.string().min(1),
  size: z.number().int().positive().max(20 * 1024 * 1024 * 1024),
  contentType: z.string().min(1),
});

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.post('/api/presign', async (req, res) => {
  try {
    const parsed = PresignSchema.parse(req.body || {});
    if (parsed.size > MAX_FILE_BYTES) {
      return res.status(400).json({ error: `Archivo excede límite del servidor: ${MAX_FILE_BYTES} bytes` });
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
