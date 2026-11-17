/**
 * Server Web & API Locale / Railway / VPS (Node.js ESM) - Carlo Munno Photographer
 * Avvolge il router unificato `lib/apiRouter.js` e serve gli asset statici da `public/`.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { getConfig } from './lib/config.js';
import {
  applySecurityHeaders,
  sendJson,
  parseJsonBody,
  isValidShareToken
} from './lib/security.js';
import { createStore } from './lib/store.js';
import { createDriveService } from './lib/drive.js';
import { createApiRouter } from './lib/apiRouter.js';

const PUBLIC_STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/style.css', 'style.css'],
  ['/script.js', 'script.js']
]);

const STATIC_MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

export function createAppServer(options = {}) {
  const config = getConfig(options);
  const store = createStore(config, options.storeDriver || null);
  const drive = options.driveService || createDriveService(config);
  const router = createApiRouter({ config, store, drive });

  const initPromise = router.ensureInitialized().catch((err) => {
    console.error('[INIT] Errore inizializzazione store:', err.message);
  });

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('405 Metodo Non Consentito');
    }

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('400 Richiesta Non Valida');
    }

    let mappedFile = PUBLIC_STATIC_FILES.get(decodedPath);
    if (!mappedFile) {
      const legacyShareMatch = decodedPath.match(/^\/share\/([^/]+)\/?$/);
      const rootSlugMatch = decodedPath.match(/^\/([^/]+)\/?$/);
      const candidateToken = legacyShareMatch?.[1] || rootSlugMatch?.[1] || '';
      if (candidateToken && isValidShareToken(candidateToken)) {
        mappedFile = 'index.html';
      }
    }

    if (!mappedFile) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Risorsa Non Trovata');
    }

    const publicResolved = path.resolve(config.publicDir);
    const targetPath = path.resolve(publicResolved, mappedFile);
    if (!targetPath.startsWith(publicResolved + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('403 Accesso Negato');
    }

    const ext = path.extname(targetPath).toLowerCase();
    const contentType = STATIC_MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(targetPath, (err, content) => {
      if (err) {
        res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(err.code === 'ENOENT' ? '404 Risorsa Non Trovata' : '500 Errore del Server');
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache'
      });
      res.end(req.method === 'HEAD' ? undefined : content);
    });
  }

  const server = http.createServer(async (req, res) => {
    applySecurityHeaders(req, res, config.port, config.publicBaseUrl);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    let urlObj;
    try {
      urlObj = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(res, 400, { message: 'URL non valido.' });
    }

    if (urlObj.pathname.startsWith('/api/')) {
      const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
      const protocol = forwardedProto || (req.socket?.encrypted ? 'https' : 'http');

      const result = await router.handle({
        method: req.method,
        pathname: urlObj.pathname,
        searchParams: urlObj.searchParams,
        headers: req.headers || {},
        ip: req.socket?.remoteAddress || 'unknown',
        host: req.headers['x-forwarded-host'] || req.headers.host || `localhost:${config.port}`,
        protocol,
        readJsonBody: (maxBytes) => parseJsonBody(req, maxBytes)
      });

      if (!result) {
        return sendJson(res, 404, { message: 'Endpoint API non trovato.' });
      }

      if (result.stream) {
        res.writeHead(result.status, result.headers);
        result.stream.on('error', () => {
          if (!res.headersSent) {
            sendJson(res, 502, { message: 'Errore durante lo streaming da Google Drive.' });
          } else {
            res.end();
          }
        });
        result.stream.pipe(res);
        return;
      }

      res.writeHead(result.status, result.headers);
      res.end(result.body);
      return;
    }

    serveStatic(req, res, urlObj.pathname);
  });

  return { server, config, store, drive, router, ready: initPromise };
}

const isEntrypoint =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  const envFilePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
  if (fs.existsSync(envFilePath)) {
    dotenv.config({ path: envFilePath });
  }

  const { server, config, drive, ready } = createAppServer();
  ready.then(() => {
    server.listen(config.port, () => {
      console.log('\n=================================================');
      console.log('📸 Carlo Munno Photographer - Portale Google Drive');
      console.log(`📡 URL Locale: http://localhost:${config.port}`);
      console.log(`👤 Admin (.env): ${config.admin.email || '(NON CONFIGURATO)'}`);
      console.log(`☁️  Google Drive: ${drive.isConfigured() ? 'Configurato' : 'In attesa di .env'}`);
      console.log('=================================================\n');
    });
  });
}
