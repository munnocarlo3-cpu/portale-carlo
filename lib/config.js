/**
 * Configurazione centralizzata dell'applicazione (Locale, Railway, Netlify)
 */
const crypto = require('crypto');
const path = require('path');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch {
  // Consente avvio anche in ambienti in cui le env var sono iniettate dalla piattaforma
}

function getConfig(overrides = {}) {
  const rootDir = overrides.rootDir || path.resolve(__dirname, '..');
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

module.exports = { getConfig };
