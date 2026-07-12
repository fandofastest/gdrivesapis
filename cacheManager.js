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

export function getCacheConfig() {
  const cacheDir = envOrDefault('CACHE_DIR', path.resolve('./cache'));
  const max = envOrDefault('CACHE_MAX_BYTES', '3.5tb');
  const maxBytes = parseBytes(max) ?? Math.floor(3.5 * 1024 ** 4);
  return { cacheDir, maxBytes };
}

export async function ensureCacheDir(cacheDir) {
  await fs.mkdir(cacheDir, { recursive: true });
}

export async function getDirectorySizeBytes(cacheDir) {
  let total = 0;
  const entries = await fs.readdir(cacheDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name.endsWith('.part')) continue;
    if (e.name.endsWith('.json')) continue;
    const st = await fs.stat(path.join(cacheDir, e.name));
    total += st.size;
  }
  return total;
}

export async function evictIfNeeded({ cacheDir, maxBytes }) {
  await ensureCacheDir(cacheDir);

  let total = await getDirectorySizeBytes(cacheDir);
  if (total <= maxBytes) return;

  const entries = await fs.readdir(cacheDir, { withFileTypes: true });
  const files = [];

  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name.endsWith('.part')) continue;
    if (e.name.endsWith('.json')) continue;
    const full = path.join(cacheDir, e.name);
    const st = await fs.stat(full);
    files.push({ full, mtimeMs: st.mtimeMs, size: st.size });
  }

  files.sort((a, b) => a.mtimeMs - b.mtimeMs);

  for (const f of files) {
    if (total <= maxBytes) break;
    try {
      await fs.unlink(f.full);
      total -= f.size;
      const meta = `${f.full}.json`;
      await fs.unlink(meta).catch(() => {});
      console.log(`[CACHE] evicted ${path.basename(f.full)} size=${f.size}`);
    } catch {
      // ignore
    }
  }
}
