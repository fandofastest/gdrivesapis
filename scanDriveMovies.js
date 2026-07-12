import 'dotenv/config';
import fs from 'node:fs/promises';
import { google } from 'googleapis';
import { MongoClient } from 'mongodb';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { pathToFileURL } from 'node:url';

const VIDEO_EXTENSIONS = new Set(['mkv', 'mp4', 'avi', 'mov']);

// TMDB image base URLs
const TMDB_POSTER_BASE = 'https://image.tmdb.org/t/p/w500';
const TMDB_BACKDROP_BASE = 'https://image.tmdb.org/t/p/original';

const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

const DEBUG = String(process.env.DEBUG || '').trim() === '1';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

async function enrichMetadata({ mongoUri, tmdbApiKey }) {
  const { client, movies, series } = await connectMongo(mongoUri);
  const limit = createLimiter(Number(process.env.CONCURRENCY || '5'));

  let updatedMovies = 0;
  let updatedSeries = 0;
  let scannedMovies = 0;
  let scannedSeries = 0;

  try {
    console.log('[enrich] start movies');
    const movieCursor = movies.find({
      $or: [
        { overview: null },
        { poster: null },
        { genres: { $size: 0 } },
        { tmdbId: null },
        { tmdbId: { $exists: false } },
        { imdbId: null },
        { imdbId: { $exists: false } },
      ],
    });
    const movieTasks = [];
    while (await movieCursor.hasNext()) {
      const doc = await movieCursor.next();
      if (!doc?.driveFileId) continue;
      scannedMovies += 1;

      movieTasks.push(
        limit(async () => {
          const tmdb = await fetchTMDBMetadata({ title: doc.title, year: doc.year, tmdbApiKey });
          if (!tmdb) return;
          await movies.updateOne(
            { driveFileId: doc.driveFileId },
            {
              $set: {
                title: tmdb.officialTitle ?? doc.title,
                overview: tmdb.overview ?? doc.overview,
                genres: tmdb.genres ?? doc.genres,
                rating: tmdb.voteAverage ?? doc.rating,
                poster: tmdb.posterUrl ?? doc.poster,
                backdrop: tmdb.backdropUrl ?? doc.backdrop,
                tmdbId: tmdb.tmdbId ?? doc.tmdbId ?? null,
                imdbId: tmdb.imdbId ?? doc.imdbId ?? null,
              },
            },
          );
          updatedMovies += 1;
        }),
      );

      if (movieTasks.length >= 200) {
        await Promise.allSettled(movieTasks.splice(0, movieTasks.length));
        console.log(`[enrich] movies scanned=${scannedMovies} updated=${updatedMovies}`);
      }
    }
    if (movieTasks.length) {
      await Promise.allSettled(movieTasks);
      console.log(`[enrich] movies scanned=${scannedMovies} updated=${updatedMovies}`);
    }

    console.log('[enrich] start series');
    const seriesCursor = series.find({
      $or: [
        { overview: null },
        { poster: null },
        { genres: { $size: 0 } },
        { tmdbId: null },
        { tmdbId: { $exists: false } },
        { imdbId: null },
        { imdbId: { $exists: false } },
      ],
    });
    const seriesTasks = [];
    while (await seriesCursor.hasNext()) {
      const doc = await seriesCursor.next();
      if (!doc?._id) continue;
      scannedSeries += 1;
      seriesTasks.push(
        limit(async () => {
          const tmdb = await fetchTMDBSeriesMetadata({ title: doc.title, year: doc.year, tmdbApiKey });
          if (!tmdb) return;
          await series.updateOne(
            { _id: doc._id },
            {
              $set: {
                title: tmdb.officialTitle ?? doc.title,
                overview: tmdb.overview ?? doc.overview,
                genres: tmdb.genres ?? doc.genres,
                rating: tmdb.voteAverage ?? doc.rating,
                poster: tmdb.posterUrl ?? doc.poster,
                backdrop: tmdb.backdropUrl ?? doc.backdrop,
                tmdbId: tmdb.tmdbId ?? doc.tmdbId ?? null,
                imdbId: tmdb.imdbId ?? doc.imdbId ?? null,
              },
            },
          );
          updatedSeries += 1;
        }),
      );

      if (seriesTasks.length >= 200) {
        await Promise.allSettled(seriesTasks.splice(0, seriesTasks.length));
        console.log(`[enrich] series scanned=${scannedSeries} updated=${updatedSeries}`);
      }
    }
    if (seriesTasks.length) {
      await Promise.allSettled(seriesTasks);
      console.log(`[enrich] series scanned=${scannedSeries} updated=${updatedSeries}`);
    }

    console.log(`[enrich] updated movies=${updatedMovies} series=${updatedSeries}`);
  } finally {
    await client.close();
  }
}

