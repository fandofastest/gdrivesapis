import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { getDriveClient } from './auth.js';
import { ensureCacheDir, evictIfNeeded, getCacheConfig } from './cacheManager.js';

function nowIso() {
  return new Date().toISOString();
}

async function startBackgroundPrefetchChunks({ drive, fileId, finalPath, rangeMetaPath, meta }) {
  if (!meta?.size) return;
  if (activePrefetch.has(fileId)) return;

  const p = (async () => {
    try {
      const chunkBytes = getChunkBytes();
      // Prefetch sequentially to reduce random IO; range requests may download chunks in parallel.
      for (let s = 0; s < meta.size; s += chunkBytes) {
        const e = Math.min(meta.size - 1, s + chunkBytes - 1);
        const state = await loadRangeMeta(rangeMetaPath, meta);
        if (rangeCovered(state.ranges, s, e)) continue;

        await downloadChunkToCache({ drive, fileId, finalPath, rangeMetaPath, meta, start: s, end: e });
      }
      console.log(`[CACHE] prefetch complete fileId=${fileId}`);
    } catch (e) {
      console.log(`[CACHE] prefetch failed fileId=${fileId} err=${e?.message || e}`);
    } finally {
      activePrefetch.delete(fileId);
    }
  })();

  activePrefetch.set(fileId, p);
}

function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function parseRange(rangeHeader, size) {
  if (!rangeHeader) return null;
  const m = String(rangeHeader).match(/bytes=(\d*)-(\d*)/i);
  if (!m) return null;

  let start = m[1] ? Number(m[1]) : NaN;
  let end = m[2] ? Number(m[2]) : NaN;

  if (Number.isNaN(start) && Number.isNaN(end)) return null;

  if (Number.isNaN(start)) {
    // suffix range: last N bytes
    const suffix = end;
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    if (Number.isNaN(end) || end >= size) end = size - 1;
  }

  if (start < 0 || start >= size || end < start) return null;
  return { start, end };
}

function envOrDefault(name, defaultValue) {
  const v = process.env[name];
  return v && String(v).trim() ? v : defaultValue;
}

function getCachePublicBaseUrl() {
  const v = process.env.CACHE_PUBLIC_BASE_URL;
  if (!v || !String(v).trim()) return null;
  return String(v).replace(/\/+$/, '');
}

function joinUrl(base, suffix) {
  const b = String(base || '').replace(/\/+$/, '');
  const s = String(suffix || '').replace(/^\/+/, '');
  return `${b}/${s}`;
}

function parseBytes(input) {
  if (typeof input === 'number') return input;
  const s = String(input || '').trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*(b|kb|mb|gb|tb)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 'b').toLowerCase();
  const mult =
    unit === 'tb'
      ? 1024 ** 4
      : unit === 'gb'
        ? 1024 ** 3
        : unit === 'mb'
          ? 1024 ** 2
          : unit === 'kb'
            ? 1024
            : 1;
  return Math.floor(n * mult);
}

function guessContentType(fileName) {
  const ext = path.extname(fileName || '').toLowerCase();
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mkv') return 'video/x-matroska';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.avi') return 'video/x-msvideo';
  return 'application/octet-stream';
}

const COMMON_EXTS = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.bin'];

async function findCachedFileById(cacheDir, fileId) {
  // Fast path: direct stat lookup for common video extensions (avoids scanning 6k+ directory entries)
  for (const ext of COMMON_EXTS) {
    const fileName = `${fileId}${ext}`;
    const full = path.join(cacheDir, fileName);
    try {
      const st = await fsp.stat(full);
      if (st.isFile()) {
        return { filePath: full, fileName, stat: st };
      }
    } catch {}
  }

  const entries = await fsp.readdir(cacheDir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name.endsWith('.part')) continue;
    if (e.name.endsWith('.json')) continue;
    if (e.name === `${fileId}.part`) continue;

    // Match "{fileId}.<ext>"
    if (e.name.startsWith(`${fileId}.`)) {
      const full = path.join(cacheDir, e.name);
      const st = await fsp.stat(full);
      return { filePath: full, fileName: e.name, stat: st };
    }
  }
  return null;
}

