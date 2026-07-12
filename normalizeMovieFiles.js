import 'dotenv/config';
import { MongoClient } from 'mongodb';

function envBool(name, def = false) {
  const v = process.env[name];
  if (v === undefined) return def;
  const s = String(v).trim().toLowerCase();
  if (!s) return def;
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return def;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function normalizeResolution(v) {
  const s = String(v || '').trim().toLowerCase();
  return s || null;
}

function fileFromRoot(doc) {
  if (!isNonEmptyString(doc?.driveFileId)) return null;
  return {
    driveFileId: doc.driveFileId.trim(),
    driveLink: isNonEmptyString(doc?.driveLink) ? doc.driveLink : null,
    fileName: isNonEmptyString(doc?.fileName) ? doc.fileName : null,
    fileSize: typeof doc?.fileSize === 'number' && Number.isFinite(doc.fileSize) ? doc.fileSize : null,
    resolution: isNonEmptyString(doc?.resolution) ? normalizeResolution(doc.resolution) : null,
    createdAt: doc?.createdAt ?? null,
  };
}

function uniqFiles(files) {
  const map = new Map();
  for (const f of files) {
    if (!f || !isNonEmptyString(f.driveFileId)) continue;
    const id = f.driveFileId.trim();
    const prev = map.get(id);
    if (!prev) {
      map.set(id, { ...f, driveFileId: id });
      continue;
    }
    for (const k of ['driveLink', 'fileName', 'fileSize', 'resolution', 'createdAt']) {
      if (prev[k] == null && f[k] != null) prev[k] = f[k];
    }
  }
  return [...map.values()];
}

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri || !String(mongoUri).trim()) throw new Error('Missing MONGO_URI environment variable.');

  const dryRun = envBool('NORMALIZE_DRY_RUN', true);
  const limit = Number.parseInt(String(process.env.NORMALIZE_LIMIT || '0'), 10) || 0;

  const client = new MongoClient(mongoUri, { maxPoolSize: 5 });
  await client.connect();

  try {
    const db = client.db();
    const movies = db.collection('movies');

    // If a unique index exists on root driveFileId, unsetting driveFileId will cause many documents
    // to collide on the index key (null). Drop it before normalization.
    const indexes = await movies.indexes().catch(() => []);
    const hasDriveFileIdIndex = Array.isArray(indexes) && indexes.some((idx) => idx?.name === 'driveFileId_1');
    if (hasDriveFileIdIndex) {
      if (dryRun) {
        console.log('[dry-run] would drop index: driveFileId_1');
      } else {
        await movies.dropIndex('driveFileId_1');
        console.log('[index] dropped: driveFileId_1');
      }
    }

    // Target docs that either:
    // - have no files[]
    // - have empty files[]
    // - still have legacy root file fields (driveFileId etc)
    const cursor = movies.find({
      $or: [
        { files: { $exists: false } },
        { files: { $size: 0 } },
        { driveFileId: { $exists: true } },
        { driveLink: { $exists: true } },
        { fileName: { $exists: true } },
        { fileSize: { $exists: true } },
        { resolution: { $exists: true } },
      ],
    });

    let scanned = 0;
    let updated = 0;

    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      scanned += 1;
      if (limit && scanned > limit) break;

      const existingFiles = Array.isArray(doc?.files) ? doc.files : [];
      const rootFile = fileFromRoot(doc);
      const nextFiles = uniqFiles([...(existingFiles || []), ...(rootFile ? [rootFile] : [])]);

      // Always enforce files[] existence, even if empty (but ideally it won't be empty)
      const update = {
        $set: { files: nextFiles },
        $unset: {
          driveFileId: '',
          driveLink: '',
          fileName: '',
          fileSize: '',
          resolution: '',
        },
      };

      if (!dryRun) {
        await movies.updateOne({ _id: doc._id }, update);
      }

      updated += 1;
      if (scanned % 1000 === 0) {
        console.log(`[progress] scanned=${scanned} updated=${updated}`);
      }
    }

    console.log('== Normalize Movie Files ==');
    console.log(`dry_run: ${dryRun}`);
    console.log(`scanned: ${scanned}`);
    console.log(`updated: ${updated}`);

    // Create a unique index on files.driveFileId (new schema) to prevent duplicates across movies.
    // Use partialFilterExpression to only index valid string ids.
    const desiredIndexName = 'files.driveFileId_1';
    const hasFilesIndex = Array.isArray(indexes) && indexes.some((idx) => idx?.name === desiredIndexName);
    if (!hasFilesIndex) {
      if (dryRun) {
        console.log(`[dry-run] would create unique index: ${desiredIndexName}`);
      } else {
        await movies.createIndex(
          { 'files.driveFileId': 1 },
          {
            unique: true,
            name: desiredIndexName,
            partialFilterExpression: { 'files.driveFileId': { $type: 'string' } },
          },
        );
        console.log(`[index] created unique: ${desiredIndexName}`);
      }
    }

    if (dryRun) {
      console.log('NOTE: This was a dry run. Set NORMALIZE_DRY_RUN=0 to apply changes.');
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exitCode = 1;
});
