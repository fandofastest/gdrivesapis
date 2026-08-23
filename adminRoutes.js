import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  getAuthStatus,
  generateAuthUrl,
  exchangeCodeForToken,
  saveCredentialsJson,
  saveTokenJson,
} from './auth.js';
import { scanManager } from './scanManager.js';
import { connectMongo } from './db.js';
import { getCacheConfig } from './cacheManager.js';

function getAdminPassword() {
  const v = process.env.ADMIN_PASSWORD;
  return v && String(v).trim() ? String(v).trim() : 'admin123';
}

function createToken(password) {
  return Buffer.from(`admin:${password}`).toString('base64');
}

function verifyToken(token) {
  if (!token) return false;
  const expected = createToken(getAdminPassword());
  return token === expected;
}

export function createAdminRouter() {
  const router = express.Router();

  // JSON Body parser middleware for admin routes
  router.use(express.json({ limit: '10mb' }));
  router.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Auth Middleware for protected endpoints
  const requireAdmin = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const tokenHeader = req.headers['x-admin-token'];
    const cookieToken = req.headers.cookie
      ?.split(';')
      .find((c) => c.trim().startsWith('admin_token='))
      ?.split('=')[1];

    let token = tokenHeader || cookieToken;
    if (!token && authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }

    if (verifyToken(token)) {
      return next();
    }
    return res.status(401).json({ error: 'unauthorized', message: 'Admin authentication required.' });
  };

  // -------------------------------------------------------------
  // Public Auth Endpoints
  // -------------------------------------------------------------
  router.post('/login', (req, res) => {
    const { password } = req.body || {};
    const expected = getAdminPassword();

    if (password === expected) {
      const token = createToken(expected);
      res.setHeader('Set-Cookie', `admin_token=${token}; Path=/; HttpOnly; SameSite=Lax`);
      return res.json({ success: true, token });
    }
    return res.status(401).json({ error: 'invalid_password', message: 'Password salah' });
  });

  router.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'admin_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    res.json({ success: true });
  });

  router.get('/session', (req, res) => {
    const tokenHeader = req.headers['x-admin-token'];
    const cookieToken = req.headers.cookie
      ?.split(';')
      .find((c) => c.trim().startsWith('admin_token='))
      ?.split('=')[1];
    const authHeader = req.headers['authorization'];
    let token = tokenHeader || cookieToken;
    if (!token && authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }

    const authenticated = verifyToken(token);
    res.json({ authenticated });
  });

  // -------------------------------------------------------------
  // Protected Admin Endpoints
  // -------------------------------------------------------------

  // Status & Health
  router.get('/status', requireAdmin, async (req, res) => {
    try {
      const authStatus = await getAuthStatus();
      const scanStatus = scanManager.getStatus();

      let mongoStatus = { connected: false, error: null };
      let counts = { movies: 0, series: 0, episodes: 0, plays: 0 };

      try {
        const { movies, series, episodes, db } = await connectMongo();
        mongoStatus.connected = true;
        const [mCount, sCount, eCount, pCount] = await Promise.all([
          movies.countDocuments().catch(() => 0),
          series.countDocuments().catch(() => 0),
          episodes.countDocuments().catch(() => 0),
          db.collection('plays').countDocuments().catch(() => 0),
        ]);
        counts = { movies: mCount, series: sCount, episodes: eCount, plays: pCount };
      } catch (err) {
        mongoStatus.error = err?.message || String(err);
      }

      let cacheStats = { cacheDir: '', maxBytes: 0, usedBytes: 0, fileCount: 0 };
      try {
        const cfg = getCacheConfig();
        cacheStats.cacheDir = cfg.cacheDir;
        cacheStats.maxBytes = cfg.maxBytes;

        const entries = await fs.readdir(cfg.cacheDir, { withFileTypes: true }).catch(() => []);
        let totalSize = 0;
        let count = 0;
        for (const e of entries) {
          if (e.isFile() && !e.name.endsWith('.json') && !e.name.endsWith('.part')) {
            const st = await fs.stat(path.join(cfg.cacheDir, e.name)).catch(() => null);
            if (st) {
              totalSize += st.size;
              count += 1;
            }
          }
        }
        cacheStats.usedBytes = totalSize;
        cacheStats.fileCount = count;
      } catch {
        // ignore cache stat errors
      }

      res.json({
        ok: true,
        auth: authStatus,
        scanner: scanStatus,
        mongo: mongoStatus,
        counts,
        cache: cacheStats,
        env: {
          DRIVE_FOLDER_ID: process.env.DRIVE_FOLDER_ID || '',
          TMDB_API_KEY_SET: Boolean(process.env.TMDB_API_KEY),
          MONGO_URI_SET: Boolean(process.env.MONGO_URI),
          PLAYER_BASE_URL: process.env.PLAYER_BASE_URL || '',
          CONCURRENCY: process.env.CONCURRENCY || '5',
        },
      });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Credentials & OAuth
  router.get('/credentials', requireAdmin, async (req, res) => {
    try {
      const status = await getAuthStatus();
      res.json(status);
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  router.post('/credentials/upload', requireAdmin, async (req, res) => {
    try {
      const { type, content } = req.body || {};
      if (!content) {
        return res.status(400).json({ error: 'missing_content', message: 'Payload content is required' });
      }

      if (type === 'credentials') {
        await saveCredentialsJson(content);
        return res.json({ success: true, message: 'credentials.json berhasil disimpan.' });
      } else if (type === 'token') {
        await saveTokenJson(content);
        return res.json({ success: true, message: 'token.json berhasil disimpan.' });
      } else {
        return res.status(400).json({ error: 'invalid_type', message: 'Type must be credentials or token' });
      }
    } catch (e) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  router.get('/oauth/url', requireAdmin, async (req, res) => {
    try {
      const data = await generateAuthUrl();
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  router.post('/oauth/code', requireAdmin, async (req, res) => {
    try {
      const { code } = req.body || {};
      if (!code) return res.status(400).json({ error: 'missing_code', message: 'Authorization code required' });

      const tokens = await exchangeCodeForToken(code);
      res.json({ success: true, message: 'Otorisasi Google Drive berhasil! Token disimpan.', tokens });
    } catch (e) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  // TMDB Metadata Fetch
  router.get('/tmdb/fetch', requireAdmin, async (req, res) => {
    try {
      const tmdbApiKey = process.env.TMDB_API_KEY;
      if (!tmdbApiKey || !String(tmdbApiKey).trim()) {
        return res.status(400).json({ error: 'missing_tmdb_key', message: 'TMDB_API_KEY belum dikonfigurasi di server' });
      }

      const { tmdbId, query, type = 'movie', year } = req.query;
      const isSeries = type === 'series' || type === 'tv';

      const TMDB_POSTER_BASE = 'https://image.tmdb.org/t/p/w500';
      const TMDB_BACKDROP_BASE = 'https://image.tmdb.org/t/p/original';

      let details = null;
      let externalIds = null;

      if (tmdbId && String(tmdbId).trim()) {
        const idStr = String(tmdbId).trim();
        const endpoint = isSeries ? `tv/${encodeURIComponent(idStr)}` : `movie/${encodeURIComponent(idStr)}`;
        const url = `https://api.themoviedb.org/3/${endpoint}?api_key=${encodeURIComponent(tmdbApiKey)}`;
        const r = await fetch(url);
        if (!r.ok) {
          return res.status(404).json({ error: 'not_found', message: `TMDB ID ${idStr} tidak ditemukan` });
        }
        details = await r.json();

        const extUrl = `https://api.themoviedb.org/3/${endpoint}/external_ids?api_key=${encodeURIComponent(tmdbApiKey)}`;
        externalIds = await fetch(extUrl).then((res) => res.json()).catch(() => null);
      } else if (query && String(query).trim()) {
        const qStr = String(query).trim();
        const searchEndpoint = isSeries ? 'search/tv' : 'search/movie';
        const yearParam = year ? (isSeries ? `&first_air_date_year=${encodeURIComponent(year)}` : `&year=${encodeURIComponent(year)}`) : '';
        const searchUrl = `https://api.themoviedb.org/3/${searchEndpoint}?api_key=${encodeURIComponent(tmdbApiKey)}&query=${encodeURIComponent(qStr)}${yearParam}&include_adult=false`;

        const searchRes = await fetch(searchUrl).then((r) => r.json());
        const first = searchRes?.results?.[0];
        if (!first?.id) {
          return res.status(404).json({ error: 'not_found', message: `Media '${qStr}' tidak ditemukan di TMDB.` });
        }

        const endpoint = isSeries ? `tv/${first.id}` : `movie/${first.id}`;
        const url = `https://api.themoviedb.org/3/${endpoint}?api_key=${encodeURIComponent(tmdbApiKey)}`;
        details = await fetch(url).then((r) => r.json());

        const extUrl = `https://api.themoviedb.org/3/${endpoint}/external_ids?api_key=${encodeURIComponent(tmdbApiKey)}`;
        externalIds = await fetch(extUrl).then((res) => res.json()).catch(() => null);
      } else {
        return res.status(400).json({ error: 'missing_params', message: 'Masukkan TMDB ID atau Judul untuk mencari TMDB' });
      }

      if (!details || !details.id) {
        return res.status(404).json({ error: 'not_found', message: 'Data TMDB tidak ditemukan' });
      }

      const releaseDate = details.release_date || details.first_air_date || '';
      const parsedYear = releaseDate ? Number(releaseDate.split('-')[0]) : (year ? Number(year) : null);

      const result = {
        tmdbId: details.id,
        imdbId: details.imdb_id || externalIds?.imdb_id || null,
        title: details.title || details.name || null,
        year: parsedYear,
        overview: details.overview || null,
        genres: Array.isArray(details.genres) ? details.genres.map((g) => g.name).filter(Boolean) : [],
        rating: typeof details.vote_average === 'number' ? Math.round(details.vote_average * 10) / 10 : null,
        poster: details.poster_path ? `${TMDB_POSTER_BASE}${details.poster_path}` : null,
        backdrop: details.backdrop_path ? `${TMDB_BACKDROP_BASE}${details.backdrop_path}` : null,
      };

      res.json({ ok: true, metadata: result });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Scanner Endpoints
  router.get('/scan/status', requireAdmin, (req, res) => {
    res.json(scanManager.getStatus());
  });

  router.get('/scan/logs', requireAdmin, (req, res) => {
    const limit = Number.parseInt(String(req.query.limit || '100'), 10);
    res.json({ logs: scanManager.getLogs(limit) });
  });

  router.post('/scan/start', requireAdmin, async (req, res) => {
    try {
      const { mode, driveFolderId, tmdbApiKey, concurrency } = req.body || {};
      const result = await scanManager.startScan({
        mode: mode || 'full',
        driveFolderId,
        tmdbApiKey,
        concurrency,
      });
      res.json({ success: true, message: `Scan '${mode || 'full'}' berhasil dimulai.`, status: result });
    } catch (e) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  router.post('/scan/stop', requireAdmin, (req, res) => {
    try {
      const result = scanManager.stopScan();
      res.json({ success: true, message: 'Proses scan dihentikan.', status: result });
    } catch (e) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  // Configuration / Environment
  router.get('/config', requireAdmin, (req, res) => {
    res.json({
      DRIVE_FOLDER_ID: process.env.DRIVE_FOLDER_ID || '',
      TMDB_API_KEY: process.env.TMDB_API_KEY || '',
      MONGO_URI: process.env.MONGO_URI ? '***** (Set)' : '',
      PLAYER_BASE_URL: process.env.PLAYER_BASE_URL || '',
      PLAYER_PATH_TEMPLATE: process.env.PLAYER_PATH_TEMPLATE || '/stream/{fileId}',
      CONCURRENCY: process.env.CONCURRENCY || '5',
      ADMIN_PASSWORD_SET: process.env.ADMIN_PASSWORD ? true : false,
      INDEX_MODE: process.env.INDEX_MODE || 'full',
      DEBUG: process.env.DEBUG || '0',
    });
  });

  router.post('/config', requireAdmin, async (req, res) => {
    try {
      const updates = req.body || {};
      const allowed = [
        'DRIVE_FOLDER_ID',
        'TMDB_API_KEY',
        'MONGO_URI',
        'PLAYER_BASE_URL',
        'PLAYER_PATH_TEMPLATE',
        'CONCURRENCY',
        'ADMIN_PASSWORD',
        'INDEX_MODE',
        'DEBUG',
      ];

      const envPath = path.resolve('.env');
      let envContent = '';
      try {
        envContent = await fs.readFile(envPath, 'utf8');
      } catch {
        envContent = '';
      }

      const lines = envContent.split(/\r?\n/);
      const envMap = new Map();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx > 0) {
          const k = trimmed.slice(0, idx).trim();
          const v = trimmed.slice(idx + 1).trim();
          envMap.set(k, v);
        }
      }

      for (const key of allowed) {
        if (typeof updates[key] === 'string' && updates[key].trim() !== '') {
          // Don't overwrite MONGO_URI if masked default string is passed
          if (key === 'MONGO_URI' && updates[key] === '***** (Set)') continue;
          process.env[key] = updates[key].trim();
          envMap.set(key, updates[key].trim());
        }
      }

      const newLines = [];
      for (const [k, v] of envMap.entries()) {
        newLines.push(`${k}=${v}`);
      }

      await fs.writeFile(envPath, newLines.join('\n') + '\n', 'utf8');
      res.json({ success: true, message: 'Pengaturan environment berhasil diperbarui.' });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Catalog CRUD Endpoints
  router.get('/catalog/list', requireAdmin, async (req, res) => {
    try {
      const type = String(req.query.type || 'movie').toLowerCase();
      const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
      const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || '20'), 10) || 20));
      const skip = (page - 1) * limit;
      const q = String(req.query.q || '').trim();

      const { movies, series, episodes } = await connectMongo();
      const { ObjectId } = await import('mongodb');

      let col;
      let filter = {};
      if (q) {
        filter.title = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      }

      if (type === 'movie') {
        col = movies;
      } else if (type === 'series') {
        col = series;
      } else if (type === 'episode') {
        col = episodes;
        if (q) {
          filter = {
            $or: [
              { title: filter.title },
              { episodeTitle: filter.title },
              { fileName: filter.title },
              { driveFileId: q },
            ],
          };
        }
      } else {
        return res.status(400).json({ error: 'invalid_type', message: 'Type must be movie, series, or episode' });
      }

      const total = await col.countDocuments(filter);
      const items = await col.find(filter).sort({ _id: -1 }).skip(skip).limit(limit).toArray();

      // If episode, enrich with series title if seriesId is present
      if (type === 'episode' && items.length > 0) {
        const seriesIds = [...new Set(items.map((i) => i.seriesId).filter(Boolean))];
        const seriesMap = new Map();

        if (seriesIds.length > 0) {
          const oids = seriesIds.map((id) => (ObjectId.isValid(String(id)) ? new ObjectId(String(id)) : id));
          const seriesDocs = await series.find({ _id: { $in: oids } }, { projection: { title: 1 } }).toArray();
          for (const s of seriesDocs) {
            seriesMap.set(String(s._id), s.title);
          }
        }

        for (const item of items) {
          if (item.seriesId) {
            item.seriesTitle = seriesMap.get(String(item.seriesId)) || null;
          }
        }
      }

      res.json({ type, page, limit, total, items });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // CREATE Movie
  router.post('/catalog/movie', requireAdmin, async (req, res) => {
    try {
      const { movies } = await connectMongo();
      const body = req.body || {};

      if (!body.title || !String(body.title).trim()) {
        return res.status(400).json({ error: 'missing_title', message: 'Judul film (title) wajib diisi' });
      }
      if (!body.driveFileId || !String(body.driveFileId).trim()) {
        return res.status(400).json({ error: 'missing_driveFileId', message: 'Drive File ID wajib diisi' });
      }

      const driveFileId = String(body.driveFileId).trim();
      const doc = {
        title: String(body.title).trim(),
        year: body.year ? Number(body.year) : null,
        overview: body.overview || null,
        genres: Array.isArray(body.genres) ? body.genres : String(body.genres || '').split(',').map((g) => g.trim()).filter(Boolean),
        rating: body.rating ? Number(body.rating) : null,
        poster: body.poster || null,
        backdrop: body.backdrop || null,
        tmdbId: body.tmdbId ? Number(body.tmdbId) : null,
        imdbId: body.imdbId || null,
        resolution: body.resolution || null,
        fileName: body.fileName || `${body.title}.mkv`,
        driveFileId,
        driveLink: body.driveLink || `https://drive.google.com/file/d/${driveFileId}/view`,
        fileSize: body.fileSize ? Number(body.fileSize) : null,
        createdAt: new Date(),
      };

      const result = await movies.insertOne(doc);
      res.json({ success: true, message: 'Film berhasil ditambahkan.', item: { _id: result.insertedId, ...doc } });
    } catch (e) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  // CREATE Series
  router.post('/catalog/series', requireAdmin, async (req, res) => {
    try {
      const { series } = await connectMongo();
      const body = req.body || {};

      if (!body.title || !String(body.title).trim()) {
        return res.status(400).json({ error: 'missing_title', message: 'Judul serial (title) wajib diisi' });
      }

      const doc = {
        title: String(body.title).trim(),
        year: body.year ? Number(body.year) : null,
        overview: body.overview || null,
        genres: Array.isArray(body.genres) ? body.genres : String(body.genres || '').split(',').map((g) => g.trim()).filter(Boolean),
        rating: body.rating ? Number(body.rating) : null,
        poster: body.poster || null,
        backdrop: body.backdrop || null,
        tmdbId: body.tmdbId ? Number(body.tmdbId) : null,
        imdbId: body.imdbId || null,
        createdAt: new Date(),
      };

      const result = await series.insertOne(doc);
      res.json({ success: true, message: 'Serial berhasil ditambahkan.', item: { _id: result.insertedId, ...doc } });
    } catch (e) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  // CREATE Episode
  router.post('/catalog/episode', requireAdmin, async (req, res) => {
    try {
      const { episodes } = await connectMongo();
      const { ObjectId } = await import('mongodb');
      const body = req.body || {};

      if (!body.driveFileId || !String(body.driveFileId).trim()) {
        return res.status(400).json({ error: 'missing_driveFileId', message: 'Drive File ID wajib diisi' });
      }

      let seriesId = body.seriesId || null;
      if (seriesId && ObjectId.isValid(String(seriesId))) {
        seriesId = new ObjectId(String(seriesId));
      }

      const driveFileId = String(body.driveFileId).trim();
      const doc = {
        seriesId,
        season: Number(body.season || 1),
        episode: Number(body.episode || 1),
        title: body.title || body.episodeTitle || null,
        fileName: body.fileName || `Episode_${body.season}x${body.episode}.mkv`,
        driveFileId,
        driveLink: body.driveLink || `https://drive.google.com/file/d/${driveFileId}/view`,
        fileSize: body.fileSize ? Number(body.fileSize) : null,
        resolution: body.resolution || null,
        createdAt: new Date(),
      };

      const result = await episodes.insertOne(doc);
      res.json({ success: true, message: 'Episode berhasil ditambahkan.', item: { _id: result.insertedId, ...doc } });
    } catch (e) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  // UPDATE Movie
  router.put('/catalog/movie/:id', requireAdmin, async (req, res) => {
    try {
      const { movies } = await connectMongo();
      const { ObjectId } = await import('mongodb');
      const id = req.params.id;
      const body = req.body || {};

      const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { driveFileId: id };

      const updateFields = {};
      if (body.title !== undefined) updateFields.title = String(body.title).trim();
      if (body.year !== undefined) updateFields.year = body.year ? Number(body.year) : null;
      if (body.overview !== undefined) updateFields.overview = body.overview || null;
      if (body.genres !== undefined) updateFields.genres = Array.isArray(body.genres) ? body.genres : String(body.genres).split(',').map((g) => g.trim()).filter(Boolean);
      if (body.rating !== undefined) updateFields.rating = body.rating ? Number(body.rating) : null;
      if (body.poster !== undefined) updateFields.poster = body.poster || null;
      if (body.backdrop !== undefined) updateFields.backdrop = body.backdrop || null;
      if (body.tmdbId !== undefined) updateFields.tmdbId = body.tmdbId ? Number(body.tmdbId) : null;
      if (body.imdbId !== undefined) updateFields.imdbId = body.imdbId || null;
      if (body.resolution !== undefined) updateFields.resolution = body.resolution || null;
      if (body.fileName !== undefined) updateFields.fileName = body.fileName || null;
      if (body.driveFileId !== undefined) updateFields.driveFileId = body.driveFileId || null;
      if (body.driveLink !== undefined) updateFields.driveLink = body.driveLink || null;

      const result = await movies.updateOne(query, { $set: updateFields });
      res.json({ success: true, message: 'Film berhasil diperbarui.', modifiedCount: result.modifiedCount });
    } catch (e) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  // UPDATE Series
  router.put('/catalog/series/:id', requireAdmin, async (req, res) => {
    try {
      const { series } = await connectMongo();
      const { ObjectId } = await import('mongodb');
      const id = req.params.id;
      const body = req.body || {};

      const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id };

      const updateFields = {};
      if (body.title !== undefined) updateFields.title = String(body.title).trim();
      if (body.year !== undefined) updateFields.year = body.year ? Number(body.year) : null;
      if (body.overview !== undefined) updateFields.overview = body.overview || null;
      if (body.genres !== undefined) updateFields.genres = Array.isArray(body.genres) ? body.genres : String(body.genres).split(',').map((g) => g.trim()).filter(Boolean);
      if (body.rating !== undefined) updateFields.rating = body.rating ? Number(body.rating) : null;
      if (body.poster !== undefined) updateFields.poster = body.poster || null;
      if (body.backdrop !== undefined) updateFields.backdrop = body.backdrop || null;
      if (body.tmdbId !== undefined) updateFields.tmdbId = body.tmdbId ? Number(body.tmdbId) : null;
      if (body.imdbId !== undefined) updateFields.imdbId = body.imdbId || null;

      const result = await series.updateOne(query, { $set: updateFields });
      res.json({ success: true, message: 'Serial berhasil diperbarui.', modifiedCount: result.modifiedCount });
    } catch (e) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  // UPDATE Episode
  router.put('/catalog/episode/:id', requireAdmin, async (req, res) => {
    try {
      const { episodes } = await connectMongo();
      const { ObjectId } = await import('mongodb');
      const id = req.params.id;
      const body = req.body || {};

      const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { driveFileId: id };

      const updateFields = {};
      if (body.seriesId !== undefined) {
        updateFields.seriesId = body.seriesId && ObjectId.isValid(String(body.seriesId)) ? new ObjectId(String(body.seriesId)) : body.seriesId;
      }
      if (body.season !== undefined) updateFields.season = Number(body.season);
      if (body.episode !== undefined) updateFields.episode = Number(body.episode);
      if (body.title !== undefined || body.episodeTitle !== undefined) {
        updateFields.title = body.title || body.episodeTitle || null;
      }
      if (body.fileName !== undefined) updateFields.fileName = body.fileName || null;
      if (body.driveFileId !== undefined) updateFields.driveFileId = body.driveFileId || null;
      if (body.driveLink !== undefined) updateFields.driveLink = body.driveLink || null;
      if (body.resolution !== undefined) updateFields.resolution = body.resolution || null;

      const result = await episodes.updateOne(query, { $set: updateFields });
      res.json({ success: true, message: 'Episode berhasil diperbarui.', modifiedCount: result.modifiedCount });
    } catch (e) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  // DELETE Catalog Item (RESTful route)
  router.delete('/catalog/:type/:id', requireAdmin, async (req, res) => {
    try {
      const { type, id } = req.params;
      const { movies, series, episodes } = await connectMongo();
      const { ObjectId } = await import('mongodb');
      let result;

      if (type === 'movie') {
        result = await movies.deleteOne({ driveFileId: id });
        if (result.deletedCount === 0 && ObjectId.isValid(id)) {
          result = await movies.deleteOne({ _id: new ObjectId(id) });
        }
      } else if (type === 'series') {
        const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id };
        result = await series.deleteOne(query);
      } else if (type === 'episode') {
        result = await episodes.deleteOne({ driveFileId: id });
        if (result.deletedCount === 0 && ObjectId.isValid(id)) {
          result = await episodes.deleteOne({ _id: new ObjectId(id) });
        }
      } else {
        return res.status(400).json({ error: 'invalid_type' });
      }

      res.json({ success: true, message: 'Item berhasil dihapus.', deletedCount: result.deletedCount });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Legacy POST Catalog Item Deletion
  router.post('/catalog/delete-item', requireAdmin, async (req, res) => {
    try {
      const { type, id } = req.body || {};
      if (!type || !id) return res.status(400).json({ error: 'missing_params' });

      const { movies, series, episodes } = await connectMongo();
      const { ObjectId } = await import('mongodb');
      let result;

      if (type === 'movie') {
        result = await movies.deleteOne({ driveFileId: id });
        if (result.deletedCount === 0 && ObjectId.isValid(id)) {
          result = await movies.deleteOne({ _id: new ObjectId(id) });
        }
      } else if (type === 'series') {
        const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id };
        result = await series.deleteOne(query);
      } else if (type === 'episode') {
        result = await episodes.deleteOne({ driveFileId: id });
        if (result.deletedCount === 0 && ObjectId.isValid(id)) {
          result = await episodes.deleteOne({ _id: new ObjectId(id) });
        }
      } else {
        return res.status(400).json({ error: 'invalid_type' });
      }

      res.json({ success: true, message: 'Item berhasil dihapus.', deletedCount: result.deletedCount });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  return router;
}
