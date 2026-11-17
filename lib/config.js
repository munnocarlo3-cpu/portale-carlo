/**
 * Configurazione centralizzata dell'applicazione (Locale, Railway, Netlify)
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT_DIR = path.resolve(__dirname, '..');

const envFilePath = path.join(DEFAULT_ROOT_DIR, '.env');
if (fs.existsSync(envFilePath)) {
  dotenv.config({ path: envFilePath });
}

export function getConfig(overrides = {}) {
  const rootDir = overrides.rootDir || DEFAULT_ROOT_DIR;
  const env = overrides.env || process.env;

  const dataDir = overrides.dataDir || env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || rootDir;
  const publicDir = overrides.publicDir || path.join(rootDir, 'public');

  const rawPrivateKey = env.GOOGLE_PRIVATE_KEY || '';
  const normalizedPrivateKey = rawPrivateKey.replace(/\\n/g, '\n');

  const adminEmail = (env.ADMIN_EMAIL || '').trim().toLowerCase();
  const adminPassword = env.ADMIN_PASSWORD || '';

  // Chiave HMAC per sessioni stateless (su Netlify è consigliato impostare SESSION_SECRET nelle env var)
  let sessionSecret = (env.SESSION_SECRET || '').trim();
  if (!sessionSecret) {
    const seed = `${adminEmail}|${adminPassword}|${normalizedPrivateKey}|carlo-portal-session-key`;
    sessionSecret = crypto.createHash('sha256').update(seed).digest('hex');
  }

  let publicBaseUrl = (env.PUBLIC_BASE_URL || env.URL || '').trim().replace(/\/+$/, '');
  if (!publicBaseUrl && env.RAILWAY_PUBLIC_DOMAIN) {
    publicBaseUrl = `https://${String(env.RAILWAY_PUBLIC_DOMAIN).trim()}`;
  }

  const isNetlify = Boolean(
    overrides.useNetlifyBlobs ||
    env.NETLIFY ||
    env.NETLIFY_BLOBS_CONTEXT
  );

  return {
    rootDir,
    publicDir,
    dataDir,
    isNetlify,
    port: Number(env.PORT) || 3000,
    publicBaseUrl,
    files: {
      users: path.join(dataDir, 'users.json'),
      albums: path.join(dataDir, 'albums.json'),
      photos: path.join(dataDir, 'photos.json')
    },
    admin: {
      email: adminEmail,
      password: adminPassword,
      name: (env.ADMIN_NAME || 'Carlo Munno Photographer').trim()
    },
    drive: {
      serviceAccountEmail: (env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim(),
      privateKey: normalizedPrivateKey,
      rootFolderId: (env.GOOGLE_DRIVE_ROOT_FOLDER_ID || '').trim()
    },
    session: {
      secret: sessionSecret,
      ttlMs: 24 * 60 * 60 * 1000, // 24 ore
      rememberTtlMs: 7 * 24 * 60 * 60 * 1000 // 7 giorni
    }
  };
}
