import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import Busboy from 'busboy';
import { z } from 'zod';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const {
  PORT = 10000,
  S3_ENDPOINT,
  S3_BUCKET,
  S3_REGION = 'auto',
  S3_ACCESS_KEY,
  S3_SECRET_KEY,
  S3_FORCE_PATH_STYLE = 'true',
  ALLOWED_ORIGINS = '[]',
  PUBLIC_BASE_URL = '',
  MAX_UPLOAD_MB = '200'
} = process.env;

const allowed = (()=>{ try{const a=JSON.parse(ALLOWED_ORIGINS);return Array.isArray(a)?a:[]}catch{return []} })();
const app = express(); app.use(express.json());

app.use((req,res,next)=>{
  if(['/api/health','/api/ping','/api/debug/env'].includes(req.path)) return next();
  return cors({ origin(o,cb){ if(!o||allowed.includes(o)) cb(null,true); else cb(new Error('CORS')); },
                methods:['GET','POST','OPTIONS'], allowedHeaders:['Content-Type'], maxAge:86400 })(req,res,next);
});

app.get('/api/health',(_req,res)=>res.json({ok:true,service:'Mixtli Transfer',ts:new Date().toISOString()}));
app.get('/api/ping',(_req,res)=>res.json({pong:true}));
app.get('/api/debug/env',(_req,res)=>res.json({ok:true,env:{
  S3_ENDPOINT,S3_BUCKET,S3_REGION,S3_FORCE_PATH_STYLE,PUBLIC_BASE_URL,ALLOWED_ORIGINS:allowed,
  HAS_KEYS:Boolean(S3_ACCESS_KEY&&S3_SECRET_KEY),ACCESS_KEY_LEN:S3_ACCESS_KEY?S3_ACCESS_KEY.length:0,SECRET_KEY_LEN:S3_SECRET_KEY?S3_SECRET_KEY.length:0
}}));

const s3=new S3Client({region:S3_REGION,endpoint:S3_ENDPOINT,forcePathStyle:S3_FORCE_PATH_STYLE==='true',
  credentials:{accessKeyId:S3_ACCESS_KEY,secretAccessKey:S3_SECRET_KEY}});
const safe=s=> (s||'file').replace(/[^a-zA-Z0-9._-]/g,'_'); const rnd=n=>crypto.randomBytes(n).toString('hex');

app.post('/api/upload',(req,res)=>{
  const bb=Busboy({headers:req.headers,limits:{files:1,fileSize:parseInt(MAX_UPLOAD_MB,10)*1024*1024}});
  let info={filename:'file',mime:'application/octet-stream'}; const chunks=[];
  bb.on('file',(_n,stream,meta)=>{ info.filename=meta.filename||'file'; info.mime=meta.mimeType||'application/octet-stream'; stream.on('data',d=>chunks.push(d)); });
  bb.on('finish',async()=>{ try{
    if(!chunks.length) return res.status(400).json({ok:false,error:'No file'});
    const buf=Buffer.concat(chunks); const key=`${rnd(4)}/${Date.now()}-${safe(info.filename)}`;
    await s3.send(new PutObjectCommand({Bucket:S3_BUCKET,Key:key,Body:buf,ContentType:info.mime}));
    const publicUrl = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL.replace(/\/$/,'')}/${key}` : '';
    res.json({ok:true,key,publicUrl,size:buf.length,contentType:info.mime});
  }catch(e){ res.status(500).json({ok:false,error:e.message||'Upload failed'}); } });
  req.pipe(bb);
});

// presign opcional
app.post('/api/presign', async (req, res) => {
  try {
    const { filename, contentType } = z.object({ filename:z.string().min(1), contentType:z.string().default('application/octet-stream') }).parse(req.body||{});
    const key=`${rnd(4)}/${Date.now()}-${safe(filename)}`;
    const url=await getSignedUrl(s3,new PutObjectCommand({Bucket:S3_BUCKET,Key:key,ContentType:contentType}),{expiresIn:900});
    const publicUrl = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL.replace(/\/$/,'')}/${key}` : '';
    res.json({ok:true,url,key,publicUrl,expiresInSeconds:900});
  } catch(e) {
    res.status(400).json({ok:false,error:e.message||'Bad Request'});
  }
});

app.use((_req,res)=>res.status(404).json({ok:false,error:'Not Found'}));
app.listen(PORT,()=>console.log('Mixtli master backend on :' + PORT));
