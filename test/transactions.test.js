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
    transactions: structuredClone(initial.transactions || [])
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

test('Admin cash register (transactions) CRUD, validation, summary math, and auth protection', async () => {
  const env = {
    SESSION_SECRET: 'c'.repeat(40),
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
  assert.equal((await router.handle(makeReq('GET', '/api/admin/transactions'))).status, 401);
  assert.equal(
    (await router.handle(makeReq('POST', '/api/admin/transactions', { body: { type: 'income', amount: 100, date: '2026-11-22', description: 'Test' } }))).status,
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
    (await router.handle(makeReq('POST', '/api/admin/transactions', { headers: authHeaders, body: { type: 'invalid', amount: 50, date: '2026-11-22', description: 'Test' } }))).status,
    400
  );
  assert.equal(
    (await router.handle(makeReq('POST', '/api/admin/transactions', { headers: authHeaders, body: { type: 'income', amount: -10, date: '2026-11-22', description: 'Test' } }))).status,
    400
  );
  assert.equal(
    (await router.handle(makeReq('POST', '/api/admin/transactions', { headers: authHeaders, body: { type: 'income', amount: 50, date: '2026-99-99', description: 'Test' } }))).status,
    400
  );

  // Create income (paid), expense (paid), and income (pending)
  const incRes = await router.handle(
    makeReq('POST', '/api/admin/transactions', {
      headers: authHeaders,
      body: {
        type: 'income',
        amount: '1200,50',
        date: '2026-11-20',
        description: 'Saldo Matrimonio Marco & Sara',
        category: 'Saldo',
        paymentMethod: 'bank_transfer',
        status: 'paid',
        clientOrVendor: 'Marco & Sara',
        invoiceRef: 'FT-2026/041'
      }
    })
  );
  assert.equal(incRes.status, 201);
  const inc = JSON.parse(incRes.body).transaction;
  assert.ok(inc.id.startsWith('txn_'));
  assert.equal(inc.amount, 1200.5);

  const expRes = await router.handle(
    makeReq('POST', '/api/admin/transactions', {
      headers: authHeaders,
      body: {
        type: 'expense',
        amount: 250.25,
        date: '2026-11-22',
        description: 'Stampa Album Fotolibro',
        category: 'Stampe & Album',
        paymentMethod: 'card',
        status: 'paid',
        clientOrVendor: 'Lab Stampa'
      }
    })
  );
  assert.equal(expRes.status, 201);
  const exp = JSON.parse(expRes.body).transaction;

  const pendRes = await router.handle(
    makeReq('POST', '/api/admin/transactions', {
      headers: authHeaders,
      body: {
        type: 'income',
        amount: 300,
        date: '2026-11-25',
        description: 'Acconto Servizio Battesimo',
        category: 'Acconto',
        paymentMethod: 'cash',
        status: 'pending'
      }
    })
  );
  assert.equal(pendRes.status, 201);
  const pend = JSON.parse(pendRes.body).transaction;

  // Verify sorting (newest date first) and summary math
  const listRes = await router.handle(makeReq('GET', '/api/admin/transactions', { headers: authHeaders }));
  assert.equal(listRes.status, 200);
  const listData = JSON.parse(listRes.body);
  assert.equal(listData.transactions.length, 3);
  assert.equal(listData.transactions[0].id, pend.id);
  assert.equal(listData.transactions[1].id, exp.id);
  assert.equal(listData.transactions[2].id, inc.id);
  assert.equal(listData.summary.totalIncome, 1200.5);
  assert.equal(listData.summary.totalExpense, 250.25);
  assert.equal(listData.summary.balance, 950.25);
  assert.equal(listData.summary.pendingIncome, 300);
  assert.equal(listData.summary.pendingExpense, 0);

  // Mark pending transaction as paid via partial PUT
  const updRes = await router.handle(
    makeReq('PUT', `/api/admin/transactions/${pend.id}`, {
      headers: authHeaders,
      body: { status: 'paid' }
    })
  );
  assert.equal(updRes.status, 200);
  assert.equal(JSON.parse(updRes.body).transaction.status, 'paid');

  const afterPay = JSON.parse((await router.handle(makeReq('GET', '/api/admin/transactions', { headers: authHeaders }))).body);
  assert.equal(afterPay.summary.totalIncome, 1500.5);
  assert.equal(afterPay.summary.balance, 1250.25);
  assert.equal(afterPay.summary.pendingIncome, 0);

  // Delete expense
  const delRes = await router.handle(
    makeReq('DELETE', `/api/admin/transactions/${exp.id}`, { headers: authHeaders })
  );
  assert.equal(delRes.status, 200);
  assert.equal(JSON.parse(delRes.body).deletedId, exp.id);
  assert.equal(
    (await router.handle(makeReq('DELETE', `/api/admin/transactions/${exp.id}`, { headers: authHeaders }))).status,
    404
  );
});
