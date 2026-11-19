/**
 * Utility di sicurezza: hashing scrypt, token sessione stateless firmati HMAC-SHA256,
 * protezione brute-force, validazione input, CORS e header HTTP sicuri.
 */
import crypto from 'crypto';

export const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
]);

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, originalHash) {
  if (!password || !salt || !originalHash) return false;
  const hashBuf = crypto.scryptSync(String(password), salt, 64);
  const originalBuf = Buffer.from(originalHash, 'hex');
  if (hashBuf.length !== originalBuf.length) return false;
  return crypto.timingSafeEqual(hashBuf, originalBuf);
}

export function generateToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function isValidDriveFileId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{4,128}$/.test(id);
}

export const RESERVED_SHARE_SLUGS = new Set([
  'api',
  'share',
  'admin',
  'login',
  'logout',
  'dashboard',
  'health',
  'auth',
  'me',
  'media',
  'public',
  'uploads',
  'static',
  'favicon',
  'index.html',
  'style.css',
  'script.js',
  'favicon.ico',
  'robots.txt',
  'sitemap.xml',
  'assets',
  'netlify',
  '.netlify'
]);

export function normalizeShareSlug(username) {
  return String(username || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 80);
}

export function isValidShareSlug(slug) {
  if (typeof slug !== 'string') return false;
  const normalized = slug.trim().toLowerCase();
  return (
    /^[a-z0-9][a-z0-9_-]{1,127}$/.test(normalized) &&
    !RESERVED_SHARE_SLUGS.has(normalized)
  );
}

export function isValidShareToken(token) {
  if (typeof token !== 'string') return false;
  return /^[a-f0-9]{16,128}$/i.test(token) || isValidShareSlug(token);
}

export function isValidAlbumId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{3,80}$/.test(id);
}

export function detectImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', ext: '.jpg' };
  }
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return { mimeType: 'image/png', ext: '.png' };
  }
  const gifHeader = buffer.subarray(0, 6).toString('ascii');
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    return { mimeType: 'image/gif', ext: '.gif' };
  }
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mimeType: 'image/webp', ext: '.webp' };
  }
  return null;
}

export function sanitizeDownloadFilename(name) {
  const cleaned = String(name || 'foto.jpg')
    .replace(/[\r\n"\\]/g, '_')
    .replace(/\//g, '_');
  const asciiFallback = cleaned.replace(/[^\x20-\x7E]/g, '_') || 'foto.jpg';
  const encoded = encodeURIComponent(cleaned);
  return { asciiFallback, encoded };
}

export function getClientIpFromHeaders(headers, fallbackIp = 'unknown') {
  const netlifyIp = headers['x-nf-client-connection-ip'];
  if (typeof netlifyIp === 'string' && netlifyIp.trim()) {
    return netlifyIp.trim();
  }
  const forwarded = headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return fallbackIp;
}

export function getClientIp(req) {
  return getClientIpFromHeaders(req.headers || {}, req.socket?.remoteAddress || 'unknown');
}

export function createLoginRateLimiter({
  windowMs = 15 * 60 * 1000,
  maxAttempts = 5,
  blockDurationMs = 15 * 60 * 1000
} = {}) {
  const buckets = new Map();

  function cleanup(now) {
    if (buckets.size < 200) return;
    for (const [key, entry] of buckets.entries()) {
      if (now > entry.blockedUntil && now - entry.firstAttemptAt > windowMs) {
        buckets.delete(key);
      }
    }
  }

  return {
    check(key) {
      const now = Date.now();
      cleanup(now);
      const entry = buckets.get(key);
      if (!entry) return { allowed: true, retryAfterSec: 0 };
      if (entry.blockedUntil > now) {
        return {
          allowed: false,
          retryAfterSec: Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000))
        };
      }
      if (now - entry.firstAttemptAt > windowMs) {
        buckets.delete(key);
      }
      return { allowed: true, retryAfterSec: 0 };
    },
    recordFailure(key) {
      const now = Date.now();
      const entry = buckets.get(key);
      if (!entry || now - entry.firstAttemptAt > windowMs) {
        buckets.set(key, { count: 1, firstAttemptAt: now, blockedUntil: 0 });
        return;
      }
      entry.count += 1;
      if (entry.count >= maxAttempts) {
        entry.blockedUntil = now + blockDurationMs;
      }
    },
    reset(key) {
      buckets.delete(key);
    }
  };
}

export function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const part of String(cookieHeader).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      cookies[key] = decodeURIComponent(val);
    } catch {
      cookies[key] = val;
    }
  }
  return cookies;
}

export const ADMIN_SESSION_COOKIE = 'sid_admin';
export const CLIENT_SESSION_COOKIE = 'sid_client';
export const LEGACY_SESSION_COOKIE = 'sid';

export function extractTokensBySource(headers = {}) {
  const authHeader = headers['authorization'] || '';
  const bearer =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : '';
  const cookies = parseCookies(headers['cookie']);
  return {
    bearer,
    adminCookie: cookies[ADMIN_SESSION_COOKIE] || '',
    clientCookie: cookies[CLIENT_SESSION_COOKIE] || '',
    legacyCookie: cookies[LEGACY_SESSION_COOKIE] || ''
  };
}

export function extractTokenFromHeaders(headers, scope = 'any') {
  const { bearer, adminCookie, clientCookie, legacyCookie } = extractTokensBySource(headers);
  if (bearer) return bearer;
  if (scope === 'admin') return adminCookie || legacyCookie || '';
  if (scope === 'client') return clientCookie || legacyCookie || '';
  return adminCookie || clientCookie || legacyCookie || '';
}

export function extractToken(req, scope = 'any') {
  return extractTokenFromHeaders(req.headers || {}, scope);
}