function getCachePaths({ cacheDir, fileId, fileName }) {
  const ext = path.extname(fileName || '') || '.bin';
  const safeExt = ext.length <= 10 ? ext : '.bin';
  const finalPath = path.join(cacheDir, `${fileId}${safeExt}`);
  const partPath = path.join(cacheDir, `${fileId}.part`);
  const metaPath = `${finalPath}.json`;
  return { finalPath, partPath, metaPath };
}

const activeDownloads = new Map();

// Single-flight per chunk download: key = `${fileId}:${start}-${end}`
const activeChunkDownloads = new Map();
// Single-flight prefetch per file: key = fileId
const activePrefetch = new Map();
// Serialize range metadata writes per finalPath
const rangeMetaLocks = new Map();

function getChunkBytes() {
  // User requested: 100Mb
  return parseBytes(envOrDefault('CACHE_CHUNK_BYTES', '100mb')) ?? 100 * 1024 * 1024;
}

function normalizeRanges(ranges) {
  const sorted = (ranges || [])
    .filter((r) => Array.isArray(r) && r.length === 2)
    .map((r) => [Number(r[0]), Number(r[1])])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a <= b)
    .sort((a, b) => a[0] - b[0]);

  const merged = [];
  for (const [s, e] of sorted) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push([s, e]);
      continue;
    }
    if (s <= last[1] + 1) {
      last[1] = Math.max(last[1], e);
    } else {
      merged.push([s, e]);
    }
  }
  return merged;
}

function rangeCovered(ranges, start, end) {
  if (!ranges || ranges.length === 0) return false;
  for (const [s, e] of ranges) {
    if (start >= s && end <= e) return true;
  }
  return false;
}

function isFullyCached(ranges, size) {
  if (!Number.isFinite(size) || size <= 0) return false;
  if (!ranges || ranges.length === 0) return false;
  const norm = normalizeRanges(ranges);
  return norm.length === 1 && norm[0][0] === 0 && norm[0][1] >= size - 1;
}

function alignToChunks(start, end, chunkBytes, fileSize) {
  const aStart = Math.floor(start / chunkBytes) * chunkBytes;
  const aEnd = Math.min(fileSize - 1, Math.floor(end / chunkBytes) * chunkBytes + (chunkBytes - 1));
  const chunks = [];
  for (let s = aStart; s <= aEnd; s += chunkBytes) {
    const e = Math.min(fileSize - 1, s + chunkBytes - 1);
    chunks.push({ start: s, end: e });
  }
  return chunks;
}

async function loadRangeMeta(rangeMetaPath, meta) {
  try {
    const raw = await fsp.readFile(rangeMetaPath, 'utf8');
    const json = JSON.parse(raw);
    return {
      size: typeof json.size === 'number' ? json.size : meta.size,
      mimeType: json.mimeType || meta.mimeType,
      ranges: normalizeRanges(json.ranges || []),
    };
  } catch {
    return { size: meta.size, mimeType: meta.mimeType, ranges: [] };
  }
}

async function withRangeMetaLock(key, fn) {
  const prev = rangeMetaLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((r) => {
    release = r;
  });
  rangeMetaLocks.set(key, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (rangeMetaLocks.get(key) === next) {
      rangeMetaLocks.delete(key);
    }
  }
}

async function saveRangeMeta(rangeMetaPath, meta) {
  await withRangeMetaLock(rangeMetaPath, async () => {
    const current = await loadRangeMeta(rangeMetaPath, meta);
    const merged = normalizeRanges(current.ranges);
    const out = {
      size: meta.size,
      mimeType: meta.mimeType,
      ranges: merged,
    };
    await fsp.writeFile(rangeMetaPath, JSON.stringify(out, null, 2), 'utf8');
  });
}

async function ensureFileExists(finalPath) {
  // On Windows, ftruncate can fail with EPERM if another handle is open.
  // We avoid pre-allocation; writing at an offset will extend the file.
  const fh = await fsp.open(finalPath, 'a');
  await fh.close();
}

