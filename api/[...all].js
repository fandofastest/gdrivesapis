import { getApp } from '../apiApp.js';

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
