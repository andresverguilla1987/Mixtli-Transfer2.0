# mixtli-transfer-we-backend (Render)
API Express para presign (PUT) y firmas de descarga (GET) contra S3/R2.

## Deploy en Render
- Build: `npm install --no-audit --no-fund`
- Start: `node server.js`
- Node >= 20
- Variables de entorno: ver `.env.example`

## Importante
- `URL_TTL_SECONDS=86400` → enlaces válidos por 1 día
- `ALLOWED_ORIGINS` → agrega el dominio de tu nuevo sitio de Netlify
- `MAX_FILE_BYTES` → ajusta para Free/Pro/Pro Max (ej. 2GB / 5GB / 10GB)

## Endpoints
- `GET /api/health`
- `POST /api/presign`  body: `{ filename, size, contentType }`
- `GET /api/sign-get?key=...`
