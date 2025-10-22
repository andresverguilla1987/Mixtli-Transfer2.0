# Mixtli Transfer Backend v2.0

Minimal presigned S3/R2 backend for direct browser uploads.

## Quick Start (Render)
1) New Web Service → Node 18+.
2) Build command: `npm install --no-audit --no-fund`
3) Start command: `node server.js`
4) Add env vars from `.env.example` (fill values).
5) Open `/api/health`.

### Important
- `ALLOWED_ORIGINS` **must** include your Netlify origin(s).
- Use `PUBLIC_BASE_URL` only if your bucket is public / behind a CDN. Otherwise, the frontend can call `/api/presign-get` per object to get a temporary GET URL.
