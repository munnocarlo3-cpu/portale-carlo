/**
 * Client Google Drive API v3 tramite Service Account (JWT RS256 + fetch nativo, zero dipendenze esterne).
 * Mappa le sottocartelle della Root Folder in Album e le immagini in Foto.
 */
import crypto from 'crypto';
import { Readable } from 'stream';
import { ALLOWED_IMAGE_MIMES } from './security.js';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

function base64UrlEncodeJson(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function escapeDriveQueryValue(val) {
  return String(val || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function toNodeReadable(body) {
  if (body instanceof Readable) return body;
  if (typeof Readable.fromWeb === 'function' && body && typeof body.getReader === 'function') {
    return Readable.fromWeb(body);
  }
  return Readable.from(body || []);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, list.length));
  const results = new Array(list.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < list.length) {
      const idx = nextIndex++;
      results[idx] = await mapper(list[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

async function parseDriveError(res) {
  let raw = '';
  try {
    raw = await res.text();
  } catch {}

  let parsed = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {}
  }

  const message =
    parsed?.error?.message ||
    parsed?.error_description ||
    parsed?.message ||
    (typeof parsed?.error === 'string' ? parsed.error : '') ||
    raw ||
    `Errore Google Drive HTTP ${res.status}`;

  const err = new Error(message);
  err.status = res.status;
  err.code = parsed?.error?.code || res.status;
  return err;
}

export function createDriveService(config, { fetchImpl = globalThis.fetch } = {}) {
  let cachedAccessToken = '';
  let tokenExpiresAtMs = 0;
  let inFlightTokenPromise = null;

  function isConfigured() {
    return Boolean(
      config.drive.serviceAccountEmail &&
      config.drive.privateKey &&
      config.drive.rootFolderId &&
      !config.drive.privateKey.includes('INSERISCI_LA_TUA_CHIAVE_PRIVATA')
    );
  }

  function assertConfigured() {
    if (!isConfigured()) {
      throw new Error(
        'Google Drive non configurato. Imposta GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY e GOOGLE_DRIVE_ROOT_FOLDER_ID nelle variabili d\'ambiente.'
      );
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('Fetch API non disponibile in questo runtime Node.js (richiesto Node >= 20).');
    }
  }

  function createServiceAccountJwt() {
    const nowSec = Math.floor(Date.now() / 1000);
    const header = base64UrlEncodeJson({ alg: 'RS256', typ: 'JWT' });
    const claimSet = base64UrlEncodeJson({
      iss: config.drive.serviceAccountEmail,
      scope: DRIVE_SCOPE,
      aud: OAUTH_TOKEN_URL,
      exp: nowSec + 3600,
      iat: nowSec
    });
    const signingInput = `${header}.${claimSet}`;
    const signature = crypto
      .createSign('RSA-SHA256')
      .update(signingInput)
      .sign(config.drive.privateKey, 'base64url');
    return `${signingInput}.${signature}`;
  }

  async function requestNewAccessToken() {
    const assertion = createServiceAccountJwt();
    const formBody = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    }).toString();

    const res = await fetchImpl(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formBody
    });

    if (!res.ok) {
      throw await parseDriveError(res);
    }

    const data = await res.json();
    if (!data?.access_token) {
      throw new Error('Risposta OAuth2 Google priva di access_token.');
    }

    const expiresInSec = Math.max(120, Number(data.expires_in) || 3600);
    cachedAccessToken = data.access_token;
    tokenExpiresAtMs = Date.now() + (expiresInSec - 60) * 1000;
    return cachedAccessToken;
  }

  async function getAccessToken(forceRefresh = false) {
    assertConfigured();
    if (!forceRefresh && cachedAccessToken && Date.now() < tokenExpiresAtMs) {
      return cachedAccessToken;
    }
    if (forceRefresh) {
      cachedAccessToken = '';
      tokenExpiresAtMs = 0;
    }
    if (!inFlightTokenPromise) {
      inFlightTokenPromise = requestNewAccessToken().finally(() => {
        inFlightTokenPromise = null;
      });
    }
    return inFlightTokenPromise;
  }

  async function driveFetch(url, options = {}, allowTokenRetry = true) {
    const token = await getAccessToken(false);
    const res = await fetchImpl(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${token}`
      }
    });

    if (res.status === 401 && allowTokenRetry && !options.body) {
      const freshToken = await getAccessToken(true);
      return fetchImpl(url, {
        ...options,
        headers: {
          ...(options.headers || {}),
          Authorization: `Bearer ${freshToken}`
        }
      });
    }

    return res;
  }

  async function listAllPages(queryParams) {
    const items = [];
    let pageToken = undefined;

    do {
      const url = new URL(`${DRIVE_API_BASE}/files`);
      url.searchParams.set('q', queryParams.q);
      url.searchParams.set('fields', queryParams.fields);
      if (queryParams.orderBy) url.searchParams.set('orderBy', queryParams.orderBy);
      url.searchParams.set('pageSize', '1000');
      url.searchParams.set('supportsAllDrives', 'true');
      url.searchParams.set('includeItemsFromAllDrives', 'true');
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const res = await driveFetch(url.toString());
      if (!res.ok) {
        throw await parseDriveError(res);
      }

      const data = await res.json();
      const files = Array.isArray(data?.files) ? data.files : [];
      items.push(...files);
      pageToken = data?.nextPageToken || undefined;
    } while (pageToken);

    return items;
  }

  /**
   * Scansiona GOOGLE_DRIVE_ROOT_FOLDER_ID con concorrenza controllata:
   * - Sottocartelle -> Album
   * - File immagine consentiti dentro ciascuna sottocartella -> Foto
   */
  async function listDriveAlbumsAndPhotos({ concurrency = 5 } = {}) {
    assertConfigured();
    const safeRootId = escapeDriveQueryValue(config.drive.rootFolderId);

    const folders = await listAllPages({
      q: `'${safeRootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'nextPageToken, files(id, name, description, createdTime, modifiedTime)',
      orderBy: 'name'
    });

    const mimeConditions = Array.from(ALLOWED_IMAGE_MIMES)
      .map(m => `mimeType = '${m}'`)
      .join(' or ');

    return mapWithConcurrency(folders, concurrency, async (folder) => {
      const safeFolderId = escapeDriveQueryValue(folder.id);
      const files = await listAllPages({
        q: `'${safeFolderId}' in parents and trashed = false and (${mimeConditions})`,
        fields: 'nextPageToken, files(id, name, mimeType, size, thumbnailLink, hasThumbnail, createdTime, modifiedTime)',
        orderBy: 'name'
      });

      return {
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
          thumbnailLink: f.thumbnailLink || '',
          createdTime: f.createdTime || new Date().toISOString(),
          modifiedTime: f.modifiedTime || f.createdTime || new Date().toISOString()
        }))
      };
    });
  }

  async function fetchFileMetadata(driveFileId) {
    const metaUrl = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(driveFileId)}`);
    metaUrl.searchParams.set('fields', 'id, name, mimeType, size, thumbnailLink');
    metaUrl.searchParams.set('supportsAllDrives', 'true');

    const metaRes = await driveFetch(metaUrl.toString());
    if (!metaRes.ok) {
      throw await parseDriveError(metaRes);
    }
    return metaRes.json();
  }

  async function tryFetchThumb(thumbnailLink, fallbackFilename) {
    if (!thumbnailLink) return null;
    try {
      const scaledThumbUrl = thumbnailLink.replace(/=s\d+(-c)?$/, '=s640');
      const thumbRes = await driveFetch(scaledThumbUrl);
      if (thumbRes.ok && thumbRes.body) {
        return {
          stream: toNodeReadable(thumbRes.body),
          mimeType: thumbRes.headers.get('content-type') || 'image/jpeg',
          size: Number(thumbRes.headers.get('content-length')) || 0,
          filename: fallbackFilename || 'thumb.jpg',
          isThumbnail: true
        };
      }
    } catch {
      // Fallback al refresh metadata o file originale
    }
    return null;
  }

  /**
   * Restituisce uno stream Node.js per il file richiesto (originale o thumbnail se thumb=true).
   * Se `photoMeta` è già noto dallo store, evita la chiamata metadata extra verso Google Drive.
   */
  async function openMediaStream(driveFileId, { thumb = false, photoMeta = null } = {}) {
    assertConfigured();

    let meta = photoMeta
      ? {
          id: driveFileId,
          name: photoMeta.originalName || photoMeta.name,
          mimeType: photoMeta.mimeType,
          size: photoMeta.size,
          thumbnailLink: photoMeta.thumbnailLink || ''
        }
      : null;

    if (thumb) {
      if (meta?.thumbnailLink) {
        const directThumb = await tryFetchThumb(meta.thumbnailLink, meta.name);
        if (directThumb) return directThumb;
      }

      const freshMeta = await fetchFileMetadata(driveFileId);
      meta = freshMeta;
      if (freshMeta.thumbnailLink) {
        const freshThumb = await tryFetchThumb(freshMeta.thumbnailLink, freshMeta.name);
        if (freshThumb) return freshThumb;
      }
    } else if (!meta) {
      meta = await fetchFileMetadata(driveFileId);
    }

    const mediaUrl = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(driveFileId)}`);
    mediaUrl.searchParams.set('alt', 'media');
    mediaUrl.searchParams.set('supportsAllDrives', 'true');

    const mediaRes = await driveFetch(mediaUrl.toString());
    if (!mediaRes.ok || !mediaRes.body) {
      throw await parseDriveError(mediaRes);
    }

    return {
      stream: toNodeReadable(mediaRes.body),
      mimeType: meta?.mimeType || mediaRes.headers.get('content-type') || 'application/octet-stream',
      size: Number(meta?.size) || Number(mediaRes.headers.get('content-length')) || 0,
      filename: meta?.name || 'foto.jpg',
      isThumbnail: false
    };
  }

  /**
   * Aggiorna il contenuto binario di un file esistente su Google Drive
   * (richiede che il Service Account abbia permessi Editor sulla cartella).
   */
  async function updateMediaContent(driveFileId, buffer, mimeType) {
    assertConfigured();

    const uploadUrl = new URL(`${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(driveFileId)}`);
    uploadUrl.searchParams.set('uploadType', 'media');
    uploadUrl.searchParams.set('fields', 'id, name, mimeType, size, thumbnailLink, hasThumbnail, modifiedTime');
    uploadUrl.searchParams.set('supportsAllDrives', 'true');

    const uploadRes = await driveFetch(uploadUrl.toString(), {
      method: 'PATCH',
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(buffer.length)
      },
      body: buffer
    });

    if (!uploadRes.ok) {
      throw await parseDriveError(uploadRes);
    }

    return uploadRes.json();
  }

  return {
    isConfigured,
    listDriveAlbumsAndPhotos,
    openMediaStream,
    updateMediaContent
  };
}
