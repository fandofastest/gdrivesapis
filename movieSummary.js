import 'dotenv/config';
import { MongoClient } from 'mongodb';

function fmt(n) {
  return new Intl.NumberFormat('en-US').format(Number(n) || 0);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri || !String(mongoUri).trim()) {
    throw new Error('Missing MONGO_URI environment variable.');
  }

  const client = new MongoClient(mongoUri, { maxPoolSize: 5 });
  await client.connect();

  try {
    const db = client.db();
    const movies = db.collection('movies');

    const total = await movies.countDocuments();

    const missingImdb = await movies.countDocuments({ $or: [{ imdbId: null }, { imdbId: { $exists: false } }, { imdbId: '' }] });
    const missingTmdb = await movies.countDocuments({ $or: [{ tmdbId: null }, { tmdbId: { $exists: false } }] });
    const missingBoth = await movies.countDocuments({
      $and: [
        { $or: [{ imdbId: null }, { imdbId: { $exists: false } }, { imdbId: '' }] },
        { $or: [{ tmdbId: null }, { tmdbId: { $exists: false } }] },
      ],
    });

    const hasImdb = total - missingImdb;
    const hasTmdb = total - missingTmdb;

    const dupImdbAgg = await movies
      .aggregate([
        { $match: { imdbId: { $type: 'string', $ne: '' } } },
        { $group: { _id: '$imdbId', count: { $sum: 1 }, driveFileIds: { $push: '$driveFileId' } } },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1 } },
      ])
      .toArray();

    const dupTmdbAgg = await movies
      .aggregate([
        { $match: { tmdbId: { $type: 'number' } } },
        { $group: { _id: '$tmdbId', count: { $sum: 1 }, driveFileIds: { $push: '$driveFileId' } } },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1 } },
      ])
      .toArray();

    const dupPairAgg = await movies
      .aggregate([
        {
          $match: {
            imdbId: { $type: 'string', $ne: '' },
            tmdbId: { $type: 'number' },
          },
        },
        {
          $group: {
            _id: { imdbId: '$imdbId', tmdbId: '$tmdbId' },
            count: { $sum: 1 },
            driveFileIds: { $push: '$driveFileId' },
          },
        },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1 } },
      ])
      .toArray();

    const dupImdbTotalDocs = dupImdbAgg.reduce((acc, r) => acc + (Number(r.count) || 0), 0);
    const dupTmdbTotalDocs = dupTmdbAgg.reduce((acc, r) => acc + (Number(r.count) || 0), 0);
    const dupPairTotalDocs = dupPairAgg.reduce((acc, r) => acc + (Number(r.count) || 0), 0);

    console.log('== Movies Summary ==');
    console.log(`total_movies: ${fmt(total)}`);
    console.log('');

    console.log('== Coverage ==');
    console.log(`has_imdbId: ${fmt(hasImdb)}`);
    console.log(`missing_imdbId: ${fmt(missingImdb)}`);
    console.log(`has_tmdbId: ${fmt(hasTmdb)}`);
    console.log(`missing_tmdbId: ${fmt(missingTmdb)}`);
    console.log(`missing_both_imdbId_and_tmdbId: ${fmt(missingBoth)}`);
    console.log('');

    console.log('== Duplicates (same id appears in multiple movie docs) ==');
    console.log(`duplicate_imdbId_distinct_values: ${fmt(dupImdbAgg.length)}`);
    console.log(`duplicate_imdbId_total_docs_involved: ${fmt(dupImdbTotalDocs)}`);
    console.log(`duplicate_tmdbId_distinct_values: ${fmt(dupTmdbAgg.length)}`);
    console.log(`duplicate_tmdbId_total_docs_involved: ${fmt(dupTmdbTotalDocs)}`);
    console.log(`duplicate_pair(imdbId+tmdbId)_distinct_values: ${fmt(dupPairAgg.length)}`);
    console.log(`duplicate_pair(imdbId+tmdbId)_total_docs_involved: ${fmt(dupPairTotalDocs)}`);
    console.log('');

    const show = (rows, mapId) => {
      const top = rows.slice(0, 10);
      if (!top.length) return;
      console.log('Top 10 examples:');
      for (const r of top) {
        const id = mapId(r._id);
        const ids = Array.isArray(r.driveFileIds) ? r.driveFileIds.slice(0, 5).filter(isNonEmptyString) : [];
        console.log(`- id=${id} count=${r.count} driveFileIds=${ids.join(', ')}${Array.isArray(r.driveFileIds) && r.driveFileIds.length > 5 ? ' ...' : ''}`);
      }
      console.log('');
    };

    console.log('== Duplicate imdbId examples ==');
    show(dupImdbAgg, (id) => String(id));

    console.log('== Duplicate tmdbId examples ==');
    show(dupTmdbAgg, (id) => String(id));

    console.log('== Duplicate (imdbId+tmdbId) examples ==');
    show(dupPairAgg, (id) => `${id.imdbId} / ${id.tmdbId}`);

    // Sanity checks: count docs with bad types
    const badImdbType = await movies.countDocuments({ imdbId: { $exists: true, $not: { $type: 'string' } } });
    const badTmdbType = await movies.countDocuments({ tmdbId: { $exists: true, $not: { $type: 'number' } } });

    if (badImdbType || badTmdbType) {
      console.log('== Type warnings ==');
      if (badImdbType) console.log(`imdbId_exists_but_not_string: ${fmt(badImdbType)}`);
      if (badTmdbType) console.log(`tmdbId_exists_but_not_number: ${fmt(badTmdbType)}`);
      console.log('');
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exitCode = 1;
});