async function downloadChunkToCache({ drive, fileId, finalPath, rangeMetaPath, meta, start, end }) {
  const key = `${fileId}:${start}-${end}`;
  if (activeChunkDownloads.has(key)) return activeChunkDownloads.get(key);

  const p = (async () => {
    await ensureFileExists(finalPath);

    const res = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      {
        responseType: 'stream',
        headers: {
          Range: `bytes=${start}-${end}`,
        },
      },
    );

    // Use positioned write into the file. File will grow automatically.
    await pipeline(res.data, fs.createWriteStream(finalPath, { flags: 'r+', start }));

    // Update range meta
    await withRangeMetaLock(rangeMetaPath, async () => {
      const current = await loadRangeMeta(rangeMetaPath, meta);
      current.ranges = normalizeRanges([...current.ranges, [start, end]]);
      await fsp.writeFile(
        rangeMetaPath,
        JSON.stringify({ size: meta.size, mimeType: meta.mimeType, ranges: current.ranges }, null, 2),
        'utf8',
      );
    });
  })()
    .catch((e) => {
      console.log(`[CACHE] chunk download failed fileId=${fileId} range=${start}-${end} err=${e?.message || e}`);
      throw e;
    })
    .finally(() => {
      activeChunkDownloads.delete(key);
    });

  activeChunkDownloads.set(key, p);
  return p;
}

async function getDriveFileMetadata(drive, fileId) {
  const metaRes = await drive.files.get({
    fileId,
    fields: 'id,name,size,mimeType',
    supportsAllDrives: true,
  });

  const name = metaRes?.data?.name || `${fileId}.bin`;
  const size = metaRes?.data?.size ? Number(metaRes.data.size) : null;
  const mimeType = metaRes?.data?.mimeType || null;

  return { name, size, mimeType };
}

async function startBackgroundCacheDownload({ drive, fileId, finalPath, partPath, metaPath, meta }) {
  if (activeDownloads.has(fileId)) return;

  const p = (async () => {
    try {
      // If already cached by another run, skip.
      const exists = await fsp
        .stat(finalPath)
        .then(() => true)
        .catch(() => false);
      if (exists) return;

      const res = await drive.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' },
      );

      await pipeline(res.data, fs.createWriteStream(partPath));
      await fsp.rename(partPath, finalPath);
      await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8').catch(() => {});
      console.log(`[CACHE] saved fileId=${fileId} -> ${finalPath}`);
    } catch (e) {
      await fsp.unlink(partPath).catch(() => {});
      console.log(`[CACHE] download failed fileId=${fileId} err=${e?.message || e}`);
    } finally {
      activeDownloads.delete(fileId);
    }
  })();

  activeDownloads.set(fileId, p);
}

