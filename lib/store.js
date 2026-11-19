/**
 * Layer di persistenza asincrono con doppio backend:
 *  - File JSON locali (sviluppo locale, VPS, Railway Volume)
 *  - Netlify Blobs (produzione serverless su Netlify, con fallback eventual se strong non disponibile)
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getStore as getNetlifyBlobStore } from '@netlify/blobs';
import { getMediaType, hashPassword } from './security.js';

function backupCorruptFile(filePath) {
  const backupPath = `${filePath}.corrupt.${Date.now()}.bak`;
  try {
    fs.copyFileSync(filePath, backupPath);
    return backupPath;
  } catch {
    return '';
  }
}

function readJsonArraySync(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }

  if (!raw || !raw.trim()) {
    const backupPath = backupCorruptFile(filePath);
    throw new Error(
      `File dati vuoto o troncato (${path.basename(filePath)})${backupPath ? `; backup salvato in ${path.basename(backupPath)}` : ''}.`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const backupPath = backupCorruptFile(filePath);
    throw new Error(
      `File dati JSON corrotto (${path.basename(filePath)})${backupPath ? `; backup salvato in ${path.basename(backupPath)}` : ''}.`
    );
  }

  if (!Array.isArray(parsed)) {
    const backupPath = backupCorruptFile(filePath);
    throw new Error(
      `Formato dati non valido in ${path.basename(filePath)} (atteso array JSON)${backupPath ? `; backup salvato in ${path.basename(backupPath)}` : ''}.`
    );
  }

  return parsed;
}

function writeJsonArraySync(filePath, data) {
  if (!Array.isArray(data)) {
    throw new TypeError(`Impossibile salvare ${path.basename(filePath)}: atteso un array.`);
  }
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const payload = JSON.stringify(data, null, 2);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;

  try {
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeFileSync(fd, payload, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

export function createJsonFileDriver(config) {
  const keyToPath = {
    users: config.files.users,
    albums: config.files.albums,
    photos: config.files.photos
  };
  const thumbCacheDir = path.join(config.dataDir, '.cache', 'thumbs');

  function safeCacheKey(cacheKey) {
    return String(cacheKey || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  return {
    async getArray(key) {
      return readJsonArraySync(keyToPath[key]);
    },
    async setArray(key, data) {
      writeJsonArraySync(keyToPath[key], data);
    },
    async initIfMissing() {
      for (const p of Object.values(keyToPath)) {
        if (!fs.existsSync(p)) writeJsonArraySync(p, []);
      }
    },
    async getCachedBinary(cacheKey, expectedVersion) {
      try {
        const safe = safeCacheKey(cacheKey);
        if (!safe) return null;
        const metaPath = path.join(thumbCacheDir, `${safe}.json`);
        const binPath = path.join(thumbCacheDir, `${safe}.bin`);
        if (!fs.existsSync(metaPath) || !fs.existsSync(binPath)) return null;
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (!meta || meta.version !== expectedVersion) return null;
        const buffer = fs.readFileSync(binPath);
        return { buffer, mimeType: meta.mimeType || 'image/jpeg' };
      } catch {
        return null;
      }
    },
    async setCachedBinary(cacheKey, buffer, metadata = {}) {
      try {
        const safe = safeCacheKey(cacheKey);
        if (!safe || !Buffer.isBuffer(buffer)) return;
        if (!fs.existsSync(thumbCacheDir)) fs.mkdirSync(thumbCacheDir, { recursive: true });
        const metaPath = path.join(thumbCacheDir, `${safe}.json`);
        const binPath = path.join(thumbCacheDir, `${safe}.bin`);
        const suffix = `${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        fs.writeFileSync(`${binPath}.${suffix}`, buffer);
        fs.renameSync(`${binPath}.${suffix}`, binPath);
        fs.writeFileSync(`${metaPath}.${suffix}`, JSON.stringify(metadata), 'utf-8');
        fs.renameSync(`${metaPath}.${suffix}`, metaPath);
      } catch {
        // Cache best-effort: non blocca la risposta
      }
    }
  };
}

export function createNetlifyBlobsDriver(
  storeName = 'carlo-portal-data',
  thumbStoreName = 'carlo-portal-thumbs'
) {
  return {
    async getArray(key) {
      try {
        const strongStore = getNetlifyBlobStore({ name: storeName, consistency: 'strong' });
        const data = await strongStore.get(key, { type: 'json', consistency: 'strong' });
        return Array.isArray(data) ? data : [];
      } catch (err) {
        if (err?.name === 'BlobsConsistencyError') {
          const eventualStore = getNetlifyBlobStore(storeName);
          const data = await eventualStore.get(key, { type: 'json' });
          return Array.isArray(data) ? data : [];
        }
        throw err;
      }
    },
    async setArray(key, data) {
      const store = getNetlifyBlobStore(storeName);
      await store.setJSON(key, data);
    },
    async initIfMissing() {
      // Su Netlify Blobs i key vengono creati al primo salvataggio
    },
    async getCachedBinary(cacheKey, expectedVersion) {
      try {
        const thumbStore = getNetlifyBlobStore(thumbStoreName);
        const entry = await thumbStore.getWithMetadata(cacheKey, { type: 'arrayBuffer' });
        if (!entry || !entry.data) return null;
        if (entry.metadata?.version !== expectedVersion) return null;
        return {
          buffer: Buffer.from(entry.data),
          mimeType: String(entry.metadata?.mimeType || 'image/jpeg')
        };
      } catch {
        return null;
      }
    },
    async setCachedBinary(cacheKey, buffer, metadata = {}) {
      try {
        if (!Buffer.isBuffer(buffer)) return;
        const thumbStore = getNetlifyBlobStore(thumbStoreName);
        const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        await thumbStore.set(cacheKey, ab, { metadata });
      } catch {
        // Cache best-effort
      }
    }
  };
}

export function createStore(config, customDriver = null) {
  const driver =
    customDriver ||
    (config.isNetlify ? createNetlifyBlobsDriver() : createJsonFileDriver(config));

  const keyLocks = new Map();

  function withKeyLock(key, task) {
    const prev = keyLocks.get(key) || Promise.resolve();
    const next = prev.then(task, task);
    const settled = next.catch(() => {});
    keyLocks.set(key, settled);
    settled.then(() => {
      if (keyLocks.get(key) === settled) {
        keyLocks.delete(key);
      }
    });
    return next;
  }

  async function runWithLocks(keys, task) {
    const uniqueSorted = [...new Set(keys)].sort();
    const runNested = (idx) => {
      if (idx >= uniqueSorted.length) return Promise.resolve().then(task);
      return withKeyLock(uniqueSorted[idx], () => runNested(idx + 1));
    };
    return runNested(0);
  }

  async function updateArray(key, updater) {
    return withKeyLock(key, async () => {
      const current = await driver.getArray(key);
      const outcome = await updater(current);
      if (Array.isArray(outcome)) {
        await driver.setArray(key, outcome);
        return outcome;
      }
      if (outcome && Array.isArray(outcome.data)) {
        if (outcome.save !== false) {
          await driver.setArray(key, outcome.data);
        }
        return outcome.result !== undefined ? outcome.result : outcome.data;
      }
      return current;
    });
  }

  async function loadUsers() {
    return driver.getArray('users');
  }

  async function saveUsers(users) {
    return withKeyLock('users', () => driver.setArray('users', users));
  }

  async function updateUsers(updater) {
    return updateArray('users', updater);
  }

  async function loadAlbums() {
    return driver.getArray('albums');
  }

  async function saveAlbums(albums) {
    return withKeyLock('albums', () => driver.setArray('albums', albums));
  }

  async function updateAlbums(updater) {
    return updateArray('albums', updater);
  }

  async function loadPhotos() {
    return driver.getArray('photos');
  }

  async function savePhotos(photos) {
    return withKeyLock('photos', () => driver.setArray('photos', photos));
  }

  async function updatePhotos(updater) {
    return updateArray('photos', updater);
  }

  async function updateCatalog(updater) {
    return runWithLocks(['albums', 'photos'], async () => {
      const [albums, photos] = await Promise.all([
        driver.getArray('albums'),
        driver.getArray('photos')
      ]);
      const outcome = await updater({ albums, photos });
      if (!outcome) return null;
      const writes = [];
      if (Array.isArray(outcome.albums)) {
        writes.push(driver.setArray('albums', outcome.albums));
      }
      if (Array.isArray(outcome.photos)) {
        writes.push(driver.setArray('photos', outcome.photos));
      }
      if (writes.length > 0) {
        await Promise.all(writes);
      }
      return outcome.result !== undefined ? outcome.result : outcome;
    });
  }

  /**
   * Inizializza e sincronizza l'unico utente Admin dalle variabili d'ambiente.
   * Usa un fingerprint SHA-256 per evitare di ricalcolare scryptSync ad ogni cold start se invariato.
   */
  async function ensureAdminUser() {
    return withKeyLock('users', async () => {
      const existingUsers = await driver.getArray('users');
      const { email, password, name } = config.admin;

      if (!email || !password) {
        const existingAdmin = existingUsers.find(u => u.role === 'admin' || u.id);
        if (existingAdmin && existingAdmin.role !== 'admin') {
          existingAdmin.role = 'admin';
          await driver.setArray('users', [existingAdmin]);
        }
        if (!existingAdmin) {
          console.warn('[AUTH] Attenzione: ADMIN_EMAIL o ADMIN_PASSWORD non configurati.');
        }
        return existingAdmin || null;
      }

      const fingerprint = crypto
        .createHash('sha256')
        .update(`${email}|${password}|${name}`)
        .digest('hex')
        .slice(0, 16);

      const currentAdmin = existingUsers.find(u => u.email.toLowerCase() === email);
      if (
        currentAdmin &&
        currentAdmin.role === 'admin' &&
        currentAdmin.configFingerprint === fingerprint &&
        existingUsers.length === 1
      ) {
        return currentAdmin;
      }

      const { salt, hash } = hashPassword(password);
      const now = new Date().toISOString();
      const fingerprintChanged = Boolean(currentAdmin && currentAdmin.configFingerprint !== fingerprint);
      const adminRecord = {
        id: 'usr_admin_01',
        role: 'admin',
        name,
        email,
        salt,
        passwordHash: hash,
        configFingerprint: fingerprint,
        sessionVersion: Number(currentAdmin?.sessionVersion) || 1,
        revokedJtis: fingerprintChanged
          ? []
          : (Array.isArray(currentAdmin?.revokedJtis) ? currentAdmin.revokedJtis : []),
        createdAt: currentAdmin?.createdAt || now,
        updatedAt: now
      };
      await driver.setArray('users', [adminRecord]);
      return adminRecord;
    });
  }

  async function ensureDataFilesExist() {
    await driver.initIfMissing();
    await ensureAdminUser();
  }

  function sanitizeAlbumForAdmin(album, photosCountMap = null) {
    const photoCount = photosCountMap ? (photosCountMap.get(album.id) || 0) : undefined;
    return {
      id: album.id,
      driveFolderId: album.driveFolderId,
      name: album.name,
      description: album.description || '',
      slideshowEnabled: Boolean(album.slideshowEnabled),
      shareEnabled: Boolean(album.shareEnabled),
      shareToken: album.shareToken || '',
      clientUsername: album.clientUsername || '',
      hasClientPassword: Boolean(album.clientPasswordHash),
      ...(photoCount !== undefined ? { photoCount } : {}),
      createdAt: album.createdAt,
      updatedAt: album.updatedAt
    };
  }

  function sanitizeAlbumForClient(album, photoCount = 0) {
    return {
      id: album.id,
      name: album.name,
      description: album.description || '',
      photoCount
    };
  }

  function sanitizePhotoForResponse(photo) {
    const mediaType = photo.mediaType || getMediaType(photo.mimeType);
    return {
      id: photo.id,
      driveFileId: photo.driveFileId,
      albumId: photo.albumId,
      originalName: photo.originalName,
      mimeType: photo.mimeType,
      mediaType,
      size: photo.size || 0,
      hasThumbnail: Boolean(photo.hasThumbnail),
      ...(photo.durationMillis ? { durationMillis: Number(photo.durationMillis) } : {}),
      ...(photo.width ? { width: Number(photo.width) } : {}),
      ...(photo.height ? { height: Number(photo.height) } : {}),
      uploadedAt: photo.uploadedAt,
      updatedAt: photo.updatedAt
    };
  }

  async function getCachedThumb(driveFileId, version) {
    if (typeof driver.getCachedBinary !== 'function') return null;
    const safeId = String(driveFileId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeId) return null;
    try {
      return await driver.getCachedBinary(`thumb_${safeId}`, String(version || ''));
    } catch {
      return null;
    }
  }

  async function setCachedThumb(driveFileId, version, buffer, mimeType) {
    if (typeof driver.setCachedBinary !== 'function') return;
    const safeId = String(driveFileId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeId || !Buffer.isBuffer(buffer)) return;
    try {
      await driver.setCachedBinary(`thumb_${safeId}`, buffer, {
        version: String(version || ''),
        mimeType: mimeType || 'image/jpeg'
      });
    } catch {
      // Best-effort
    }
  }

  return {
    loadUsers,
    saveUsers,
    updateUsers,
    loadAlbums,
    saveAlbums,
    updateAlbums,
    loadPhotos,
    savePhotos,
    updatePhotos,
    updateCatalog,
    getCachedThumb,
    setCachedThumb,
    ensureAdminUser,
    ensureDataFilesExist,
    sanitizeAlbumForAdmin,
    sanitizeAlbumForClient,
    sanitizePhotoForResponse
  };
}
