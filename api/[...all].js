import { getApp } from '../apiApp.js';
import '../auth.js';
import '../adminRoutes.js';
import '../db.js';
import '../scanManager.js';
import '../scanDriveMovies.js';
import '../driveStream.js';
import '../cacheManager.js';

export default async function handler(req, res) {
  try {
    const app = await getApp();
    return app(req, res);
  } catch (err) {
    console.error('[Vercel Handler Error]', err);
    res.status(500).json({
      error: 'serverless_function_error',
      message: err?.message || String(err),
      hint: 'Pastikan MONGO_URI dan environment variables telah di-set di Dashboard Vercel (Project Settings -> Environment Variables).',
    });
  }
}