async function fetchTMDBSeriesMetadata({ title, year, tmdbApiKey }) {
  const query = encodeURIComponent(title);
  const firstAirDateYear = year ? `&first_air_date_year=${encodeURIComponent(String(year))}` : '';
  const searchUrl = `https://api.themoviedb.org/3/search/tv?api_key=${encodeURIComponent(
    tmdbApiKey,
  )}&query=${query}${firstAirDateYear}&include_adult=false`;

  const search = await fetchJsonWithBackoff(searchUrl);
  const first = search?.results?.[0];
  if (!first?.id) return null;

  const detailsUrl = `https://api.themoviedb.org/3/tv/${encodeURIComponent(
    String(first.id),
  )}?api_key=${encodeURIComponent(tmdbApiKey)}`;

  const details = await fetchJsonWithBackoff(detailsUrl);

  const externalIdsUrl = `https://api.themoviedb.org/3/tv/${encodeURIComponent(
    String(first.id),
  )}/external_ids?api_key=${encodeURIComponent(tmdbApiKey)}`;
  const externalIds = await fetchJsonWithBackoff(externalIdsUrl).catch(() => null);

  return {
    tmdbId: first.id,
    imdbId: typeof externalIds?.imdb_id === 'string' ? externalIds.imdb_id : null,
    officialTitle: details?.name ?? null,
    overview: details?.overview ?? null,
    releaseDate: details?.first_air_date ?? null,
    genres: Array.isArray(details?.genres) ? details.genres.map((g) => g.name).filter(Boolean) : [],
    voteAverage: typeof details?.vote_average === 'number' ? details.vote_average : null,
    posterUrl: details?.poster_path ? `${TMDB_POSTER_BASE}${details.poster_path}` : null,
    backdropUrl: details?.backdrop_path ? `${TMDB_BACKDROP_BASE}${details.backdrop_path}` : null,
  };
}

