import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { google } from 'googleapis';

function envOrDefault(name, defaultValue) {
  const v = process.env[name];
  return v && String(v).trim() ? v : defaultValue;
}

async function loadOAuthClientFromCredentialsFile(credentialsPath) {
  const raw = await fs.readFile(credentialsPath, 'utf8');
  const json = JSON.parse(raw);

  const cfg = json.installed || json.web;
  if (!cfg?.client_id || !cfg?.client_secret) {
    throw new Error(
      `Invalid OAuth credentials file at ${credentialsPath}. Expected { installed: { client_id, client_secret, redirect_uris } }`,
    );
  }

  const redirectUri = Array.isArray(cfg.redirect_uris) && cfg.redirect_uris.length > 0 ? cfg.redirect_uris[0] : undefined;
  if (!redirectUri) {
    throw new Error(`OAuth credentials missing redirect_uris in ${credentialsPath}`);
  }

  return new google.auth.OAuth2(cfg.client_id, cfg.client_secret, redirectUri);
}

async function loadSavedToken(tokenPath) {
  try {
    const raw = await fs.readFile(tokenPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveToken(tokenPath, token) {
  const dir = path.dirname(tokenPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tokenPath, JSON.stringify(token, null, 2), 'utf8');
}

export async function getDriveAuth() {
  const credentialsPath = envOrDefault('GOOGLE_OAUTH_CREDENTIALS', path.resolve('credentials.json'));
  const tokenPath = envOrDefault('GOOGLE_OAUTH_TOKEN_PATH', path.resolve('token.json'));

  const oauth2Client = await loadOAuthClientFromCredentialsFile(credentialsPath);

  const saved = await loadSavedToken(tokenPath);
  if (saved) {
    oauth2Client.setCredentials(saved);

    // Persist refreshed tokens automatically
    oauth2Client.on('tokens', async (tokens) => {
      if (!tokens) return;
      const merged = { ...oauth2Client.credentials, ...tokens };
      await saveToken(tokenPath, merged);
    });

    return oauth2Client;
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
    console.log(`[auth] Token saved to ${tokenPath}`);

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

export async function getDriveClient() {
  const auth = await getDriveAuth();
  return google.drive({ version: 'v3', auth });
}
