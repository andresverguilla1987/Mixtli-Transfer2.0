import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import { nanoid } from 'nanoid';
import AWS from 'aws-sdk';
import archiver from 'archiver';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// ---- CORS ----
const ORIGINS = (()=>{
  try{ return JSON.parse(process.env.ALLOWED_ORIGINS||'[]'); }catch(_){ return []; }
})();
app.use(cors({
  origin: (origin, cb)=>{
    if(!origin) return cb(null, true);
    if(ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Origin not allowed: '+origin));
  },
  credentials: true
}));
app.use(express.json());

// ---- Multer ----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB||'2000',10))*1024*1024 }
});

// ---- S3 Client (Cloudflare R2 S3 compat) ----
const s3 = new AWS.S3({
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  endpoint: `https://${process.env.S3_ENDPOINT}`,
  region: process.env.S3_REGION || 'auto',
  signatureVersion: 'v4',
  s3ForcePathStyle: String(process.env.S3_FORCE_PATH_STYLE||'true') === 'true'
});

const BUCKET = process.env.S3_BUCKET;
if(!BUCKET){ throw new Error('S3_BUCKET no definido'); }

const PUBLIC_BASE = process.env.PUBLIC_BASE || null;
const DEFAULT_TTL = parseInt(process.env.LINK_TTL_DAYS||'7',10);

