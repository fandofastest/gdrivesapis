import 'dotenv/config';
import { MongoClient } from 'mongodb';

let cached;

export async function connectMongo() {
  if (cached) return cached;

  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri || !String(mongoUri).trim()) {
    throw new Error('Missing MONGO_URI environment variable.');
  }

  const client = new MongoClient(mongoUri, { maxPoolSize: 20 });
  await client.connect();

  const db = client.db();
  const movies = db.collection('movies');
  const series = db.collection('series');
  const episodes = db.collection('episodes');

  cached = { client, db, movies, series, episodes };
  return cached;
}

export async function closeMongo() {
  if (!cached) return;
  const { client } = cached;
  cached = null;
  await client.close();
}
