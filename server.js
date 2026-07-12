import 'dotenv/config';
import express from 'express';
import { streamHandler } from './driveStream.js';

const PORT = Number(process.env.PORT || '3000');

const app = express();

app.get('/stream/:fileId', (req, res) => {
  streamHandler(req, res);
});

app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] listening on :${PORT}`);
});
