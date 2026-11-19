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
  const envApi = typeof globalThis.Netlify !== 'undefined' ? globalThis.Netlify?.env : null;
  const netlifyEnv = envApi && typeof envApi.toObject === 'function' ? envApi.toObject() : {};
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

    const urlObj = new URL(req.url);
    const forwardedProto = String(headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const protocol = forwardedProto || urlObj.protocol.replace(':', '') || 'https';
    const isHttps = protocol === 'https';
    const secHeaders = getSecurityHeaders(headers['origin'], config.port, config.publicBaseUrl, { isHttps });

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: secHeaders });
    }

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
          const err = new Error('Richiesta troppo grande');
          err.status = 413;
          throw err;
        }
        try {
          return raw ? JSON.parse(raw) : {};
        } catch {
          const err = new Error('JSON non valido');
          err.status = 400;
          throw err;
        }
      },
      readBinaryBody: async (maxBytes = 25 * 1024 * 1024) => {
        const contentLength = Number(headers['content-length'] || 0);
        if (contentLength > maxBytes) {
          const err = new Error('Richiesta troppo grande');
          err.status = 413;
          throw err;
        }
        const buf = Buffer.from(await req.arrayBuffer());
        if (buf.length > maxBytes) {
          const err = new Error('Richiesta troppo grande');
          err.status = 413;
          throw err;
        }
        return buf;
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

    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries({ ...secHeaders, ...(result.headers || {}) })) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          responseHeaders.append(key, String(item));
        }
      } else {
        responseHeaders.set(key, String(value));
      }
    }

    if (result.stream) {
      const webStream =
        typeof ReadableStream !== 'undefined' && result.stream instanceof ReadableStream
          ? result.stream
          : Readable.toWeb(result.stream);
      return new Response(webStream, {
        status: result.status,
        headers: responseHeaders
      });
    }

    const responseBody = [204, 205, 304].includes(result.status) ? null : result.body;
    return new Response(responseBody, {
      status: result.status,
      headers: responseHeaders
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
