# Backend 3.1 (ZIP Bundle streaming)
Requiere añadir dependencia:
  npm i archiver

Endpoint:
GET /api/bundle?m=<manifestKey>

Donde <manifestKey> es el objeto JSON en tu bucket con la estructura:
{
  "name": "combo.zip",
  "items": [
    { "key": "uploads/2025/10/20/uuid-foto1.png", "name": "foto1.png" },
    { "key": "uploads/2025/10/20/uuid-video.mp4" }
  ]
}

El servidor lee el manifiesto directo del bucket y **streamea** el ZIP sin cargarlo en memoria.
