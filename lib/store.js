/**
 * Layer di persistenza asincrono con doppio backend:
 *  - File JSON locali (sviluppo locale, VPS, Railway Volume)
 *  - Netlify Blobs (produzione serverless su Netlify, con fallback eventual se strong non disponibile)
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getStore as getNetlifyBlobStore } from '@netlify/blobs';
import { hashPassword } from './security.js';

function readJsonArraySync(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJsonArraySync(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export function createJsonFileDriver(config) {
  const keyToPath = {
    users: config.files.users,
    albums: config.files.albums,
    photos: config.files.photos
  };

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
    }
  };
}

export function createNetlifyBlobsDriver(storeName = 'carlo-portal-data') {
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
    }
  };
}

export function createStore(config, customDriver = null) {
  const driver =
    customDriver ||
    (config.isNetlify ? createNetlifyBlobsDriver() : createJsonFileDriver(config));

  async function loadUsers() {
    return driver.getArray('users');
  }

  async function saveUsers(users) {
    await driver.setArray('users', users);
  }

  async function loadAlbums() {
    return driver.getArray('albums');
  }

  async function saveAlbums(albums) {
    await driver.setArray('albums', albums);
  }

  async function loadPhotos() {
    return driver.getArray('photos');
  }

  async function savePhotos(photos) {
    await driver.setArray('photos', photos);
  }

  /**
   * Inizializza e sincronizza l'unico utente Admin dalle variabili d'ambiente.
   * Usa un fingerprint SHA-256 per evitare di ricalcolare scryptSync ad ogni cold start se invariato.
   */
  async function ensureAdminUser() {
    const existingUsers = await loadUsers();
    const { email, password, name } = config.admin;

    if (!email || !password) {
      const existingAdmin = existingUsers.find(u => u.role === 'admin' || u.id);
      if (existingAdmin && existingAdmin.role !== 'admin') {
        existingAdmin.role = 'admin';
        await saveUsers([existingAdmin]);
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
    const adminRecord = {
      id: 'usr_admin_01',
      role: 'admin',
      name,
      email,
      salt,
      passwordHash: hash,
      configFingerprint: fingerprint,
      createdAt: currentAdmin?.createdAt || now,
      updatedAt: now
    };
    await saveUsers([adminRecord]);
    return adminRecord;
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
    return {
      id: photo.id,
      driveFileId: photo.driveFileId,
      albumId: photo.albumId,
      originalName: photo.originalName,
      mimeType: photo.mimeType,
      size: photo.size || 0,
      hasThumbnail: Boolean(photo.hasThumbnail),
      uploadedAt: photo.uploadedAt,
      updatedAt: photo.updatedAt
    };
  }

  return {
    loadUsers,
    saveUsers,
    loadAlbums,
    saveAlbums,
    loadPhotos,
    savePhotos,
    ensureAdminUser,
    ensureDataFilesExist,
    sanitizeAlbumForAdmin,
    sanitizeAlbumForClient,
    sanitizePhotoForResponse
  };
}
