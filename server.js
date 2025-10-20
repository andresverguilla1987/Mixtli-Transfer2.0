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
 * - CORS estricto por ALLOWED_ORIGINS (JSON array exacto con https://...).
 * - Límites por plan vía PLAN_LIMITS_JSON o FREE_/PRO_/PROMAX_.
 * - Header opcional x-mixtli-plan (ENABLE_PLAN_HEADER).
 * - Firmas S3/R2 con URL_TTL_SECONDS.
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

function bytesFromEnv(name, fallback) {
  return parseSize(process.env[name], fallback);
}

function jsonFromEnv(name, fallback) {
  try { return JSON.parse(process.env[name] || ''); } catch { return fallback; }
}

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
  // Agrega aquí headers custom que use tu frontend
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-mixtli-token, x-mixtli-plan');
  // Si necesitas leer headers en el cliente, expón aquí:
  // res.setHeader('Access-Control-Expose-Headers', 'Content-Length');
}

app.use((req, res, next) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    // Preflight rápido; no importa si el origin no coincide: el browser lo valida.
    return res.status(204).end();
  }
  next();
});

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
})
