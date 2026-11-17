/**
 * Utility di sicurezza: hashing scrypt, sessioni isolate Admin/Client,
 * protezione brute-force, validazione input, CORS e header HTTP sicuri.
 */
const crypto = require('crypto');

const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
]);

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, originalHash) {
  if (!password || !salt || !originalHash) return false;
  const hashBuf = crypto.scryptSync(String(password), salt, 64);
  const originalBuf = Buffer.from(originalHash, 'hex');
  if (hashBuf.length !== originalBuf.length) return false;
  return crypto.timingSafeEqual(hashBuf, originalBuf);
}

function generateToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

function isValidDriveFileId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{4,128}$/.test(id);
}

function isValidShareToken(token) {
  return typeof token === 'string' && /^[a-f0-9]{16,128}$/i.test(token);
}

function isValidAlbumId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{3,80}$/.test(id);
}

function detectImageFormat(buffer) {
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

function sanitizeDownloadFilename(name) {
  const cleaned = String(name || 'foto.jpg')
    .replace(/[\r\n"\\]/g, '_')
    .replace(/\//g, '_');
  const asciiFallback = cleaned.replace(/[^\x20-\x7E]/g, '_') || 'foto.jpg';
  const encoded = encodeURIComponent(cleaned);
  return { asciiFallback, encoded };
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function createLoginRateLimiter({
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

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie;
  if (!header) return cookies;
  for (const part of header.split(';')) {
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

function extractToken(req) {
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (bearer) return bearer;
  }
  const cookies = parseCookies(req);
  return cookies.sid || '';
}

function buildSessionCookie(token, maxAgeSeconds, req) {
  const isHttps = Boolean(req?.socket?.encrypted || req?.headers?.['x-forwarded-proto'] === 'https');
  const securePart = isHttps ? '; Secure' : '';
  return `sid=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${securePart}`;
}

function buildClearSessionCookie() {
  return 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
}

function createSessionStore({ ttlMs, rememberTtlMs }) {
  const sessions = new Map();

  function purgeExpired(now = Date.now()) {
    for (const [tok, sess] of sessions.entries()) {
      if (now > sess.expiresAt) sessions.delete(tok);
    }
  }

  return {
    create(payload, rememberMe = false) {
      const now = Date.now();
      purgeExpired(now);
      const durationMs = rememberMe ? rememberTtlMs : ttlMs;
      const token = 'tok_' + generateToken(32);
      sessions.set(token, {
        ...payload,
        createdAt: now,
        expiresAt: now + durationMs
      });
      return { token, maxAgeSeconds: Math.floor(durationMs / 1000) };
    },
    get(token) {
      if (!token) return null;
      const sess = sessions.get(token);
      if (!sess) return null;
      if (Date.now() > sess.expiresAt) {
        sessions.delete(token);
        return null;
      }
      return sess;
    },
    delete(token) {
      if (token) sessions.delete(token);
    },
    deleteClientSessionsForAlbum(albumId) {
      for (const [tok, sess] of sessions.entries()) {
        if (sess.role === 'client' && sess.albumId === albumId) {
          sessions.delete(tok);
        }
      }
    }
  };
}

function applySecurityHeaders(req, res, port, publicBaseUrl) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  const allowedOrigins = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`
  ]);
  if (publicBaseUrl) {
    try {
      allowedOrigins.add(new URL(publicBaseUrl).origin);
    } catch {}
  }

  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
}

function sendJson(res, statusCode, data, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
}

function parseJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      total += buf.length;
      if (total > maxBytes) {
        req.connection?.destroy?.();
        reject(new Error('Richiesta troppo grande'));
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('JSON non valido'));
      }
    });

    req.on('error', reject);
  });
}

module.exports = {
  ALLOWED_IMAGE_MIMES,
  hashPassword,
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
};
