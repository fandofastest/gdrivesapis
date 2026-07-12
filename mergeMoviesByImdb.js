import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function fmt(n) {
  return new Intl.NumberFormat('en-US').format(Number(n) || 0);
}

function envBool(name, def = false) {
  const v = process.env[name];
  if (v === undefined) return def;
  const s = String(v).trim().toLowerCase();
  if (!s) return def;
  return ['1', 'true', 'yes', 'y', 'on'].includes(s);
}

function scoreMovieDoc(doc) {
  // Prefer docs that look more complete.
  let score = 0;
  if (isNonEmptyString(doc?.overview)) score += 3;
  if (isNonEmptyString(doc?.poster)) score += 2;
  if (isNonEmptyString(doc?.backdrop)) score += 1;
  if (Array.isArray(doc?.genres) && doc.genres.length) score += 2;
  if (typeof doc?.rating === 'number' && Number.isFinite(doc.rating)) score += 1;
  if (typeof doc?.tmdbId === 'number' && Number.isFinite(doc.tmdbId)) score += 2;
  if (isNonEmptyString(doc?.imdbId)) score += 4;
  if (typeof doc?.playCount === 'number' && Number.isFinite(doc.playCount)) score += 1;
  if (doc?.lastPlayedAt) score += 1;
  return score;
}

function fileFromDoc(doc) {
  const driveFileId = doc?.driveFileId;
  if (!isNonEmptyString(driveFileId)) return null;
  return {
    driveFileId,
    driveLink: isNonEmptyString(doc?.driveLink) ? doc.driveLink : null,
    fileName: isNonEmptyString(doc?.fileName) ? doc.fileName : null,
    fileSize: typeof doc?.fileSize === 'number' && Number.isFinite(doc.fileSize) ? doc.fileSize : null,
    resolution: isNonEmptyString(doc?.resolution) ? String(doc.resolution).trim().toLowerCase() : null,
    createdAt: doc?.createdAt ?? null,
  };
}

function uniqFiles(files) {
  const map = new Map();
  for (const f of files) {
    if (!f || !isNonEmptyString(f.driveFileId)) continue;
    const prev = map.get(f.driveFileId);
    if (!prev) {
      map.set(f.driveFileId, f);
      continue;
    }
    // Merge: keep existing but fill gaps.
    for (const k of ['driveLink', 'fileName', 'fileSize', 'resolution', 'createdAt']) {
      if (prev[k] == null && f[k] != null) prev[k] = f[k];
    }
  }
  return [...map.values()];
}

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri || !String(mongoUri).trim()) {
    throw new Error('Missing MONGO_URI environment variable.');
  }

  const dryRun = envBool('MERGE_DRY_RUN', true);
  const limitGroups = Number.parseInt(String(process.env.MERGE_LIMIT || '0'), 10) || 0;

  const client = new MongoClient(mongoUri, { maxPoolSize: 5 });
  await client.connect();

  try {
    const db = client.db();
    const movies = db.collection('movies');

    const groups = await movies
      .aggregate([
        { $match: { imdbId: { $type: 'string', $ne: '' } } },
        { $group: { _id: '$imdbId', ids: { $push: '$_id' }, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1 } },
      ])
      .toArray();

    console.log('== Merge Movies By imdbId ==');
    console.log(`dry_run: ${dryRun}`);
    console.log(`duplicate_imdb_groups: ${fmt(groups.length)}`);

    let processedGroups = 0;
    let mergedDocs = 0;
    let deletedDocs = 0;

    for (const g of groups) {
      processedGroups += 1;
      if (limitGroups && processedGroups > limitGroups) break;

      const imdbId = g._id;
      const ids = Array.isArray(g.ids) ? g.ids : [];
      if (!isNonEmptyString(imdbId) || ids.length < 2) continue;

      const docs = await movies
        .find({ _id: { $in: ids.map((x) => (typeof x === 'string' ? new ObjectId(x) : x)) } })
        .toArray();
      if (docs.length < 2) continue;

      docs.sort((a, b) => scoreMovieDoc(b) - scoreMovieDoc(a));
      const master = docs[0];
      const others = docs.slice(1);

      const files = uniqFiles(docs.map(fileFromDoc));

      // Combine play stats at movie-level
      const playCountSum = docs.reduce((acc, d) => acc + (typeof d?.playCount === 'number' ? d.playCount : 0), 0);
      const lastPlayedAt = docs
        .map((d) => d?.lastPlayedAt)
        .filter(Boolean)
        .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];

      const update = {
        $set: {
          files,
          imdbId,
          tmdbId: typeof master?.tmdbId === 'number' ? master.tmdbId : null,
          title: master?.title ?? null,
          year: typeof master?.year === 'number' ? master.year : null,
          overview: master?.overview ?? null,
          genres: Array.isArray(master?.genres) ? master.genres : [],
          rating: typeof master?.rating === 'number' ? master.rating : null,
          poster: master?.poster ?? null,
          backdrop: master?.backdrop ?? null,
          playCount: playCountSum,
          lastPlayedAt: lastPlayedAt ?? master?.lastPlayedAt ?? null,
          mergedAt: new Date(),
          mergedFromCount: docs.length,
        },
      };

      if (!dryRun) {
        await movies.updateOne({ _id: master._id }, update);
        await movies.deleteMany({ _id: { $in: others.map((d) => d._id) } });
      }

      mergedDocs += 1;
      deletedDocs += others.length;

      if (processedGroups % 50 === 0) {
        console.log(
          `[progress] groups=${fmt(processedGroups)}/${fmt(groups.length)} merged=${fmt(mergedDocs)} deleted=${fmt(deletedDocs)}`,
        );
      }
    }

    console.log('== Done ==');
    console.log(`groups_processed: ${fmt(processedGroups)}`);
    console.log(`masters_updated: ${fmt(mergedDocs)}`);
    console.log(`duplicates_deleted: ${fmt(deletedDocs)}`);

    if (dryRun) {
      console.log('NOTE: This was a dry run. Set MERGE_DRY_RUN=0 to apply changes.');
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exitCode = 1;
});
