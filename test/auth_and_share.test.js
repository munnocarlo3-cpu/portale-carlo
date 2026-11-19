import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

const TEST_ADMIN_PASSWORD = `TestPwd_${crypto.randomBytes(12).toString('hex')}`;

const { getConfig } = await import('../lib/config.js');
const { createStore } = await import('../lib/store.js');
const { createApiRouter } = await import('../lib/apiRouter.js');
const { handleNetlifyRequest } = await import('../netlify/functions/api.mjs');

function createMemoryDriver(initial = {}) {
  const db = {
    users: structuredClone(initial.users || []),
    albums: structuredClone(initial.albums || []),
    photos: structuredClone(initial.photos || [])
  };
  return {
    async getArray(key) {
      return structuredClone(db[key] || []);
    },
    async setArray(key, data) {
      db[key] = structuredClone(data);
    },
    async initIfMissing() {}
  };
}

function createMockDrive() {
  return {
    isConfigured: () => true,
    async listDriveAlbumsAndPhotos() { return []; },
    async openMediaStream(id) {
      return {
        stream: Readable.from(Buffer.from('img')),
        mimeType: 'image/jpeg',
        size: 3,
        filename: `${id}.jpg`,
        isThumbnail: false
      };
    },
    async updateMediaContent() { return {}; }
  };
}

function makeReq(method, pathname, { body = null, headers = {}, search = '', ip = '10.0.0.1' } = {}) {
  const url = new URL(`http://localhost:3000${pathname}${search}`);
  return {
    method,
    pathname: url.pathname,
    searchParams: url.searchParams,
    headers,
    ip,
    host: 'localhost:3000',
    protocol: 'http',
    readJsonBody: async () => body || {}
  };
}

function extractCookiePairs(setCookieHeader) {
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader].filter(Boolean);
  const out = {};
  for (const item of list) {
    const first = item.split(';')[0];
    const eq = first.indexOf('=');
    if (eq !== -1) out[first.slice(0, eq)] = first.slice(eq + 1);
  }
  return out;
}

test('Admin login rate limiting, HMAC session cookies, scoped logout, and persistent revocation', async () => {
  const env = {
    SESSION_SECRET: 's'.repeat(40),
    ADMIN_EMAIL: 'carlo@munno.it',
    ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
    ADMIN_NAME: 'Carlo Munno'
  };
  const config = getConfig({ env });
  const driver = createMemoryDriver();
  const store = createStore(config, driver);
  const drive = createMockDrive();
  const router1 = createApiRouter({ config, store, drive });
  await router1.ensureInitialized();

  // 5 failed attempts trigger 429 rate limit
  for (let i = 0; i < 5; i++) {
    const bad = await router1.handle(
      makeReq('POST', '/api/admin/login', {
        body: { email: 'carlo@munno.it', password: 'WrongPassword!' },
        ip: '203.0.113.10'
      })
    );
    assert.equal(bad.status, 401);
  }
  const blocked = await router1.handle(
    makeReq('POST', '/api/admin/login', {
      body: { email: 'carlo@munno.it', password: TEST_ADMIN_PASSWORD },
      ip: '203.0.113.10'
    })
  );
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['Retry-After']) > 0);

  // Successful login from another IP yields sid_admin cookie
  const login1 = await router1.handle(
    makeReq('POST', '/api/admin/login', {
      body: { email: 'carlo@munno.it', password: TEST_ADMIN_PASSWORD, rememberMe: true },
      ip: '203.0.113.11'
    })
  );
  assert.equal(login1.status, 200);
  const body1 = JSON.parse(login1.body);
  const cookies1 = extractCookiePairs(login1.headers['Set-Cookie']);
  assert.ok(cookies1.sid_admin);
  assert.equal(cookies1.sid_client, undefined);

  const login2 = await router1.handle(
    makeReq('POST', '/api/admin/login', {
      body: { email: 'carlo@munno.it', password: TEST_ADMIN_PASSWORD, rememberMe: true },
      ip: '203.0.113.12'
    })
  );
  const body2 = JSON.parse(login2.body);

  // Single-session logout revokes token1 persistently across new router instance
  const logout1 = await router1.handle(
    makeReq('POST', '/api/logout', {
      search: '?scope=admin',
      headers: { authorization: `Bearer ${body1.token}` }
    })
  );
  assert.equal(logout1.status, 200);

  const router2 = createApiRouter({ config, store, drive });
  await router2.ensureInitialized();
  assert.equal(
    (await router2.handle(makeReq('GET', '/api/admin/albums', { headers: { authorization: `Bearer ${body1.token}` } }))).status,
    401
  );
  assert.equal(
    (await router2.handle(makeReq('GET', '/api/admin/albums', { headers: { authorization: `Bearer ${body2.token}` } }))).status,
    200
  );

  // Global admin session revocation invalidates token2 everywhere
  const revokeAll = await router2.handle(
    makeReq('POST', '/api/admin/sessions/revoke-all', {
      headers: { authorization: `Bearer ${body2.token}` }
    })
  );
  assert.equal(revokeAll.status, 200);

  const router3 = createApiRouter({ config, store, drive });
  await router3.ensureInitialized();
  assert.equal(
    (await router3.handle(makeReq('GET', '/api/admin/albums', { headers: { authorization: `Bearer ${body2.token}` } }))).status,
    401
  );
});

