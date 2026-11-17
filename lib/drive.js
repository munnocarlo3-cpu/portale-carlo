/**
 * Client Google Drive API v3 tramite Service Account.
 * Mappa le sottocartelle della Root Folder in Album e le immagini in Foto.
 */
const { Readable } = require('stream');
const { ALLOWED_IMAGE_MIMES } = require('./security');

function createDriveService(config) {
  let cachedDrive = null;
  let cachedAuth = null;

  function isConfigured() {
    return Boolean(
      config.drive.serviceAccountEmail &&
      config.drive.privateKey &&
      config.drive.rootFolderId &&
      !config.drive.privateKey.includes('INSERISCI_LA_TUA_CHIAVE_PRIVATA')
    );
  }

  function getClients() {
    if (!isConfigured()) {
      throw new Error(
        'Google Drive non configurato. Imposta GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY e GOOGLE_DRIVE_ROOT_FOLDER_ID nel file .env.'
      );
    }
    if (cachedDrive && cachedAuth) {
      return { drive: cachedDrive, auth: cachedAuth };
    }

    const { google } = require('googleapis');
    cachedAuth = new google.auth.JWT({
      email: config.drive.serviceAccountEmail,
      key: config.drive.privateKey,
      scopes: ['https://www.googleapis.com/auth/drive']
    });
    cachedDrive = google.drive({ version: 'v3', auth: cachedAuth });
    return { drive: cachedDrive, auth: cachedAuth };
  }

  async function listAllPages(drive, queryParams) {
    const items = [];
    let pageToken = undefined;
    do {
      const response = await drive.files.list({
        ...queryParams,
        pageToken,
        pageSize: 1000,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });
      const files = response.data?.files || [];
      items.push(...files);
      pageToken = response.data?.nextPageToken || undefined;
    } while (pageToken);
    return items;
  }

  /**
   * Scansiona GOOGLE_DRIVE_ROOT_FOLDER_ID:
   * - Sottocartelle -> Album
   * - File immagine consentiti dentro ciascuna sottocartella -> Foto
   */
  async function listDriveAlbumsAndPhotos() {
    const { drive } = getClients();
    const rootId = config.drive.rootFolderId;

    const folders = await listAllPages(drive, {
      q: `'${rootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'nextPageToken, files(id, name, description, createdTime, modifiedTime)',
      orderBy: 'name'
    });

    const mimeConditions = Array.from(ALLOWED_IMAGE_MIMES)
      .map(m => `mimeType = '${m}'`)
      .join(' or ');

    const results = [];
    for (const folder of folders) {
      const files = await listAllPages(drive, {
        q: `'${folder.id}' in parents and trashed = false and (${mimeConditions})`,
        fields: 'nextPageToken, files(id, name, mimeType, size, thumbnailLink, hasThumbnail, createdTime, modifiedTime)',
        orderBy: 'name'
      });

      results.push({
        driveFolderId: folder.id,
        name: folder.name || 'Album senza nome',
        description: folder.description || '',
        createdTime: folder.createdTime || new Date().toISOString(),
        modifiedTime: folder.modifiedTime || folder.createdTime || new Date().toISOString(),
        photos: files.map(f => ({
          driveFileId: f.id,
          originalName: f.name || 'foto.jpg',
          mimeType: f.mimeType || 'image/jpeg',
          size: Number(f.size) || 0,
          hasThumbnail: Boolean(f.thumbnailLink || f.hasThumbnail),
          createdTime: f.createdTime || new Date().toISOString(),
          modifiedTime: f.modifiedTime || f.createdTime || new Date().toISOString()
        }))
      });
    }

    return results;
  }

  /**
   * Restituisce uno stream Node.js per il file richiesto (originale o thumbnail se thumb=true).
   */
  async function openMediaStream(driveFileId, { thumb = false } = {}) {
    const { drive, auth } = getClients();

    const metaRes = await drive.files.get({
      fileId: driveFileId,
      fields: 'id, name, mimeType, size, thumbnailLink',
      supportsAllDrives: true
    });
    const meta = metaRes.data;

    if (thumb && meta.thumbnailLink) {
      try {
        const scaledThumbUrl = meta.thumbnailLink.replace(/=s\d+(-c)?$/, '=s640');
        const tokenObj = await auth.getAccessToken();
        const accessToken = typeof tokenObj === 'string' ? tokenObj : tokenObj?.token;
        const thumbRes = await fetch(scaledThumbUrl, {
          headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
        });
        if (thumbRes.ok && thumbRes.body) {
          return {
            stream: Readable.fromWeb(thumbRes.body),
            mimeType: thumbRes.headers.get('content-type') || 'image/jpeg',
            size: Number(thumbRes.headers.get('content-length')) || 0,
            filename: meta.name || 'thumb.jpg'
          };
        }
      } catch {
        // Fallback automatico al file originale in caso di problemi col link thumbnail
      }
    }

    const mediaRes = await drive.files.get(
      {
        fileId: driveFileId,
        alt: 'media',
        supportsAllDrives: true
      },
      { responseType: 'stream' }
    );

    return {
      stream: mediaRes.data,
      mimeType: meta.mimeType || 'application/octet-stream',
      size: Number(meta.size) || 0,
      filename: meta.name || 'foto.jpg'
    };
  }

  /**
   * Aggiorna il contenuto binario di un file esistente su Google Drive
   * (richiede che il Service Account abbia permessi Editor sulla cartella).
   */
  async function updateMediaContent(driveFileId, buffer, mimeType) {
    const { drive } = getClients();
    const res = await drive.files.update({
      fileId: driveFileId,
      media: {
        mimeType,
        body: Readable.from(buffer)
      },
      fields: 'id, name, mimeType, size, thumbnailLink, hasThumbnail, modifiedTime',
      supportsAllDrives: true
    });
    return res.data;
  }

  return {
    isConfigured,
    listDriveAlbumsAndPhotos,
    openMediaStream,
    updateMediaContent
  };
}

module.exports = { createDriveService };
