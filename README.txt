# Mixtli Backend 3.0 (Multipart)
- Reemplaza tu `server.js` por `server_multipart.js` (o renómbralo a `server.js`).
- ENV necesarias: mismas de antes (S3_* y ALLOWED_ORIGINS). Opcionales para multipart:
```
ENABLE_MULTIPART=true
MULTIPART_PART_SIZE=16MB
```
- Endpoints nuevos:
  - POST `/api/multipart/create` → `{ uploadId, key, partSize }`
  - POST `/api/multipart/part-url` → `{ url }` (por `partNumber`)
  - POST `/api/multipart/complete` → `{ ok, key, location }`
  - POST `/api/multipart/abort` → `{ ok: true }`
