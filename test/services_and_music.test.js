import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const TEST_ADMIN_PASSWORD = `TestPwd_${crypto.randomBytes(12).toString('hex')}`;

const { getConfig } = await import('../lib/config.js');
const { createStore } = await import('../lib/store.js');
const { createApiRouter } = await import('../lib/apiRouter.js');

function createMemoryDriver(initial = {}) {
  const db = {
    users: structuredClone(initial.users || []),
    albums: structuredClone(initial.albums || []),
    photos: structuredClone(initial.photos || []),
    activities: structuredClone(initial.activities || []),
    transactions: structuredClone(initial.transactions || []),
    services: structuredClone(initial.services || []),
    music: structuredClone(initial.music || [])
  };
  const musicBins = new Map();
  return {
    musicBins,
    async getArray(key) {
      return structuredClone(db[key] || []);
    },
    async setArray(key, data) {
      db[key] = structuredClone(data);
    },
    async initIfMissing() {},
    async getMusicBinary(trackId) {
      return musicBins.get(trackId) || null;
    },
    async setMusicBinary(trackId, buffer, metadata = {}) {
      musicBins.set(trackId, { buffer: Buffer.from(buffer), mimeType: metadata.mimeType || 'audio/mpeg' });
    },
    async deleteMusicBinary(trackId) {
      musicBins.delete(trackId);
    }
  };
}

function createMockDrive() {
  return {
    isConfigured: () => true,
    async listDriveAlbumsAndPhotos() { return []; },
    async openMediaStream() { return {}; },
    async updateMediaContent() { return {}; }
  };
}

function makeReq(method, pathname, { body = null, binaryBody = null, headers = {}, search = '', ip = '10.0.0.1' } = {}) {
  const url = new URL(`http://localhost:3000${pathname}${search}`);
  return {
    method,
    pathname: url.pathname,
    searchParams: url.searchParams,
    headers,
    ip,
    host: 'localhost:3000',
    protocol: 'http',
    readJsonBody: async () => body || {},
    readBinaryBody: async () => binaryBody || Buffer.alloc(0)
  };
}

async function readStreamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

test('Admin offered services CRUD, validation, visibility toggle, and public client listing', async () => {
  const env = {
    SESSION_SECRET: 's'.repeat(40),
    ADMIN_EMAIL: 'carlo@munno.it',
    ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
    ADMIN_NAME: 'Carlo Munno'
  };
  const config = getConfig({ env });
  const driver = createMemoryDriver();
  const store = createStore(config, driver);
  const router = createApiRouter({ config, store, drive: createMockDrive() });
  await router.ensureInitialized();

  // Unauthenticated admin routes rejected
  assert.equal((await router.handle(makeReq('GET', '/api/admin/services'))).status, 401);
  assert.equal(
    (await router.handle(makeReq('POST', '/api/admin/services', { body: { name: 'Matrimonio', price: 1200 } }))).status,
    401
  );

  // Admin login
  const loginRes = await router.handle(
    makeReq('POST', '/api/admin/login', {
      body: { email: 'carlo@munno.it', password: TEST_ADMIN_PASSWORD }
    })
  );
  assert.equal(loginRes.status, 200);
  const { token } = JSON.parse(loginRes.body);
  const authHeaders = { authorization: `Bearer ${token}` };

  // Validation checks
  assert.equal(
    (await router.handle(makeReq('POST', '/api/admin/services', { headers: authHeaders, body: { name: 'A', price: 100 } }))).status,
    400
  );
  assert.equal(
    (await router.handle(makeReq('POST', '/api/admin/services', { headers: authHeaders, body: { name: 'Servizio Test', price: -5 } }))).status,
    400
  );

  // Create two services: one active, one hidden
  const create1 = await router.handle(
    makeReq('POST', '/api/admin/services', {
      headers: authHeaders,
      body: {
        name: 'Servizio Matrimonio Completo',
        price: '1450,50',
        priceUnit: 'a servizio',
        category: 'Matrimoni',
        description: 'Copertura intera giornata + fotolibro',
        active: true
      }
    })
  );
  assert.equal(create1.status, 201);
  const srv1 = JSON.parse(create1.body).service;
  assert.ok(srv1.id.startsWith('srv_'));
  assert.equal(srv1.price, 1450.5);
  assert.equal(srv1.active, true);

  const create2 = await router.handle(
    makeReq('POST', '/api/admin/services', {
      headers: authHeaders,
      body: {
        name: 'Pacchetto VIP Riservato',
        price: 2500,
        category: 'Eventi',
        active: false
      }
    })
  );
  assert.equal(create2.status, 201);
  const srv2 = JSON.parse(create2.body).service;
  assert.equal(srv2.active, false);

  // Admin sees both services
  const adminList = JSON.parse((await router.handle(makeReq('GET', '/api/admin/services', { headers: authHeaders }))).body);
  assert.equal(adminList.services.length, 2);

  // Public client endpoint sees ONLY active services
  const pubList = JSON.parse((await router.handle(makeReq('GET', '/api/public/services'))).body);
  assert.equal(pubList.services.length, 1);
  assert.equal(pubList.services[0].id, srv1.id);
  assert.equal(pubList.services[0].price, 1450.5);

  // Activate srv2 via partial PUT
  const upd = await router.handle(
    makeReq('PUT', `/api/admin/services/${srv2.id}`, {
      headers: authHeaders,
      body: { active: true, price: 2200 }
    })
  );
  assert.equal(upd.status, 200);
  const pubListAfter = JSON.parse((await router.handle(makeReq('GET', '/api/public/services'))).body);
  assert.equal(pubListAfter.services.length, 2);

  // Delete srv1
  const del = await router.handle(
    makeReq('DELETE', `/api/admin/services/${srv1.id}`, { headers: authHeaders })
  );
  assert.equal(del.status, 200);
  assert.equal(JSON.parse(del.body).deletedId, srv1.id);
  assert.equal((await router.handle(makeReq('DELETE', `/api/admin/services/${srv1.id}`, { headers: authHeaders }))).status, 404);
});

