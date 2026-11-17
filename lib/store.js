/**
 * Layer di persistenza JSON (utenti Admin, album Drive e foto)
 * con sanitizzazione DTO per evitare la fuga di hash/salt verso il client.
 */
const fs = require('fs');
const path = require('path');
const { hashPassword, verifyPassword } = require('./security');

function readJsonArray(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJsonArray(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function createStore(config) {
  function loadUsers() {
    return readJsonArray(config.files.users);
  }

  function saveUsers(users) {
    writeJsonArray(config.files.users, users);
  }

  function loadAlbums() {
    return readJsonArray(config.files.albums);
  }

  function saveAlbums(albums) {
    writeJsonArray(config.files.albums, albums);
  }

  function loadPhotos() {
    return readJsonArray(config.files.photos);
  }

  function savePhotos(photos) {
    writeJsonArray(config.files.photos, photos);
  }

  /**
   * Inizializza e mantiene un unico utente Admin sincronizzato con .env.
   * Non prevede mai registrazione pubblica.
   */
  function ensureAdminUser() {
    const existingUsers = loadUsers();
    const { email, password, name } = config.admin;

    if (!email || !password) {
      // Mantiene eventuale admin esistente senza hardcodare password di fallback
      const existingAdmin = existingUsers.find(u => u.role === 'admin' || u.id);
      if (existingAdmin && existingAdmin.role !== 'admin') {
        existingAdmin.role = 'admin';
        saveUsers([existingAdmin]);
      }
      if (!existingAdmin) {
        console.warn('[AUTH] Attenzione: ADMIN_EMAIL o ADMIN_PASSWORD non configurati nel file .env.');
      }
      return existingAdmin || null;
    }

    const currentAdmin = existingUsers.find(u => u.email.toLowerCase() === email);
    const sameCredentials =
      currentAdmin &&
      currentAdmin.role === 'admin' &&
      currentAdmin.name === name &&
      verifyPassword(password, currentAdmin.salt, currentAdmin.passwordHash);

    if (sameCredentials && existingUsers.length === 1) {
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
      createdAt: currentAdmin?.createdAt || now,
      updatedAt: now
    };
    saveUsers([adminRecord]);
    return adminRecord;
  }

  function ensureDataFilesExist() {
    if (!fs.existsSync(config.files.albums)) saveAlbums([]);
    if (!fs.existsSync(config.files.photos)) savePhotos([]);
    ensureAdminUser();
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

module.exports = { createStore };