function normalizeTitleForMatch(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleSimilarity(a, b) {
  const na = normalizeTitleForMatch(a);
  const nb = normalizeTitleForMatch(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const aTokens = new Set(na.split(' ').filter(Boolean));
  const bTokens = new Set(nb.split(' ').filter(Boolean));
  if (!aTokens.size || !bTokens.size) return 0;
  let inter = 0;
  for (const t of aTokens) if (bTokens.has(t)) inter += 1;
  const union = aTokens.size + bTokens.size - inter;
  return union ? inter / union : 0;
}

function yearFromDateString(s) {
  const m = String(s || '').match(/^(19\d{2}|20\d{2})/);
  return m ? Number(m[1]) : null;
}

export async function findOrCreateSeries({ seriesCol, tmdbApiKey, seriesCache, title, year, fetchMetadata }) {
  const key = `${title}::${year || ''}`;
  if (seriesCache.has(key)) return seriesCache.get(key);

  const tmdb = fetchMetadata ? await fetchTMDBSeriesMetadata({ title, year, tmdbApiKey }) : null;
  if (fetchMetadata) {
    if (tmdb) {
      console.log(`[tmdb] series metadata fetched: ${tmdb.officialTitle ?? title} (${tmdb.releaseDate ?? year ?? 'n/a'})`);
    } else {
      console.log(`[tmdb] no series match for: ${title}${year ? ` (${year})` : ''}`);
    }
  }

  const finalTitle = tmdb?.officialTitle ?? title;
  const doc = {
    title: finalTitle,
    year: year ?? null,
    overview: tmdb?.overview ?? null,
    genres: tmdb?.genres ?? [],
    rating: tmdb?.voteAverage ?? null,
    poster: tmdb?.posterUrl ?? null,
    backdrop: tmdb?.backdropUrl ?? null,
    tmdbId: tmdb?.tmdbId ?? null,
    imdbId: tmdb?.imdbId ?? null,
    createdAt: new Date(),
  };

  // Upsert to avoid races under concurrency.
  await seriesCol.updateOne(
    { title: finalTitle, year: year ?? null },
    { $setOnInsert: doc },
    { upsert: true },
  );

  const stored = await seriesCol.findOne({ title: finalTitle, year: year ?? null });
  if (!stored?._id) throw new Error(`Failed to upsert series: ${finalTitle}`);

  seriesCache.set(key, stored);
  return stored;
}

export async function insertEpisode({ episodesCol, seriesId, season, episode, episodeTitle, fileName, driveFileId, driveLink, fileSize, resolution }) {
  const doc = {
    seriesId,
    season,
    episode,
    title: episodeTitle ?? null,
    fileName,
    driveFileId,
    driveLink,
    fileSize,
    resolution,
    createdAt: new Date(),
  };

  const res = await episodesCol.updateOne(
    { driveFileId },
    { $setOnInsert: doc },
    { upsert: true },
  );

  if (res.upsertedCount === 1) {
    console.log(
      `[db] episode saved: series=${seriesId} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')} [${driveFileId}]`,
    );
  }

  return res.upsertedCount === 1;
}

function parseMovieFolderName(folderName) {
  // Examples:
  // - Avatar (2009)
  // - Dua Hati Biru (2024)
  // - Some Title (Unknown Year) -> return null
  const normalized = String(folderName).replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const m = normalized.match(/^(.*?)\s*\((19\d{2}|20\d{2})\)\s*$/);
  if (!m) return null;
  const title = m[1].trim();
  const year = Number(m[2]);
  if (!title) return null;
  return { title: toTitleCase(title), year };
}

function envOrDefault(name, defaultValue) {
  const v = process.env[name];
  return v && String(v).trim() ? v : defaultValue;
}

function getIndexMode() {
  const mode = String(envOrDefault('INDEX_MODE', 'full')).toLowerCase();
  if (mode === 'raw' || mode === 'full' || mode === 'enrich' || mode === 'migrate') return mode;
  throw new Error(`Invalid INDEX_MODE: ${mode}. Use raw|full|enrich|migrate`);
}

async function migrateMisclassifiedEpisodes({ mongoUri, tmdbApiKey }) {
  const { client, movies, series, episodes } = await connectMongo(mongoUri);
  const limit = createLimiter(Number(process.env.CONCURRENCY || '5'));

  const dryRun = String(process.env.MIGRATE_DRY_RUN || '').trim() === '1';
  const seriesCache = new Map();

  let scanned = 0;
  let candidates = 0;
  let migrated = 0;
  let skippedDuplicate = 0;
  let skippedNotEpisode = 0;

  try {
    console.log(`[migrate] start (dryRun=${dryRun})`);

    const cursor = movies.find({}, { projection: { driveFileId: 1, fileName: 1, driveLink: 1, fileSize: 1, resolution: 1, title: 1, year: 1, createdAt: 1 } });
    const tasks = [];

    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      scanned += 1;

      const fileName = doc?.fileName || '';
      const driveFileId = doc?.driveFileId;
      if (!driveFileId) continue;

      const ep = parseEpisodeInfo(fileName);
      if (!ep) {
        skippedNotEpisode += 1;
        continue;
      }

      candidates += 1;

      tasks.push(
        limit(async () => {
          // If episode already exists, don't migrate/delete movie record.
          const existingEp = await episodes.findOne({ driveFileId }, { projection: { _id: 1 } });
          if (existingEp) {
            skippedDuplicate += 1;
            return;
          }

          const seriesTitle = doc.title || parseSeriesTitleFromFilename(fileName, ep);
          if (!seriesTitle) return;

          const seriesYear = typeof doc.year === 'number' ? doc.year : null;
          const seriesDoc = await findOrCreateSeries({
            seriesCol: series,
            tmdbApiKey,
            seriesCache,
            title: seriesTitle,
            year: seriesYear,
            fetchMetadata: false,
          });

          const inserted = dryRun
            ? true
            : await insertEpisode({
                episodesCol: episodes,
                seriesId: seriesDoc._id,
                season: ep.season,
                episode: ep.episode,
                episodeTitle: null,
                fileName,
                driveFileId,
                driveLink: doc.driveLink || buildDriveFileLink(driveFileId),
                fileSize: typeof doc.fileSize === 'number' ? doc.fileSize : null,
                resolution: doc.resolution || parseResolutionFromText(fileName),
              });

          if (!inserted) {
            skippedDuplicate += 1;
            return;
          }

          if (!dryRun) {
            await movies.deleteOne({ driveFileId });
          }

          migrated += 1;
        }),
      );

      if (tasks.length >= 500) {
        await Promise.allSettled(tasks.splice(0, tasks.length));
        console.log(`[migrate] scanned=${scanned} candidates=${candidates} migrated=${migrated} skipped_duplicate=${skippedDuplicate} skipped_not_episode=${skippedNotEpisode}`);
      }
    }

    if (tasks.length) {
      await Promise.allSettled(tasks);
    }

    console.log(`[migrate] done scanned=${scanned} candidates=${candidates} migrated=${migrated} skipped_duplicate=${skippedDuplicate} skipped_not_episode=${skippedNotEpisode}`);
  } finally {
    await client.close();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFileExtension(fileName) {
  const m = /\.([^.]+)$/.exec(fileName);
  return m ? m[1].toLowerCase() : '';
}

function parseResolutionFromText(text) {
  const resMatch = String(text).match(/\b(720p|1080p|2160p)\b/i);
  return resMatch ? resMatch[1].toLowerCase() : null;
}

export function detectMediaType(fileName) {
  return parseEpisodeInfo(fileName) ? 'episode' : 'movie';
}

function normalizeSeparators(inputText) {
  return String(inputText)
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripCommonTags(text) {
  // Remove common quality/source tags that can confuse title parsing
  return String(text)
    .replace(/\b(480p|720p|1080p|2160p|4k|8k)\b/gi, ' ')
    .replace(/\b(x264|x265|h\.?264|h\.?265|hevc|aac|dts|ddp?5\.1|bluray|b[dr]rip|webrip|webdl|hdr|dv|dolby\s*vision)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detect and parse episode info.
 * Supported patterns:
 * - S01E01, S1E2
 * - EP01, EP 01
 * - Episode 01
 */
export function parseEpisodeInfo(fileName) {
  const base = normalizeSeparators(fileName.replace(/\.[^.]+$/, ''));

  // SxxEyy
  let m = base.match(/\bS(\d{1,2})\s*E(\d{1,4})\b/i);
  if (m) {
    return {
      season: Number(m[1]),
      episode: Number(m[2]),
      token: m[0],
    };
  }

  // EPxx
  m = base.match(/\bEP\s*(\d{1,4})\b/i);
  if (m) {
    return {
      season: 1,
      episode: Number(m[1]),
      token: m[0],
    };
  }

  // Episode xx
  m = base.match(/\bEpisode\s*(\d{1,4})\b/i);
  if (m) {
    return {
      season: 1,
      episode: Number(m[1]),
      token: m[0],
    };
  }

  return null;
}

function parseSeriesTitleFromFilename(fileName, episodeInfo) {
  const ext = getFileExtension(fileName);
  const base0 = ext ? fileName.slice(0, -(ext.length + 1)) : fileName;
  const base = stripCommonTags(normalizeSeparators(base0));

  // Remove the episode token and anything after it (often release groups / extra info)
  const tokenIdx = episodeInfo?.token ? base.toLowerCase().indexOf(episodeInfo.token.toLowerCase()) : -1;
  const head = tokenIdx >= 0 ? base.slice(0, tokenIdx).trim() : base;
  const yearMatch = head.match(/\b(19\d{2}|20\d{2})\b/);
  const titlePart = yearMatch ? head.slice(0, yearMatch.index).trim() : head;
  return titlePart ? toTitleCase(titlePart) : null;
}

function toTitleCase(input) {
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Parse filenames like:
 * - Oppenheimer.2023.2160p.WEBRip.mkv
 * - Avengers.Endgame.2019.1080p.BluRay.x264.mkv
 * - The.Dark.Knight.2008.1080p.mkv
 *
 * Returns { title, year, resolution } or null if not confidently detected.
 */
export function parseMovieFilename(fileName) {
  const ext = getFileExtension(fileName);
  const base = ext ? fileName.slice(0, -(ext.length + 1)) : fileName;

  // Normalize separators into spaces (keep parentheses so "(2023)" works)
  const normalized = normalizeSeparators(base);

  const yearMatch = normalized.match(/(?:\(|\b)(19\d{2}|20\d{2})(?:\)|\b)/);
  if (!yearMatch) return null;

  const year = Number(yearMatch[1]);

  const resolution = parseResolutionFromText(normalized);

  // Title is typically before the year token
  const yearIdx = yearMatch.index ?? normalized.indexOf(yearMatch[0]);
  const rawTitle = normalized.slice(0, yearIdx).trim();
  if (!rawTitle) return null;

  // Remove trailing opening bracket if the year match was "(2023" style
  const cleanedTitle = rawTitle.replace(/[\[(]$/g, '').trim();

  return {
    title: toTitleCase(cleanedTitle),
    year,
    resolution,
  };
}

async function fetchJsonWithBackoff(url, { maxRetries = 5 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
      },
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') || '0');
      const delayMs = retryAfter > 0 ? retryAfter * 1000 : 500 * Math.pow(2, attempt);
      await sleep(Math.min(delayMs, 10_000));
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} for ${url}${text ? `: ${text}` : ''}`);
    }

    return res.json();
  }

  throw new Error(`Too many retries for ${url}`);
}

/**
 * Fetch movie metadata from TMDB.
 * Strategy:
 * 1) Search movie by title + year
 * 2) Fetch full movie details by id
 */
export async function fetchTMDBMetadata({ title, year, tmdbApiKey }) {
  const query = encodeURIComponent(title);

  const buildSearchUrl = (withYear) => {
    const y = withYear && Number.isFinite(year) ? `&year=${encodeURIComponent(String(year))}` : '';
    return `https://api.themoviedb.org/3/search/movie?api_key=${encodeURIComponent(
      tmdbApiKey,
    )}&query=${query}${y}&include_adult=false`;
  };

  const search1 = await fetchJsonWithBackoff(buildSearchUrl(true));
  let results = Array.isArray(search1?.results) ? search1.results : [];

  if (!results.length) {
    const search2 = await fetchJsonWithBackoff(buildSearchUrl(false));
    results = Array.isArray(search2?.results) ? search2.results : [];
  }

  const candidates = results.slice(0, 10).filter((r) => r && r.id);
  if (!candidates.length) return null;

  let best = null;
  let bestScore = -1;

  for (const c of candidates) {
    const tScore = titleSimilarity(title, c.title || c.original_title || '');
    let yScore = 0;
    if (Number.isFinite(year)) {
      const cy = yearFromDateString(c.release_date);
      if (typeof cy === 'number' && Number.isFinite(cy)) {
        const diff = Math.abs(cy - year);
        yScore = Math.max(0, 1 - diff / 5);
      }
    }

    const score = tScore * 0.85 + yScore * 0.15 + (typeof c.popularity === 'number' ? Math.min(1, c.popularity / 100) * 0.02 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  if (!best?.id) return null;

  const detailsUrl = `https://api.themoviedb.org/3/movie/${encodeURIComponent(
    String(best.id),
  )}?api_key=${encodeURIComponent(tmdbApiKey)}`;

  const details = await fetchJsonWithBackoff(detailsUrl);

  return {
    tmdbId: best.id,
    imdbId: typeof details?.imdb_id === 'string' ? details.imdb_id : null,
    officialTitle: details?.title ?? null,
    overview: details?.overview ?? null,
    releaseDate: details?.release_date ?? null,
    genres: Array.isArray(details?.genres) ? details.genres.map((g) => g.name).filter(Boolean) : [],
    voteAverage: typeof details?.vote_average === 'number' ? details.vote_average : null,
    posterUrl: details?.poster_path ? `${TMDB_POSTER_BASE}${details.poster_path}` : null,
    backdropUrl: details?.backdrop_path ? `${TMDB_BACKDROP_BASE}${details.backdrop_path}` : null,
  };
}

function createLimiter(maxConcurrent) {
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= maxConcurrent) return;
    const item = queue.shift();
    if (!item) return;

    active += 1;
    item()
      .catch(() => {})
      .finally(() => {
        active -= 1;
        next();
      });
  };

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push(async () => {
        try {
          const r = await fn();
          resolve(r);
        } catch (e) {
          reject(e);
        }
      });
      next();
    });
  };
}

function buildDriveFileLink(fileId) {
  return `https://drive.google.com/file/d/${fileId}/view`;
}

async function connectMongo(mongoUri) {
  const client = new MongoClient(mongoUri, {
    maxPoolSize: 20,
  });

  await client.connect();
  const db = client.db();
  const movies = db.collection('movies');
  const series = db.collection('series');
  const episodes = db.collection('episodes');

  // Ensure dedupe by driveFileId.
  // movies: use partialFilterExpression because normalized movies have driveFileId unset/null.
  const movieIndexes = await movies.indexes().catch(() => []);
  const hasLegacyMovieDriveIndex = Array.isArray(movieIndexes) && movieIndexes.some((i) => i?.name === 'driveFileId_1');
  if (hasLegacyMovieDriveIndex) {
    const legacyIndex = movieIndexes.find((i) => i?.name === 'driveFileId_1');
    if (!legacyIndex?.partialFilterExpression) {
      await movies.dropIndex('driveFileId_1').catch(() => {});
    }
  }
  await movies
    .createIndex(
      { driveFileId: 1 },
      {
        unique: true,
        name: 'driveFileId_1',
        partialFilterExpression: { driveFileId: { $type: 'string' } },
      },
    )
    .catch(() => {});

  await episodes.createIndex({ driveFileId: 1 }, { unique: true });

  // Helpful indexes
  await series.createIndex({ title: 1, year: 1 }, { unique: true });
  await episodes.createIndex({ seriesId: 1, season: 1, episode: 1 });

  return { client, db, movies, series, episodes };
}

function createDriveClient() {
  throw new Error('createDriveClient() is replaced by OAuth2. Use createDriveClientOAuth2().');
}

async function loadOAuthClientFromCredentialsFile(credentialsPath) {
  let raw;
  try {
    raw = await fs.readFile(credentialsPath, 'utf8');
  } catch (e) {
    throw new Error(
      `Unable to read OAuth credentials file at ${credentialsPath}. Set GOOGLE_OAUTH_CREDENTIALS to a valid path.`,
    );
  }

  if (!raw || !String(raw).trim()) {
    throw new Error(
      `OAuth credentials file at ${credentialsPath} is empty. Download an OAuth Client (Desktop app) JSON from Google Cloud Console.`,
    );
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`OAuth credentials file at ${credentialsPath} is not valid JSON.`);
  }

  // Google "Desktop app" credentials are usually under "installed".
  const cfg = json.installed || json.web;
  if (!cfg?.client_id || !cfg?.client_secret) {
    throw new Error(
      `Invalid OAuth credentials file at ${credentialsPath}. Expected { installed: { client_id, client_secret, redirect_uris } }`,
    );
  }

  const redirectUri = Array.isArray(cfg.redirect_uris) && cfg.redirect_uris.length > 0 ? cfg.redirect_uris[0] : undefined;
  if (!redirectUri) {
    throw new Error(`OAuth credentials missing redirect_uris in ${credentialsPath}`);
  }

  return new google.auth.OAuth2(cfg.client_id, cfg.client_secret, redirectUri);
}

async function loadSavedToken(tokenPath) {
  try {
    const raw = await fs.readFile(tokenPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveToken(tokenPath, token) {
  const dir = path.dirname(tokenPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tokenPath, JSON.stringify(token, null, 2), 'utf8');
}

async function authorizeDriveOAuth2({ credentialsPath, tokenPath: tokenPathInput }) {
  const tokenPath = tokenPathInput;
  const oauth2Client = await loadOAuthClientFromCredentialsFile(credentialsPath);

  const saved = await loadSavedToken(tokenPath);
  if (saved) {
    oauth2Client.setCredentials(saved);
    return oauth2Client;
  }

  const scopes = ['https://www.googleapis.com/auth/drive.readonly'];
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent',
  });

  console.log('[auth] Open this URL in your browser to authorize:');
  console.log(authUrl);

  const rl = readline.createInterface({ input, output });
  try {
    const code = await rl.question('[auth] Paste the authorization code here: ');
    const { tokens } = await oauth2Client.getToken(code.trim());
    oauth2Client.setCredentials(tokens);
    await saveToken(tokenPath, tokens);
    console.log(`[auth] Token saved to ${tokenPath}`);
    return oauth2Client;
  } finally {
    rl.close();
  }
}

async function createDriveClientOAuth2() {
  const credentialsPath = envOrDefault('GOOGLE_OAUTH_CREDENTIALS', path.resolve('credentials.json'));
  const tokenPath = envOrDefault('GOOGLE_OAUTH_TOKEN_PATH', path.resolve('token.json'));

  const auth = await authorizeDriveOAuth2({ credentialsPath, tokenPath });
  return google.drive({ version: 'v3', auth });
}

/**
 * Scan Google Drive for movie files inside DRIVE_FOLDER_ID and index into MongoDB.
 *
 * Notes for large libraries:
 * - Uses Drive pagination via nextPageToken
 * - Limits concurrent processing to avoid overwhelming TMDB/Mongo
 * - Dedupes by driveFileId
 */
export async function scanDriveMovies({ driveFolderId, tmdbApiKey, mongoUri }) {
  const drive = await createDriveClientOAuth2();
  const { client, movies, series, episodes } = await connectMongo(mongoUri);

  const mode = getIndexMode();
  const fetchMetadata = mode !== 'raw';

  const tmdbMovieCache = new Map();
  const seriesCache = new Map();
  const limit = createLimiter(Number(process.env.CONCURRENCY || '5'));

  let scanned = 0;
  let detected = 0;
  let saved = 0;
  let skipped = 0;
  let skippedNonVideo = 0;
  let skippedParseFailed = 0;
  let skippedDuplicate = 0;
  let skippedFolder = 0;
  let scannedFolders = 0;
  let discoveredFolders = 0;

  let pagesFetched = 0;
  const folderInfoById = new Map();

  const foldersToScan = [driveFolderId];
  const seenFolders = new Set();

  try {
    while (foldersToScan.length > 0) {
      const folderId = foldersToScan.shift();
      if (!folderId || seenFolders.has(folderId)) continue;
      seenFolders.add(folderId);
      scannedFolders += 1;

      let pageToken = undefined;
      do {
        const res = await drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: 'nextPageToken, files(id, name, mimeType, size, webViewLink)',
          pageSize: 1000,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });

        pagesFetched += 1;

        const files = res.data.files || [];
        pageToken = res.data.nextPageToken || undefined;

        scanned += files.length;
        if (DEBUG || pagesFetched % 10 === 0) {
          console.log(
            `[scan] folder=${folderId} page_items=${files.length} scanned_items=${scanned} folders_scanned=${scannedFolders} queue=${foldersToScan.length}`,
          );
        }

        const tasks = files.map((f) =>
          limit(async () => {
            const name = f.name || '';
            const mimeType = f.mimeType || '';
            const id = f.id || '';

            if (mimeType === DRIVE_FOLDER_MIME) {
              if (id && !seenFolders.has(id)) {
                foldersToScan.push(id);
                discoveredFolders += 1;
                const folderParsed = parseMovieFolderName(name);
                if (folderParsed) folderInfoById.set(id, folderParsed);
                if (DEBUG) console.log(`[scan] discovered folder: ${name} [${id}]`);
              }
              skipped += 1;
              skippedFolder += 1;
              return;
            }

            const ext = getFileExtension(name);
            if (!VIDEO_EXTENSIONS.has(ext)) {
              skipped += 1;
              skippedNonVideo += 1;
              return;
            }

            const mediaType = detectMediaType(name);

            const driveFileId = id;
            if (!driveFileId) {
              skipped += 1;
              return;
            }

            const driveLink = f.webViewLink || buildDriveFileLink(driveFileId);
            const fileSize = f.size ? Number(f.size) : null;
            const resolution = parseResolutionFromText(name);

            if (mediaType === 'episode') {
              const episodeInfo = parseEpisodeInfo(name);
              const folderParsed = folderInfoById.get(folderId) || null;
              const seriesTitle =
                parseSeriesTitleFromFilename(name, episodeInfo) ||
                (folderParsed ? folderParsed.title : null);

              if (!seriesTitle || !episodeInfo) {
                skipped += 1;
                skippedParseFailed += 1;
                if (DEBUG) console.log(`[skip] episode parse failed: ${name}`);
                return;
              }

              detected += 1;
              console.log(
                `[detect] series=${seriesTitle} S${String(episodeInfo.season).padStart(2, '0')}E${String(episodeInfo.episode).padStart(2, '0')} -> ${name}`,
              );

              const seriesYear = folderParsed?.year ?? null;
              const seriesDoc = await findOrCreateSeries({
                seriesCol: series,
                tmdbApiKey,
                seriesCache,
                title: seriesTitle,
                year: seriesYear,
                fetchMetadata,
              });

              const epInserted = await insertEpisode({
                episodesCol: episodes,
                seriesId: seriesDoc._id,
                season: episodeInfo.season,
                episode: episodeInfo.episode,
                episodeTitle: null,
                fileName: name,
                driveFileId,
                driveLink,
                fileSize,
                resolution,
              });

              if (epInserted) {
                saved += 1;
              } else {
                skipped += 1;
                skippedDuplicate += 1;
              }
              return;
            }

            // Movie path
            // Prefer parsing from filename; if it lacks year, fall back to parent folder name like "Avatar (2009)".
            const parsedFromFile = parseMovieFilename(name);
            const parsedFromFolder = folderInfoById.get(folderId) || null;

            const parsed =
              parsedFromFile ||
              (parsedFromFolder
                ? {
                    title: parsedFromFolder.title,
                    year: parsedFromFolder.year,
                    resolution,
                  }
                : null);

            if (!parsed) {
              skipped += 1;
              skippedParseFailed += 1;
              if (DEBUG) console.log(`[skip] movie parse failed: ${name}`);
              return;
            }

            // If parsed from filename but no resolution, try extract from name anyway.
            if (parsedFromFile && !parsed.resolution) {
              parsed.resolution = resolution;
            }

            detected += 1;
            console.log(
              `[detect] movie=${parsed.title} (${parsed.year})${parsed.resolution ? ` ${parsed.resolution}` : ''} -> ${name}`,
            );

            const cacheKey = `${parsed.title}::${parsed.year}`;
            let tmdb = null;
            if (fetchMetadata) {
              tmdb = tmdbMovieCache.get(cacheKey);
              if (!tmdb) {
                tmdb = await fetchTMDBMetadata({ title: parsed.title, year: parsed.year, tmdbApiKey });
                tmdbMovieCache.set(cacheKey, tmdb);
              }

              if (tmdb) {
                console.log(`[tmdb] metadata fetched: ${tmdb.officialTitle ?? parsed.title} (${tmdb.releaseDate ?? parsed.year})`);
              } else {
                console.log(`[tmdb] no match for: ${parsed.title} (${parsed.year})`);
              }
            }

            const doc = {
              title: tmdb?.officialTitle ?? parsed.title,
              year: parsed.year,
              overview: tmdb?.overview ?? null,
              genres: tmdb?.genres ?? [],
              rating: tmdb?.voteAverage ?? null,
              poster: tmdb?.posterUrl ?? null,
              backdrop: tmdb?.backdropUrl ?? null,
              tmdbId: tmdb?.tmdbId ?? null,
              imdbId: tmdb?.imdbId ?? null,
              resolution: parsed.resolution ?? null,
              fileName: name,
              driveFileId,
              driveLink,
              fileSize,
              createdAt: new Date(),
            };

            const writeRes = await movies.updateOne(
              { driveFileId },
              { $setOnInsert: doc },
              { upsert: true },
            );

            if (writeRes.upsertedCount === 1) {
              saved += 1;
              console.log(`[db] movie saved: ${doc.title} (${doc.year}) [${driveFileId}]`);
            } else {
              skipped += 1;
              skippedDuplicate += 1;
            }
          }),
        );

        await Promise.allSettled(tasks);

        if (DEBUG || pagesFetched % 10 === 0) {
          console.log(
            `[progress] scanned=${scanned} folders_scanned=${scannedFolders} folders_discovered=${discoveredFolders} detected=${detected} saved=${saved} skipped=${skipped} (folders=${skippedFolder}, non_video=${skippedNonVideo}, parse_failed=${skippedParseFailed}, duplicate=${skippedDuplicate})`,
          );
        }
      } while (pageToken);
    }

    console.log(
      `[done] scanned=${scanned} folders_scanned=${scannedFolders} folders_discovered=${discoveredFolders} detected=${detected} saved=${saved} skipped=${skipped} (non_video=${skippedNonVideo}, parse_failed=${skippedParseFailed}, duplicate=${skippedDuplicate})`,
    );
  } finally {
    await client.close();
  }
}

async function main() {
  console.log('[start] drive-movie-indexer');
  const tmdbApiKey = requireEnv('TMDB_API_KEY');
  const mongoUri = requireEnv('MONGO_URI');

  const mode = getIndexMode();
  if (process.env.MIGRATE_DRY_RUN && mode !== 'migrate') {
    console.log('[warn] MIGRATE_DRY_RUN is set but INDEX_MODE is not migrate; migration will not run.');
  }
  if (mode === 'migrate') {
    await migrateMisclassifiedEpisodes({ mongoUri, tmdbApiKey });
    return;
  }
  if (mode === 'enrich') {
    await enrichMetadata({ mongoUri, tmdbApiKey });
    return;
  }

  const driveFolderId = requireEnv('DRIVE_FOLDER_ID');

  await scanDriveMovies({ driveFolderId, tmdbApiKey, mongoUri });
}

// Run only when executed directly (not when imported).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[fatal]', err);
    process.exitCode = 1;
  });
}
