/**
 * Router API unificato (indipendente dall'ambiente HTTP):
 * utilizzato sia dal server Node.js locale/Railway sia da Netlify Functions v2.
 */
import { Readable } from 'stream';
import {
  hashPassword,
  verifyPassword,
  generateToken,
  isValidDriveFileId,
  isValidShareToken,
  normalizeShareSlug,
  RESERVED_SHARE_SLUGS,
  isValidAlbumId,
  detectImageFormat,
  isVideoMime,
  getMediaType,
  normalizeByteRangeHeader,
  sanitizeDownloadFilename,
  buildImageEtag,
  isEtagMatch,
  getClientIpFromHeaders,
  createLoginRateLimiter,
  ADMIN_SESSION_COOKIE,
  CLIENT_SESSION_COOKIE,
  LEGACY_SESSION_COOKIE,
  extractTokensBySource,
  extractTokenFromHeaders,
  buildSessionCookie,
  buildClearSessionCookie,
  isJtiRevoked,
  appendRevokedJti,
  createSessionStore
} from './security.js';

const MAX_MEMORY_THUMB_ITEMS = 80;
const MAX_CACHED_THUMB_BYTES = 512 * 1024;

function readStreamWithLimit(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    function onData(chunk) {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      chunks.push(buf);

      if (total > maxBytes) {
        settled = true;
        stream.removeListener('data', onData);
        stream.removeListener('end', onEnd);
        stream.removeListener('error', onError);
        stream.pause?.();
        const combined = Readable.from(
          (async function* () {
            for (const c of chunks) yield c;
            for await (const rest of stream) yield rest;
          })()
        );
        resolve({ complete: false, stream: combined });
      }
    }

    function onEnd() {
      if (settled) return;
      settled = true;
      resolve({ complete: true, buffer: Buffer.concat(chunks) });
    }

    function onError(err) {
      if (settled) return;
      settled = true;
      reject(err);
    }

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

export function createApiRouter({ config, store, drive, sessions: customSessions, loginLimiter: customLimiter }) {
  const sessions = customSessions || createSessionStore(config.session);
  const thumbMemoryCache = new Map();

  function getMemoryThumb(cacheKey) {
    const entry = thumbMemoryCache.get(cacheKey);
    if (!entry) return null;
    thumbMemoryCache.delete(cacheKey);
    thumbMemoryCache.set(cacheKey, entry);
    return entry;
  }

  function setMemoryThumb(cacheKey, value) {
    if (thumbMemoryCache.has(cacheKey)) {
      thumbMemoryCache.delete(cacheKey);
    } else if (thumbMemoryCache.size >= MAX_MEMORY_THUMB_ITEMS) {
      const oldestKey = thumbMemoryCache.keys().next().value;
      if (oldestKey !== undefined) thumbMemoryCache.delete(oldestKey);
    }
    thumbMemoryCache.set(cacheKey, value);
  }
  const loginLimiter =
    customLimiter ||
    createLoginRateLimiter({
      windowMs: 15 * 60 * 1000,
      maxAttempts: 5,
      blockDurationMs: 15 * 60 * 1000
    });

  let initializedPromise = null;
  async function ensureInitialized() {
    if (!initializedPromise) {
      initializedPromise = store.ensureDataFilesExist().catch((err) => {
        initializedPromise = null;
        throw err;
      });
    }
    return initializedPromise;
  }

  function jsonRes(status, data, extraHeaders = {}) {
    return {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...extraHeaders
      },
      body: JSON.stringify(data)
    };
  }

  function getBaseUrl(reqCtx) {
    if (config.publicBaseUrl) return config.publicBaseUrl;
    const proto = reqCtx.protocol || 'http';
    const host = reqCtx.host || `localhost:${config.port}`;
    return `${proto}://${host}`;
  }

  function buildShareUrls(reqCtx, shareToken) {
    if (!shareToken) return { shareUrl: '', legacyShareUrl: '', queryShareUrl: '' };
    const base = getBaseUrl(reqCtx);
    return {
      shareUrl: `${base}/${shareToken}`,
      legacyShareUrl: `${base}/share/${shareToken}`,
      queryShareUrl: `${base}/?album=${shareToken}`
    };
  }

  function getPhotoCountMap(photos) {
    const map = new Map();
    for (const p of photos) {
      map.set(p.albumId, (map.get(p.albumId) || 0) + 1);
    }
    return map;
  }

  function getAdminSessionVersion(admin) {
    const base = admin.configFingerprint || String(admin.passwordHash || '').slice(0, 16);
    return `${base}:v${Number(admin.sessionVersion) || 1}`;
  }

  function isValidAdminSession(admin, session) {
    if (!admin || !session || session.role !== 'admin') return false;
    if (session.userId !== admin.id) return false;
    if (session.ver !== getAdminSessionVersion(admin)) return false;
    if (isJtiRevoked(admin.revokedJtis, session.jti)) return false;
    return true;
  }

  function isValidClientSessionForAlbum(album, session, expectedShareToken = null) {
    if (!album || !session || session.role !== 'client') return false;
    if (album.id !== session.albumId) return false;
    if (album.shareEnabled !== true) return false;
    if (!albumMatchesShareToken(album, session.shareToken)) return false;
    if (expectedShareToken && !albumMatchesShareToken(album, expectedShareToken)) return false;
    if ((album.clientSessionVersion || 1) !== session.ver) return false;
    if (isJtiRevoked(album.revokedJtis, session.jti)) return false;
    return true;
  }

  function getCurrentSession(reqCtx, scope = 'any') {
    const token = extractTokenFromHeaders(reqCtx.headers || {}, scope);
    if (!token) return null;
    const session = sessions.get(token);
    return session ? { token, session } : null;
  }

  async function requireAdmin(reqCtx) {
    const auth = getCurrentSession(reqCtx, 'admin');
    if (!auth) {
      return { error: jsonRes(401, { message: 'Accesso non autenticato. Effettua il login come Admin.' }) };
    }
    if (auth.session.role !== 'admin') {
      return { error: jsonRes(403, { message: 'Accesso negato: privilegi di amministratore richiesti.' }) };
    }
    const users = await store.loadUsers();
    const admin = users.find(u => u.id === auth.session.userId && u.role === 'admin');
    if (!isValidAdminSession(admin, auth.session)) {
      return { error: jsonRes(401, { message: 'Sessione Admin non più valida.' }) };
    }
    return { token: auth.token, session: auth.session, admin };
  }

  function isLegacyRandomToken(token) {
    return /^[a-f0-9]{48}$/i.test(String(token || ''));
  }

  function getEffectiveShareSlug(album) {
    if (!album) return '';
    if (album.shareToken && !isLegacyRandomToken(album.shareToken)) {
      return album.shareToken;
    }
    if (album.clientUsername) {
      const slug = normalizeShareSlug(album.clientUsername);
      if (slug && slug.length >= 2 && !RESERVED_SHARE_SLUGS.has(slug)) {
        return slug;
      }
    }
    return album.shareToken || '';
  }

  function albumMatchesShareToken(album, shareToken) {
    const normalized = String(shareToken || '').trim().toLowerCase();
    if (!normalized || !album) return false;
    if (String(album.shareToken || '').toLowerCase() === normalized) {
      return true;
    }
    if ((!album.shareToken || isLegacyRandomToken(album.shareToken)) && album.clientUsername) {
      return normalizeShareSlug(album.clientUsername) === normalized;
    }
    return false;
  }

  function findAlbumByShareToken(albums, shareToken) {
    if (!shareToken) return null;
    return albums.find(a => albumMatchesShareToken(a, shareToken)) || null;
  }

  function formatAlbumForAdmin(album, countsMap, reqCtx) {
    const effectiveToken = getEffectiveShareSlug(album);
    return {
      ...store.sanitizeAlbumForAdmin(album, countsMap),
      ...(effectiveToken ? { shareToken: effectiveToken, ...buildShareUrls(reqCtx, effectiveToken) } : {})
    };
  }

  async function requireClientForAlbum(reqCtx, shareToken) {
    if (!isValidShareToken(shareToken)) {
      return { error: jsonRes(404, { message: 'Galleria non trovata.' }) };
    }
    const auth = getCurrentSession(reqCtx, 'client');
    if (!auth) {
      return { error: jsonRes(401, { message: 'Autenticazione richiesta per visualizzare questo album.' }) };
    }
    if (auth.session.role !== 'client') {
      return { error: jsonRes(403, { message: 'Non sei autorizzato ad accedere a questo album.' }) };
    }
    const albums = await store.loadAlbums();
    const album = albums.find(a => isValidClientSessionForAlbum(a, auth.session, shareToken));
    if (!album) {
      if (!albumMatchesShareToken({ shareToken: auth.session.shareToken }, shareToken)) {
        return { error: jsonRes(403, { message: 'Non sei autorizzato ad accedere a questo album.' }) };
      }
      return { error: jsonRes(401, { message: 'Condivisione revocata o sessione scaduta.' }) };
    }
    return { token: auth.token, session: auth.session, album };
  }

  async function handle(reqCtx) {
    const { method, pathname, searchParams, headers } = reqCtx;
    const isHttps = String(reqCtx.protocol || '').toLowerCase() === 'https';

    // ================= ENDPOINT PUBBLICI =================

    if (pathname === '/api/health' && method === 'GET') {
      let storageStatus = 'ok';
      let storageError = '';
      try {
        await ensureInitialized();
      } catch (err) {
        storageStatus = 'error';
        storageError = err?.message || 'Storage non disponibile';
      }
      return jsonRes(200, {
        status: 'ok',
        server: config.isNetlify
          ? 'Carlo Munno Photo Portal (Netlify + Google Drive)'
          : 'Carlo Munno Photo Portal (Google Drive Sync)',
        runtime: config.isNetlify ? 'netlify' : 'node',
        driveConfigured: drive.isConfigured(),
        storageStatus,
        ...(storageError ? { storageError } : {}),
        time: new Date().toISOString()
      });
    }

    await ensureInitialized();

    if (pathname === '/api/public/slideshow' && method === 'GET') {
      const [albums, photos] = await Promise.all([store.loadAlbums(), store.loadPhotos()]);
      const slideshowAlbumsMap = new Map(
        albums.filter(a => a.slideshowEnabled === true).map(a => [a.id, a.name])
      );

      const items = photos
        .filter(p => slideshowAlbumsMap.has(p.albumId) && !isVideoMime(p.mimeType))
        .map(p => ({
          driveFileId: p.driveFileId,
          originalName: p.originalName,
          albumName: slideshowAlbumsMap.get(p.albumId)
        }));

      return jsonRes(200, { items });
    }

    // ================= AUTENTICAZIONE ADMIN & SESSIONE =================

    if (pathname === '/api/admin/login' && method === 'POST') {
      const clientIp = getClientIpFromHeaders(headers, reqCtx.ip);
      const rateKey = `admin:${clientIp}`;
      const limit = loginLimiter.check(rateKey);
      if (!limit.allowed) {
        return jsonRes(
          429,
          { message: `Troppi tentativi falliti. Riprova tra ${limit.retryAfterSec} secondi.` },
          { 'Retry-After': String(limit.retryAfterSec) }
        );
      }

      try {
        await store.ensureAdminUser();

        const { email, password, rememberMe } = await reqCtx.readJsonBody();
        if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
          return jsonRes(400, { message: 'Inserisci email e password.' });
        }

        const users = await store.loadUsers();
        const normalizedEmail = email.toLowerCase().trim();
        const admin = users.find(u => u.role === 'admin' && u.email.toLowerCase() === normalizedEmail);

        if (!admin || !verifyPassword(password, admin.salt, admin.passwordHash)) {
          loginLimiter.recordFailure(rateKey);
          return jsonRes(401, { message: 'Credenziali Admin non valide.' });
        }

        loginLimiter.reset(rateKey);
        const { token, maxAgeSeconds } = sessions.create(
          {
            role: 'admin',
            userId: admin.id,
            ver: getAdminSessionVersion(admin)
          },
          Boolean(rememberMe)
        );

        return jsonRes(
          200,
          {
            message: 'Accesso Admin effettuato con successo.',
            token,
            role: 'admin',
            user: { id: admin.id, name: admin.name, email: admin.email }
          },
          {
            'Set-Cookie': buildSessionCookie(token, maxAgeSeconds, {
              isHttps,
              cookieName: ADMIN_SESSION_COOKIE
            })
          }
        );
      } catch (err) {
        return jsonRes(400, { message: err.message || 'Richiesta non valida.' });
      }
    }

    if (pathname === '/api/logout' && method === 'POST') {
      const scope = String(searchParams.get('scope') || '').toLowerCase();
      const revokeAll = ['1', 'true'].includes(String(searchParams.get('all') || '').toLowerCase());
      const { bearer, adminCookie, clientCookie, legacyCookie } = extractTokensBySource(headers);

      const clearNames = new Set();
      const candidateTokens = [];

      if (scope === 'admin') {
        if (bearer) candidateTokens.push(bearer);
        if (adminCookie) candidateTokens.push(adminCookie);
        if (legacyCookie) candidateTokens.push(legacyCookie);
        clearNames.add(ADMIN_SESSION_COOKIE);
        if (legacyCookie) clearNames.add(LEGACY_SESSION_COOKIE);
      } else if (scope === 'client') {
        if (bearer) candidateTokens.push(bearer);
        if (clientCookie) candidateTokens.push(clientCookie);
        if (legacyCookie) candidateTokens.push(legacyCookie);
        clearNames.add(CLIENT_SESSION_COOKIE);
        if (legacyCookie) clearNames.add(LEGACY_SESSION_COOKIE);
      } else {
        for (const t of [bearer, adminCookie, clientCookie, legacyCookie]) {
          if (t) candidateTokens.push(t);
        }
        clearNames.add(ADMIN_SESSION_COOKIE);
        clearNames.add(CLIENT_SESSION_COOKIE);
        if (legacyCookie) clearNames.add(LEGACY_SESSION_COOKIE);
      }

      const adminRevocations = [];
      const clientRevocations = [];
      let revokeAllAdmin = false;

      for (const tok of new Set(candidateTokens)) {
        const parsed = sessions.get(tok);
        sessions.delete(tok);
        if (!parsed) continue;
        if (parsed.role === 'admin' && (scope === '' || scope === 'admin')) {
          if (revokeAll) {
            revokeAllAdmin = true;
          } else if (parsed.jti) {
            adminRevocations.push({ userId: parsed.userId, jti: parsed.jti, exp: parsed.exp });
          }
        } else if (parsed.role === 'client' && (scope === '' || scope === 'client')) {
          if (parsed.jti && parsed.albumId) {
            clientRevocations.push({ albumId: parsed.albumId, jti: parsed.jti, exp: parsed.exp });
          }
        }
      }

      if (revokeAllAdmin || adminRevocations.length > 0) {
        await store.updateUsers((users) => {
          let changed = false;
          const nextUsers = users.map((u) => {
            if (u.role !== 'admin') return u;
            if (revokeAllAdmin) {
              changed = true;
              return {
                ...u,
                sessionVersion: (Number(u.sessionVersion) || 1) + 1,
                revokedJtis: [],
                updatedAt: new Date().toISOString()
              };
            }
            const matching = adminRevocations.filter(r => r.userId === u.id);
            if (matching.length === 0) return u;
            let nextJtis = u.revokedJtis;
            for (const r of matching) {
              nextJtis = appendRevokedJti(nextJtis, r.jti, r.exp);
            }
            changed = true;
            return { ...u, revokedJtis: nextJtis };
          });
          return { data: nextUsers, save: changed };
        });
      }

      if (clientRevocations.length > 0) {
        await store.updateAlbums((albums) => {
          let changed = false;
          const nextAlbums = albums.map((a) => {
            const matching = clientRevocations.filter(r => r.albumId === a.id);
            if (matching.length === 0) return a;
            let nextJtis = a.revokedJtis;
            for (const r of matching) {
              nextJtis = appendRevokedJti(nextJtis, r.jti, r.exp);
            }
            changed = true;
            return { ...a, revokedJtis: nextJtis };
          });
          return { data: nextAlbums, save: changed };
        });
      }

      const clearCookies = Array.from(clearNames).map(cookieName =>
        buildClearSessionCookie({ isHttps, cookieName })
      );

      return jsonRes(
        200,
        { message: 'Logout effettuato con successo.' },
        { 'Set-Cookie': clearCookies.length === 1 ? clearCookies[0] : clearCookies }
      );
    }

    if (pathname === '/api/me' && method === 'GET') {
      const scope = String(searchParams.get('scope') || '').toLowerCase();
      const { bearer, adminCookie, clientCookie, legacyCookie } = extractTokensBySource(headers);

      let candidates;
      if (bearer) {
        candidates = [bearer];
      } else if (scope === 'admin') {
        candidates = [adminCookie, legacyCookie].filter(Boolean);
      } else if (scope === 'client') {
        candidates = [clientCookie, legacyCookie].filter(Boolean);
      } else {
        candidates = [adminCookie, clientCookie, legacyCookie].filter(Boolean);
      }

      const validAuths = [];
      for (const tok of new Set(candidates)) {
        const s = sessions.get(tok);
        if (s) validAuths.push({ token: tok, session: s });
      }

      if (validAuths.length === 0) {
        return jsonRes(401, { message: 'Sessione assente o scaduta.' });
      }

      const tryAdmin = async (auth) => {
        if (auth.session.role !== 'admin') return null;
        const users = await store.loadUsers();
        const admin = users.find(u => u.id === auth.session.userId && u.role === 'admin');
        if (!isValidAdminSession(admin, auth.session)) return null;
        return jsonRes(200, {
          role: 'admin',
          user: { id: admin.id, name: admin.name, email: admin.email },
          security: {
            sessionSecretConfigured: config.session.configured,
            ...(config.session.warning ? { sessionSecretWarning: config.session.warning } : {})
          }
        });
      };

      const tryClient = async (auth) => {
        if (auth.session.role !== 'client') return null;
        const albums = await store.loadAlbums();
        const album = albums.find(a => isValidClientSessionForAlbum(a, auth.session));
        if (!album) return null;
        const photos = await store.loadPhotos();
        const photoCount = photos.filter(p => p.albumId === album.id).length;
        return jsonRes(200, {
          role: 'client',
          albumId: album.id,
          shareToken: getEffectiveShareSlug(album),
          album: store.sanitizeAlbumForClient(album, photoCount)
        });
      };

      for (const auth of validAuths) {
        if (scope === 'admin') {
          const res = await tryAdmin(auth);
          if (res) return res;
        } else if (scope === 'client') {
          const res = await tryClient(auth);
          if (res) return res;
        } else {
          const res = auth.session.role === 'admin' ? await tryAdmin(auth) : await tryClient(auth);
          if (res) return res;
        }
      }

      return jsonRes(401, { message: 'Sessione non valida o scaduta.' });
    }

    // ================= ENDPOINT ADMIN (PROTETTI) =================

    if (pathname === '/api/admin/sessions/revoke-all' && method === 'POST') {
      const auth = await requireAdmin(reqCtx);
      if (auth.error) return auth.error;

      await store.updateUsers((users) => {
        const nextUsers = users.map((u) =>
          u.id === auth.admin.id && u.role === 'admin'
            ? {
                ...u,
                sessionVersion: (Number(u.sessionVersion) || 1) + 1,
                revokedJtis: [],
                updatedAt: new Date().toISOString()
              }
            : u
        );
        return { data: nextUsers, save: true };
      });
      sessions.delete(auth.token);

      const clearCookies = [
        buildClearSessionCookie({ isHttps, cookieName: ADMIN_SESSION_COOKIE }),
        buildClearSessionCookie({ isHttps, cookieName: LEGACY_SESSION_COOKIE })
      ];

      return jsonRes(
        200,
        { message: 'Tutte le sessioni Admin sono state revocate.' },
        { 'Set-Cookie': clearCookies }
      );
    }

    if (pathname === '/api/admin/drive/sync' && method === 'POST') {
      const auth = await requireAdmin(reqCtx);
      if (auth.error) return auth.error;

      if (!drive.isConfigured()) {
        return jsonRes(503, {
          message: 'Google Drive non configurato. Imposta GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY e GOOGLE_DRIVE_ROOT_FOLDER_ID nelle variabili d\'ambiente.'
        });
      }

      try {
        const driveFolders = await drive.listDriveAlbumsAndPhotos();
        const syncOutcome = await store.updateCatalog(({ albums: prevAlbums, photos: prevPhotos }) => {
          const prevAlbumByDriveId = new Map(prevAlbums.map(a => [a.driveFolderId, a]));
          const prevPhotoByDriveId = new Map(prevPhotos.map(p => [p.driveFileId, p]));

          // Primo passaggio: match diretto per driveFolderId; secondo passaggio: fallback 1-a-1 non ambiguo per nome
          const matchedAlbumByFolderId = new Map();
          const matchedPrevAlbumIds = new Set();
          const unmatchedFolders = [];

          for (const folder of driveFolders) {
            const exact = prevAlbumByDriveId.get(folder.driveFolderId);
            if (exact) {
              matchedAlbumByFolderId.set(folder.driveFolderId, exact);
              matchedPrevAlbumIds.add(exact.id);
            } else {
              unmatchedFolders.push(folder);
            }
          }

          const unmatchedPrevByName = new Map();
          for (const alb of prevAlbums) {
            if (matchedPrevAlbumIds.has(alb.id)) continue;
            const key = String(alb.name || '').trim().toLowerCase();
            if (!key) continue;
            const bucket = unmatchedPrevByName.get(key) || [];
            bucket.push(alb);
            unmatchedPrevByName.set(key, bucket);
          }

          const unmatchedFoldersByName = new Map();
          for (const folder of unmatchedFolders) {
            const key = String(folder.name || '').trim().toLowerCase();
            if (!key) continue;
            const bucket = unmatchedFoldersByName.get(key) || [];
            bucket.push(folder);
            unmatchedFoldersByName.set(key, bucket);
          }

          let relinkedAlbums = 0;
          for (const folder of unmatchedFolders) {
            const key = String(folder.name || '').trim().toLowerCase();
            const prevCandidates = unmatchedPrevByName.get(key);
            const folderCandidates = unmatchedFoldersByName.get(key);
            if (prevCandidates?.length === 1 && folderCandidates?.length === 1) {
              matchedAlbumByFolderId.set(folder.driveFolderId, prevCandidates[0]);
              matchedPrevAlbumIds.add(prevCandidates[0].id);
              relinkedAlbums += 1;
            }
          }

          const now = new Date().toISOString();
          const nextAlbums = [];
          const nextPhotos = [];

          let addedAlbums = 0;
          let updatedAlbums = 0;
          let addedPhotos = 0;
          let updatedPhotos = 0;

          for (const folder of driveFolders) {
            const existingAlbum = matchedAlbumByFolderId.get(folder.driveFolderId);

            let albumRecord;
            if (existingAlbum) {
              updatedAlbums += 1;
              albumRecord = {
                ...existingAlbum,
                driveFolderId: folder.driveFolderId,
                name: folder.name,
                description: folder.description || existingAlbum.description || '',
                updatedAt: now
              };
            } else {
              addedAlbums += 1;
              albumRecord = {
                id: 'alb_' + generateToken(8),
                driveFolderId: folder.driveFolderId,
                name: folder.name,
                description: folder.description || '',
                slideshowEnabled: false,
                shareEnabled: false,
                shareToken: generateToken(24),
                clientUsername: '',
                clientPasswordSalt: '',
                clientPasswordHash: '',
                clientSessionVersion: 1,
                createdAt: folder.createdTime || now,
                updatedAt: now
              };
            }
            nextAlbums.push(albumRecord);

            for (const file of folder.photos) {
              const existingPhoto = prevPhotoByDriveId.get(file.driveFileId);
              const mediaType = file.mediaType || getMediaType(file.mimeType);
              const durationMillis = Number(file.durationMillis) || existingPhoto?.durationMillis || 0;
              const width = Number(file.width) || existingPhoto?.width || 0;
              const height = Number(file.height) || existingPhoto?.height || 0;
              if (existingPhoto) {
                updatedPhotos += 1;
                const fileModified = file.modifiedTime || '';
                const hasPhotoChanged =
                  existingPhoto.albumId !== albumRecord.id ||
                  existingPhoto.originalName !== file.originalName ||
                  existingPhoto.mimeType !== file.mimeType ||
                  existingPhoto.size !== file.size ||
                  (fileModified &&
                    existingPhoto.driveModifiedTime &&
                    existingPhoto.driveModifiedTime !== fileModified);

                nextPhotos.push({
                  ...existingPhoto,
                  albumId: albumRecord.id,
                  originalName: file.originalName,
                  mimeType: file.mimeType,
                  mediaType,
                  size: file.size,
                  hasThumbnail: file.hasThumbnail,
                  thumbnailLink: file.thumbnailLink || existingPhoto.thumbnailLink || '',
                  ...(durationMillis ? { durationMillis } : {}),
                  ...(width ? { width } : {}),
                  ...(height ? { height } : {}),
                  driveModifiedTime: fileModified || existingPhoto.driveModifiedTime || '',
                  updatedAt: hasPhotoChanged ? now : (existingPhoto.updatedAt || now)
                });
              } else {
                addedPhotos += 1;
                nextPhotos.push({
                  id: 'photo_' + generateToken(8),
                  driveFileId: file.driveFileId,
                  albumId: albumRecord.id,
                  originalName: file.originalName,
                  mimeType: file.mimeType,
                  mediaType,
                  size: file.size,
                  hasThumbnail: file.hasThumbnail,
                  thumbnailLink: file.thumbnailLink || '',
                  ...(durationMillis ? { durationMillis } : {}),
                  ...(width ? { width } : {}),
                  ...(height ? { height } : {}),
                  driveModifiedTime: file.modifiedTime || '',
                  uploadedAt: file.createdTime || now,
                  updatedAt: now
                });
              }
            }
          }

          const removedAlbums = prevAlbums.filter(a => !matchedPrevAlbumIds.has(a.id)).length;
          const nextPhotoDriveIds = new Set(nextPhotos.map(p => p.driveFileId));
          const removedPhotos = prevPhotos.filter(p => !nextPhotoDriveIds.has(p.driveFileId)).length;
          const totalVideos = nextPhotos.filter(p => isVideoMime(p.mimeType)).length;
          const totalImages = nextPhotos.length - totalVideos;

          return {
            albums: nextAlbums,
            photos: nextPhotos,
            result: {
              nextAlbums,
              nextPhotos,
              stats: {
                totalAlbums: nextAlbums.length,
                totalPhotos: nextPhotos.length,
                totalImages,
                totalVideos,
                addedAlbums,
                updatedAlbums,
                relinkedAlbums,
                removedAlbums,
                addedPhotos,
                updatedPhotos,
                removedPhotos
              }
            }
          };
        });

        const { nextAlbums, nextPhotos, stats } = syncOutcome;
        const countsMap = getPhotoCountMap(nextPhotos);

        return jsonRes(200, {
          message: stats.totalVideos > 0
            ? `Sincronizzazione completata: ${nextAlbums.length} album, ${stats.totalImages} foto e ${stats.totalVideos} video.`
            : `Sincronizzazione completata: ${nextAlbums.length} album e ${nextPhotos.length} foto.`,
          stats,
          albums: nextAlbums.map(a => formatAlbumForAdmin(a, countsMap, reqCtx)),
          photos: nextPhotos.map(store.sanitizePhotoForResponse)
        });
      } catch (err) {
        return jsonRes(502, {
          message: 'Errore durante la sincronizzazione con Google Drive: ' + err.message
        });
      }
    }

    if (pathname === '/api/admin/albums' && method === 'GET') {
      const auth = await requireAdmin(reqCtx);
      if (auth.error) return auth.error;

      const [albums, photos] = await Promise.all([store.loadAlbums(), store.loadPhotos()]);
      const countsMap = getPhotoCountMap(photos);

      return jsonRes(200, {
        albums: albums.map(a => formatAlbumForAdmin(a, countsMap, reqCtx))
      });
    }

    if (pathname === '/api/admin/photos' && method === 'GET') {
      const auth = await requireAdmin(reqCtx);
      if (auth.error) return auth.error;

      const albumIdFilter = searchParams.get('albumId');
      if (albumIdFilter && !isValidAlbumId(albumIdFilter)) {
        return jsonRes(400, { message: 'albumId non valido.' });
      }

      const photos = await store.loadPhotos();
      const filtered = albumIdFilter ? photos.filter(p => p.albumId === albumIdFilter) : photos;
      return jsonRes(200, {
        photos: filtered.map(store.sanitizePhotoForResponse)
      });
    }

    const saveEditedPhotoMatch = pathname.match(/^\/api\/admin\/photos\/([^/]+)\/save$/);
    if (saveEditedPhotoMatch && method === 'POST') {
      const auth = await requireAdmin(reqCtx);
      if (auth.error) return auth.error;

      if (!drive.isConfigured()) {
        return jsonRes(503, { message: 'Google Drive non configurato.' });
      }

      const photoId = saveEditedPhotoMatch[1];
      if (!isValidAlbumId(photoId)) {
        return jsonRes(400, { message: 'ID foto non valido.' });
      }

      try {
        const initialPhotos = await store.loadPhotos();
        const photo = initialPhotos.find(p => p.id === photoId);
        if (!photo) {
          return jsonRes(404, { message: 'Foto non trovata.' });
        }
        if (isVideoMime(photo.mimeType)) {
          return jsonRes(400, { message: 'L\'editor fotografico supporta solo immagini, non video.' });
        }

        const contentType = String(headers['content-type'] || '').toLowerCase();
        let buffer;

        if (contentType.includes('application/json') || !contentType) {
          const body = await reqCtx.readJsonBody(40 * 1024 * 1024);
          if (!body || typeof body.base64 !== 'string' || !body.base64) {
            return jsonRes(400, { message: 'Immagine Base64 mancante.' });
          }
          const base64Data = body.base64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/i, '');
          buffer = Buffer.from(base64Data, 'base64');
        } else if (typeof reqCtx.readBinaryBody === 'function') {
          buffer = await reqCtx.readBinaryBody(25 * 1024 * 1024);
        } else {
          return jsonRes(415, { message: 'Formato upload non supportato dal runtime.' });
        }

        if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
          return jsonRes(400, { message: 'Dati immagine mancanti o vuoti.' });
        }
        if (buffer.length > 25 * 1024 * 1024) {
          return jsonRes(413, { message: 'Immagine troppo grande (massimo 25MB).' });
        }

        const detected = detectImageFormat(buffer);
        if (!detected) {
          return jsonRes(400, { message: 'Formato immagine non valido o non supportato.' });
        }

        const updatedDriveFile = await drive.updateMediaContent(photo.driveFileId, buffer, detected.mimeType);

        const now = new Date().toISOString();
        const savedPhoto = await store.updatePhotos((photos) => {
          const idx = photos.findIndex(p => p.id === photoId || p.driveFileId === photo.driveFileId);
          if (idx === -1) {
            return { data: photos, save: false, result: null };
          }
          const current = photos[idx];
          const updatedRecord = {
            ...current,
            mimeType: updatedDriveFile?.mimeType || detected.mimeType,
            size: Number(updatedDriveFile?.size) || buffer.length,
            hasThumbnail: Boolean(updatedDriveFile?.thumbnailLink || updatedDriveFile?.hasThumbnail || current.hasThumbnail),
            thumbnailLink: updatedDriveFile?.thumbnailLink || current.thumbnailLink || '',
            driveModifiedTime: updatedDriveFile?.modifiedTime || now,
            updatedAt: now
          };
          const nextPhotos = [...photos];
          nextPhotos[idx] = updatedRecord;
          return { data: nextPhotos, save: true, result: updatedRecord };
        });

        if (!savedPhoto) {
          return jsonRes(404, { message: 'Foto non più presente dopo la sincronizzazione.' });
        }

        return jsonRes(200, {
          message: 'Modifiche salvate direttamente su Google Drive!',
          photo: store.sanitizePhotoForResponse(savedPhoto)
        });
      } catch (err) {
        const errMsg = String(err.message || '');
        const statusCode = Number(err.code || err.status) || 502;
        if (statusCode === 413 || /troppo grande/i.test(errMsg)) {
          return jsonRes(413, { message: 'Immagine troppo grande per il limite di upload del server.' });
        }
        if (statusCode === 400 || /JSON non valido/i.test(errMsg)) {
          return jsonRes(400, { message: errMsg || 'Richiesta non valida.' });
        }
        if (statusCode === 403 || /insufficient|permission|forbidden|readonly/i.test(errMsg)) {
          return jsonRes(403, {
            message: 'Permessi insufficienti su Google Drive: per salvare direttamente su Drive imposta il Service Account come "Editor" sulla cartella condivisa (oppure usa "Scarica Copia").'
          });
        }
        return jsonRes(502, { message: 'Errore salvataggio su Google Drive: ' + errMsg });
      }
    }

    const shareConfigMatch = pathname.match(/^\/api\/admin\/albums\/([^/]+)\/share$/);
    if (shareConfigMatch && method === 'POST') {
      const auth = await requireAdmin(reqCtx);
      if (auth.error) return auth.error;

      const albumId = shareConfigMatch[1];
      if (!isValidAlbumId(albumId)) {
        return jsonRes(400, { message: 'ID album non valido.' });
      }

      try {
        const body = await reqCtx.readJsonBody();
        const shareOutcome = await store.updateAlbums((albums) => {
          const index = albums.findIndex(a => a.id === albumId);
          if (index === -1) {
            return { data: albums, save: false, result: { errorResponse: jsonRes(404, { message: 'Album non trovato.' }) } };
          }

          const album = { ...albums[index] };
          const nextShareEnabled =
            typeof body.shareEnabled === 'boolean' ? body.shareEnabled : Boolean(album.shareEnabled);
          const prevUsername = album.clientUsername || '';
          const nextUsername =
            body.clientUsername !== undefined ? String(body.clientUsername).trim() : prevUsername;
          const newPassword =
            body.clientPassword !== undefined ? String(body.clientPassword) : '';

          if (nextShareEnabled) {
            if (!nextUsername || nextUsername.length < 2) {
              return {
                data: albums,
                save: false,
                result: { errorResponse: jsonRes(400, { message: 'Inserisci uno username cliente valido (almeno 2 caratteri).' }) }
              };
            }
            if (!newPassword && !album.clientPasswordHash) {
              return {
                data: albums,
                save: false,
                result: { errorResponse: jsonRes(400, { message: 'Imposta una password di accesso per attivare la condivisione.' }) }
              };
            }
          }

          let bumpSessionVersion = false;
          if (newPassword) {
            if (newPassword.length < 6) {
              return {
                data: albums,
                save: false,
                result: { errorResponse: jsonRes(400, { message: 'La password cliente deve avere almeno 6 caratteri.' }) }
              };
            }
            const { salt, hash } = hashPassword(newPassword);
            album.clientPasswordSalt = salt;
            album.clientPasswordHash = hash;
            bumpSessionVersion = true;
          }

          if (nextUsername) {
            const baseSlug = normalizeShareSlug(nextUsername);
            if (!baseSlug || baseSlug.length < 2 || RESERVED_SHARE_SLUGS.has(baseSlug)) {
              return {
                data: albums,
                save: false,
                result: {
                  errorResponse: jsonRes(400, {
                    message: 'Username cliente non valido o riservato per generare il link (/nomecliente).'
                  })
                }
              };
            }

            const shouldRotate = body.regenerateToken === true;
            const nextShareToken = shouldRotate ? `${baseSlug}-${generateToken(2)}` : baseSlug;

            const duplicateAlbum = albums.find(
              a => a.id !== album.id && getEffectiveShareSlug(a).toLowerCase() === nextShareToken.toLowerCase()
            );
            if (duplicateAlbum) {
              return {
                data: albums,
                save: false,
                result: {
                  errorResponse: jsonRes(409, {
                    message: `Il link "/${nextShareToken}" è già usato dall'album "${duplicateAlbum.name}". Scegli un altro username cliente.`
                  })
                }
              };
            }

            if (nextShareToken !== album.shareToken) {
              album.shareToken = nextShareToken;
              bumpSessionVersion = true;
            }
          } else if (body.regenerateToken === true || !album.shareToken) {
            album.shareToken = generateToken(24);
            bumpSessionVersion = true;
          }

          if (!nextShareEnabled && album.shareEnabled) {
            bumpSessionVersion = true;
          }

          if (bumpSessionVersion) {
            album.clientSessionVersion = (album.clientSessionVersion || 1) + 1;
            album.revokedJtis = [];
          }

          album.clientUsername = nextUsername;
          album.shareEnabled = nextShareEnabled;
          album.updatedAt = new Date().toISOString();

          const nextAlbums = [...albums];
          nextAlbums[index] = album;
          return { data: nextAlbums, save: true, result: { album } };
        });

        if (shareOutcome.errorResponse) {
          return shareOutcome.errorResponse;
        }

        const { album } = shareOutcome;
        const photos = await store.loadPhotos();
        const countsMap = getPhotoCountMap(photos);
        const urls = buildShareUrls(reqCtx, album.shareToken);

        return jsonRes(200, {
          message: album.shareEnabled
            ? 'Condivisione cliente salvata e attivata.'
            : 'Condivisione cliente disattivata.',
          album: {
            ...store.sanitizeAlbumForAdmin(album, countsMap),
            ...urls
          },
          ...urls
        });
      } catch (err) {
        return jsonRes(400, { message: err.message || 'Errore configurazione condivisione.' });
      }
    }

    const slideshowMatch = pathname.match(/^\/api\/admin\/albums\/([^/]+)\/slideshow$/);
    if (slideshowMatch && method === 'POST') {
      const auth = await requireAdmin(reqCtx);
      if (auth.error) return auth.error;

      const albumId = slideshowMatch[1];
      if (!isValidAlbumId(albumId)) {
        return jsonRes(400, { message: 'ID album non valido.' });
      }

      try {
        const body = await reqCtx.readJsonBody();
        const slideOutcome = await store.updateAlbums((albums) => {
          const index = albums.findIndex(a => a.id === albumId);
          if (index === -1) {
            return { data: albums, save: false, result: null };
          }
          const current = albums[index];
          const updatedAlbum = {
            ...current,
            slideshowEnabled:
              typeof body.slideshowEnabled === 'boolean' ? body.slideshowEnabled : !current.slideshowEnabled,
            updatedAt: new Date().toISOString()
          };
          const nextAlbums = [...albums];
          nextAlbums[index] = updatedAlbum;
          return { data: nextAlbums, save: true, result: updatedAlbum };
        });

        if (!slideOutcome) {
          return jsonRes(404, { message: 'Album non trovato.' });
        }

        const photos = await store.loadPhotos();
        const countsMap = getPhotoCountMap(photos);
        return jsonRes(200, {
          message: slideOutcome.slideshowEnabled
            ? `"${slideOutcome.name}" aggiunto allo sfondo dinamico.`
            : `"${slideOutcome.name}" rimosso dallo sfondo dinamico.`,
          album: formatAlbumForAdmin(slideOutcome, countsMap, reqCtx)
        });
      } catch (err) {
        return jsonRes(400, { message: err.message || 'Richiesta non valida.' });
      }
    }

    // ================= ACCESSO & GALLERIA CLIENTE =================

    const shareMetaMatch = pathname.match(/^\/api\/share\/([^/]+)\/meta$/);
    if (shareMetaMatch && method === 'GET') {
      const shareToken = shareMetaMatch[1];
      if (!isValidShareToken(shareToken)) {
        return jsonRes(404, { active: false, message: 'Galleria non trovata.' });
      }

      const albums = await store.loadAlbums();
      const album = findAlbumByShareToken(albums, shareToken);
      if (!album) {
        return jsonRes(404, { active: false, message: 'Galleria non trovata o link non valido.' });
      }

      return jsonRes(200, {
        albumName: album.name,
        description: album.description || '',
        active: Boolean(album.shareEnabled)
      });
    }

    const shareLoginMatch = pathname.match(/^\/api\/share\/([^/]+)\/login$/);
    if (shareLoginMatch && method === 'POST') {
      const shareToken = shareLoginMatch[1];
      if (!isValidShareToken(shareToken)) {
        return jsonRes(404, { message: 'Link galleria non valido.' });
      }

      const clientIp = getClientIpFromHeaders(headers, reqCtx.ip);
      const rateKey = `share:${String(shareToken).toLowerCase()}:${clientIp}`;
      const limit = loginLimiter.check(rateKey);
      if (!limit.allowed) {
        return jsonRes(
          429,
          { message: `Troppi tentativi falliti. Riprova tra ${limit.retryAfterSec} secondi.` },
          { 'Retry-After': String(limit.retryAfterSec) }
        );
      }

      try {
        const { username, password } = await reqCtx.readJsonBody();
        if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
          return jsonRes(400, { message: 'Inserisci username e password della galleria.' });
        }

        const albums = await store.loadAlbums();
        const album = findAlbumByShareToken(albums, shareToken);
        if (!album || !album.shareEnabled) {
          return jsonRes(403, { message: 'Questa galleria non è attiva o il link è stato revocato.' });
        }

        const usernameMatches =
          album.clientUsername &&
          username.trim().toLowerCase() === album.clientUsername.toLowerCase();
        const passwordMatches =
          album.clientPasswordHash &&
          verifyPassword(password, album.clientPasswordSalt, album.clientPasswordHash);

        if (!usernameMatches || !passwordMatches) {
          loginLimiter.recordFailure(rateKey);
          return jsonRes(401, { message: 'Username o password non corretti per questo album.' });
        }

        loginLimiter.reset(rateKey);
        const { token, maxAgeSeconds } = sessions.create(
          {
            role: 'client',
            albumId: album.id,
            shareToken: getEffectiveShareSlug(album),
            ver: album.clientSessionVersion || 1
          },
          false
        );

        const photos = await store.loadPhotos();
        const photoCount = photos.filter(p => p.albumId === album.id).length;
        return jsonRes(
          200,
          {
            message: `Benvenuto nella galleria "${album.name}".`,
            token,
            role: 'client',
            album: store.sanitizeAlbumForClient(album, photoCount)
          },
          {
            'Set-Cookie': buildSessionCookie(token, maxAgeSeconds, {
              isHttps,
              cookieName: CLIENT_SESSION_COOKIE
            })
          }
        );
      } catch (err) {
        return jsonRes(400, { message: err.message || 'Richiesta non valida.' });
      }
    }

    const sharePhotosMatch = pathname.match(/^\/api\/share\/([^/]+)\/photos$/);
    if (sharePhotosMatch && method === 'GET') {
      const shareToken = sharePhotosMatch[1];
      const auth = await requireClientForAlbum(reqCtx, shareToken);
      if (auth.error) return auth.error;

      const photos = await store.loadPhotos();
      const albumPhotos = photos.filter(p => p.albumId === auth.album.id);
      return jsonRes(200, {
        album: store.sanitizeAlbumForClient(auth.album, albumPhotos.length),
        photos: albumPhotos.map(store.sanitizePhotoForResponse)
      });
    }

    // ================= PROXY MEDIA SICURO GOOGLE DRIVE =================

    const mediaMatch = pathname.match(/^\/api\/media\/([^/]+)$/);
    if (mediaMatch && method === 'GET') {
      const driveFileId = mediaMatch[1];
      if (!isValidDriveFileId(driveFileId)) {
        return jsonRes(400, { message: 'ID file non valido.' });
      }

      const [photos, albums] = await Promise.all([store.loadPhotos(), store.loadAlbums()]);
      const photo = photos.find(p => p.driveFileId === driveFileId);
      if (!photo) {
        return jsonRes(404, { message: 'File non trovato.' });
      }
      const isVideo = isVideoMime(photo.mimeType);

      const { bearer, adminCookie, clientCookie, legacyCookie } = extractTokensBySource(headers);
      const candidateTokens = [...new Set([bearer, adminCookie, clientCookie, legacyCookie].filter(Boolean))];
      const candidateSessions = candidateTokens
        .map(tok => sessions.get(tok))
        .filter(Boolean);

      let isAdmin = false;
      const adminSessions = candidateSessions.filter(s => s.role === 'admin');
      if (adminSessions.length > 0) {
        const users = await store.loadUsers();
        isAdmin = adminSessions.some((session) => {
          const admin = users.find(u => u.id === session.userId && u.role === 'admin');
          return isValidAdminSession(admin, session);
        });
      }

      const isClientForThisAlbum = candidateSessions.some((session) => {
        if (session.role !== 'client' || photo.albumId !== session.albumId) return false;
        return albums.some(a => isValidClientSessionForAlbum(a, session));
      });

      const isPublicSlideshow =
        !isVideo &&
        albums.some(a => a.id === photo.albumId && a.slideshowEnabled === true);

      if (!isAdmin && !isClientForThisAlbum && !isPublicSlideshow) {
        return jsonRes(candidateSessions.length > 0 ? 403 : 401, {
          message: 'Non autorizzato a visualizzare questo file.'
        });
      }

      const wantsDownload = searchParams.get('download') === '1';
      if (wantsDownload && !isAdmin && !isClientForThisAlbum) {
        return jsonRes(401, { message: 'Download consentito solo agli utenti autenticati.' });
      }

      const wantsThumb = !wantsDownload && searchParams.get('thumb') === '1';
      const maxRangeChunkBytes = config.isNetlify && isVideo ? 4 * 1024 * 1024 : 0;
      const requestedRange =
        !wantsThumb && !wantsDownload
          ? normalizeByteRangeHeader(headers['range'], {
              totalSize: Number(photo.size) || 0,
              maxChunkBytes: maxRangeChunkBytes
            })
          : '';
      const version = photo.updatedAt || photo.driveModifiedTime || String(photo.size || 0);
      const etag = buildImageEtag(driveFileId, version, wantsThumb ? 'thumb' : 'full');
      const cacheControl = 'private, max-age=86400';

      if (!requestedRange && isEtagMatch(headers['if-none-match'], etag)) {
        return {
          status: 304,
          headers: {
            ETag: etag,
            'Cache-Control': cacheControl,
            Vary: 'Cookie, Authorization'
          },
          body: null
        };
      }

      const defaultName = isVideo ? 'video.mp4' : 'foto.jpg';
      const { asciiFallback, encoded } = sanitizeDownloadFilename(photo.originalName || defaultName);
      const baseDisposition = wantsDownload
        ? `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`
        : `inline; filename="${asciiFallback}"`;

      try {
        if (wantsThumb) {
          const thumbKey = `${driveFileId}:${version}`;
          const memHit = getMemoryThumb(thumbKey);
          if (memHit) {
            return {
              status: 200,
              headers: {
                'Content-Type': memHit.mimeType,
                'Content-Length': String(memHit.buffer.length),
                'Cache-Control': cacheControl,
                ETag: etag,
                Vary: 'Cookie, Authorization',
                'Content-Disposition': baseDisposition
              },
              stream: Readable.from(memHit.buffer)
            };
          }

          const diskOrBlobHit = await store.getCachedThumb(driveFileId, version);
          if (diskOrBlobHit && Buffer.isBuffer(diskOrBlobHit.buffer)) {
            setMemoryThumb(thumbKey, diskOrBlobHit);
            return {
              status: 200,
              headers: {
                'Content-Type': diskOrBlobHit.mimeType || 'image/jpeg',
                'Content-Length': String(diskOrBlobHit.buffer.length),
                'Cache-Control': cacheControl,
                ETag: etag,
                Vary: 'Cookie, Authorization',
                'Content-Disposition': baseDisposition
              },
              stream: Readable.from(diskOrBlobHit.buffer)
            };
          }
        }

        const media = await drive.openMediaStream(driveFileId, {
          thumb: wantsThumb,
          photoMeta: photo,
          range: requestedRange
        });

        const mediaMime = media.mimeType || photo.mimeType || 'application/octet-stream';
        const mediaHeaders = {
          'Content-Type': mediaMime,
          'Cache-Control': cacheControl,
          ETag: etag,
          Vary: 'Cookie, Authorization',
          'Content-Disposition': baseDisposition
        };

        if (wantsThumb && media.isThumbnail !== false && media.stream) {
          const buffered = await readStreamWithLimit(media.stream, MAX_CACHED_THUMB_BYTES);
          if (buffered.complete && buffered.buffer.length > 0) {
            const entry = { buffer: buffered.buffer, mimeType: mediaMime };
            setMemoryThumb(`${driveFileId}:${version}`, entry);
            await store.setCachedThumb(driveFileId, version, buffered.buffer, mediaMime);
            mediaHeaders['Content-Length'] = String(buffered.buffer.length);
            return {
              status: 200,
              headers: mediaHeaders,
              stream: Readable.from(buffered.buffer)
            };
          }
          return {
            status: 200,
            headers: mediaHeaders,
            stream: buffered.stream
          };
        }

        if (!wantsThumb) {
          mediaHeaders['Accept-Ranges'] = media.acceptRanges || 'bytes';
        }
        if (media.status === 206 && media.contentRange) {
          mediaHeaders['Content-Range'] = media.contentRange;
        }
        if (media.size > 0) {
          mediaHeaders['Content-Length'] = String(media.size);
        }

        return {
          status: media.status === 206 ? 206 : 200,
          headers: mediaHeaders,
          stream: media.stream
        };
      } catch (err) {
        if (err?.status === 404) {
          return jsonRes(404, { message: err.message || 'File non trovato su Google Drive.' });
        }
        if (err?.status === 416) {
          return jsonRes(416, { message: 'Intervallo byte richiesto non valido.' });
        }
        return jsonRes(502, { message: 'Impossibile recuperare il file da Google Drive: ' + err.message });
      }
    }

    return null;
  }

  return {
    handle,
    ensureInitialized,
    sessions
  };
}
