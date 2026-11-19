import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');

const { getConfig } = await import('../lib/config.js');
const {
  hashPassword,
  verifyPassword,
  detectImageFormat,
  createLoginRateLimiter,
  getSecurityHeaders,
  CONTENT_SECURITY_POLICY,
  RESERVED_SHARE_SLUGS
} = await import('../lib/security.js');
const { createStore } = await import('../lib/store.js');
const { createAppServer } = await import('../server.js');
const { handleNetlifyRequest } = await import('../netlify/functions/api.mjs');

test('All project JS files pass node --check and frontend avoids inline onclick attributes', () => {
  for (const rel of [
    'server.js',
    'lib/config.js',
    'lib/security.js',
    'lib/store.js',
    'lib/drive.js',
    'lib/apiRouter.js',
    'netlify/functions/api.mjs',
    'public/script.js'
  ]) {
    execSync(`node --check "${path.join(ROOT_DIR, rel)}"`, { stdio: 'pipe' });
  }

  const scriptSrc = fs.readFileSync(path.join(ROOT_DIR, 'public/script.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(ROOT_DIR, 'public/index.html'), 'utf8');
  assert.doesNotMatch(scriptSrc, /\bonclick=/i);
  assert.doesNotMatch(htmlSrc, /\bon(click|change|submit)=/i);
});

test('Password hashing, magic-byte image detection, and login rate limiter behave correctly', () => {
  const { salt, hash } = hashPassword('MySecretPass123!');
  assert.equal(verifyPassword('MySecretPass123!', salt, hash), true);
  assert.equal(verifyPassword('WrongPass', salt, hash), false);

  assert.equal(detectImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))?.mimeType, 'image/jpeg');
  assert.equal(detectImageFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))?.mimeType, 'image/png');
  assert.equal(detectImageFormat(Buffer.from('GIF89a000000', 'ascii'))?.mimeType, 'image/gif');
  assert.equal(detectImageFormat(Buffer.from('RIFF0000WEBP', 'ascii'))?.mimeType, 'image/webp');
  assert.equal(detectImageFormat(Buffer.from('not-an-image-bytes', 'ascii')), null);

  const limiter = createLoginRateLimiter({ windowMs: 60000, maxAttempts: 3, blockDurationMs: 60000 });
  assert.equal(limiter.check('ip1').allowed, true);
  limiter.recordFailure('ip1');
  limiter.recordFailure('ip1');
  assert.equal(limiter.check('ip1').allowed, true);
  limiter.recordFailure('ip1');
  const blocked = limiter.check('ip1');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec >= 1);
  limiter.reset('ip1');
  assert.equal(limiter.check('ip1').allowed, true);
});

test('SESSION_SECRET is required in production and warns in local/dev', () => {
  assert.throws(
    () => getConfig({ env: { ADMIN_EMAIL: 'a@b.it', ADMIN_PASSWORD: 'pass' }, useNetlifyBlobs: true }),
    /SESSION_SECRET/
  );
  assert.throws(
    () => getConfig({ env: { SESSION_SECRET: 'short', NETLIFY: 'true' } }),
    /SESSION_SECRET/
  );

  const prodOk = getConfig({ env: { SESSION_SECRET: 'a'.repeat(32), NETLIFY: 'true' } });
  assert.equal(prodOk.session.configured, true);
  assert.equal(prodOk.session.warning, '');

  const netlifyDev = getConfig({
    env: { CONTEXT: 'dev', NETLIFY: 'true', ADMIN_EMAIL: 'a@b.it', ADMIN_PASSWORD: 'pass' }
  });
  assert.equal(netlifyDev.session.configured, false);
  assert.ok(netlifyDev.session.warning.length > 0);

  const localDev = getConfig({ env: { ADMIN_EMAIL: 'a@b.it', ADMIN_PASSWORD: 'pass' } });
  assert.equal(localDev.session.configured, false);
  assert.ok(localDev.session.warning.length > 0);
});