// ---- Helpers ----
const safeName = (name)=> name.replace(/[\\#?<>:*|"\x00-\x1F]/g, '_');
function toRFC3339(date){ return date.toISOString(); }

async function putObject(Key, Body, ContentType){
  await s3.putObject({ Bucket: BUCKET, Key, Body, ContentType, ACL: 'private' }).promise();
}

async function headObject(Key){
  try{ return await s3.headObject({ Bucket: BUCKET, Key }).promise(); }catch(e){ if(e.code==='NotFound') return null; throw e; }
}

async function getObjectStream(Key){
  return s3.getObject({ Bucket: BUCKET, Key }).createReadStream();
}

async function listObjects(prefix){
  const out = await s3.listObjectsV2({ Bucket: BUCKET, Prefix: prefix }).promise();
  return out.Contents || [];
}

// ---- Routes ----
app.get('/api/health', (req,res)=> res.json({ ok:true, time: new Date().toISOString() }));

// Create transfer (multi-file, one link)
app.post('/api/transfers', upload.array('files', 50), async (req, res)=>{
  try{
    const files = req.files || [];
    if(files.length===0){ return res.status(400).json({ error:'No files' }); }

    const expiresInDays = Math.max(1, Math.min(30, parseInt(req.body.expiresInDays||String(DEFAULT_TTL),10)));
    const id = nanoid(10);
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + expiresInDays*24*60*60*1000);

    let total = 0;
    const items = [];

    for(const f of files){
      const key = `transfers/${id}/${safeName(f.originalname)}`;
      await putObject(key, f.buffer, f.mimetype || 'application/octet-stream');
      total += f.size;
      items.push({
        name: f.originalname,
        size: f.size,
        type: f.mimetype || 'application/octet-stream',
        key
      });
    }

    const manifest = {
      id,
      version: '2.3',
      createdAt: toRFC3339(createdAt),
      expiresAt: toRFC3339(expiresAt),
      totalBytes: total,
      count: items.length,
      files: items.map(i=>({ name:i.name, size:i.size, type:i.type }))
    };

    await putObject(`transfers/${id}/manifest.json`, Buffer.from(JSON.stringify(manifest,null,2)), 'application/json');

    const backendBase = `${req.protocol}://${req.get('host')}`;
    const viewPath = `/t/${id}`;
    const link = backendBase + viewPath;
    const publicLink = PUBLIC_BASE ? `${PUBLIC_BASE}${viewPath}` : null;

    res.json({ id, link, publicLink, expiresInDays, count: items.length, totalBytes: total });
  }catch(err){
    console.error(err);
    res.status(500).json({ error: err.message || 'upload_failed' });
  }
});

// Get manifest (and enforce expiry)
app.get('/api/transfers/:id', async (req,res)=>{
  try{
    const id = req.params.id;
    const manKey = `transfers/${id}/manifest.json`;
    const head = await headObject(manKey);
    if(!head) return res.status(404).json({ error:'not_found' });

    const stream = await getObjectStream(manKey);
    let buf = Buffer.from([]);
    for await (const chunk of stream){ buf = Buffer.concat([buf, chunk]); }
    const manifest = JSON.parse(buf.toString('utf8'));

    if(new Date(manifest.expiresAt) < new Date()){
      return res.status(410).json({ error:'expired' });
    }
    res.json(manifest);
  }catch(err){
    res.status(500).json({ error: err.message || 'get_manifest_failed' });
  }
});

// Stream individual file
app.get('/api/file/:id/:name', async (req,res)=>{
  try{
    const { id, name } = req.params;
    const manKey = `transfers/${id}/manifest.json`;
    const head = await headObject(manKey);
    if(!head) return res.status(404).send('not found');
    const streamM = await getObjectStream(manKey);
    let buf = Buffer.from([]);
    for await (const c of streamM){ buf = Buffer.concat([buf,c]); }
    const manifest = JSON.parse(buf.toString('utf8'));
    if(new Date(manifest.expiresAt) < new Date()){ return res.status(410).send('expired'); }

    const key = `transfers/${id}/${safeName(name)}`;
    const objHead = await headObject(key);
    if(!objHead) return res.status(404).send('not found');

    res.setHeader('Content-Type', objHead.ContentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    const stream = await getObjectStream(key);
    stream.pipe(res);
  }catch(err){
    res.status(500).send('error');
  }
});

// Download ZIP of all files
app.get('/api/transfers/:id/download.zip', async (req,res)=>{
  try{
    const { id } = req.params;
    const manKey = `transfers/${id}/manifest.json`;
    const head = await headObject(manKey);
    if(!head) return res.status(404).send('not found');
    const streamM = await getObjectStream(manKey);
    let buf = Buffer.from([]);
    for await (const c of streamM){ buf = Buffer.concat([buf,c]); }
    const manifest = JSON.parse(buf.toString('utf8'));
    if(new Date(manifest.expiresAt) < new Date()){ return res.status(410).send('expired'); }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="mixtli-${id}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err=>{ throw err; });
    archive.pipe(res);

    for(const f of manifest.files){
      const key = `transfers/${id}/${safeName(f.name)}`;
      const objHead = await headObject(key);
      if(!objHead) continue;
      const stream = await getObjectStream(key);
      archive.append(stream, { name: f.name });
    }
    archive.finalize();
  }catch(err){
    console.error(err);
    if(!res.headersSent){ res.status(500).send('zip_error'); }
  }
});

// Minimal share page
app.get('/t/:id', async (req,res)=>{
  try{
    const id = req.params.id;
    const manKey = `transfers/${id}/manifest.json`;
    const head = await headObject(manKey);
    if(!head) return res.status(404).send('<h1>No encontrado</h1>');
    const streamM = await getObjectStream(manKey);
    let buf = Buffer.from([]);
    for await (const c of streamM){ buf = Buffer.concat([buf,c]); }
    const manifest = JSON.parse(buf.toString('utf8'));
    const expired = new Date(manifest.expiresAt) < new Date();

    const html = `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mixtli Transfer — Bundle ${id}</title>
<style>
body{background:#0f1117;color:#e5e9f3;font-family:system-ui,Segoe UI,Roboto;-webkit-font-smoothing:antialiased}
.container{max-width:860px;margin:40px auto;padding:24px}
.card{background:#151923;border:1px solid #23283a;border-radius:16px;padding:24px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
h1{margin:0 0 10px} .muted{color:#a8b3cf}
.file{display:flex;justify-content:space-between;align-items:center;border:1px solid #23283a;background:#0f1423;border-radius:12px;padding:10px 12px;margin:8px 0}
.btn{background:#7c5cff;color:#fff;border:none;border-radius:10px;padding:10px 14px;font-weight:600;cursor:pointer;text-decoration:none}
.btn.secondary{background:#26314b;color:#e5e9f3;border:1px solid #23283a}
.grid{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center}
.footer{margin-top:20px;color:#a8b3cf;font-size:12px}
</style>
</head>
<body><div class="container"><div class="card">
<h1>Bundle ${id}</h1>
<p class="muted">Archivos: ${manifest.count} · Total: ${Math.round(manifest.totalBytes/1024/1024*10)/10} MB · Expira: ${manifest.expiresAt}</p>
${ expired ? '<p style="color:#ff4d4d">Este bundle expiró y ya no está disponible.</p>' : '' }
<div>
${manifest.files.map(f=>`
  <div class="file">
    <div style="max-width:60%">
      <div>${f.name}</div>
      <div class="muted" style="font-size:12px">${(f.size/1024/1024).toFixed(2)} MB · ${f.type||'application/octet-stream'}</div>
    </div>
    <a class="btn secondary" href="/api/file/${id}/${encodeURIComponent(f.name)}">Descargar</a>
  </div>
`).join('')}
</div>
${ expired ? '' : `<div style="margin-top:16px"><a class="btn" href="/api/transfers/${id}/download.zip">Descargar todo (ZIP)</a></div>` }
<div class="footer">Mixtli Transfer v2.3 — compartido vía link único.</div>
</div></div></body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }catch(err){
    res.status(500).send('error');
  }
});

app.listen(PORT, ()=>{
  console.log('Mixtli Transfer backend v2.3 listening on', PORT);
});