async function streamFromDisk({ req, res, filePath, fileSize, contentType, rangeHeader }) {
  const range = parseRange(rangeHeader, fileSize);

  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${fileSize}`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(range.end - range.start + 1));
    res.setHeader('Content-Type', contentType);

    fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
    return;
  }

  res.status(200);
  res.setHeader('Content-Length', String(fileSize));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  fs.createReadStream(filePath).pipe(res);
}

async function streamFromDrive({ req, res, drive, fileId, fileSize, contentType, rangeHeader }) {
  // If range exists, forward it to Google Drive.
  const headers = {};
  if (rangeHeader) headers.Range = rangeHeader;

  const driveRes = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream', headers },
  );

  const status = driveRes.status || 200;

  // Google will respond 206 if Range is honored.
  res.status(status);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);

  // Pass through relevant headers if present.
  const h = driveRes.headers || {};
  if (h['content-range']) res.setHeader('Content-Range', h['content-range']);
  if (h['content-length']) res.setHeader('Content-Length', h['content-length']);

  driveRes.data.on('error', () => {
    if (!res.headersSent) res.status(502);
    res.end();
  });

  driveRes.data.pipe(res);
}

function mapDriveErrorToHttp(err) {
  const status = err?.code || err?.response?.status;
  if (status === 404) return { status: 404, message: 'File not found' };
  if (status === 403) return { status: 403, message: 'Forbidden or quota exceeded' };
  if (status === 401) return { status: 401, message: 'Unauthorized' };
  return { status: 502, message: 'Bad gateway' };
}

export async function streamHandler(req, res) {
  const fileId = req.params.fileId;
  const ip = getClientIp(req);
  const rangeHeader = req.headers.range;

  const { cacheDir, maxBytes } = getCacheConfig();
  await ensureCacheDir(cacheDir);

  const cached = await findCachedFileById(cacheDir, fileId);

  if (cached) {
    const metaPath = `${cached.filePath}.json`;
    const meta = await fsp
      .readFile(metaPath, 'utf8')
      .then((s) => JSON.parse(s))
      .catch(() => ({}));

    const fileSize = meta.size ? Number(meta.size) : cached.stat.size;
    const rangeMetaPath = `${cached.filePath}.ranges.json`;
    const rangeState = await loadRangeMeta(rangeMetaPath, { size: fileSize, mimeType: meta.mimeType || null });
    const fullCached = isFullyCached(rangeState.ranges, fileSize);

    const publicBaseUrl = getCachePublicBaseUrl();
    if (fullCached && publicBaseUrl) {
      // Offload serving to Nginx/static when fully cached.
      // Use 307 to preserve Range header behavior in clients.
      const url = joinUrl(publicBaseUrl, cached.fileName);
      console.log(`[${nowIso()}] [STREAM] fileId=${fileId} ip=${ip} REDIRECT_FULL_CACHE -> ${url}`);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Range, DNT, User-Agent, X-Requested-With, If-Modified-Since, Cache-Control, Content-Type');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
      res.status(307);
      res.setHeader('Location', url);
      res.end();
      return;
    }

    const contentType = meta.mimeType || guessContentType(meta.name || cached.fileName);

    // If this is a partial/sparse cache, only serve from disk if the requested range is covered.
    if (rangeHeader) {
      const r = parseRange(rangeHeader, fileSize);
      if (r && rangeCovered(rangeState.ranges, r.start, r.end)) {
        console.log(
          `[${nowIso()}] [STREAM] fileId=${fileId} ip=${ip} CACHE_HIT_PARTIAL range=${rangeHeader}`,
        );

        await fsp.utimes(cached.filePath, new Date(), new Date()).catch(() => {});
        await streamFromDisk({
          req,
          res,
          filePath: cached.filePath,
          fileSize,
          contentType,
          rangeHeader,
        });

        evictIfNeeded({ cacheDir, maxBytes }).catch(() => {});
        return;
      }
    } else if (fullCached) {
      console.log(
        `[${nowIso()}] [STREAM] fileId=${fileId} ip=${ip} CACHE_HIT range=none`,
      );

      await fsp.utimes(cached.filePath, new Date(), new Date()).catch(() => {});
      await streamFromDisk({
        req,
        res,
        filePath: cached.filePath,
        fileSize,
        contentType,
        rangeHeader: null,
      });

      evictIfNeeded({ cacheDir, maxBytes }).catch(() => {});
      return;
    }
  }

  try {
    const drive = await getDriveClient();

    if (cached) {
      const metaPath = `${cached.filePath}.json`;
      const meta = await fsp
        .readFile(metaPath, 'utf8')
        .then((s) => JSON.parse(s))
        .catch(() => ({}));

      const fileSize = meta.size ? Number(meta.size) : cached.stat.size;
      const rangeMetaPath = `${cached.filePath}.ranges.json`;
      const rangeState = await loadRangeMeta(rangeMetaPath, { size: fileSize, mimeType: meta.mimeType || null });
      const contentType = meta.mimeType || guessContentType(meta.name || cached.fileName);

      if (rangeHeader) {
        const r = parseRange(rangeHeader, fileSize);
        console.log(
          `[${nowIso()}] [STREAM] fileId=${fileId} ip=${ip} CACHE_PARTIAL_MISS range=${rangeHeader}`,
        );

        const requested = r;
        if (requested) {
          const chunkBytes = getChunkBytes();
          const chunks = alignToChunks(requested.start, requested.end, chunkBytes, fileSize);
          const missing = chunks.filter((c) => !rangeCovered(rangeState.ranges, c.start, c.end));
          for (const c of missing) {
            downloadChunkToCache({
              drive,
              fileId,
              finalPath: cached.filePath,
              rangeMetaPath,
              meta: { size: fileSize, mimeType: meta.mimeType || null },
              start: c.start,
              end: c.end,
            }).catch(() => {});
          }
        }

        // Keep prefetch running to complete full cache.
        startBackgroundPrefetchChunks({
          drive,
          fileId,
          finalPath: cached.filePath,
          rangeMetaPath,
          meta: { size: fileSize, mimeType: meta.mimeType || null },
        }).catch(() => {});

        await streamFromDrive({
          req,
          res,
          drive,
          fileId,
          fileSize,
          contentType,
          rangeHeader,
        });

        evictIfNeeded({ cacheDir, maxBytes }).catch(() => {});
        return;
      }

      if (fullCached) {
        console.log(
          `[${nowIso()}] [STREAM] fileId=${fileId} ip=${ip} CACHE_HIT range=none`,
        );

        await fsp.utimes(cached.filePath, new Date(), new Date()).catch(() => {});
        await streamFromDisk({
          req,
          res,
          filePath: cached.filePath,
          fileSize,
          contentType,
          rangeHeader: null,
        });

        evictIfNeeded({ cacheDir, maxBytes }).catch(() => {});
        return;
      }

      // No Range request and not fully cached -> proxy from Drive to avoid serving zero-filled holes.
      console.log(
        `[${nowIso()}] [STREAM] fileId=${fileId} ip=${ip} CACHE_PARTIAL_PROXY range=none`,
      );

      startBackgroundPrefetchChunks({
        drive,
        fileId,
        finalPath: cached.filePath,
        rangeMetaPath,
        meta: { size: fileSize, mimeType: meta.mimeType || null },
      }).catch(() => {});

      await streamFromDrive({
        req,
        res,
        drive,
        fileId,
        fileSize,
        contentType,
        rangeHeader: null,
      });

      evictIfNeeded({ cacheDir, maxBytes }).catch(() => {});
      return;
    }

    // Cache miss: we will proxy stream from Drive immediately for correct Range support,
    // and start a background full-file download to cache (single-flight) for next requests.
    const meta = await getDriveFileMetadata(drive, fileId);
    const contentType = meta.mimeType || guessContentType(meta.name);

    const { finalPath, partPath, metaPath } = getCachePaths({ cacheDir, fileId, fileName: meta.name });
    const rangeMetaPath = `${finalPath}.ranges.json`;

    console.log(
      `[${nowIso()}] [STREAM] fileId=${fileId} ip=${ip} CACHE_MISS range=${rangeHeader || 'none'}`,
    );

    // Hybrid Mode (Mode 2): if the request has a Range, opportunistically cache aligned chunks.
    if (meta.size && rangeHeader) {
      const requested = parseRange(rangeHeader, meta.size);
      if (requested) {
        const chunkBytes = getChunkBytes();
        const chunks = alignToChunks(requested.start, requested.end, chunkBytes, meta.size);

        const rangeState = await loadRangeMeta(rangeMetaPath, meta);
        const missing = chunks.filter((c) => !rangeCovered(rangeState.ranges, c.start, c.end));

        if (missing.length) {
          // Fire-and-forget chunk downloads in parallel (deduped per chunk)
          for (const c of missing) {
            downloadChunkToCache({ drive, fileId, finalPath, rangeMetaPath, meta, start: c.start, end: c.end }).catch(() => {});
          }
        }
      }
    }

    // Persist base metadata for the cached file
    await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8').catch(() => {});

    // Background prefetch: fill all remaining chunks to complete cache.
    startBackgroundPrefetchChunks({ drive, fileId, finalPath, rangeMetaPath, meta }).catch(() => {});

    await streamFromDrive({
      req,
      res,
      drive,
      fileId,
      fileSize: meta.size,
      contentType,
      rangeHeader,
    });

    evictIfNeeded({ cacheDir, maxBytes }).catch(() => {});
  } catch (err) {
    const m = mapDriveErrorToHttp(err);
    console.log(`[${nowIso()}] [STREAM_ERR] fileId=${fileId} ip=${ip} err=${err?.message || err}`);
    res.status(m.status).json({ error: m.message });
  }
}
