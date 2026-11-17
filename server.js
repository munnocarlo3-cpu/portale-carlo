/**
 * Server Web & API (Node.js) - Carlo Munno Photographer
 * Architettura:
 *  - Unico account Admin inizializzato da .env in users.json
 *  - Sincronizzazione album e foto da Google Drive API v3 (Service Account)
 *  - Condivisione album clienti tramite link /share/<token> (o /?album=<token>) + credenziali dedicate
 *  - Proxy sicuro per lo streaming immagini da Google Drive con isolamento sessioni Admin / Client
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { getConfig } = require('./lib/config');
const {
  verifyPassword,
  generateToken,
  isValidDriveFileId,
  isValidShareToken,
  isValidAlbumId,
  detectImageFormat,
  sanitizeDownloadFilename,
  getClientIp,
  createLoginRateLimiter,
  extractToken,
  buildSessionCookie,
  buildClearSessionCookie,
  createSessionStore,
  applySecurityHeaders,
  sendJson,
  parseJsonBody
} = require('./lib/security');
const { createStore } = require('./lib/store');
const { createDriveService } = require('./lib/drive');

const PUBLIC_STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/style.css', 'style.css'],
  ['/script.js', 'script.js']
]);

const STATIC_MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

function createAppServer(options = {}) {
  const config = getConfig(options);
  const store = createStore(config);
  const drive = options.driveService || createDriveService(config);
  const sessions = createSessionStore(config.session);
  const loginLimiter = createLoginRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxAttempts: 5,
    blockDurationMs: 15 * 60 * 1000
  });

  store.ensureDataFilesExist();

  function getBaseUrl(req) {
    if (config.publicBaseUrl) return config.publicBaseUrl;
    const proto = req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http');
    const host = req.headers.host || `localhost:${config.port}`;
    return `${proto}://${host}`;
  }

  function buildShareUrls(req, shareToken) {
    const base = getBaseUrl(req);
    return {
      shareUrl: `${base}/share/${shareToken}`,
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

  function getCurrentSession(req) {
    const token = extractToken(req);
    if (!token) return null;
    const session = sessions.get(token);
    return session ? { token, session } : null;
  }

  function requireAdmin(req, res) {
    const auth = getCurrentSession(req);
    if (!auth) {
      sendJson(res, 401, { message: 'Accesso non autenticato. Effettua il login come Admin.' });
      return null;
    }
    if (auth.session.role !== 'admin') {
      sendJson(res, 403, { message: 'Accesso negato: privilegi di amministratore richiesti.' });
      return null;
    }
    const users = store.loadUsers();
    const admin = users.find(u => u.id === auth.session.userId && u.role === 'admin');
    if (!admin) {
      sessions.delete(auth.token);
      sendJson(res, 401, { message: 'Sessione Admin non più valida.' });
      return null;
    }
    return { token: auth.token, session: auth.session, admin };
  }

  function requireClientForAlbum(req, res, shareToken) {
    if (!isValidShareToken(shareToken)) {
      sendJson(res, 404, { message: 'Galleria non trovata.' });
      return null;
    }
    const auth = getCurrentSession(req);
    if (!auth) {
      sendJson(res, 401, { message: 'Autenticazione richiesta per visualizzare questo album.' });
      return null;
    }
    if (auth.session.role !== 'client' || auth.session.shareToken !== shareToken) {
      sendJson(res, 403, { message: 'Non sei autorizzato ad accedere a questo album.' });
      return null;
    }
    const albums = store.loadAlbums();
    const album = albums.find(
      a => a.id === auth.session.albumId && a.shareToken === shareToken && a.shareEnabled === true
    );
    if (!album) {
      sessions.delete(auth.token);
      sendJson(res, 403, { message: 'Condivisione revocata o album non disponibile.' });
      return null;
    }
    return { token: auth.token, session: auth.session, album };
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('405 Metodo Non Consentito');
    }

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('400 Richiesta Non Valida');
    }

    // Route SPA per i link diretti ai clienti: /share/<shareToken>
    let mappedFile = PUBLIC_STATIC_FILES.get(decodedPath);
    if (!mappedFile && /^\/share\/[a-f0-9]{16,128}\/?$/i.test(decodedPath)) {
      mappedFile = 'index.html';
    }

    if (!mappedFile) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Risorsa Non Trovata');
    }

    const rootResolved = path.resolve(config.rootDir);
    const targetPath = path.resolve(rootResolved, mappedFile);
    if (!targetPath.startsWith(rootResolved + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('403 Accesso Negato');
    }

    const ext = path.extname(targetPath).toLowerCase();
    const contentType = STATIC_MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(targetPath, (err, content) => {
      if (err) {
        res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(err.code === 'ENOENT' ? '404 Risorsa Non Trovata' : '500 Errore del Server');
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache'
      });
      res.end(req.method === 'HEAD' ? undefined : content);
    });
  }

  const server = http.createServer(async (req, res) => {
    applySecurityHeaders(req, res, config.port, config.publicBaseUrl);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    let urlObj;
    try {
      urlObj = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(res, 400, { message: 'URL non valido.' });
    }
    const pathname = urlObj.pathname;

    // ================= ENDPOINT PUBBLICI =================

    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        status: 'ok',
        server: 'Carlo Munno Photo Portal (Google Drive Sync)',
        driveConfigured: drive.isConfigured(),
        time: new Date().toISOString()
      });
    }

    if (pathname === '/api/public/slideshow' && req.method === 'GET') {
      const albums = store.loadAlbums();
      const photos = store.loadPhotos();
      const slideshowAlbumsMap = new Map(
        albums.filter(a => a.slideshowEnabled === true).map(a => [a.id, a.name])
      );

      const items = photos
        .filter(p => slideshowAlbumsMap.has(p.albumId))
        .map(p => ({
          driveFileId: p.driveFileId,
          originalName: p.originalName,
          albumName: slideshowAlbumsMap.get(p.albumId)
        }));

      return sendJson(res, 200, { items });
    }

    // ================= AUTENTICAZIONE ADMIN & SESSIONE =================

    if (pathname === '/api/admin/login' && req.method === 'POST') {
      const rateKey = `admin:${getClientIp(req)}`;
      const limit = loginLimiter.check(rateKey);
      if (!limit.allowed) {
        return sendJson(
          res,
          429,
          { message: `Troppi tentativi falliti. Riprova tra ${limit.retryAfterSec} secondi.` },
          { 'Retry-After': String(limit.retryAfterSec) }
        );
      }

      try {
        const { email, password, rememberMe } = await parseJsonBody(req);
        if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
          return sendJson(res, 400, { message: 'Inserisci email e password.' });
        }

        const users = store.loadUsers();
        const normalizedEmail = email.toLowerCase().trim();
        const admin = users.find(u => u.role === 'admin' && u.email.toLowerCase() === normalizedEmail);

        if (!admin || !verifyPassword(password, admin.salt, admin.passwordHash)) {
          loginLimiter.recordFailure(rateKey);
          return sendJson(res, 401, { message: 'Credenziali Admin non valide.' });
        }

        loginLimiter.reset(rateKey);
        const { token, maxAgeSeconds } = sessions.create(
          { role: 'admin', userId: admin.id },
          Boolean(rememberMe)
        );

        return sendJson(
          res,
          200,
          {
            message: 'Accesso Admin effettuato con successo.',
            token,
            role: 'admin',
            user: { id: admin.id, name: admin.name, email: admin.email }
          },
          { 'Set-Cookie': buildSessionCookie(token, maxAgeSeconds, req) }
        );
      } catch (err) {
        return sendJson(res, 400, { message: err.message || 'Richiesta non valida.' });
      }
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      const token = extractToken(req);
      if (token) sessions.delete(token);
      return sendJson(
        res,
        200,
        { message: 'Logout effettuato con successo.' },
        { 'Set-Cookie': buildClearSessionCookie() }
      );
    }

    if (pathname === '/api/me' && req.method === 'GET') {
      const auth = getCurrentSession(req);
      if (!auth) {
        return sendJson(res, 401, { message: 'Sessione assente o scaduta.' });
      }

      if (auth.session.role === 'admin') {
        const users = store.loadUsers();
        const admin = users.find(u => u.id === auth.session.userId && u.role === 'admin');
        if (!admin) {
          sessions.delete(auth.token);
          return sendJson(res, 401, { message: 'Sessione Admin non valida.' });
        }
        return sendJson(res, 200, {
          role: 'admin',
          user: { id: admin.id, name: admin.name, email: admin.email }
        });
      }

      if (auth.session.role === 'client') {
        const albums = store.loadAlbums();
        const album = albums.find(
          a => a.id === auth.session.albumId &&
               a.shareToken === auth.session.shareToken &&
               a.shareEnabled === true
        );
        if (!album) {
          sessions.delete(auth.token);
          return sendJson(res, 401, { message: 'Sessione galleria non più valida.' });
        }
        const photoCount = store.loadPhotos().filter(p => p.albumId === album.id).length;
        return sendJson(res, 200, {
          role: 'client',
          albumId: album.id,
          shareToken: album.shareToken,
          album: store.sanitizeAlbumForClient(album, photoCount)
        });
      }

      return sendJson(res, 401, { message: 'Sessione non valida.' });
    }

    // ================= ENDPOINT ADMIN (PROTETTI) =================

    if (pathname === '/api/admin/drive/sync' && req.method === 'POST') {
      const auth = requireAdmin(req, res);
      if (!auth) return;

      if (!drive.isConfigured()) {
        return sendJson(res, 503, {
          message: 'Google Drive non configurato. Imposta GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY e GOOGLE_DRIVE_ROOT_FOLDER_ID in .env.'
        });
      }

      try {
        const driveFolders = await drive.listDriveAlbumsAndPhotos();
        const prevAlbums = store.loadAlbums();
        const prevPhotos = store.loadPhotos();

        const prevAlbumByDriveId = new Map(prevAlbums.map(a => [a.driveFolderId, a]));
        const prevPhotoByDriveId = new Map(prevPhotos.map(p => [p.driveFileId, p]));

        const now = new Date().toISOString();
        const nextAlbums = [];
        const nextPhotos = [];
        const syncedDriveFolderIds = new Set();

        let addedAlbums = 0;
        let updatedAlbums = 0;
        let addedPhotos = 0;
        let updatedPhotos = 0;

        for (const folder of driveFolders) {
          syncedDriveFolderIds.add(folder.driveFolderId);
          const existingAlbum = prevAlbumByDriveId.get(folder.driveFolderId);

          let albumRecord;
          if (existingAlbum) {
            updatedAlbums += 1;
            albumRecord = {
              ...existingAlbum,
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
              createdAt: folder.createdTime || now,
              updatedAt: now
            };
          }
          nextAlbums.push(albumRecord);

          for (const file of folder.photos) {
            const existingPhoto = prevPhotoByDriveId.get(file.driveFileId);
            if (existingPhoto) {
              updatedPhotos += 1;
              nextPhotos.push({
                ...existingPhoto,
                albumId: albumRecord.id,
                originalName: file.originalName,
                mimeType: file.mimeType,
                size: file.size,
                hasThumbnail: file.hasThumbnail,
                updatedAt: now
              });
            } else {
              addedPhotos += 1;
              nextPhotos.push({
                id: 'photo_' + generateToken(8),
                driveFileId: file.driveFileId,
                albumId: albumRecord.id,
                originalName: file.originalName,
                mimeType: file.mimeType,
                size: file.size,
                hasThumbnail: file.hasThumbnail,
                uploadedAt: file.createdTime || now,
                updatedAt: now
              });
            }
          }
        }

        // Invalida sessioni client degli album eventualmente eliminati su Drive
        let removedAlbums = 0;
        for (const oldAlb of prevAlbums) {
          if (!syncedDriveFolderIds.has(oldAlb.driveFolderId)) {
            removedAlbums += 1;
            sessions.deleteClientSessionsForAlbum(oldAlb.id);
          }
        }
        const nextPhotoDriveIds = new Set(nextPhotos.map(p => p.driveFileId));
        const removedPhotos = prevPhotos.filter(p => !nextPhotoDriveIds.has(p.driveFileId)).length;

        store.saveAlbums(nextAlbums);
        store.savePhotos(nextPhotos);

        const countsMap = getPhotoCountMap(nextPhotos);

        return sendJson(res, 200, {
          message: `Sincronizzazione completata: ${nextAlbums.length} album e ${nextPhotos.length} foto.`,
          stats: {
            totalAlbums: nextAlbums.length,
            totalPhotos: nextPhotos.length,
            addedAlbums,
            updatedAlbums,
            removedAlbums,
            addedPhotos,
            updatedPhotos,
            removedPhotos
          },
          albums: nextAlbums.map(a => store.sanitizeAlbumForAdmin(a, countsMap)),
          photos: nextPhotos.map(store.sanitizePhotoForResponse)
        });
      } catch (err) {
        return sendJson(res, 502, {
          message: 'Errore durante la sincronizzazione con Google Drive: ' + err.message
        });
      }
    }

    if (pathname === '/api/admin/albums' && req.method === 'GET') {
      const auth = requireAdmin(req, res);
      if (!auth) return;

      const albums = store.loadAlbums();
      const photos = store.loadPhotos();
      const countsMap = getPhotoCountMap(photos);

      return sendJson(res, 200, {
        albums: albums.map(a => ({
          ...store.sanitizeAlbumForAdmin(a, countsMap),
          ...(a.shareToken ? buildShareUrls(req, a.shareToken) : {})
        }))
      });
    }

    if (pathname === '/api/admin/photos' && req.method === 'GET') {
      const auth = requireAdmin(req, res);
      if (!auth) return;

      const albumIdFilter = urlObj.searchParams.get('albumId');
      if (albumIdFilter && !isValidAlbumId(albumIdFilter)) {
        return sendJson(res, 400, { message: 'albumId non valido.' });
      }

      const photos = store.loadPhotos();
      const filtered = albumIdFilter ? photos.filter(p => p.albumId === albumIdFilter) : photos;
      return sendJson(res, 200, {
        photos: filtered.map(store.sanitizePhotoForResponse)
      });
    }

    const saveEditedPhotoMatch = pathname.match(/^\/api\/admin\/photos\/([^/]+)\/save$/);
    if (saveEditedPhotoMatch && req.method === 'POST') {
      const auth = requireAdmin(req, res);
      if (!auth) return;

      if (!drive.isConfigured()) {
        return sendJson(res, 503, { message: 'Google Drive non configurato.' });
      }

      const photoId = saveEditedPhotoMatch[1];
      if (!isValidAlbumId(photoId)) {
        return sendJson(res, 400, { message: 'ID foto non valido.' });
      }

      try {
        const body = await parseJsonBody(req, 40 * 1024 * 1024);
        if (!body || typeof body.base64 !== 'string' || !body.base64) {
          return sendJson(res, 400, { message: 'Immagine Base64 mancante.' });
        }

        const photos = store.loadPhotos();
        const index = photos.findIndex(p => p.id === photoId);
        if (index === -1) {
          return sendJson(res, 404, { message: 'Foto non trovata.' });
        }

        const base64Data = body.base64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/i, '');
        const buffer = Buffer.from(base64Data, 'base64');
        if (buffer.length > 25 * 1024 * 1024) {
          return sendJson(res, 413, { message: 'Immagine troppo grande (massimo 25MB).' });
        }

        const detected = detectImageFormat(buffer);
        if (!detected) {
          return sendJson(res, 400, { message: 'Formato immagine non valido o non supportato.' });
        }

        const photo = photos[index];
        const updatedDriveFile = await drive.updateMediaContent(photo.driveFileId, buffer, detected.mimeType);

        const now = new Date().toISOString();
        photos[index] = {
          ...photo,
          mimeType: updatedDriveFile?.mimeType || detected.mimeType,
          size: Number(updatedDriveFile?.size) || buffer.length,
          hasThumbnail: Boolean(updatedDriveFile?.thumbnailLink || updatedDriveFile?.hasThumbnail || photo.hasThumbnail),
          updatedAt: now
        };
        store.savePhotos(photos);

        return sendJson(res, 200, {
          message: 'Modifiche salvate direttamente su Google Drive!',
          photo: store.sanitizePhotoForResponse(photos[index])
        });
      } catch (err) {
        const errMsg = String(err.message || '');
        const statusCode = Number(err.code || err.status) || 502;
        if (statusCode === 403 || /insufficient|permission|forbidden|readonly/i.test(errMsg)) {
          return sendJson(res, 403, {
            message: 'Permessi insufficienti su Google Drive: per salvare direttamente su Drive imposta il Service Account come "Editor" sulla cartella condivisa (oppure usa "Scarica Modificata").'
          });
        }
        return sendJson(res, 502, { message: 'Errore salvataggio su Google Drive: ' + errMsg });
      }
    }

    const shareConfigMatch = pathname.match(/^\/api\/admin\/albums\/([^/]+)\/share$/);
    if (shareConfigMatch && req.method === 'POST') {
      const auth = requireAdmin(req, res);
      if (!auth) return;

      const albumId = shareConfigMatch[1];
      if (!isValidAlbumId(albumId)) {
        return sendJson(res, 400, { message: 'ID album non valido.' });
      }

      try {
        const body = await parseJsonBody(req);
        const albums = store.loadAlbums();
        const index = albums.findIndex(a => a.id === albumId);
        if (index === -1) {
          return sendJson(res, 404, { message: 'Album non trovato.' });
        }

        const album = albums[index];
        const nextShareEnabled =
          typeof body.shareEnabled === 'boolean' ? body.shareEnabled : Boolean(album.shareEnabled);
        const nextUsername =
          body.clientUsername !== undefined ? String(body.clientUsername).trim() : (album.clientUsername || '');
        const newPassword =
          body.clientPassword !== undefined ? String(body.clientPassword) : '';

        if (nextShareEnabled) {
          if (!nextUsername || nextUsername.length < 2) {
            return sendJson(res, 400, { message: 'Inserisci uno username cliente valido (almeno 2 caratteri).' });
          }
          if (!newPassword && !album.clientPasswordHash) {
            return sendJson(res, 400, { message: 'Imposta una password di accesso per attivare la condivisione.' });
          }
        }

        if (newPassword) {
          if (newPassword.length < 6) {
            return sendJson(res, 400, { message: 'La password cliente deve avere almeno 6 caratteri.' });
          }
          const { salt, hash } = require('./lib/security').hashPassword(newPassword);
          album.clientPasswordSalt = salt;
          album.clientPasswordHash = hash;
          sessions.deleteClientSessionsForAlbum(album.id);
        }

        if (body.regenerateToken === true || !album.shareToken) {
          album.shareToken = generateToken(24);
          sessions.deleteClientSessionsForAlbum(album.id);
        }

        if (!nextShareEnabled) {
          sessions.deleteClientSessionsForAlbum(album.id);
        }

        album.clientUsername = nextUsername;
        album.shareEnabled = nextShareEnabled;
        album.updatedAt = new Date().toISOString();

        albums[index] = album;
        store.saveAlbums(albums);

        const countsMap = getPhotoCountMap(store.loadPhotos());
        const urls = buildShareUrls(req, album.shareToken);

        return sendJson(res, 200, {
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
        return sendJson(res, 400, { message: err.message || 'Errore configurazione condivisione.' });
      }
    }

    const slideshowMatch = pathname.match(/^\/api\/admin\/albums\/([^/]+)\/slideshow$/);
    if (slideshowMatch && req.method === 'POST') {
      const auth = requireAdmin(req, res);
      if (!auth) return;

      const albumId = slideshowMatch[1];
      if (!isValidAlbumId(albumId)) {
        return sendJson(res, 400, { message: 'ID album non valido.' });
      }

      try {
        const body = await parseJsonBody(req);
        const albums = store.loadAlbums();
        const index = albums.findIndex(a => a.id === albumId);
        if (index === -1) {
          return sendJson(res, 404, { message: 'Album non trovato.' });
        }

        const album = albums[index];
        album.slideshowEnabled =
          typeof body.slideshowEnabled === 'boolean' ? body.slideshowEnabled : !album.slideshowEnabled;
        album.updatedAt = new Date().toISOString();

        albums[index] = album;
        store.saveAlbums(albums);

        const countsMap = getPhotoCountMap(store.loadPhotos());
        return sendJson(res, 200, {
          message: album.slideshowEnabled
            ? `"${album.name}" aggiunto allo sfondo dinamico.`
            : `"${album.name}" rimosso dallo sfondo dinamico.`,
          album: {
            ...store.sanitizeAlbumForAdmin(album, countsMap),
            ...(album.shareToken ? buildShareUrls(req, album.shareToken) : {})
          }
        });
      } catch (err) {
        return sendJson(res, 400, { message: err.message || 'Richiesta non valida.' });
      }
    }

    // ================= ACCESSO & GALLERIA CLIENTE =================

    const shareMetaMatch = pathname.match(/^\/api\/share\/([^/]+)\/meta$/);
    if (shareMetaMatch && req.method === 'GET') {
      const shareToken = shareMetaMatch[1];
      if (!isValidShareToken(shareToken)) {
        return sendJson(res, 404, { active: false, message: 'Galleria non trovata.' });
      }

      const albums = store.loadAlbums();
      const album = albums.find(a => a.shareToken === shareToken);
      if (!album) {
        return sendJson(res, 404, { active: false, message: 'Galleria non trovata o link non valido.' });
      }

      return sendJson(res, 200, {
        albumName: album.name,
        description: album.description || '',
        active: Boolean(album.shareEnabled)
      });
    }

    const shareLoginMatch = pathname.match(/^\/api\/share\/([^/]+)\/login$/);
    if (shareLoginMatch && req.method === 'POST') {
      const shareToken = shareLoginMatch[1];
      if (!isValidShareToken(shareToken)) {
        return sendJson(res, 404, { message: 'Link galleria non valido.' });
      }

      const rateKey = `share:${shareToken}:${getClientIp(req)}`;
      const limit = loginLimiter.check(rateKey);
      if (!limit.allowed) {
        return sendJson(
          res,
          429,
          { message: `Troppi tentativi falliti. Riprova tra ${limit.retryAfterSec} secondi.` },
          { 'Retry-After': String(limit.retryAfterSec) }
        );
      }

      try {
        const { username, password } = await parseJsonBody(req);
        if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
          return sendJson(res, 400, { message: 'Inserisci username e password della galleria.' });
        }

        const albums = store.loadAlbums();
        const album = albums.find(a => a.shareToken === shareToken);
        if (!album || !album.shareEnabled) {
          return sendJson(res, 403, { message: 'Questa galleria non è attiva o il link è stato revocato.' });
        }

        const usernameMatches =
          album.clientUsername &&
          username.trim().toLowerCase() === album.clientUsername.toLowerCase();
        const passwordMatches =
          album.clientPasswordHash &&
          verifyPassword(password, album.clientPasswordSalt, album.clientPasswordHash);

        if (!usernameMatches || !passwordMatches) {
          loginLimiter.recordFailure(rateKey);
          return sendJson(res, 401, { message: 'Username o password non corretti per questo album.' });
        }

        loginLimiter.reset(rateKey);
        const { token, maxAgeSeconds } = sessions.create(
          { role: 'client', albumId: album.id, shareToken: album.shareToken },
          false
        );

        const photoCount = store.loadPhotos().filter(p => p.albumId === album.id).length;
        return sendJson(
          res,
          200,
          {
            message: `Benvenuto nella galleria "${album.name}".`,
            token,
            role: 'client',
            album: store.sanitizeAlbumForClient(album, photoCount)
          },
          { 'Set-Cookie': buildSessionCookie(token, maxAgeSeconds, req) }
        );
      } catch (err) {
        return sendJson(res, 400, { message: err.message || 'Richiesta non valida.' });
      }
    }

    const sharePhotosMatch = pathname.match(/^\/api\/share\/([^/]+)\/photos$/);
    if (sharePhotosMatch && req.method === 'GET') {
      const shareToken = sharePhotosMatch[1];
      const auth = requireClientForAlbum(req, res, shareToken);
      if (!auth) return;

      const albumPhotos = store.loadPhotos().filter(p => p.albumId === auth.album.id);
      return sendJson(res, 200, {
        album: store.sanitizeAlbumForClient(auth.album, albumPhotos.length),
        photos: albumPhotos.map(store.sanitizePhotoForResponse)
      });
    }

    // ================= PROXY MEDIA SICURO GOOGLE DRIVE =================

    const mediaMatch = pathname.match(/^\/api\/media\/([^/]+)$/);
    if (mediaMatch && req.method === 'GET') {
      const driveFileId = mediaMatch[1];
      if (!isValidDriveFileId(driveFileId)) {
        return sendJson(res, 400, { message: 'ID file non valido.' });
      }

      const photos = store.loadPhotos();
      const photo = photos.find(p => p.driveFileId === driveFileId);
      if (!photo) {
        return sendJson(res, 404, { message: 'Immagine non trovata.' });
      }

      const albums = store.loadAlbums();
      const auth = getCurrentSession(req);
      const session = auth?.session || null;

      const isAdmin = session?.role === 'admin';
      const isClientForThisAlbum =
        session?.role === 'client' &&
        photo.albumId === session.albumId &&
        albums.some(
          a => a.id === session.albumId &&
               a.shareToken === session.shareToken &&
               a.shareEnabled === true
        );
      const isPublicSlideshow = albums.some(
        a => a.id === photo.albumId && a.slideshowEnabled === true
      );

      if (!isAdmin && !isClientForThisAlbum && !isPublicSlideshow) {
        return sendJson(res, session ? 403 : 401, { message: 'Non autorizzato a visualizzare questo file.' });
      }

      const wantsDownload = urlObj.searchParams.get('download') === '1';
      if (wantsDownload && !isAdmin && !isClientForThisAlbum) {
        return sendJson(res, 401, { message: 'Download consentito solo agli utenti autenticati.' });
      }

      const wantsThumb = !wantsDownload && urlObj.searchParams.get('thumb') === '1';

      try {
        const media = await drive.openMediaStream(driveFileId, { thumb: wantsThumb });
        const { asciiFallback, encoded } = sanitizeDownloadFilename(photo.originalName || media.filename);

        const headers = {
          'Content-Type': media.mimeType || photo.mimeType || 'application/octet-stream',
          'Cache-Control': 'private, max-age=3600',
          'Content-Disposition': wantsDownload
            ? `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`
            : `inline; filename="${asciiFallback}"`
        };
        if (media.size > 0) {
          headers['Content-Length'] = String(media.size);
        }

        res.writeHead(200, headers);
        media.stream.on('error', () => {
          if (!res.headersSent) {
            sendJson(res, 502, { message: 'Errore durante lo streaming da Google Drive.' });
          } else {
            res.end();
          }
        });
        media.stream.pipe(res);
        return;
      } catch (err) {
        return sendJson(res, 502, { message: 'Impossibile recuperare il file da Google Drive: ' + err.message });
      }
    }

    // ================= FILE STATICI / SPA =================
    serveStatic(req, res, pathname);
  });

  return { server, config, store, drive, sessions };
}

if (require.main === module) {
  const { server, config, drive } = createAppServer();
  server.listen(config.port, () => {
    console.log('\n=================================================');
    console.log('📸 Carlo Munno Photographer - Portale Google Drive');
    console.log(`📡 URL Locale: http://localhost:${config.port}`);
    console.log(`👤 Admin (.env): ${config.admin.email || '(NON CONFIGURATO)'}`);
    console.log(`☁️  Google Drive: ${drive.isConfigured() ? 'Configurato' : 'In attesa di .env'}`);
    console.log('=================================================\n');
  });
}

module.exports = { createAppServer };
