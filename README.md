# Mixtli Transfer Backend v2.1-debug
- /api/debug/env: revisa configuración (sin exponer secretos).
- /api/presign: errores detallados (hint para "Invalid URL").

Problema común "Invalid URL":
- S3_ENDPOINT debe ser el endpoint de la cuenta, **sin** nombre del bucket al final, ej.:
  https://8351c372dedf0e354a3196aff085f0ae.r2.cloudflarestorage.com
- El nombre del bucket va en S3_BUCKET, ej.: mixtlitransfer
- PUBLIC_BASE_URL (opcional) sí puede llevar /<bucket>
