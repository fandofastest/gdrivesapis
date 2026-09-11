import express from 'express';
import { getApp } from './apiApp.js';
import './auth.js';
import './adminRoutes.js';
import './db.js';
import './scanManager.js';
import './scanDriveMovies.js';
import './driveStream.js';
import './cacheManager.js';

let expressApp = null;

export default async function handler(req, res) {
  try {
    // Restore original URL if rewritten by Vercel
    if (req.url) {
      try {
        const urlObj = new URL(req.url, 'http://localhost');
        const customUrl = urlObj.searchParams.get('__url');
        if (customUrl) {
          urlObj.searchParams.delete('__url');
          const remainingQuery = urlObj.searchParams.toString();
          req.url = customUrl + (remainingQuery ? `?${remainingQuery}` : '');
        }
      } catch {
        // ignore url parsing error
      }
    }

    if (!expressApp) {
      expressApp = await getApp();
    }
    return expressApp(req, res);
  } catch (err) {
    console.error('[Vercel Handler Error]', err);
    res.status(500).json({
      error: 'serverless_function_error',
      message: err?.message || String(err),
      hint: 'Pastikan MONGO_URI dan environment variables telah di-set di Dashboard Vercel (Project Settings -> Environment Variables).',
    });
  }
}
