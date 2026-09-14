import fs from 'node:fs/promises';
import path from 'node:path';

function envOrDefault(name, defaultValue) {
  const v = process.env[name];
  return v && String(v).trim() ? v : defaultValue;
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

export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (!bytes || Number.isNaN(bytes)) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export function getCacheConfig() {
  const cacheDir = envOrDefault('CACHE_DIR', path.resolve('./cache'));
  const max = envOrDefault('CACHE_MAX_BYTES', '3.5tb');
  const maxBytes = parseBytes(max) ?? Math.floor(3.5 * 1024 ** 4);
  const minFreePercent = Number(envOrDefault('CACHE_MIN_FREE_PERCENT', '10')) || 10;
  const targetFreePercent = Number(envOrDefault('CACHE_TARGET_FREE_PERCENT', '15')) || 15;
  return { cacheDir, maxBytes, minFreePercent, targetFreePercent };
}

export async function ensureCacheDir(cacheDir) {
  await fs.mkdir(cacheDir, { recursive: true });
}

export async function getDiskSpace(targetPath) {
  try {
    const s = await fs.statfs(targetPath);
    const totalBlocks = Number(s.blocks);
    const availBlocks = Number(s.bavail);
    const bsize = Number(s.bsize);
    const totalBytes = totalBlocks * bsize;
    const freeBytes = availBlocks * bsize;
    const freePercent = totalBlocks > 0 ? (availBlocks / totalBlocks) * 100 : 100;
    return {
      totalBytes,
      freeBytes,
      freePercent,
    };
  } catch {
    return null;
  }
}

export async function getDirectorySizeBytes(cacheDir) {
  let total = 0;
  const entries = await fs.readdir(cacheDir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name.endsWith('.part')) continue;
    if (e.name.endsWith('.json')) continue;
    const st = await fs.stat(path.join(cacheDir, e.name)).catch(() => null);
    if (st) total += st.size;
  }
  return total;
}

let isEvicting = false;

export async function evictIfNeeded(options = {}) {
  if (isEvicting) return;
  isEvicting = true;

  try {
    const cfg = getCacheConfig();
    const cacheDir = options.cacheDir || cfg.cacheDir;
    const maxBytes = options.maxBytes ?? cfg.maxBytes;
    const minFreePercent = options.minFreePercent ?? cfg.minFreePercent;
    const targetFreePercent = options.targetFreePercent ?? cfg.targetFreePercent;

    await ensureCacheDir(cacheDir);

    let disk = await getDiskSpace(cacheDir);
    let total = await getDirectorySizeBytes(cacheDir);

    const diskIsLow = disk !== null && disk.freePercent <= minFreePercent;
    const cacheIsOverMax = maxBytes > 0 && total > maxBytes;

    if (!diskIsLow && !cacheIsOverMax) {
      return;
    }

    console.log(
      `[CACHE] Eviction check triggered. Disk free: ${disk ? disk.freePercent.toFixed(2) + '%' : 'unknown'} (threshold: <= ${minFreePercent}%), Cache used: ${formatBytes(total)} (max: ${formatBytes(maxBytes)})`
    );

    const entries = await fs.readdir(cacheDir, { withFileTypes: true }).catch(() => []);
    const files = [];

    for (const e of entries) {
      if (!e.isFile()) continue;
      if (e.name.endsWith('.part')) continue;
      if (e.name.endsWith('.json')) continue;
      const full = path.join(cacheDir, e.name);
      const st = await fs.stat(full).catch(() => null);
      if (!st) continue;

      // LRU: use the newest of atime or mtime to identify when file was last accessed/streamed
      const lastAccessTime = Math.max(st.atimeMs || 0, st.mtimeMs || 0);
      files.push({ full, lastAccessTime, size: st.size });
    }

    // Sort ascending: oldest accessed files first (Least Recently Used)
    files.sort((a, b) => a.lastAccessTime - b.lastAccessTime);

    let evictedCount = 0;
    let evictedBytes = 0;

    for (const f of files) {
      // Check if cache quota and disk free percentage are now satisfactory
      const currentCacheOk = maxBytes <= 0 || total <= maxBytes;

      let currentDiskOk = true;
      if (minFreePercent > 0) {
        disk = await getDiskSpace(cacheDir);
        if (disk !== null) {
          currentDiskOk = disk.freePercent >= targetFreePercent;
        }
      }

      if (currentCacheOk && currentDiskOk) {
        break;
      }

      try {
        await fs.unlink(f.full);
        total -= f.size;
        evictedBytes += f.size;
        evictedCount += 1;

        // Clean up corresponding metadata files if any
        await fs.unlink(`${f.full}.json`).catch(() => {});
        await fs.unlink(`${f.full}.ranges.json`).catch(() => {});
        await fs.unlink(`${f.full}.part`).catch(() => {});

        console.log(
          `[CACHE] Evicted least recently accessed: ${path.basename(f.full)} (${formatBytes(f.size)})`
        );
      } catch (err) {
        console.warn(`[CACHE] Failed to evict ${f.full}: ${err?.message || err}`);
      }
    }

    if (evictedCount > 0) {
      const updatedDisk = await getDiskSpace(cacheDir);
      console.log(
        `[CACHE] Eviction complete. Removed ${evictedCount} file(s) (${formatBytes(evictedBytes)}). New disk free: ${updatedDisk ? updatedDisk.freePercent.toFixed(2) + '%' : 'unknown'}, cache size: ${formatBytes(total)}`
      );
    }
  } catch (err) {
    console.error(`[CACHE] Eviction error:`, err);
  } finally {
    isEvicting = false;
  }
}

// Background periodic check every 15 minutes
let periodicTimer = null;
export function startPeriodicCacheCheck(intervalMs = 15 * 60 * 1000) {
  if (periodicTimer) return;
  periodicTimer = setInterval(() => {
    evictIfNeeded().catch(() => {});
  }, intervalMs);
  if (periodicTimer.unref) {
    periodicTimer.unref();
  }
}

// Automatically start background checker
startPeriodicCacheCheck();
