import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { google } from 'googleapis';
import { connectMongo } from './db.js';

function envOrDefault(name, defaultValue) {
  const v = process.env[name];
  return v && String(v).trim() ? v : defaultValue;
}

export function getCredentialsPath() {
  return envOrDefault('GOOGLE_OAUTH_CREDENTIALS', path.resolve('credentials.json'));
}

export function getTokenPath() {
  return envOrDefault('GOOGLE_OAUTH_TOKEN_PATH', path.resolve('token.json'));
}

async function getDbCredentials() {
  try {
    const { db } = await connectMongo();
    const doc = await db.collection('credentials').findOne({ _id: 'google_oauth_credentials' });
    if (!doc) return null;
    if (doc.credentials) return doc.credentials;
    const { _id, updatedAt, ...clean } = doc;
    return clean;
  } catch {
    return null;
  }
}

async function getDbToken() {
  try {
    const { db } = await connectMongo();
    const doc = await db.collection('credentials').findOne({ _id: 'google_oauth_token' });
    if (!doc) return null;
    if (doc.token) return doc.token;
    const { _id, updatedAt, ...clean } = doc;
    return clean;
  } catch {
    return null;
  }
}

export async function loadOAuthClientFromCredentialsFile(credentialsPath = getCredentialsPath()) {
  let json = await getDbCredentials();

  if (!json) {
    try {
      const raw = await fs.readFile(credentialsPath, 'utf8');
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
  }

  if (!json) {
    throw new Error(`Google OAuth credentials not found in MongoDB or file system (${credentialsPath})`);
  }

  const cfg = json.installed || json.web;
  if (!cfg?.client_id || !cfg?.client_secret) {
    throw new Error(
      `Invalid OAuth credentials. Expected { installed: { client_id, client_secret, redirect_uris } }`,
    );
  }

  const redirectUri = Array.isArray(cfg.redirect_uris) && cfg.redirect_uris.length > 0 ? cfg.redirect_uris[0] : undefined;
  if (!redirectUri) {
    throw new Error(`OAuth credentials missing redirect_uris`);
  }

  return new google.auth.OAuth2(cfg.client_id, cfg.client_secret, redirectUri);
}

export async function loadSavedToken(tokenPath = getTokenPath()) {
  const dbToken = await getDbToken();
  if (dbToken && (dbToken.access_token || dbToken.refresh_token)) {
    return dbToken;
  }

  try {
    const raw = await fs.readFile(tokenPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveToken(tokenPath = getTokenPath(), token = {}) {
  // 1. Save to MongoDB for serverless / Vercel persistence
  try {
    const { db } = await connectMongo();
    const tokenDoc = { ...token, updatedAt: new Date() };
    await db.collection('credentials').updateOne(
      { _id: 'google_oauth_token' },
      { $set: tokenDoc },
      { upsert: true },
    );
  } catch (err) {
    console.error('[auth] Failed to save token to MongoDB:', err?.message || err);
  }

  // 2. Best-effort save to local file
  try {
    const dir = path.dirname(tokenPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tokenPath, JSON.stringify(token, null, 2), 'utf8');
  } catch {
    // Ignore file write errors on read-only serverless filesystems
  }
}

export async function saveCredentialsJson(content) {
  const json = typeof content === 'string' ? JSON.parse(content) : content;

  // 1. Save to MongoDB
  try {
    const { db } = await connectMongo();
    const credDoc = { ...json, updatedAt: new Date() };
    await db.collection('credentials').updateOne(
      { _id: 'google_oauth_credentials' },
      { $set: credDoc },
      { upsert: true },
    );
  } catch (err) {
    console.error('[auth] Failed to save credentials to MongoDB:', err?.message || err);
  }

  // 2. Best-effort save to local file
  try {
    const credentialsPath = getCredentialsPath();
    const dir = path.dirname(credentialsPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(credentialsPath, JSON.stringify(json, null, 2), 'utf8');
  } catch {
    // Ignore file write errors on read-only serverless filesystems
  }
}

export async function saveTokenJson(content) {
  const tokenPath = getTokenPath();
  const json = typeof content === 'string' ? JSON.parse(content) : content;
  await saveToken(tokenPath, json);
}

export async function getAuthStatus() {
  const credentialsPath = getCredentialsPath();
  const tokenPath = getTokenPath();

  let hasCredentials = false;
  let clientId = null;
  let credSource = 'none';

  const dbCreds = await getDbCredentials();
  if (dbCreds) {
    hasCredentials = true;
    credSource = 'mongodb';
    const cfg = dbCreds.installed || dbCreds.web;
    clientId = cfg?.client_id || null;
  } else {
    try {
      const client = await loadOAuthClientFromCredentialsFile(credentialsPath);
      hasCredentials = true;
      credSource = 'file';
      clientId = client._clientId || null;
    } catch {
      hasCredentials = false;
    }
  }

  const dbToken = await getDbToken();
  let hasToken = Boolean(dbToken && (dbToken.access_token || dbToken.refresh_token));
  let tokenSource = hasToken ? 'mongodb' : 'none';

  if (!hasToken) {
    const savedToken = await loadSavedToken(tokenPath);
    hasToken = Boolean(savedToken && (savedToken.access_token || savedToken.refresh_token));
    if (hasToken) tokenSource = 'file';
  }

  return {
    hasCredentials,
    hasToken,
    credSource,
    tokenSource,
    credentialsPath,
    tokenPath,
    clientId,
    isReady: hasCredentials && hasToken,
  };
}

export async function generateAuthUrl() {
  const oauth2Client = await loadOAuthClientFromCredentialsFile();
  const scopes = ['https://www.googleapis.com/auth/drive.readonly'];
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent',
  });
  return { authUrl, scopes };
}

export async function exchangeCodeForToken(code) {
  if (!code || !String(code).trim()) {
    throw new Error('Authorization code is required');
  }
  const oauth2Client = await loadOAuthClientFromCredentialsFile();
  const { tokens } = await oauth2Client.getToken(code.trim());
  const tokenPath = getTokenPath();
  await saveToken(tokenPath, tokens);
  return tokens;
}

export async function getDriveAuth({ interactive = false } = {}) {
  const credentialsPath = getCredentialsPath();
  const tokenPath = getTokenPath();

  const oauth2Client = await loadOAuthClientFromCredentialsFile(credentialsPath);

  const saved = await loadSavedToken(tokenPath);
  if (saved) {
    oauth2Client.setCredentials(saved);

    // Persist refreshed tokens automatically to MongoDB & file
    oauth2Client.on('tokens', async (tokens) => {
      if (!tokens) return;
      const merged = { ...oauth2Client.credentials, ...tokens };
      await saveToken(tokenPath, merged);
    });

    return oauth2Client;
  }

  if (!interactive) {
    throw new Error('GOOGLE_AUTH_REQUIRED: Google OAuth token missing. Please authorize via Admin UI.');
  }

  const scopes = ['https://www.googleapis.com/auth/drive.readonly'];
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent',
  });

  console.log('[auth] Open this URL in your browser to authorize:');
  console.log(authUrl);

  const rl = readline.createInterface({ input, output });
  try {
    const code = await rl.question('[auth] Paste the authorization code here: ');
    const { tokens } = await oauth2Client.getToken(code.trim());
    oauth2Client.setCredentials(tokens);
    await saveToken(tokenPath, tokens);
    console.log(`[auth] Token saved`);

    oauth2Client.on('tokens', async (t) => {
      if (!t) return;
      const merged = { ...oauth2Client.credentials, ...t };
      await saveToken(tokenPath, merged);
    });

    return oauth2Client;
  } finally {
    rl.close();
  }
}

export async function getDriveClient(options = {}) {
  const auth = await getDriveAuth(options);
  return google.drive({ version: 'v3', auth });
}


