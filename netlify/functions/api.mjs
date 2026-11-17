/**
 * Netlify Functions v2 Entrypoint (/api/*) - 100% ESM
 * Esegue lo stesso router API di server.js utilizzando Netlify Blobs + sessioni HMAC stateless.
 */
import { Readable } from 'stream';
import { getConfig } from '../../lib/config.js';
import { getSecurityHeaders } from '../../lib/security.js';
import { createStore } from '../../lib/store.js';
import { createDriveService } from '../../lib/drive.js';
import { createApiRouter } from '../../lib/apiRouter.js';

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
  try {
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
      const webStream =
        typeof ReadableStream !== 'undefined' && result.stream instanceof ReadableStream
          ? result.stream
          : Readable.toWeb(result.stream);
      return new Response(webStream, {
        status: result.status,
        headers: finalHeaders
      });
    }

    return new Response(result.body, {
      status: result.status,
      headers: finalHeaders
    });
  } catch (err) {
    console.error('[NETLIFY_API_ERROR]', err);
    return new Response(
      JSON.stringify({
        message: 'Errore interno del server API.',
        detail: err?.message || 'Errore sconosciuto'
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      }
    );
  }
}

export default async function handler(req, context) {
  return handleNetlifyRequest(req, context);
}

export const config = {
  path: '/api/*'
};
