import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const { getConfig } = await import('../lib/config.js');
const { createStore } = await import('../lib/store.js');
const { createDriveService } = await import('../lib/drive.js');
const { createApiRouter } = await import('../lib/apiRouter.js');
const { handleNetlifyRequest } = await import('../netlify/functions/api.mjs');

const VALID_PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
]);
const VALID_JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

const { privateKey: TEST_RSA_PRIVATE_KEY } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
});

function makeReq(method, pathname, { body = null, binaryBody = null, headers = {}, search = '' } = {}) {
  const url = new URL(`http://localhost:3000${pathname}${search}`);
  return {
    method,
    pathname: url.pathname,
    searchParams: url.searchParams,
    headers,
    ip: '127.0.0.1',
    host: 'localhost:3000',
    protocol: 'http',
    readJsonBody: async () => body || {},
    readBinaryBody: async (maxBytes) => {
      if (binaryBody && binaryBody.length > maxBytes) {
        const err = new Error('Richiesta troppo grande');
        err.status = 413;
        throw err;
      }
      return binaryBody || Buffer.alloc(0);
    }
  };
}

async function readStreamToBuffer(stream) {
  const chunks = [];
  for await (const c of stream) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

test('Google Drive service skips redundant metadata fetch and parallelizes folder sync', async () => {
  const calls = [];
  let expireThumb = false;
  let activeQueries = 0;
  let maxConcurrency = 0;
  const folders = Array.from({ length: 10 }, (_, i) => ({ id: `fld_${i}`, name: `Album ${i}` }));

  const mockFetch = async (url) => {
    const u = new URL(String(url));
    calls.push(String(url));
    if (u.origin === 'https://oauth2.googleapis.com') {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (u.pathname === '/drive/v3/files' && u.searchParams.get('q')?.includes("'root_123' in parents")) {
      return new Response(JSON.stringify({ files: folders }), { status: 200 });
    }
    if (u.pathname === '/drive/v3/files') {
      activeQueries += 1;
      maxConcurrency = Math.max(maxConcurrency, activeQueries);
      await new Promise(r => setTimeout(r, 25));
      activeQueries -= 1;
      return new Response(
        JSON.stringify({
          files: [{ id: 'f1', name: 'img.jpg', mimeType: 'image/jpeg', size: '120', thumbnailLink: 'https://lh3.googleusercontent.com/t=s220' }]
        }),
        { status: 200 }
      );
    }
    if (u.searchParams.get('alt') === 'media') {
      return new Response(VALID_JPEG_BYTES, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    if (u.href.includes('expired-thumb')) {
      if (expireThumb) return new Response('Expired', { status: 403 });
      return new Response(VALID_JPEG_BYTES, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    if (u.href.includes('fresh-thumb')) {
      return new Response(VALID_JPEG_BYTES, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    if (u.pathname === '/drive/v3/files/file_1') {
      return new Response(
        JSON.stringify({ id: 'file_1', name: 'img.jpg', mimeType: 'image/jpeg', thumbnailLink: 'https://lh3.googleusercontent.com/fresh-thumb=s220' }),
        { status: 200 }
      );
    }
    return new Response('Not found', { status: 404 });
  };

  const config = getConfig({
    env: {
      SESSION_SECRET: 'k'.repeat(40),
      GOOGLE_SERVICE_ACCOUNT_EMAIL: 'svc@test.iam.gserviceaccount.com',
      GOOGLE_PRIVATE_KEY: TEST_RSA_PRIVATE_KEY,
      GOOGLE_DRIVE_ROOT_FOLDER_ID: 'root_123'
    }
  });
  const drive = createDriveService(config, { fetchImpl: mockFetch });

  const synced = await drive.listDriveAlbumsAndPhotos({ concurrency: 5 });
  assert.equal(synced.length, 10);
  assert.ok(maxConcurrency > 1 && maxConcurrency <= 5);

  calls.length = 0;
  const full = await drive.openMediaStream('file_1', {
    thumb: false,
    photoMeta: { originalName: 'img.jpg', mimeType: 'image/jpeg', size: 12 }
  });
  assert.equal(full.isThumbnail, false);
  assert.equal(calls.filter(c => c.includes('fields=')).length, 0);

  calls.length = 0;
  expireThumb = true;
  const thumbFallback = await drive.openMediaStream('file_1', {
    thumb: true,
    photoMeta: { originalName: 'img.jpg', thumbnailLink: 'https://lh3.googleusercontent.com/expired-thumb=s220' }
  });
  assert.equal(thumbFallback.isThumbnail, true);
  assert.equal(calls.filter(c => c.includes('fields=')).length, 1);
});

test('Media proxy authorization matrix, thumb disk cache, ETag 304, Drive relink, and binary photo save', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'munno-media-'));
  try {
    const env = {
      SESSION_SECRET: 'm'.repeat(40),
      ADMIN_EMAIL: 'carlo@munno.it',
      ADMIN_PASSWORD: 'AdminPassword123!'
    };
    const config = getConfig({ dataDir: tmpDir, env });
    const store = createStore(config);

    let openStreamCalls = 0;
    let driveFolders = [
      {
        driveFolderId: 'fld_client_a_v1',
        name: 'Cliente A',
        description: '',
        photos: [
          {
            driveFileId: 'drv_a1',
            originalName: 'a1.jpg',
            mimeType: 'image/jpeg',
            size: 12,
            hasThumbnail: true,
            thumbnailLink: 'https://lh3.googleusercontent.com/a1=s220',
            modifiedTime: '2026-11-01T10:00:00.000Z'
          }
        ]
      },
      {
        driveFolderId: 'fld_public',
        name: 'Portfolio Home',
        description: '',
        photos: [
          {
            driveFileId: 'drv_pub',
            originalName: 'pub.jpg',
            mimeType: 'image/jpeg',
            size: 12,
            hasThumbnail: true,
            modifiedTime: '2026-11-01T10:00:00.000Z'
          }
        ]
      },
      {
        driveFolderId: 'fld_private',
        name: 'Archivio Privato',
        description: '',
        photos: [
          {
            driveFileId: 'drv_priv',
            originalName: 'priv.jpg',
            mimeType: 'image/jpeg',
            size: 12,
            hasThumbnail: true,
            modifiedTime: '2026-11-01T10:00:00.000Z'
          }
        ]
      }
    ];

    const mockDrive = {
      isConfigured: () => true,
      async listDriveAlbumsAndPhotos() { return driveFolders; },
      async openMediaStream(driveFileId, { thumb }) {
        openStreamCalls += 1;
        return {
          stream: Readable.from(thumb ? VALID_JPEG_BYTES : VALID_PNG_BYTES),
          mimeType: thumb ? 'image/jpeg' : 'image/png',
          size: thumb ? VALID_JPEG_BYTES.length : VALID_PNG_BYTES.length,
          filename: `${driveFileId}.jpg`,
          isThumbnail: Boolean(thumb)
        };
      },
      async updateMediaContent(driveFileId, buffer, mimeType) {
        return { id: driveFileId, mimeType, size: buffer.length, hasThumbnail: true, modifiedTime: '2026-11-18T10:00:00.000Z' };
      }
    };

    const router = createApiRouter({ config, store, drive: mockDrive });
    await router.ensureInitialized();

    const adminLogin = await router.handle(
      makeReq('POST', '/api/admin/login', { body: { email: 'carlo@munno.it', password: 'AdminPassword123!' } })
    );
    const adminToken = JSON.parse(adminLogin.body).token;
    const adminCookie = String(adminLogin.headers['Set-Cookie']).split(';')[0];
    const adminAuth = { authorization: `Bearer ${adminToken}` };

    const sync1 = await router.handle(makeReq('POST', '/api/admin/drive/sync', { headers: adminAuth }));
    const sync1Body = JSON.parse(sync1.body);
    const albA = sync1Body.albums.find(a => a.name === 'Cliente A');
    const albPub = sync1Body.albums.find(a => a.name === 'Portfolio Home');
    const photoA = sync1Body.photos.find(p => p.driveFileId === 'drv_a1');

    // Share Cliente A and enable public slideshow on Portfolio Home
    await router.handle(
      makeReq('POST', `/api/admin/albums/${albA.id}/share`, {
        headers: adminAuth,
        body: { shareEnabled: true, clientUsername: 'clientea', clientPassword: 'PasswordA123' }
      })
    );
    await router.handle(
      makeReq('POST', `/api/admin/albums/${albPub.id}/slideshow`, {
        headers: adminAuth,
        body: { slideshowEnabled: true }
      })
    );

    const clientALogin = await router.handle(
      makeReq('POST', '/api/share/clientea/login', { body: { username: 'clientea', password: 'PasswordA123' } })
    );
    const clientACookie = String(clientALogin.headers['Set-Cookie']).split(';')[0];

    // Access matrix checks on /api/media/:driveFileId
    assert.equal((await router.handle(makeReq('GET', '/api/media/drv_a1'))).status, 401);
    assert.equal((await router.handle(makeReq('GET', '/api/media/drv_priv', { headers: { cookie: clientACookie } }))).status, 403);
    assert.equal((await router.handle(makeReq('GET', '/api/media/drv_a1', { headers: { cookie: clientACookie } }))).status, 200);
    // Admin with both cookies present can still access private album
    assert.equal((await router.handle(makeReq('GET', '/api/media/drv_priv', { headers: { cookie: `${adminCookie}; ${clientACookie}` } }))).status, 200);
    // Public slideshow allows view without auth, blocks download=1
    assert.equal((await router.handle(makeReq('GET', '/api/media/drv_pub'))).status, 200);
    assert.equal((await router.handle(makeReq('GET', '/api/media/drv_pub', { search: '?download=1' }))).status, 401);

    // Thumb cache + ETag 304
    openStreamCalls = 0;
    const t1 = await router.handle(makeReq('GET', '/api/media/drv_a1', { search: '?thumb=1', headers: adminAuth }));
    assert.equal(t1.status, 200);
    assert.equal(openStreamCalls, 1);
    const etag = t1.headers.ETag;
    assert.deepEqual(await readStreamToBuffer(t1.stream), VALID_JPEG_BYTES);

    const t304 = await router.handle(
      makeReq('GET', '/api/media/drv_a1', { search: '?thumb=1', headers: { ...adminAuth, 'if-none-match': etag } })
    );
    assert.equal(t304.status, 304);
    assert.equal(openStreamCalls, 1);

    // Cold router hits persistent disk cache
    const coldRouter = createApiRouter({ config, store, drive: mockDrive });
    await coldRouter.ensureInitialized();
    const tDisk = await coldRouter.handle(makeReq('GET', '/api/media/drv_a1', { search: '?thumb=1', headers: adminAuth }));
    assert.equal(tDisk.status, 200);
    assert.equal(openStreamCalls, 1);

    // Relink 1-to-1 when folder recreated on Drive; keep unchanged photo updatedAt stable
    await new Promise(r => setTimeout(r, 15));
    driveFolders = [
      { ...driveFolders[0], driveFolderId: 'fld_client_a_v2' },
      driveFolders[1],
      driveFolders[2]
    ];
    const sync2 = await router.handle(makeReq('POST', '/api/admin/drive/sync', { headers: adminAuth }));
    const sync2Body = JSON.parse(sync2.body);
    assert.equal(sync2Body.stats.relinkedAlbums, 1);
    assert.equal(sync2Body.albums.find(a => a.name === 'Cliente A').shareToken, 'clientea');
    assert.equal(sync2Body.photos.find(p => p.driveFileId === 'drv_a1').updatedAt, photoA.updatedAt);

    // Binary upload & legacy JSON upload
    const saveBin = await router.handle(
      makeReq('POST', `/api/admin/photos/${photoA.id}/save`, {
        headers: { ...adminAuth, 'content-type': 'image/png' },
        binaryBody: VALID_PNG_BYTES
      })
    );
    assert.equal(saveBin.status, 200);
    assert.equal(JSON.parse(saveBin.body).photo.mimeType, 'image/png');

    const saveJson = await router.handle(
      makeReq('POST', `/api/admin/photos/${photoA.id}/save`, {
        headers: { ...adminAuth, 'content-type': 'application/json' },
        body: { base64: `data:image/jpeg;base64,${VALID_JPEG_BYTES.toString('base64')}` }
      })
    );
    assert.equal(saveJson.status, 200);
    assert.equal(JSON.parse(saveJson.body).photo.mimeType, 'image/jpeg');

    // Netlify 304 response check
    const netlify304 = await handleNetlifyRequest(
      new Request('https://example.netlify.app/api/media/drv_a1?thumb=1', {
        headers: { ...adminAuth, 'if-none-match': `"drv_a1:thumb:${JSON.parse(saveJson.body).photo.updatedAt}"` }
      }),
      {},
      {
        env: { ...env, NETLIFY: 'true' },
        storeDriver: {
          getArray: (k) => k === 'users' ? store.loadUsers() : k === 'albums' ? store.loadAlbums() : store.loadPhotos(),
          setArray: (k, d) => k === 'users' ? store.saveUsers(d) : k === 'albums' ? store.saveAlbums(d) : store.savePhotos(d),
          initIfMissing: async () => {}
        },
        driveService: mockDrive,
        forceNew: true
      }
    );
    assert.equal(netlify304.status, 304);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Video sync, slideshow exclusion, byte-range streaming (Node & Netlify), and thumb/editor guards', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'munno-video-'));
  try {
    const VIDEO_BYTES = Buffer.from('0123456789abcdef');
    const seenDriveCalls = [];

    const mockDriveFetch = async (url, options = {}) => {
      const u = new URL(String(url));
      seenDriveCalls.push({ url: u.toString(), headers: options.headers || {} });
      if (u.origin === 'https://oauth2.googleapis.com') {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      }
      if (u.pathname === '/drive/v3/files' && u.searchParams.get('q')?.includes("'root_vid' in parents")) {
        return new Response(JSON.stringify({ files: [{ id: 'fld_mix', name: 'Matrimonio' }] }), { status: 200 });
      }
      if (u.pathname === '/drive/v3/files') {
        return new Response(
          JSON.stringify({
            files: [
              { id: 'img_1', name: 'foto.jpg', mimeType: 'image/jpeg', size: '12', thumbnailLink: 'https://lh3.googleusercontent.com/p=s220' },
              {
                id: 'vid_1',
                name: 'clip.mp4',
                mimeType: 'video/mp4',
                size: String(VIDEO_BYTES.length),
                videoMediaMetadata: { width: 1920, height: 1080, durationMillis: '64000' }
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (u.pathname === '/drive/v3/files/vid_1' && u.searchParams.get('alt') === 'media') {
        const rangeHdr = options.headers?.Range || '';
        const match = rangeHdr.match(/^bytes=(\d+)-(\d*)$/);
        if (match) {
          const start = Number(match[1]);
          const end = match[2] ? Math.min(Number(match[2]), VIDEO_BYTES.length - 1) : VIDEO_BYTES.length - 1;
          const slice = VIDEO_BYTES.subarray(start, end + 1);
          return new Response(slice, {
            status: 206,
            headers: {
              'content-type': 'video/mp4',
              'content-length': String(slice.length),
              'content-range': `bytes ${start}-${end}/${VIDEO_BYTES.length}`,
              'accept-ranges': 'bytes'
            }
          });
        }
        return new Response(VIDEO_BYTES, {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': String(VIDEO_BYTES.length), 'accept-ranges': 'bytes' }
        });
      }
      if (u.pathname === '/drive/v3/files/vid_1') {
        return new Response(JSON.stringify({ id: 'vid_1', name: 'clip.mp4', mimeType: 'video/mp4' }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };

    const env = {
      SESSION_SECRET: 'v'.repeat(40),
      ADMIN_EMAIL: 'carlo@munno.it',
      ADMIN_PASSWORD: 'AdminPassword123!',
      GOOGLE_SERVICE_ACCOUNT_EMAIL: 'svc@test.iam.gserviceaccount.com',
      GOOGLE_PRIVATE_KEY: TEST_RSA_PRIVATE_KEY,
      GOOGLE_DRIVE_ROOT_FOLDER_ID: 'root_vid'
    };
    const config = getConfig({ dataDir: tmpDir, env });
    const store = createStore(config);
    const drive = createDriveService(config, { fetchImpl: mockDriveFetch });
    const router = createApiRouter({ config, store, drive });
    await router.ensureInitialized();

    const adminLogin = await router.handle(
      makeReq('POST', '/api/admin/login', { body: { email: 'carlo@munno.it', password: 'AdminPassword123!' } })
    );
    const adminAuth = { authorization: `Bearer ${JSON.parse(adminLogin.body).token}` };

    // 1. Sync includes video with videoMediaMetadata
    const syncRes = await router.handle(makeReq('POST', '/api/admin/drive/sync', { headers: adminAuth }));
    assert.equal(syncRes.status, 200);
    const syncBody = JSON.parse(syncRes.body);
    assert.equal(syncBody.stats.totalImages, 1);
    assert.equal(syncBody.stats.totalVideos, 1);
    const alb = syncBody.albums[0];
    const vid = syncBody.photos.find(p => p.driveFileId === 'vid_1');
    assert.equal(vid.mediaType, 'video');
    assert.equal(vid.durationMillis, 64000);
    assert.equal(vid.width, 1920);
    assert.equal(vid.height, 1080);

    // 2. Enabling Home slideshow on album exposes image only, never the video
    await router.handle(
      makeReq('POST', `/api/admin/albums/${alb.id}/slideshow`, {
        headers: adminAuth,
        body: { slideshowEnabled: true }
      })
    );
    const slideRes = await router.handle(makeReq('GET', '/api/public/slideshow'));
    const slideBody = JSON.parse(slideRes.body);
    assert.equal(slideBody.items.length, 1);
    assert.equal(slideBody.items[0].driveFileId, 'img_1');
    assert.equal((await router.handle(makeReq('GET', '/api/media/vid_1'))).status, 401);

    // 3. Video thumbnail fallback does NOT download full video binary (returns 404 cleanly)
    seenDriveCalls.length = 0;
    const thumbMiss = await router.handle(
      makeReq('GET', '/api/media/vid_1', { search: '?thumb=1', headers: adminAuth })
    );
    assert.equal(thumbMiss.status, 404);
    assert.equal(seenDriveCalls.some(c => c.url.includes('alt=media')), false);

    // 4. Byte-range request returns 206 Partial Content via router and Netlify adapter
    const rangeRes = await router.handle(
      makeReq('GET', '/api/media/vid_1', { headers: { ...adminAuth, range: 'bytes=0-3' } })
    );
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers['Content-Range'], 'bytes 0-3/16');
    assert.equal(rangeRes.headers['Accept-Ranges'], 'bytes');
    assert.equal((await readStreamToBuffer(rangeRes.stream)).toString('utf8'), '0123');

    const netlifyRange = await handleNetlifyRequest(
      new Request('https://example.netlify.app/api/media/vid_1', {
        headers: { ...adminAuth, range: 'bytes=4-7' }
      }),
      {},
      {
        env: { ...env, NETLIFY: 'true' },
        storeDriver: {
          getArray: (k) => k === 'users' ? store.loadUsers() : k === 'albums' ? store.loadAlbums() : store.loadPhotos(),
          setArray: (k, d) => k === 'users' ? store.saveUsers(d) : k === 'albums' ? store.saveAlbums(d) : store.savePhotos(d),
          initIfMissing: async () => {}
        },
        driveService: drive,
        forceNew: true
      }
    );
    assert.equal(netlifyRange.status, 206);
    assert.equal(netlifyRange.headers.get('content-range'), 'bytes 4-7/16');
    assert.equal(await netlifyRange.text(), '4567');

    // 5. Photo Editor save rejects videos
    const editVidRes = await router.handle(
      makeReq('POST', `/api/admin/photos/${vid.id}/save`, {
        headers: { ...adminAuth, 'content-type': 'image/png' },
        binaryBody: VALID_PNG_BYTES
      })
    );
    assert.equal(editVidRes.status, 400);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
