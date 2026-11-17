/**
 * Netlify Functions v2 Entrypoint (/api/*)
 * Esegue lo stesso router API di server.js utilizzando Netlify Blobs + sessioni HMAC stateless.
 */
import { Readable } from 'stream';
import configMod from '../../lib/config.js';
import securityMod from '../../lib/security.js';
import storeMod from '../../lib/store.js';
import driveMod from '../../lib/drive.js';
import routerMod from '../../lib/apiRouter.js';

const { getConfig } = configMod;
const { getSecurityHeaders } = securityMod;
const { createStore } = storeMod;
const { createDriveService } = driveMod;
const { createApiRouter } = routerMod;

let cachedInstance = null;

function getRuntimeEnv() {
  const netlifyEnv =
    typeof globalThis.Netlify !== 'undefined' && globalThis.Netlify?.env
      ? globalThis.Netlify.env.toObject()
      : {};
  return {
    ...process.env,
    ...netlifyEnv,
    NETLIFY: 'true'
  };
}

function getNetlifyRouter(overrides = {}) {
  if (cachedInstance && !overrides.forceNew) return cachedInstance;

  const env = overrides.env || getRuntimeEnv();
  const config = getConfig({ env, useNetlifyBlobs: true });
  const store = createStore(config, overrides.storeDriver || null);
  const drive = overrides.driveService || createDriveService(config);
  const router = createApiRouter({ config, store, drive });

  const instance = { config, router };
  if (!overrides.forceNew) {
    cachedInstance = instance;
  }
  return instance;
}

export async function handleNetlifyRequest(req, context = {}, overrides = {}) {
  const { config, router } = getNetlifyRouter(overrides);

  const headers = {};
  req.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const secHeaders = getSecurityHeaders(headers['origin'], config.port, config.publicBaseUrl);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: secHeaders });
  }

  const urlObj = new URL(req.url);
  const forwardedProto = String(headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || urlObj.protocol.replace(':', '') || 'https';
  const host = headers['x-forwarded-host'] || headers['host'] || urlObj.host;

  const result = await router.handle({
    method: req.method,
    pathname: urlObj.pathname,
    searchParams: urlObj.searchParams,
    headers,
    ip: context?.ip || headers['x-nf-client-connection-ip'] || 'unknown',
    host,
    protocol,
    readJsonBody: async (maxBytes = 1024 * 1024) => {
      const raw = await req.text();
      if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
        throw new Error('Richiesta troppo grande');
      }
      try {
        return raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error('JSON non valido');
      }
    }
  });

  if (!result) {
    return new Response(JSON.stringify({ message: 'Endpoint API non trovato.' }), {
      status: 404,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...secHeaders
      }
    });
  }

  const finalHeaders = {
    ...secHeaders,
    ...(result.headers || {})
  };

  if (result.stream) {
    const webStream = Readable.toWeb(result.stream);
    return new Response(webStream, {
      status: result.status,
      headers: finalHeaders
    });
  }

  return new Response(result.body, {
    status: result.status,
    headers: finalHeaders
  });
}

export default async function handler(req, context) {
  return handleNetlifyRequest(req, context);
}

export const config = {
  path: '/api/*'
};
