Mixtli Transfer Backend v2.2 — Proxy Upload
-------------------------------------------
- Nuevo endpoint: POST /api/upload  (multipart/form-data, campo "file")
- Sube del navegador al BACKEND, y del backend a R2. Evita CORS del bucket.
- Sigue disponible /api/presign por si lo necesitas.

ENV (Render):
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_BUCKET=mixtlitransfer
S3_REGION=auto
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
S3_FORCE_PATH_STYLE=true
ALLOWED_ORIGINS=["https://lighthearted-froyo-9dd448.netlify.app"]
PUBLIC_BASE_URL=https://<account>.r2.cloudflarestorage.com/mixtlitransfer
MAX_UPLOAD_MB=200