test('Client share config, slug collision, reserved slugs, separated cookies, and clientSessionVersion revocation', async () => {
  const env = {
    SESSION_SECRET: 's'.repeat(40),
    ADMIN_EMAIL: 'carlo@munno.it',
    ADMIN_PASSWORD: TEST_ADMIN_PASSWORD
  };
  const config = getConfig({ env });
  const driver = createMemoryDriver({
    albums: [
      { id: 'alb_1', driveFolderId: 'd1', name: 'Album Uno', slideshowEnabled: false, shareEnabled: false, shareToken: 't1', clientSessionVersion: 1 },
      { id: 'alb_2', driveFolderId: 'd2', name: 'Album Due', slideshowEnabled: false, shareEnabled: false, shareToken: 't2', clientSessionVersion: 1 }
    ],
    photos: [
      { id: 'p_1', driveFileId: 'drv_1', albumId: 'alb_1', originalName: '1.jpg', mimeType: 'image/jpeg', size: 10 },
      { id: 'p_2', driveFileId: 'drv_2', albumId: 'alb_2', originalName: '2.jpg', mimeType: 'image/jpeg', size: 10 }
    ]
  });
  const store = createStore(config, driver);
  const drive = createMockDrive();
  const router = createApiRouter({ config, store, drive });
  await router.ensureInitialized();

  const adminLogin = await router.handle(
    makeReq('POST', '/api/admin/login', {
      body: { email: 'carlo@munno.it', password: TEST_ADMIN_PASSWORD }
    })
  );
  const { token: adminToken } = JSON.parse(adminLogin.body);
  const adminCookie = extractCookiePairs(adminLogin.headers['Set-Cookie']).sid_admin;

  // Reserved slug rejected
  const reservedRes = await router.handle(
    makeReq('POST', '/api/admin/albums/alb_1/share', {
      headers: { authorization: `Bearer ${adminToken}` },
      body: { shareEnabled: true, clientUsername: 'admin', clientPassword: 'ClientPass123' }
    })
  );
  assert.equal(reservedRes.status, 400);

  // Valid share setup generates normalized slug
  const share1 = await router.handle(
    makeReq('POST', '/api/admin/albums/alb_1/share', {
      headers: { authorization: `Bearer ${adminToken}` },
      body: { shareEnabled: true, clientUsername: 'Marco & Sara', clientPassword: 'ClientPass123' }
    })
  );
  assert.equal(share1.status, 200);
  const share1Body = JSON.parse(share1.body);
  assert.equal(share1Body.album.shareToken, 'marco-sara');

  // Duplicate slug on alb_2 returns 409 Conflict
  const conflictRes = await router.handle(
    makeReq('POST', '/api/admin/albums/alb_2/share', {
      headers: { authorization: `Bearer ${adminToken}` },
      body: { shareEnabled: true, clientUsername: 'marco-sara', clientPassword: 'ClientPass123' }
    })
  );
  assert.equal(conflictRes.status, 409);

  // Client login sets sid_client cookie separately from sid_admin
  const clientLogin = await router.handle(
    makeReq('POST', '/api/share/marco-sara/login', {
      body: { username: 'Marco & Sara', password: 'ClientPass123' }
    })
  );
  assert.equal(clientLogin.status, 200);
  const clientToken = JSON.parse(clientLogin.body).token;
  const clientCookie = extractCookiePairs(clientLogin.headers['Set-Cookie']).sid_client;
  assert.ok(clientCookie);

  // Both cookies together work seamlessly with ?scope=admin and ?scope=client
  const bothCookies = `sid_admin=${adminCookie}; sid_client=${clientCookie}`;
  const meAdmin = await router.handle(makeReq('GET', '/api/me', { search: '?scope=admin', headers: { cookie: bothCookies } }));
  const meClient = await router.handle(makeReq('GET', '/api/me', { search: '?scope=client', headers: { cookie: bothCookies } }));
  assert.equal(JSON.parse(meAdmin.body).role, 'admin');
  assert.equal(JSON.parse(meClient.body).role, 'client');

  // Scoped client logout clears ONLY sid_client
  const clientLogout = await router.handle(
    makeReq('POST', '/api/logout', { search: '?scope=client', headers: { cookie: bothCookies } })
  );
  assert.match(String(clientLogout.headers['Set-Cookie']), /sid_client=;/);
  assert.doesNotMatch(String(clientLogout.headers['Set-Cookie']), /sid_admin=;/);

  // New client login, then rotate token -> immediately revokes previous client token via clientSessionVersion
  const clientLogin2 = await router.handle(
    makeReq('POST', '/api/share/marco-sara/login', {
      body: { username: 'Marco & Sara', password: 'ClientPass123' }
    })
  );
  const clientToken2 = JSON.parse(clientLogin2.body).token;
  assert.equal(
    (await router.handle(makeReq('GET', '/api/share/marco-sara/photos', { headers: { authorization: `Bearer ${clientToken2}` } }))).status,
    200
  );

  await router.handle(
    makeReq('POST', '/api/admin/albums/alb_1/share', {
      headers: { authorization: `Bearer ${adminToken}` },
      body: { shareEnabled: true, clientUsername: 'Marco & Sara', regenerateToken: true }
    })
  );
  assert.equal(
    (await router.handle(makeReq('GET', '/api/share/marco-sara/photos', { headers: { authorization: `Bearer ${clientToken2}` } }))).status,
    401
  );
  assert.equal(
    (await router.handle(makeReq('GET', '/api/share/marco-sara/photos', { headers: { authorization: `Bearer ${clientToken}` } }))).status,
    401
  );

  // Netlify handler emits distinct Set-Cookie headers on unscoped logout
  const netlifyRes = await handleNetlifyRequest(
    new Request('https://example.netlify.app/api/logout', {
      method: 'POST',
      headers: { cookie: 'sid_admin=a; sid_client=b; sid=c' }
    }),
    {},
    { env: { ...env, NETLIFY: 'true' }, storeDriver: driver, driveService: drive, forceNew: true }
  );
  assert.equal(netlifyRes.headers.getSetCookie().length, 3);
});
