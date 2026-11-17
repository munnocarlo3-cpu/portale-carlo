/**
 * Router API unificato (indipendente dall'ambiente HTTP):
 * utilizzato sia dal server Node.js locale/Railway sia da Netlify Functions v2.
 */
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
  sanitizeDownloadFilename,
  getClientIpFromHeaders,
  createLoginRateLimiter,
  extractTokenFromHeaders,
  buildSessionCookie,
  buildClearSessionCookie,
  createSessionStore
} from './security.js';

export function createApiRouter({ config, store, drive, sessions: customSessions, loginLimiter: customLimiter }) {
  const sessions = customSessions || createSessionStore(config.session);
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
    return admin.configFingerprint || String(admin.passwordHash || '').slice(0, 16);
  }

  function getCurrentSession(reqCtx) {
    const token = extractTokenFromHeaders(reqCtx.headers || {});
    if (!token) return null;
    const session = sessions.get(token);
    return session ? { token, session } : null;
  }

  async function requireAdmin(reqCtx) {
    const auth = getCurrentSession(reqCtx);
    if (!auth) {
      return { error: jsonRes(401, { message: 'Accesso non autenticato. Effettua il login come Admin.' }) };
    }
    if (auth.session.role !== 'admin') {
      return { error: jsonRes(403, { message: 'Accesso negato: privilegi di amministratore richiesti.' }) };
    }
    const users = await store.loadUsers();
    const admin = users.find(u => u.id === auth.session.userId && u.role === 'admin');
    if (!admin || auth.session.ver !== getAdminSessionVersion(admin)) {
      return { error: jsonRes(401, { message: 'Sessione Admin non più valida.' }) };
    }
    return { token: auth.token, session: auth.session, admin };
  }

  function findAlbumByShareToken(albums, shareToken) {
    const normalized = String(shareToken || '').trim().toLowerCase();
    if (!normalized) return null;
    return albums.find(a => String(a.shareToken || '').toLowerCase() === normalized) || null;
  }

  async function requireClientForAlbum(reqCtx, shareToken) {
    if (!isValidShareToken(shareToken)) {
      return { error: jsonRes(404, { message: 'Galleria non trovata.' }) };
    }
    const auth = getCurrentSession(reqCtx);
    if (!auth) {
      return { error: jsonRes(401, { message: 'Autenticazione richiesta per visualizzare questo album.' }) };
    }
    const normalizedToken = String(shareToken).toLowerCase();
    if (
      auth.session.role !== 'client' ||
      String(auth.session.shareToken || '').toLowerCase() !== normalizedToken
    ) {
      return { error: jsonRes(403, { message: 'Non sei autorizzato ad accedere a questo album.' }) };
    }
    const albums = await store.loadAlbums();
    const album = albums.find(
      a =>
        a.id === auth.session.albumId &&
        String(a.shareToken || '').toLowerCase() === normalizedToken &&
        a.shareEnabled === true &&
        (a.clientSessionVersion || 1) === auth.session.ver
    );
    if (!album) {
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
        .filter(p => slideshowAlbumsMap.has(p.albumId))
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
          { 'Set-Cookie': buildSessionCookie(token, maxAgeSeconds, { isHttps }) }
        );
      } catch (err) {
        return jsonRes(400, { message: err.message || 'Richiesta non valida.' });
      }
    }

    if (pathname === '/api/logout' && method === 'POST') {
      const token = extractTokenFromHeaders(headers);
      if (token) sessions.delete(token);
      return jsonRes(
        200,
        { message: 'Logout effettuato con successo.' },
        { 'Set-Cookie': buildClearSessionCookie({ isHttps }) }
      );
    }

    if (pathname === '/api/me' && method === 'GET') {
      const auth = getCurrentSession(reqCtx);
      if (!auth) {
        return jsonRes(401, { message: 'Sessione assente o scaduta.' });
      }

      if (auth.session.role === 'admin') {
        const users = await store.loadUsers();
        const admin = users.find(u => u.id === auth.session.userId && u.role === 'admin');
        if (!admin || auth.session.ver !== getAdminSessionVersion(admin)) {
          return jsonRes(401, { message: 'Sessione Admin non valida.' });
        }
        return jsonRes(200, {
          role: 'admin',
          user: { id: admin.id, name: admin.name, email: admin.email }
        });
      }

      if (auth.session.role === 'client') {
        const albums = await store.loadAlbums();
        const album = albums.find(
          a =>
            a.id === auth.session.albumId &&
            a.shareToken === auth.session.shareToken &&
            a.shareEnabled === true &&
            (a.clientSessionVersion || 1) === auth.session.ver
        );
        if (!album) {
          return jsonRes(401, { message: 'Sessione galleria non più valida.' });
        }
        const photos = await store.loadPhotos();
        const photoCount = photos.filter(p => p.albumId === album.id).length;
        return jsonRes(200, {
          role: 'client',
          albumId: album.id,
          shareToken: album.shareToken,
          album: store.sanitizeAlbumForClient(album, photoCount)
        });
      }

      return jsonRes(401, { message: 'Sessione non valida.' });
    }

    // ================= ENDPOINT ADMIN (PROTETTI) =================

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
        const [prevAlbums, prevPhotos] = await Promise.all([store.loadAlbums(), store.loadPhotos()]);

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
              clientSessionVersion: 1,
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

        const removedAlbums = prevAlbums.filter(a => !syncedDriveFolderIds.has(a.driveFolderId)).length;
        const nextPhotoDriveIds = new Set(nextPhotos.map(p => p.driveFileId));
        const removedPhotos = prevPhotos.filter(p => !nextPhotoDriveIds.has(p.driveFileId)).length;

        await Promise.all([store.saveAlbums(nextAlbums), store.savePhotos(nextPhotos)]);
        const countsMap = getPhotoCountMap(nextPhotos);

        return jsonRes(200, {
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
          albums: nextAlbums.map(a => ({
            ...store.sanitizeAlbumForAdmin(a, countsMap),
            ...(a.shareToken ? buildShareUrls(reqCtx, a.shareToken) : {})
          })),
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
        albums: albums.map(a => ({
          ...store.sanitizeAlbumForAdmin(a, countsMap),
          ...(a.shareToken ? buildShareUrls(reqCtx, a.shareToken) : {})
        }))
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
        const body = await reqCtx.readJsonBody(40 * 1024 * 1024);
        if (!body || typeof body.base64 !== 'string' || !body.base64) {
          return jsonRes(400, { message: 'Immagine Base64 mancante.' });
        }

        const photos = await store.loadPhotos();
        const index = photos.findIndex(p => p.id === photoId);
        if (index === -1) {
          return jsonRes(404, { message: 'Foto non trovata.' });
        }

        const base64Data = body.base64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/i, '');
        const buffer = Buffer.from(base64Data, 'base64');
        if (buffer.length > 25 * 1024 * 1024) {
          return jsonRes(413, { message: 'Immagine troppo grande (massimo 25MB).' });
        }

        const detected = detectImageFormat(buffer);
        if (!detected) {
          return jsonRes(400, { message: 'Formato immagine non valido o non supportato.' });
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
        await store.savePhotos(photos);

        return jsonRes(200, {
          message: 'Modifiche salvate direttamente su Google Drive!',
          photo: store.sanitizePhotoForResponse(photos[index])
        });
      } catch (err) {
        const errMsg = String(err.message || '');
        const statusCode = Number(err.code || err.status) || 502;
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
        const [albums, photos] = await Promise.all([store.loadAlbums(), store.loadPhotos()]);
        const index = albums.findIndex(a => a.id === albumId);
        if (index === -1) {
          return jsonRes(404, { message: 'Album non trovato.' });
        }

        const album = albums[index];
        const nextShareEnabled =
          typeof body.shareEnabled === 'boolean' ? body.shareEnabled : Boolean(album.shareEnabled);
        const prevUsername = album.clientUsername || '';
        const nextUsername =
          body.clientUsername !== undefined ? String(body.clientUsername).trim() : prevUsername;
        const newPassword =
          body.clientPassword !== undefined ? String(body.clientPassword) : '';

        if (nextShareEnabled) {
          if (!nextUsername || nextUsername.length < 2) {
            return jsonRes(400, { message: 'Inserisci uno username cliente valido (almeno 2 caratteri).' });
          }
          if (!newPassword && !album.clientPasswordHash) {
            return jsonRes(400, { message: 'Imposta una password di accesso per attivare la condivisione.' });
          }
        }

        let bumpSessionVersion = false;
        if (newPassword) {
          if (newPassword.length < 6) {
            return jsonRes(400, { message: 'La password cliente deve avere almeno 6 caratteri.' });
          }
          const { salt, hash } = hashPassword(newPassword);
          album.clientPasswordSalt = salt;
          album.clientPasswordHash = hash;
          bumpSessionVersion = true;
        }

        if (nextUsername) {
          const baseSlug = normalizeShareSlug(nextUsername);
          if (!baseSlug || baseSlug.length < 2 || RESERVED_SHARE_SLUGS.has(baseSlug)) {
            return jsonRes(400, {
              message: 'Username cliente non valido o riservato per generare il link (/nomecliente).'
            });
          }

          const shouldRotate = body.regenerateToken === true;
          const isLegacyRandomToken = /^[a-f0-9]{48}$/i.test(album.shareToken || '');
          const usernameChanged = nextUsername.toLowerCase() !== prevUsername.toLowerCase();

          let nextShareToken = album.shareToken || baseSlug;
          if (shouldRotate) {
            nextShareToken = `${baseSlug}-${generateToken(2)}`;
          } else if (!album.shareToken || isLegacyRandomToken || usernameChanged) {
            nextShareToken = baseSlug;
          }

          const duplicateAlbum = albums.find(
            a => a.id !== album.id && String(a.shareToken || '').toLowerCase() === nextShareToken.toLowerCase()
          );
          if (duplicateAlbum) {
            return jsonRes(409, {
              message: `Il link "/${nextShareToken}" è già usato dall'album "${duplicateAlbum.name}". Scegli un altro username cliente.`
            });
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
        }

        album.clientUsername = nextUsername;
        album.shareEnabled = nextShareEnabled;
        album.updatedAt = new Date().toISOString();

        albums[index] = album;
        await store.saveAlbums(albums);

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
        const [albums, photos] = await Promise.all([store.loadAlbums(), store.loadPhotos()]);
        const index = albums.findIndex(a => a.id === albumId);
        if (index === -1) {
          return jsonRes(404, { message: 'Album non trovato.' });
        }

        const album = albums[index];
        album.slideshowEnabled =
          typeof body.slideshowEnabled === 'boolean' ? body.slideshowEnabled : !album.slideshowEnabled;
        album.updatedAt = new Date().toISOString();

        albums[index] = album;
        await store.saveAlbums(albums);

        const countsMap = getPhotoCountMap(photos);
        return jsonRes(200, {
          message: album.slideshowEnabled
            ? `"${album.name}" aggiunto allo sfondo dinamico.`
            : `"${album.name}" rimosso dallo sfondo dinamico.`,
          album: {
            ...store.sanitizeAlbumForAdmin(album, countsMap),
            ...(album.shareToken ? buildShareUrls(reqCtx, album.shareToken) : {})
          }
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
            shareToken: album.shareToken,
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
          { 'Set-Cookie': buildSessionCookie(token, maxAgeSeconds, { isHttps }) }
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
        return jsonRes(404, { message: 'Immagine non trovata.' });
      }

      const auth = getCurrentSession(reqCtx);
      const session = auth?.session || null;

      let isAdmin = false;
      if (session?.role === 'admin') {
        const users = await store.loadUsers();
        const admin = users.find(u => u.id === session.userId && u.role === 'admin');
        isAdmin = Boolean(admin && session.ver === getAdminSessionVersion(admin));
      }

      const isClientForThisAlbum =
        session?.role === 'client' &&
        photo.albumId === session.albumId &&
        albums.some(
          a =>
            a.id === session.albumId &&
            a.shareToken === session.shareToken &&
            a.shareEnabled === true &&
            (a.clientSessionVersion || 1) === session.ver
        );

      const isPublicSlideshow = albums.some(
        a => a.id === photo.albumId && a.slideshowEnabled === true
      );

      if (!isAdmin && !isClientForThisAlbum && !isPublicSlideshow) {
        return jsonRes(session ? 403 : 401, { message: 'Non autorizzato a visualizzare questo file.' });
      }

      const wantsDownload = searchParams.get('download') === '1';
      if (wantsDownload && !isAdmin && !isClientForThisAlbum) {
        return jsonRes(401, { message: 'Download consentito solo agli utenti autenticati.' });
      }

      const wantsThumb = !wantsDownload && searchParams.get('thumb') === '1';

      try {
        const media = await drive.openMediaStream(driveFileId, { thumb: wantsThumb });
        const { asciiFallback, encoded } = sanitizeDownloadFilename(photo.originalName || media.filename);

        const mediaHeaders = {
          'Content-Type': media.mimeType || photo.mimeType || 'application/octet-stream',
          'Cache-Control': 'private, max-age=3600',
          'Content-Disposition': wantsDownload
            ? `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`
            : `inline; filename="${asciiFallback}"`
        };
        if (media.size > 0) {
          mediaHeaders['Content-Length'] = String(media.size);
        }

        return {
          status: 200,
          headers: mediaHeaders,
          stream: media.stream
        };
      } catch (err) {
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
