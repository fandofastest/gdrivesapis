import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { ObjectId } from 'mongodb';
import { connectMongo } from './db.js';
import { createAdminRouter } from './adminRoutes.js';
import { playEvents } from './playEvents.js';

function parseIntParam(v, def) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : def;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function buildSort(sort) {
  switch (String(sort || '').toLowerCase()) {
    case 'latest':
      return { createdAt: -1, _id: -1 };
    case 'year_asc':
      return { year: 1, title: 1 };
    case 'year_desc':
      return { year: -1, title: 1 };
    case 'title_desc':
      return { title: -1, year: 1 };
    case 'title_asc':
    default:
      return { title: 1, year: 1 };
  }
}

function getPlayerBaseUrl() {
  const v = process.env.PLAYER_BASE_URL;
  if (!v || !String(v).trim()) return null;
  return String(v).replace(/\/+$/, '');
}

function getPlayerPathTemplate() {
  const v = process.env.PLAYER_PATH_TEMPLATE;
  return v && String(v).trim() ? String(v) : '/stream/{fileId}';
}

function buildPlayerUrl(fileId) {
  const base = getPlayerBaseUrl();
  if (!base) return null;
  const tpl = getPlayerPathTemplate();
  const p = String(tpl).replaceAll('{fileId}', encodeURIComponent(String(fileId)));
  const path = p.startsWith('/') ? p : `/${p}`;
  return `${base}${path}`;
}