export function buildSessionCookie(
  token,
  maxAgeSeconds,
  { isHttps = false, cookieName = ADMIN_SESSION_COOKIE } = {}
) {
  const securePart = isHttps ? '; Secure' : '';
  return `${cookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${securePart}`;
}

export function buildClearSessionCookie({ isHttps = false, cookieName = ADMIN_SESSION_COOKIE } = {}) {
  const securePart = isHttps ? '; Secure' : '';
  return `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${securePart}`;
}

export function isJtiRevoked(revokedJtis, jti) {
  if (!jti || !Array.isArray(revokedJtis) || revokedJtis.length === 0) return false;
  const now = Date.now();
  return revokedJtis.some(
    entry => entry && entry.jti === jti && (typeof entry.exp !== 'number' || entry.exp > now)
  );
}

export function appendRevokedJti(revokedJtis, jti, exp, { now = Date.now(), maxEntries = 100 } = {}) {
  const list = Array.isArray(revokedJtis) ? revokedJtis : [];
  const active = list.filter(
    entry => entry && typeof entry.jti === 'string' && typeof entry.exp === 'number' && entry.exp > now
  );
  if (jti && !active.some(entry => entry.jti === jti)) {
    active.push({
      jti,
      exp: typeof exp === 'number' && exp > now ? exp : now + 7 * 24 * 60 * 60 * 1000
    });
  }
  return active.length > maxEntries ? active.slice(active.length - maxEntries) : active;
}

/**
 * Store sessioni stateless firmato con HMAC-SHA256:
 * funziona sia su server Node singolo che su istanze serverless Netlify multiple.
 */
export function createSessionStore({ ttlMs, rememberTtlMs, secret }) {
  const signingKey = secret || crypto.randomBytes(32).toString('hex');
  const revokedTokens = new Set();

  function sign(payloadB64) {
    return crypto.createHmac('sha256', signingKey).update(payloadB64).digest('base64url');
  }

  return {
    create(payload, rememberMe = false) {
      const now = Date.now();
      const durationMs = rememberMe ? rememberTtlMs : ttlMs;
      const fullPayload = {
        ...payload,
        jti: crypto.randomBytes(8).toString('hex'),
        iat: now,
        exp: now + durationMs
      };
      const payloadB64 = Buffer.from(JSON.stringify(fullPayload), 'utf8').toString('base64url');
      const sig = sign(payloadB64);
      const token = `v1.${payloadB64}.${sig}`;
      return { token, maxAgeSeconds: Math.floor(durationMs / 1000) };
    },

    get(token) {
      if (!token || typeof token !== 'string' || revokedTokens.has(token)) return null;
      const parts = token.split('.');
      if (parts.length !== 3 || parts[0] !== 'v1') return null;

      const [, payloadB64, providedSig] = parts;
      const expectedSig = sign(payloadB64);
      const providedBuf = Buffer.from(providedSig, 'utf8');
      const expectedBuf = Buffer.from(expectedSig, 'utf8');
      if (providedBuf.length !== expectedBuf.length) return null;
      if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) return null;

      try {
        const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
        if (!parsed || typeof parsed.exp !== 'number' || Date.now() > parsed.exp) {
          return null;
        }
        return parsed;
      } catch {
        return null;
      }
    },

    delete(token) {
      if (token) {
        if (revokedTokens.size > 5000) revokedTokens.clear();
        revokedTokens.add(token);
      }
    },

    deleteClientSessionsForAlbum() {
      // Su token stateless la revoca immediata avviene tramite incremento di album.clientSessionVersion
    }
  };
}

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' https://images.unsplash.com data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'"
].join('; ');

export function getSecurityHeaders(origin, port, publicBaseUrl, { isHttps = false } = {}) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY
  };

  if (isHttps) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }

  const allowedOrigins = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`
  ]);
  if (publicBaseUrl) {
    try {
      allowedOrigins.add(new URL(publicBaseUrl).origin);
    } catch {}
  }

  if (origin && allowedOrigins.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  }

  return headers;
}

export function applySecurityHeaders(req, res, port, publicBaseUrl, options = {}) {
  const hdrs = getSecurityHeaders(req.headers.origin, port, publicBaseUrl, options);
  for (const [k, v] of Object.entries(hdrs)) {
    res.setHeader(k, v);
  }
}

export function sendJson(res, statusCode, data, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
}

export function buildImageEtag(driveFileId, version, variant = 'full') {
  const safeVer = String(version || '0').replace(/"/g, '');
  return `"${driveFileId}:${variant}:${safeVer}"`;
}

export function isEtagMatch(ifNoneMatchHeader, etag) {
  if (!ifNoneMatchHeader || !etag) return false;
  const raw = String(ifNoneMatchHeader).trim();
  if (raw === '*') return true;
  const normalizedTarget = etag.replace(/^W\//, '');
  return raw.split(',').some((part) => {
    const candidate = part.trim().replace(/^W\//, '');
    return candidate === normalizedTarget;
  });
}

function readRequestBuffer(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let settled = false;
    const chunks = [];

    function fail(err) {
      if (settled) return;
      settled = true;
      reject(err);
    }

    req.on('data', (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      total += buf.length;
      if (total > maxBytes) {
        req.connection?.destroy?.();
        const err = new Error('Richiesta troppo grande');
        err.status = 413;
        fail(err);
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });

    req.on('error', fail);
  });
}

export async function parseJsonBody(req, maxBytes = 1024 * 1024) {
  const buf = await readRequestBuffer(req, maxBytes);
  try {
    const raw = buf.toString('utf8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    const err = new Error('JSON non valido');
    err.status = 400;
    throw err;
  }
}

export async function parseBinaryBody(req, maxBytes = 25 * 1024 * 1024) {
  return readRequestBuffer(req, maxBytes);
}
