/**
 * Configurazione centralizzata dell'applicazione (Locale, Railway, Netlify)
 */
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const CONFIG_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = path.resolve(CONFIG_DIR, '..');

function stripOuterQuotes(raw) {
  const trimmed = String(raw || '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normalizePrivateKey(raw) {
  return stripOuterQuotes(raw).replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim();
}

export function getConfig(overrides = {}) {
  const rootDir = overrides.rootDir || DEFAULT_ROOT_DIR;
  const env = overrides.env || process.env;

  const dataDir = overrides.dataDir || env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || rootDir;
  const publicDir = overrides.publicDir || path.join(rootDir, 'public');

  const normalizedPrivateKey = normalizePrivateKey(env.GOOGLE_PRIVATE_KEY);

  const adminEmail = stripOuterQuotes(env.ADMIN_EMAIL).toLowerCase();
  const adminPassword = env.ADMIN_PASSWORD || '';

  const rawSessionSecret = stripOuterQuotes(env.SESSION_SECRET);
  const isNetlify = Boolean(
    overrides.useNetlifyBlobs ||
    env.NETLIFY ||
    env.NETLIFY_BLOBS_CONTEXT
  );
  const isNetlifyDev = env.NETLIFY_DEV === 'true' || env.CONTEXT === 'dev';
  const isProduction =
    !isNetlifyDev &&
    (isNetlify || env.NODE_ENV === 'production' || Boolean(env.RAILWAY_ENVIRONMENT));

  let sessionSecret = rawSessionSecret;
  let sessionSecretWarning = '';
  if (!rawSessionSecret) {
    sessionSecretWarning =
      'SESSION_SECRET non impostata nelle variabili d\'ambiente (richiesti almeno 32 caratteri casuali).';
  } else if (rawSessionSecret.length < 32) {
    sessionSecretWarning =
      `SESSION_SECRET troppo corta (${rawSessionSecret.length} caratteri; minimo consigliato: 32).`;
  }

  const sessionSecretConfigured = rawSessionSecret.length >= 32;
  if (sessionSecretWarning) {
    if (isProduction && env.ALLOW_WEAK_SESSION_SECRET !== 'true') {
      throw new Error(
        `[SECURITY] ${sessionSecretWarning} Imposta SESSION_SECRET nelle variabili d'ambiente dell'hosting prima di avviare in produzione.`
      );
    }
    if (!sessionSecret) {
      const seed = `${adminEmail}|${adminPassword}|${normalizedPrivateKey}|carlo-portal-session-key`;
      sessionSecret = crypto.createHash('sha256').update(seed).digest('hex');
    }
  }

  let publicBaseUrl = (env.PUBLIC_BASE_URL || env.URL || '').trim().replace(/\/+$/, '');
  if (!publicBaseUrl && env.RAILWAY_PUBLIC_DOMAIN) {
    publicBaseUrl = `https://${String(env.RAILWAY_PUBLIC_DOMAIN).trim()}`;
  }

  return {
    rootDir,
    publicDir,
    dataDir,
    isNetlify,
    isProduction,
    port: Number(env.PORT) || 3000,
    publicBaseUrl,
    files: {
      users: path.join(dataDir, 'users.json'),
      albums: path.join(dataDir, 'albums.json'),
      photos: path.join(dataDir, 'photos.json'),
      activities: path.join(dataDir, 'activities.json'),
      transactions: path.join(dataDir, 'transactions.json'),
      services: path.join(dataDir, 'services.json'),
      music: path.join(dataDir, 'music.json')
    },
    admin: {
      email: adminEmail,
      password: adminPassword,
      name: (env.ADMIN_NAME || 'Carlo Munno Photographer').trim()
    },
    drive: {
      serviceAccountEmail: stripOuterQuotes(env.GOOGLE_SERVICE_ACCOUNT_EMAIL),
      privateKey: normalizedPrivateKey,
      rootFolderId: stripOuterQuotes(env.GOOGLE_DRIVE_ROOT_FOLDER_ID)
    },
    session: {
      secret: sessionSecret,
      configured: sessionSecretConfigured,
      warning: sessionSecretWarning,
      ttlMs: 24 * 60 * 60 * 1000, // 24 ore
      rememberTtlMs: 7 * 24 * 60 * 60 * 1000 // 7 giorni
    }
  };
}