test('RESERVED_SHARE_SLUGS blocks critical routes and security headers include CSP + conditional HSTS', () => {
  for (const slug of ['api', 'share', 'admin', 'login', 'logout', 'dashboard', 'health', 'me', 'media']) {
    assert.ok(RESERVED_SHARE_SLUGS.has(slug), `Missing reserved slug: ${slug}`);
  }

  const httpHeaders = getSecurityHeaders('http://localhost:3000', 3000, '', { isHttps: false });
  assert.equal(httpHeaders['Content-Security-Policy'], CONTENT_SECURITY_POLICY);
  assert.equal(httpHeaders['X-Frame-Options'], 'DENY');
  assert.equal(httpHeaders['X-Content-Type-Options'], 'nosniff');
  assert.equal(httpHeaders['Strict-Transport-Security'], undefined);

  const httpsHeaders = getSecurityHeaders('https://carlomunno.it', 3000, 'https://carlomunno.it', { isHttps: true });
  assert.equal(httpsHeaders['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains');
  assert.equal(httpsHeaders['Access-Control-Allow-Origin'], 'https://carlomunno.it');
});

test('Store uses atomic writes, backs up corrupt JSON without wiping data, and serializes concurrent writes', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'munno-store-'));
  try {
    const config = getConfig({
      dataDir: tmpDir,
      env: {
        SESSION_SECRET: 'x'.repeat(40),
        ADMIN_EMAIL: 'admin@test.it',
        ADMIN_PASSWORD: 'SuperSecretPassword1!'
      }
    });
    const store = createStore(config);
    await store.ensureDataFilesExist();

    await store.saveAlbums([{ id: 'alb_1', name: 'Uno' }]);
    assert.ok(!fs.readdirSync(tmpDir).some(f => f.endsWith('.tmp')));

    fs.writeFileSync(config.files.albums, '{corrupted json', 'utf8');
    await assert.rejects(() => store.loadAlbums(), /corrotto/i);
    const backup = fs.readdirSync(tmpDir).find(f => f.startsWith('albums.json.corrupt.') && f.endsWith('.bak'));
    assert.ok(backup);
    assert.equal(fs.readFileSync(path.join(tmpDir, backup), 'utf8'), '{corrupted json');

    const memDb = { users: [], albums: [{ id: 'alb_counter', tags: [] }], photos: [] };
    const memDriver = {
      async getArray(key) {
        await new Promise(r => setTimeout(r, 5));
        return structuredClone(memDb[key] || []);
      },
      async setArray(key, data) {
        await new Promise(r => setTimeout(r, 5));
        memDb[key] = structuredClone(data);
      },
      async initIfMissing() {}
    };
    const memStore = createStore(config, memDriver);
    await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        memStore.updateAlbums(albums => [{ ...albums[0], tags: [...albums[0].tags, i] }])
      )
    );
    const finalAlbums = await memStore.loadAlbums();
    assert.equal(finalAlbums[0].tags.length, 15);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('server.js and Netlify entrypoint emit security headers and handle corrupt JSON safely', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'munno-srv-'));
  try {
    const env = {
      PORT: '3000',
      SESSION_SECRET: 'z'.repeat(40),
      ADMIN_EMAIL: 'carlo@munno.it',
      ADMIN_PASSWORD: 'AdminPassword123!'
    };
    const app = createAppServer({ dataDir: tmpDir, env });
    await app.ready;
    fs.writeFileSync(app.config.files.albums, 'NOT_JSON', 'utf8');

    const req = new EventEmitter();
    req.method = 'GET';
    req.url = '/api/public/slideshow';
    req.headers = { host: 'localhost:3000', 'x-forwarded-proto': 'https' };
    req.socket = { remoteAddress: '127.0.0.1' };

    const res = await new Promise((resolve) => {
      const headers = {};
      let statusCode = 200;
      const chunks = [];
      const mockRes = {
        headersSent: false,
        setHeader(k, v) { headers[k] = v; },
        writeHead(status, hdrs = {}) {
          statusCode = status;
          Object.assign(headers, hdrs);
          mockRes.headersSent = true;
        },
        end(data) {
          if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
          resolve({ status: statusCode, headers, body: Buffer.concat(chunks).toString('utf8') });
        }
      };
      app.server.emit('request', req, mockRes);
    });

    assert.equal(res.status, 500);
    assert.ok(res.headers['Content-Security-Policy']);
    assert.equal(res.headers['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains');
    assert.match(JSON.parse(res.body).detail, /corrotto/i);

    const netlifyHealth = await handleNetlifyRequest(
      new Request('https://carlomunno.netlify.app/api/health'),
      {},
      {
        env: { ...env, NETLIFY: 'true' },
        storeDriver: {
          async getArray() { return []; },
          async setArray() {},
          async initIfMissing() {}
        },
        forceNew: true
      }
    );
    assert.equal(netlifyHealth.status, 200);
    assert.ok(netlifyHealth.headers.get('content-security-policy'));
    assert.equal(netlifyHealth.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
