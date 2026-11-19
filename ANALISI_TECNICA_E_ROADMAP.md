# Analisi Tecnica ed Evolutiva — Carlo Munno Photo Portal (`v2.1.1`)

> **Data Audit:** 18 Novembre 2026  
> **Target:** Architettura Node.js ESM (`server.js`), Serverless Netlify Functions v2 (`netlify/functions/api.mjs`), Persistenza Dual-Mode (`lib/store.js`), Google Drive API v3 (`lib/drive.js`) e Frontend SPA (`public/`).

---

## 1. Panoramica Architetturale e Punti di Forza

Il progetto è ben strutturato, snello e progettato con una chiara separazione delle responsabilità:

- **Core API agnostico dal runtime (`lib/apiRouter.js`)**: la logica di business è isolata in un unico router che riceve un contesto astratto (`reqCtx`), funzionando senza duplicazioni sia su server HTTP Node.js (`server.js`) sia su Netlify Functions v2 (`netlify/functions/api.mjs`).
- **Zero dipendenze pesanti e bundle ESM puro (`package.json`, `lib/drive.js`)**: l'uso esclusivo di `@netlify/blobs` e `dotenv` insieme a `node:crypto` (JWT `RS256` per il Service Account Google) e `fetch` nativo (Node >= 20) evita l'inclusione di `googleapis`, riducendo drasticamente i tempi di cold start su Netlify.
- **Proxy Media protetto (`GET /api/media/:driveFileId`)**: i file su Google Drive non vengono esposti pubblicamente; il backend verifica i permessi (`admin`, `client` autenticato sull'album specifico o album abilitato allo slideshow pubblico) prima di aprire lo stream.
- **Buona igiene di sicurezza di base**:
  - Hashing delle password con `crypto.scryptSync` e verifica tramite `crypto.timingSafeEqual` (`lib/security.js`).
  - Validazione dei magic bytes reali dei file immagine (`detectImageFormat` per JPEG, PNG, GIF, WebP).
  - Sanitizzazione sistematica dell'output HTML (`escapeHtml`) e degli URL media (`sanitizeMediaUrl`) nel frontend (`public/script.js`).

---

## 2. Criticità Rilevate (Audit Tecnico)

### 2.1 Sicurezza e Gestione Sessioni

1. **[CRITICO] Conflitto tra Cookie `sid` e `Authorization: Bearer` nello stesso browser**
   - *File:* `lib/security.js` (`extractTokenFromHeaders`, `buildSessionCookie`), `public/script.js`
   - *Dettaglio:* Le chiamate `fetch()` inviano l'header `Authorization: Bearer <token>` (letto da `localStorage` o `sessionStorage`), mentre i tag `<img src="/api/media/...">` e i link di download `<a href="/api/media/...?download=1">` si affidano **esclusivamente al cookie `HttpOnly` `sid`** impostato su `Path=/`.
   - *Impatto:* Se l'Admin apre nello stesso browser un link cliente (`/<nomecliente>`) e fa login per testarlo, il cookie `sid` viene sovrascritto dalla sessione cliente. Le chiamate API della dashboard Admin continueranno a funzionare (grazie al Bearer token), ma **tutte le miniature e i download nella dashboard Admin restituiranno `403 Forbidden`**.

2. **[CRITICO] Revoca token (`revokedTokens`) inefficace in ambiente Serverless**
   - *File:* `lib/security.js` (`createSessionStore`)
   - *Dettaglio:* Al logout (`POST /api/logout`), il token viene inserito in un `Set` in memoria (`revokedTokens`). Su Netlify Functions (multi-istanza ed effimero), le altre istanze o i riavvii a freddo non condividono quel `Set`. Un Bearer token rubato (es. Admin con `rememberMe` valido 7 giorni) resta valido fino alla scadenza naturale (`exp`).

3. **[ALTO] Rate Limiter in-memory e possibile IP Spoofing via `x-forwarded-for`**
   - *File:* `lib/security.js` (`createLoginRateLimiter`, `getClientIpFromHeaders`)
   - *Dettaglio:* Il rate limiter di login utilizza una `Map` locale al processo (facilmente aggirabile su istanze serverless multiple). Inoltre, in assenza di `x-nf-client-connection-ip`, legge il primo IP di `x-forwarded-for`, che può essere falsificato dal client se il server Node viene esposto senza un reverse proxy configurato per sovrascriverlo.

4. **[MEDIO] Fallback deterministico di `SESSION_SECRET`**
   - *File:* `lib/config.js`
   - *Dettaglio:* Se `SESSION_SECRET` non è valorizzato nelle variabili d'ambiente, viene generato un hash SHA-256 concatenando `adminEmail | adminPassword | normalizedPrivateKey`. Se Drive non è ancora configurato e la password Admin è debole, il segreto di firma è prevedibile; inoltre, cambiare la chiave privata Google invalida tutte le sessioni.

5. **[MEDIO] Slug riservati incompleti e assenza di CSP / HSTS**
   - *File:* `lib/security.js` (`RESERVED_SHARE_SLUGS`, `getSecurityHeaders`)
   - *Dettaglio:* Mancano nella blacklist slug come `admin`, `login`, `logout`, `dashboard`, `health`, `public`, `uploads`. Un cliente chiamato `admin` genererebbe lo slug `/admin`. Inoltre mancano gli header `Content-Security-Policy` e `Strict-Transport-Security` (quando in HTTPS).

---

### 2.2 Persistenza, Concorrenza e Integrità Dati

1. **[CRITICO] Race Condition (Lost Updates) su File JSON e Netlify Blobs**
   - *File:* `lib/store.js`, `lib/apiRouter.js`
   - *Dettaglio:* Tutte le scritture seguono il pattern *read-modify-write* sull'intero array (`albums`, `photos`, `users`) senza lock in memoria (per Node locale) né controllo ETag (`onlyIfMatch` su Netlify Blobs). Due operazioni concorrenti (es. modifica condivisione mentre è in corso una sync o un salvataggio foto) sovrascrivono silenziosamente i dati.

2. **[CRITICO] Scrittura file non atomica e silenzioso azzeramento su JSON corrotto**
   - *File:* `lib/store.js` (`writeJsonArraySync`, `readJsonArraySync`)
   - *Dettaglio:* `fs.writeFileSync` scrive direttamente sul file di destinazione: un crash o riavvio del processo a metà scrittura tronca il file. Subito dopo, `readJsonArraySync` intercetta l'errore di `JSON.parse` nel blocco `catch` e **restituisce silenziosamente `[]`**, causando alla scrittura successiva la cancellazione definitiva di tutti gli album e delle credenziali clienti.

3. **[MEDIO] Accoppiamento rigido al `driveFolderId` durante la sincronizzazione**
   - *File:* `lib/apiRouter.js` (`POST /api/admin/drive/sync`)
   - *Dettaglio:* Se una cartella su Google Drive viene ricreata con lo stesso nome (cambiando ID), l'album precedente viene eliminato insieme a `shareToken`, `clientUsername`, `clientPasswordHash` e `slideshowEnabled`.

---

### 2.3 Performance, Scalabilità e Limiti Serverless (Netlify)

1. **[CRITICO] Cascata di richieste (N+1) nel Proxy Media (`GET /api/media/:driveFileId`)**
   - *File:* `lib/apiRouter.js`, `lib/drive.js` (`openMediaStream`)
   - *Dettaglio:* Per **ogni singola miniatura (`?thumb=1`)** visualizzata in griglia, il server esegue:
     1. Lettura strong-consistency di `photos` e `albums` da Netlify Blobs (+ `users` se Admin);
     2. Chiamata HTTP `GET /drive/v3/files/:id` a Google Drive per leggere i metadati e ottenere `thumbnailLink`;
     3. Seconda chiamata HTTP a Google per scaricare lo stream della miniatura.
   - *Impatto:* Una galleria di 60 foto genera **60 invocazioni serverless** e **120+ richieste HTTP verso Google Drive**, rischiando errori `429 Too Many Requests` da Google e rallentamenti marcati.

2. **[ALTO] Limite payload 6 MB di Netlify Functions sul salvataggio foto da Editor**
   - *File:* `lib/apiRouter.js` (`POST /api/admin/photos/:id/save`), `public/script.js` (`saveToDrive`)
   - *Dettaglio:* L'editor invia l'immagine modificata come stringa Base64 in un body JSON (+33% di peso). Anche se `apiRouter.js` accetta fino a 40 MB di JSON, **Netlify Functions v2 impone un limite rigido di ~6 MB** sulle richieste sincrone: il salvataggio diretto su Drive di foto ad alta risoluzione fallirà su Netlify con `413 Payload Too Large`.

3. **[ALTO] Scansione Google Drive sequenziale a rischio Timeout**
   - *File:* `lib/drive.js` (`listDriveAlbumsAndPhotos`)
   - *Dettaglio:* Il ciclo `for (const folder of folders)` interroga Google Drive una cartella alla volta in modo strettamente sequenziale. Con 20–30 cartelle si rischia di superare il timeout di esecuzione delle Netlify Functions (10s–26s).

4. **[ALTO] Rendering Canvas 2D a risoluzione piena ad ogni movimento dello slider**
   - *File:* `public/script.js` (`photoEditor.render`)
   - *Dettaglio:* Ad ogni evento `input` degli slider (luminosità, contrasto, sfocatura, ecc.), `canvas.width` e `canvas.height` vengono riassegnati a `img.naturalWidth × img.naturalHeight` e ridisegnati con `ctx.filter`. Su scatti da 24–45 MP questo blocca il main thread del browser e può superare il limite massimo di memoria Canvas su iOS Safari (~16.7 megapixel).

---

### 2.4 Frontend, UX e Qualità del Codice

1. **[MEDIO] UX ambigua al click sulle card Album (Dashboard Admin)**
   - *File:* `public/script.js` (`renderAdminAlbumCards`)
   - *Dettaglio:* Cliccare su una card album seleziona il filtro nella griglia sottostante ma **apre anche contemporaneamente il Lightbox** sulla prima foto dell'album.

2. **[BASSO] Rotazione nel Lightbox ed esportazione copia ruotata**
   - *File:* `public/script.js` (`applyLightboxRotation`, `downloadCurrentLightboxPhoto`), `public/style.css`
   - *Dettaglio:*
     - Ruotando di ±90° una foto orizzontale, le dimensioni CSS (`max-width: 90%; max-height: 68vh`) non vengono invertite e l'immagine può risultare tagliata dal contenitore.
     - Il download della versione ruotata forza sempre `toDataURL('image/jpeg', 0.95)` (anche per PNG/WebP), rimuove i dati EXIF e non passa `{ version: photo.updatedAt }` nell'URL sorgente.

3. **[BASSO] Piccole inconsistenze e assenza di test automatici**
   - *File:* `public/script.js`, `server.js`, `package.json`
   - *Dettaglio:*
     - `openLightbox(photo, photoList = null)` viene invocata in 5 punti passando un terzo parametro `{ canDownload: true }` che la funzione non dichiara né utilizza.
     - Il routing dei path inesistenti restituisce `404` su `server.js` locale, ma `200` (`/index.html`) su Netlify (`netlify.toml`).
     - Assenza di una suite di test automatici (`node --test`), nonostante il codice backend usi già un'ottima Dependency Injection (`createApiRouter`, `createAppServer`, `handleNetlifyRequest`).

---

## 3. Piano Operativo — Cose da Fare (Checklist Prioritizzata)

### 🔴 Priorità P0 — Sicurezza, Sessioni e Integrità Dati (Completata ✅)

- [x] **Separare i cookie di sessione Admin e Cliente**
  - Utilizzati due cookie distinti (`sid_admin` e `sid_client`) in `lib/security.js` e `lib/apiRouter.js`, con supporto `?scope=admin|client` su `/api/me` e `/api/logout` e gestione corretta di multipli header `Set-Cookie` in `netlify/functions/api.mjs`.
  - Rimossa in `public/script.js` la condizione che saltava `/api/logout` per le sessioni basate su solo cookie, e aggiornato `/api/media/:driveFileId` per valutare tutti i token presenti senza conflitti.
- [x] **Rendere atomiche e sicure le scritture in `lib/store.js`**
  - In `writeJsonArraySync`: scrittura atomica su file temporaneo con `fs.fsyncSync` e sostituzione tramite `fs.renameSync`.
  - In `readJsonArraySync`: distinzione tra file assente (`ENOENT` → `[]`) e file corrotto/non-array (salvataggio backup `.corrupt.<timestamp>.bak` ed errore esplicito gestito con HTTP 500 JSON in `server.js`).
  - Aggiunto mutex per-chiave (`withKeyLock` / `runWithLocks`) e metodi atomici (`updateUsers`, `updateAlbums`, `updatePhotos`, `updateCatalog`) per serializzare tutte le operazioni read-modify-write.
- [x] **Proteggere `SESSION_SECRET` e ampliare `RESERVED_SHARE_SLUGS`**
  - Aggiunti `admin`, `login`, `logout`, `dashboard`, `health`, `auth`, `me`, `media`, `public`, `uploads`, `static`, `favicon` a `RESERVED_SHARE_SLUGS` in `lib/security.js` e `public/script.js`.
  - In `lib/config.js`: blocco fail-fast in produzione (Netlify/Railway/`NODE_ENV=production`) se `SESSION_SECRET` manca o è `< 32` caratteri (salvo `ALLOW_WEAK_SESSION_SECRET=true`), e avviso esplicito in locale/dev.
- [x] **Gestire la revoca Admin stateless**
  - Aggiunti `sessionVersion` e `revokedJtis` persistenti sul record Admin (e `revokedJtis` sugli album cliente) in `lib/store.js` e `lib/apiRouter.js`: il logout singolo revoca il `jti` su tutte le istanze serverless, mentre `POST /api/admin/sessions/revoke-all` (o `POST /api/logout?scope=admin&all=1`) incrementa `sessionVersion` per la revoca globale immediata.

---

### 🟠 Priorità P1 — Performance, Google Drive e Limiti Serverless (Completata ✅)

- [x] **Eliminare la doppia chiamata Google Drive su `/api/media/:driveFileId`**
  - In `lib/drive.js` (`openMediaStream`) i metadati già noti dallo store (`photoMeta`, incluso `thumbnailLink`) vengono riutilizzati evitando la chiamata `GET /drive/v3/files/:id` (con refresh automatico solo se il `thumbnailLink` risulta scaduto).
  - Aggiunto in `lib/apiRouter.js` supporto a `ETag` / `If-None-Match` (`304 Not Modified`, gestito anche senza body in `netlify/functions/api.mjs`), `Cache-Control: private, max-age=86400`, cache LRU in memoria e cache binaria persistente per le miniature (`getCachedThumb`/`setCachedThumb` su `.cache/thumbs/` in locale e store `carlo-portal-thumbs` su Netlify Blobs).
- [x] **Parallelizzare la sincronizzazione Google Drive (`listDriveAlbumsAndPhotos`)**
  - Introdotto `mapWithConcurrency` (`concurrency = 5`) in `lib/drive.js` per scansionare le cartelle in parallelo preservandone l'ordine.
  - Aggiunto in `lib/apiRouter.js` (`POST /api/admin/drive/sync`) fallback di matching 1-a-1 non ambiguo sul nome cartella (`relinkedAlbums`) per preservare `shareToken`, `slideshowEnabled` e credenziali cliente, oltre al mantenimento stabile di `updatedAt` per le foto invariate (`driveModifiedTime`).
- [x] **Ottimizzare l'Editor Fotografico (`photoEditor`)**
  - In `public/script.js`: anteprima live scalata a max `1600px` (`buildScaledSource`) e throttling con `requestAnimationFrame` (`scheduleRender`), lasciando l'elaborazione a risoluzione piena solo in esportazione (`exportBlob`).
  - Introdotto upload binario diretto (`Blob` via `readBinaryBody` in `server.js`, `netlify/functions/api.mjs` e `lib/apiRouter.js` mantenendo il fallback JSON Base64), con compressione progressiva automatica e conferma ridimensionamento su Netlify se il file supera 5.5 MB.

---

### 🟡 Priorità P2 — UX, Hardening e Test Automatici (Completata ✅)

- [x] **Migliorare gli header HTTP di sicurezza (`lib/security.js`)**
  - Aggiunto `Strict-Transport-Security: max-age=31536000; includeSubDomains` condizionato alle sole connessioni HTTPS (`server.js` / `netlify/functions/api.mjs`) e configurato anche su Netlify CDN in `netlify.toml`.
  - Aggiunta `Content-Security-Policy` (`CONTENT_SECURITY_POLICY`) con `script-src 'self'` (rimosso l'unico `onclick` inline in `public/script.js`), Google Fonts, `data:`/`blob:` per Canvas Editor/download e `https://images.unsplash.com`.
- [x] **Rifinire UX Dashboard e Lightbox (`public/script.js`, `public/style.css`)**
  - Separato il click sulla card album in Dashboard Admin (ora filtra soltanto la griglia foto) dal nuovo pulsante esplicito **Apri Slideshow** (`.btn-open-lightbox`).
  - Aggiornato `applyLightboxRotation()` e gli eventi `onload`/`resize`/`fullscreenchange` per adattare dinamicamente scala e ingombro delle foto ruotate di 90°/270° nel Lightbox; preservato il `mimeType` originale (+ `toBlob` e `?v=updatedAt`) in `downloadCurrentLightboxPhoto()`.
  - Rimosso il parametro inutilizzato `{ canDownload: true }` dalle chiamate a `openLightbox()`.
- [x] **Introdurre una suite di test automatici (`node --test`)**
  - Aggiunto `"test": "node --test test/*.test.js"` in `package.json` e create tre suite di test native in `test/` (`security_store.test.js`, `auth_and_share.test.js`, `media_and_sync.test.js`) a copertura di auth, rate limiting, sessioni HMAC, revoca persistente, condivisione cliente, proxy media, sync Google Drive mockata e adapter Netlify.
