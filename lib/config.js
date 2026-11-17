/**
 * Configurazione centralizzata dell'applicazione (caricamento variabili .env)
 */
const path = require('path');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch {
  // Consente test o avvio anche se dotenv non è ancora installato
}

function getConfig(overrides = {}) {
  const rootDir = overrides.rootDir || path.resolve(__dirname, '..');
  const env = overrides.env || process.env;

  const rawPrivateKey = env.GOOGLE_PRIVATE_KEY || '';
  const normalizedPrivateKey = rawPrivateKey.replace(/\\n/g, '\n');

  return {
    rootDir,
    port: Number(env.PORT) || 3000,
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, ''),
    files: {
      users: path.join(rootDir, 'users.json'),
      albums: path.join(rootDir, 'albums.json'),
      photos: path.join(rootDir, 'photos.json')
    },
    admin: {
      email: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
      password: env.ADMIN_PASSWORD || '',
      name: (env.ADMIN_NAME || 'Carlo Munno Photographer').trim()
    },
    drive: {
      serviceAccountEmail: (env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim(),
      privateKey: normalizedPrivateKey,
      rootFolderId: (env.GOOGLE_DRIVE_ROOT_FOLDER_ID || '').trim()
    },
    session: {
      ttlMs: 24 * 60 * 60 * 1000, // 24 ore
      rememberTtlMs: 7 * 24 * 60 * 60 * 1000 // 7 giorni
    }
  };
}

module.exports = { getConfig };