function buildTitleQuery(q) {
  const s = String(q || '').trim();
  if (!s) return null;
  return { $regex: s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
}

function buildExactRegex(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { $regex: `^${escaped}$`, $options: 'i' };
}

function tryParseObjectId(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  if (!ObjectId.isValid(s)) return null;
  // Only accept canonical 24-hex to avoid ObjectId treating other values as valid.
  if (!/^[a-fA-F0-9]{24}$/.test(s)) return null;
  return new ObjectId(s);
}

function normalizeResolution(res) {
  const s = String(res || '').trim().toLowerCase();
  return s || null;
}

function resolutionRank(res) {
  const s = normalizeResolution(res);
  if (!s) return 0;
  if (s.includes('2160') || s.includes('4k')) return 4;
  if (s.includes('1440')) return 3;
  if (s.includes('1080')) return 2;
  if (s.includes('720')) return 1;
  return 0;
}

function pickDriveFileIdFromMovie(doc, preferredResolution) {
  const pref = normalizeResolution(preferredResolution);

  const files = Array.isArray(doc?.files) ? doc.files : [];
  if (files.length) {
    if (pref) {
      const exact = files.find((f) => normalizeResolution(f?.resolution) === pref && typeof f?.driveFileId === 'string');
      if (exact?.driveFileId) return exact.driveFileId;
    }

    const scored = files
      .filter((f) => typeof f?.driveFileId === 'string' && f.driveFileId.trim())
      .map((f) => ({ id: f.driveFileId.trim(), score: resolutionRank(f?.resolution) }))
      .sort((a, b) => b.score - a.score);
    if (scored[0]?.id) return scored[0].id;
  }

  if (typeof doc?.driveFileId === 'string' && doc.driveFileId.trim()) return doc.driveFileId.trim();
  return null;
}

let appPromise;

async function buildApp() {
  const app = express();
  app.disable('x-powered-by');

  // Admin API & Static Admin UI
  app.use('/api/admin', createAdminRouter());

  const publicAdminPath = path.resolve('public/admin');
  app.use('/admin', express.static(publicAdminPath));
  app.get('/admin', (req, res) => {
    res.sendFile(path.join(publicAdminPath, 'index.html'));
  });

  const { db, movies, series, episodes } = await connectMongo();
  const plays = db.collection('plays');

  // Plays indexing:
  // - legacy endpoint (/api/play/:driveFileId) upserts by driveFileId
  // - movie endpoint (/api/play/movie/:movieId) upserts by movieId but still stores the chosen driveFileId
  // Using a single unique index on driveFileId would cause duplicate-key errors when movie plays reuse an existing driveFileId.
  // Split indexes with partial filters.
  const playIndexes = await plays.indexes().catch(() => []);
  const hasLegacyDriveIndex = Array.isArray(playIndexes) && playIndexes.some((i) => i?.name === 'driveFileId_1');
  if (hasLegacyDriveIndex) {
    await plays.dropIndex('driveFileId_1').catch(() => { });
  }

  await plays
    .createIndex(
      { driveFileId: 1 },
      {
        unique: true,
        name: 'driveFileId_1',
        partialFilterExpression: { driveFileId: { $type: 'string' }, movieId: { $exists: false } },
      },
    )
    .catch(() => { });

  await plays
    .createIndex(
      { movieId: 1 },
      {
        unique: true,
        name: 'movieId_1',
        partialFilterExpression: { movieId: { $type: 'string' } },
      },
    )
    .catch(() => { });

  // Health (keep both for convenience when deployed behind /api)
  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });
  app.get('/api/health', (req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/docs', (req, res) => {
    res.json({
      service: 'drive-movie-indexer-api',
      version: 1,
      endpoints: {
        health: {
          method: 'GET',
          path: '/health',
          description: 'Health check',
        },
        docs: {
          method: 'GET',
          path: '/api/docs',
          description: 'JSON documentation for all endpoints',
        },
        genres_list: {
          method: 'GET',
          path: '/api/genres',
          description: 'List distinct genres across movies and series with counts',
        },
        resolve: {
          method: 'GET',
          path: '/api/resolve/:driveFileId',
          description: 'Find which collection contains the provided driveFileId (movies/episodes/series)',
          params: { driveFileId: 'string' },
        },
        movies_list: {
          method: 'GET',
          path: '/api/movies',
          query: {
            page: 'number (default 1)',
            limit: 'number (default 50, max 200)',
            q: 'string (title search, case-insensitive)',
            year: 'number',
            genre: 'string (exact match inside genres[], case-insensitive)',
            resolution: 'string (e.g. 720p/1080p/2160p)',
            sort: 'title_asc|title_desc|year_asc|year_desc|latest',
          },
          fields: {
            tmdbId: 'number|null (TMDB movie id)',
            imdbId: 'string|null (IMDb title id, e.g. tt1234567)',
          },
        },
        movies_get: {
          method: 'GET',
          path: '/api/movies/:driveFileId',
          params: { driveFileId: 'string' },
        },
        series_list: {
          method: 'GET',
          path: '/api/series',
          query: {
            page: 'number (default 1)',
            limit: 'number (default 50, max 200)',
            q: 'string (title search, case-insensitive)',
            year: 'number',
            genre: 'string (exact match inside genres[], case-insensitive)',
            sort: 'title_asc|title_desc|year_asc|year_desc|latest',
          },
          fields: {
            tmdbId: 'number|null (TMDB series id)',
            imdbId: 'string|null (IMDb title id, e.g. tt1234567)',
          },
        },
        series_get: {
          method: 'GET',
          path: '/api/series/:id',
          params: { id: 'string (_id stored in MongoDB; may be ObjectId)' },
        },
        episodes_list: {
          method: 'GET',
          path: '/api/episodes',
          query: {
            page: 'number (default 1)',
            limit: 'number (default 50, max 200)',
            seriesId: 'string',
            season: 'number',
            episode: 'number',
            resolution: 'string (e.g. 720p/1080p/2160p)',
          },
        },
        episodes_get: {
          method: 'GET',
          path: '/api/episodes/:driveFileId',
          params: { driveFileId: 'string' },
        },
        play_redirect: {
          method: 'GET',
          path: '/api/play/:driveFileId',
          description:
            'Logs plays (upsert into plays collection) then redirects (307) to PLAYER_BASE_URL + PLAYER_PATH_TEMPLATE',
          env: {
            PLAYER_BASE_URL: 'required',
            PLAYER_PATH_TEMPLATE: 'optional, default /stream/{fileId}',
          },
        },
        play_movie_redirect: {
          method: 'GET',
          path: '/api/play/movie/:movieId',
          description:
            'Logs plays by movieId then redirects (307) to PLAYER_BASE_URL + PLAYER_PATH_TEMPLATE using one of the driveFileIds inside movie.files[]',
          params: { movieId: 'string (MongoDB _id)' },
          query: { resolution: 'optional (prefer this file resolution if available, e.g. 1080p)' },
          env: {
            PLAYER_BASE_URL: 'required',
            PLAYER_PATH_TEMPLATE: 'optional, default /stream/{fileId}',
          },
        },
      },
      related: {
        streaming_proxy: {
          method: 'GET',
          path: '/stream/:fileId',
          description:
            'Streaming proxy endpoint served by server.js (separate process) with disk cache + Range support.',
        },
      },
    });
  });

  app.get('/api/genres', async (req, res) => {
    try {
      const [movieAgg, seriesAgg] = await Promise.all([
        movies
          .aggregate([
            { $unwind: '$genres' },
            { $match: { genres: { $type: 'string', $ne: '' } } },
            { $group: { _id: { $toLower: '$genres' }, name: { $first: '$genres' }, count: { $sum: 1 } } },
          ])
          .toArray(),
        series
          .aggregate([
            { $unwind: '$genres' },
            { $match: { genres: { $type: 'string', $ne: '' } } },
            { $group: { _id: { $toLower: '$genres' }, name: { $first: '$genres' }, count: { $sum: 1 } } },
          ])
          .toArray(),
      ]);

      const map = new Map();
      for (const row of [...movieAgg, ...seriesAgg]) {
        const key = row?._id;
        if (!key) continue;
        const prev = map.get(key);
        if (!prev) {
          map.set(key, { genre: row.name || key, count: Number(row.count) || 0 });
        } else {
          prev.count += Number(row.count) || 0;
        }
      }

      const items = [...map.values()].sort(
        (a, b) => b.count - a.count || String(a.genre).localeCompare(String(b.genre)),
      );
      res.json({ total: items.length, items });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.get('/api/resolve/:driveFileId', async (req, res) => {
    try {
      const driveFileId = req.params.driveFileId;

      const movie = await movies.findOne(
        { $or: [{ driveFileId }, { 'files.driveFileId': driveFileId }] },
        { projection: { _id: 1, title: 1, year: 1, imdbId: 1, tmdbId: 1, files: 1 } },
      );
      if (movie) return res.json({ type: 'movie', item: movie });

      const episode = await episodes.findOne(
        { driveFileId },
        { projection: { _id: 1, driveFileId: 1, seriesId: 1, season: 1, episode: 1, episodeTitle: 1 } },
      );
      if (episode) return res.json({ type: 'episode', item: episode });

      const seriesDoc = await series.findOne(
        { driveFileId },
        { projection: { _id: 1, driveFileId: 1, title: 1, year: 1 } },
      );
      if (seriesDoc) return res.json({ type: 'series', item: seriesDoc });

      return res.status(404).json({ error: 'not_found' });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.get('/api/movies', async (req, res) => {
    try {
      const page = clamp(parseIntParam(req.query.page, 1), 1, 1_000_000);
      const limit = clamp(parseIntParam(req.query.limit, 50), 1, 200);
      const skip = (page - 1) * limit;

      const sort = buildSort(req.query.sort);
      const q = buildTitleQuery(req.query.q);

      const filter = {};
      if (q) filter.title = q;
      if (req.query.year) filter.year = parseIntParam(req.query.year, undefined);
      if (req.query.genre) {
        const g = buildExactRegex(req.query.genre);
        if (g) filter.genres = g;
      }
      if (req.query.resolution) {
        const r = String(req.query.resolution).trim().toLowerCase();
        // Support both legacy schema (root resolution) and normalized multi-file schema (files[].resolution)
        filter.$or = [{ resolution: r }, { 'files.resolution': r }];
      }

      const cursor = movies.find(filter).sort(sort).skip(skip).limit(limit);
      const items = await cursor.toArray();
      const total = await movies.countDocuments(filter);

      res.json({ page, limit, total, items });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.get('/api/movies/:driveFileId', async (req, res) => {
    try {
      const param = req.params.driveFileId;
      const oid = tryParseObjectId(param);
      const doc = oid
        ? await movies.findOne({ _id: oid })
        : await movies.findOne({ $or: [{ driveFileId: param }, { 'files.driveFileId': param }] });
      if (!doc) return res.status(404).json({ error: 'not_found' });
      res.json(doc);
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.get('/api/series', async (req, res) => {
    try {
      const page = clamp(parseIntParam(req.query.page, 1), 1, 1_000_000);
      const limit = clamp(parseIntParam(req.query.limit, 50), 1, 200);
      const skip = (page - 1) * limit;

      const sort = buildSort(req.query.sort);
      const q = buildTitleQuery(req.query.q);

      const filter = {};
      if (q) filter.title = q;
      if (req.query.year) filter.year = parseIntParam(req.query.year, undefined);
      if (req.query.genre) {
        const g = buildExactRegex(req.query.genre);
        if (g) filter.genres = g;
      }

      const cursor = series.find(filter).sort(sort).skip(skip).limit(limit);
      const items = await cursor.toArray();
      const total = await series.countDocuments(filter);

      res.json({ page, limit, total, items });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.get('/api/series/:id', async (req, res) => {
    try {
      const id = req.params.id;
      const oid = tryParseObjectId(id);
      const doc = await series.findOne({ _id: oid ?? id });
      if (!doc) return res.status(404).json({ error: 'not_found' });
      res.json(doc);
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.get('/api/episodes', async (req, res) => {
    try {
      const page = clamp(parseIntParam(req.query.page, 1), 1, 1_000_000);
      const limit = clamp(parseIntParam(req.query.limit, 50), 1, 200);
      const skip = (page - 1) * limit;

      const filter = {};
      if (req.query.seriesId) {
        const oid = tryParseObjectId(req.query.seriesId);
        filter.seriesId = oid ?? req.query.seriesId;
      }
      if (req.query.season) filter.season = parseIntParam(req.query.season, undefined);
      if (req.query.episode) filter.episode = parseIntParam(req.query.episode, undefined);
      if (req.query.resolution) {
        filter.resolution = String(req.query.resolution).trim().toLowerCase();
      }

      const cursor = episodes
        .find(filter)
        .sort({ seriesId: 1, season: 1, episode: 1 })
        .skip(skip)
        .limit(limit);

      const items = await cursor.toArray();
      const total = await episodes.countDocuments(filter);

      res.json({ page, limit, total, items });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.get('/api/episodes/:driveFileId', async (req, res) => {
    try {
      const doc = await episodes.findOne({ driveFileId: req.params.driveFileId });
      if (!doc) return res.status(404).json({ error: 'not_found' });
      res.json(doc);
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.get('/api/play/:driveFileId', async (req, res) => {
    try {
      const driveFileId = req.params.driveFileId;
      const url = buildPlayerUrl(driveFileId);
      if (!url) return res.status(500).json({ error: 'missing_PLAYER_BASE_URL' });

      const now = new Date();

      const playRes = await plays.findOneAndUpdate(
        { driveFileId },
        {
          $inc: { playCount: 1 },
          $set: { lastPlayedAt: now },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true, returnDocument: 'after' },
      );

      const contentUpdate = { $inc: { playCount: 1 }, $set: { lastPlayedAt: now } };
      const matchedMovie = await movies
        .findOneAndUpdate({ $or: [{ driveFileId }, { 'files.driveFileId': driveFileId }] }, contentUpdate, { returnDocument: 'after' })
        .catch(() => null);
      const matchedEpisode = !matchedMovie
        ? await episodes.findOneAndUpdate({ driveFileId }, contentUpdate, { returnDocument: 'after' }).catch(() => null)
        : null;

      let title = driveFileId;
      let mediaType = 'unknown';
      let resolution = null;

      if (matchedMovie?.value || matchedMovie?.title) {
        const m = matchedMovie.value || matchedMovie;
        title = m.title || driveFileId;
        mediaType = 'movie';
        resolution = m.resolution || null;
      } else if (matchedEpisode?.value || matchedEpisode?.title) {
        const ep = matchedEpisode.value || matchedEpisode;
        title = ep.title || ep.episodeTitle || ep.fileName || driveFileId;
        mediaType = 'episode';
        resolution = ep.resolution || null;
      }

      const currentCount = playRes?.value?.playCount || playRes?.playCount || 1;
      playEvents.emitPlay({
        mediaType,
        title,
        driveFileId,
        resolution,
        playCount: currentCount,
      });

      res.status(307);
      res.setHeader('Location', url);
      res.end();
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.get('/api/play/movie/:movieId', async (req, res) => {
    try {
      const movieId = req.params.movieId;
      const oid = tryParseObjectId(movieId);
      if (!oid) return res.status(400).json({ error: 'invalid_movieId' });

      const movie = await movies.findOne({ _id: oid });
      if (!movie) return res.status(404).json({ error: 'not_found' });

      const chosenDriveFileId = pickDriveFileIdFromMovie(movie, req.query.resolution);
      if (!chosenDriveFileId) return res.status(404).json({ error: 'no_files' });

      const url = buildPlayerUrl(chosenDriveFileId);
      if (!url) return res.status(500).json({ error: 'missing_PLAYER_BASE_URL' });

      const now = new Date();

      const playRes = await plays.findOneAndUpdate(
        { movieId },
        {
          $inc: { playCount: 1 },
          $set: { lastPlayedAt: now, driveFileId: chosenDriveFileId },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true, returnDocument: 'after' },
      );

      const contentUpdate = { $inc: { playCount: 1 }, $set: { lastPlayedAt: now } };
      await movies.updateOne({ _id: oid }, contentUpdate).catch(() => { });

      const currentCount = playRes?.value?.playCount || playRes?.playCount || (movie.playCount || 0) + 1;
      playEvents.emitPlay({
        mediaType: 'movie',
        title: movie.title,
        movieId,
        driveFileId: chosenDriveFileId,
        resolution: req.query.resolution || movie.resolution || null,
        playCount: currentCount,
      });

      res.status(307);
      res.setHeader('Location', url);
      res.end();
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  return app;
}

export async function getApp() {
  if (!appPromise) appPromise = buildApp();
  return appPromise;
}
