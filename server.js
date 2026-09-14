import 'dotenv/config';
import express from 'express';
import { streamHandler } from './driveStream.js';

const PORT = Number(process.env.PORT || '3000');

const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, DNT, User-Agent, X-Requested-With, If-Modified-Since, Cache-Control, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

app.get('/stream/:fileId', (req, res) => {
  streamHandler(req, res);
});

app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] listening on :${PORT}`);
});