test('Background music upload, URL tracks, public playlist, Range streaming, and cleanup on delete', async () => {
  const env = {
    SESSION_SECRET: 'm'.repeat(40),
    ADMIN_EMAIL: 'carlo@munno.it',
    ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
    ADMIN_NAME: 'Carlo Munno'
  };
  const config = getConfig({ env });
  const driver = createMemoryDriver();
  const store = createStore(config, driver);
  const router = createApiRouter({ config, store, drive: createMockDrive() });
  await router.ensureInitialized();

  // Unauthenticated admin music routes rejected
  assert.equal((await router.handle(makeReq('GET', '/api/admin/music'))).status, 401);

  // Login admin
  const loginRes = await router.handle(
    makeReq('POST', '/api/admin/login', {
      body: { email: 'carlo@munno.it', password: TEST_ADMIN_PASSWORD }
    })
  );
  const { token } = JSON.parse(loginRes.body);
  const authHeaders = { authorization: `Bearer ${token}` };

  // Reject non-HTTPS URL
  const badUrlRes = await router.handle(
    makeReq('POST', '/api/admin/music', {
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: { title: 'Test', url: 'http://insecure.example.com/song.mp3' }
    })
  );
  assert.equal(badUrlRes.status, 400);

  // Add HTTPS URL track
  const urlRes = await router.handle(
    makeReq('POST', '/api/admin/music', {
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: { title: 'Piano Elegante', artist: 'Studio', url: 'https://cdn.example.com/piano.mp3', enabled: true }
    })
  );
  assert.equal(urlRes.status, 201);
  const urlTrack = JSON.parse(urlRes.body).track;
  assert.equal(urlTrack.sourceType, 'url');
  assert.equal(urlTrack.youtubeVideoId, '');
  assert.equal(urlTrack.streamUrl, 'https://cdn.example.com/piano.mp3');

  // Reject YouTube URL without a valid video ID
  const badYtRes = await router.handle(
    makeReq('POST', '/api/admin/music', {
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: { title: 'YT Bad', url: 'https://www.youtube.com/', enabled: true }
    })
  );
  assert.equal(badYtRes.status, 400);

  // Add YouTube URL track and verify youtubeVideoId extraction
  const ytRes = await router.handle(
    makeReq('POST', '/api/admin/music', {
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: { title: 'YT Piano', artist: 'YouTube', url: 'https://youtu.be/dQw4w9WgXcQ', enabled: true }
    })
  );
  assert.equal(ytRes.status, 201);
  const ytTrack = JSON.parse(ytRes.body).track;
  assert.equal(ytTrack.sourceType, 'url');
  assert.equal(ytTrack.youtubeVideoId, 'dQw4w9WgXcQ');

  // Reject invalid non-audio binary upload
  const badBinRes = await router.handle(
    makeReq('POST', '/api/admin/music', {
      headers: { ...authHeaders, 'content-type': 'application/octet-stream' },
      search: '?title=FakeFile&filename=script.exe',
      binaryBody: Buffer.from('NOT_AUDIO_DATA_1234567890')
    })
  );
  assert.equal(badBinRes.status, 400);

  // Upload valid MP3 (ID3 header)
  const fakeMp3 = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00'), Buffer.from('0123456789abcdef')]);
  const uploadRes = await router.handle(
    makeReq('POST', '/api/admin/music', {
      headers: { ...authHeaders, 'content-type': 'audio/mpeg' },
      search: '?title=Atmosfera+Matrimonio&artist=Carlo+Studio&filename=atmosfera.mp3&enabled=1',
      binaryBody: fakeMp3
    })
  );
  assert.equal(uploadRes.status, 201);
  const uploadedTrack = JSON.parse(uploadRes.body).track;
  assert.ok(uploadedTrack.id.startsWith('mus_'));
  assert.equal(uploadedTrack.sourceType, 'upload');
  assert.equal(uploadedTrack.streamUrl, `/api/music/${uploadedTrack.id}`);
  assert.equal(driver.musicBins.has(uploadedTrack.id), true);

  // Public playlist lists all 3 enabled tracks
  const pubMusic = JSON.parse((await router.handle(makeReq('GET', '/api/public/music'))).body);
  assert.equal(pubMusic.tracks.length, 3);

  // Stream uploaded MP3 (full)
  const fullStream = await router.handle(makeReq('GET', `/api/music/${uploadedTrack.id}`));
  assert.equal(fullStream.status, 200);
  assert.equal(fullStream.headers['Content-Type'], 'audio/mpeg');
  const streamedBuf = await readStreamToBuffer(fullStream.stream);
  assert.deepEqual(streamedBuf, fakeMp3);

  // Stream uploaded MP3 (Range 206)
  const rangeStream = await router.handle(
    makeReq('GET', `/api/music/${uploadedTrack.id}`, { headers: { range: 'bytes=0-9' } })
  );
  assert.equal(rangeStream.status, 206);
  assert.equal(rangeStream.headers['Content-Range'], `bytes 0-9/${fakeMp3.length}`);
  const rangeBuf = await readStreamToBuffer(rangeStream.stream);
  assert.equal(rangeBuf.length, 10);

  // Disable uploaded track -> hidden from public playlist and blocked for anonymous streaming
  const disableRes = await router.handle(
    makeReq('PUT', `/api/admin/music/${uploadedTrack.id}`, {
      headers: authHeaders,
      body: { enabled: false }
    })
  );
  assert.equal(disableRes.status, 200);
  const pubMusicAfter = JSON.parse((await router.handle(makeReq('GET', '/api/public/music'))).body);
  assert.equal(pubMusicAfter.tracks.length, 2);
  assert.equal((await router.handle(makeReq('GET', `/api/music/${uploadedTrack.id}`))).status, 403);
  // Admin can still preview disabled track
  assert.equal((await router.handle(makeReq('GET', `/api/music/${uploadedTrack.id}`, { headers: authHeaders }))).status, 200);

  // Delete uploaded track -> removes binary too
  const delRes = await router.handle(
    makeReq('DELETE', `/api/admin/music/${uploadedTrack.id}`, { headers: authHeaders })
  );
  assert.equal(delRes.status, 200);
  assert.equal(driver.musicBins.has(uploadedTrack.id), false);
});
