# Mixtli Transfer — Backend Drop-in (Render)
Todo se controla por variables de entorno (sin tocar código).

## Variables mínimas
- `ALLOWED_ORIGINS` (JSON array)
- `URL_TTL_SECONDS` (segundos; 432000 = 5 días)
- Límites por plan:
  - O usa `PLAN_LIMITS_JSON={"free":"4GB","pro":"200GB","promax":"300GB"}`
  - O usa `FREE_MAX_FILE_BYTES` / `PRO_MAX_FILE_BYTES` / `PROMAX_MAX_FILE_BYTES`
- `ENABLE_PLAN_HEADER=true` para leer `x-mixtli-plan` (free/pro/promax). Si `false`, usa `DEFAULT_PLAN`.
- S3/R2: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`.

## CORS
Agrega tu dominio de Netlify en `ALLOWED_ORIGINS`.

## Deploy
- Build: (Render auto) `npm install`
- Start: `node server.js`
- Probar: `GET /api/health`

## Notas
- Tamaños como "4GB" o "200 GB" son válidos en `PLAN_LIMITS_JSON`.
- Si no mandas header y `ENABLE_PLAN_HEADER=true`, usa `DEFAULT_PLAN=free`.
