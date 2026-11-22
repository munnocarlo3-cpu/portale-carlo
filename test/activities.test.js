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
    activities: structuredClone(initial.activities || [])
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
    async openMediaStream() { return {}; },
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

test('Admin calendar activities CRUD, validation, sorting, and auth protection', async () => {
  const env = {
    SESSION_SECRET: 'k'.repeat(40),
    ADMIN_EMAIL: 'carlo@munno.it',
    ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
    ADMIN_NAME: 'Carlo Munno'
  };
  const config = getConfig({ env });
  const driver = createMemoryDriver();
  const store = createStore(config, driver);
  const router = createApiRouter({ config, store, drive: createMockDrive() });
  await router.ensureInitialized();

  // Unauthenticated access rejected
  assert.equal((await router.handle(makeReq('GET', '/api/admin/activities'))).status, 401);
  assert.equal((await router.handle(makeReq('POST', '/api/admin/activities', { body: { title: 'Test', date: '2026-11-25' } }))).status, 401);

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
  const badTitle = await router.handle(
    makeReq('POST', '/api/admin/activities', {
      headers: authHeaders,
      body: { title: 'A', date: '2026-11-25' }
    })
  );
  assert.equal(badTitle.status, 400);

  const badDateRange = await router.handle(
    makeReq('POST', '/api/admin/activities', {
      headers: authHeaders,
      body: { title: 'Servizio', date: '2026-11-25', endDate: '2026-11-20' }
    })
  );
  assert.equal(badDateRange.status, 400);

  const badStatus = await router.handle(
    makeReq('POST', '/api/admin/activities', {
      headers: authHeaders,
      body: { title: 'Servizio', date: '2026-11-25', status: 'invalid' }
    })
  );
  assert.equal(badStatus.status, 400);

  // Create two activities
  const create1 = await router.handle(
    makeReq('POST', '/api/admin/activities', {
      headers: authHeaders,
      body: {
        title: 'Matrimonio Marco & Sara',
        date: '2026-11-28',
        time: '10:30',
        status: 'scheduled',
        client: 'Marco & Sara',
        location: 'Villa d\'Este',
        notes: 'Portare 2 corpi macchina'
      }
    })
  );
  assert.equal(create1.status, 201);
  const act1 = JSON.parse(create1.body).activity;
  assert.ok(act1.id.startsWith('act_'));
  assert.equal(act1.endDate, '2026-11-28');

  const create2 = await router.handle(
    makeReq('POST', '/api/admin/activities', {
      headers: authHeaders,
      body: {
        title: 'Post-produzione Album Autunno',
        date: '2026-11-22',
        endDate: '2026-11-24',
        status: 'in_progress'
      }
    })
  );
  assert.equal(create2.status, 201);
  const act2 = JSON.parse(create2.body).activity;

  // List returns chronologically sorted
  const listRes = await router.handle(makeReq('GET', '/api/admin/activities', { headers: authHeaders }));
  assert.equal(listRes.status, 200);
  const listed = JSON.parse(listRes.body).activities;
  assert.equal(listed.length, 2);
  assert.equal(listed[0].id, act2.id);
  assert.equal(listed[1].id, act1.id);

  // Partial status update via PUT preserves other fields
  const updRes = await router.handle(
    makeReq('PUT', `/api/admin/activities/${act1.id}`, {
      headers: authHeaders,
      body: { status: 'in_progress' }
    })
  );
  assert.equal(updRes.status, 200);
  const updated = JSON.parse(updRes.body).activity;
  assert.equal(updated.status, 'in_progress');
  assert.equal(updated.title, 'Matrimonio Marco & Sara');
  assert.equal(updated.client, 'Marco & Sara');

  // Delete activity
  const delRes = await router.handle(
    makeReq('DELETE', `/api/admin/activities/${act2.id}`, { headers: authHeaders })
  );
  assert.equal(delRes.status, 200);
  assert.equal(JSON.parse(delRes.body).deletedId, act2.id);

  // Deleting again returns 404
  const delAgain = await router.handle(
    makeReq('DELETE', `/api/admin/activities/${act2.id}`, { headers: authHeaders })
  );
  assert.equal(delAgain.status, 404);

  const listAfter = JSON.parse((await router.handle(makeReq('GET', '/api/admin/activities', { headers: authHeaders }))).body).activities;
  assert.equal(listAfter.length, 1);
  assert.equal(listAfter[0].id, act1.id);
});
