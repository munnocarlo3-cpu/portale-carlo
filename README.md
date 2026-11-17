# Carlo Munno Photographer — Portale Gallerie Google Drive

Applicazione web Node.js pronta sia per l'esecuzione **locale / Railway / VPS** che per il deploy serverless su **Netlify** (Netlify Functions v2 + Netlify Blobs).

## Architettura

- **Frontend statico (`public/`)**: `index.html`, `style.css`, `script.js` serviti su CDN (o da `server.js` in locale).
- **Unico account Admin (Proprietario)**: configurato tramite variabili d'ambiente (`ADMIN_EMAIL`, `ADMIN_PASSWORD`), cifrato con `crypto.scryptSync`. Nessuna registrazione pubblica.
- **Google Drive API v3**:
  - Ogni sottocartella dentro `GOOGLE_DRIVE_ROOT_FOLDER_ID` diventa un **Album**.
  - Ogni immagine (`JPG`, `PNG`, `WEBP`, `GIF`) diventa una **Foto**.
- **Persistenza Dual-Mode (`lib/store.js`)**:
  - **Netlify**: utilizza **Netlify Blobs** (`@netlify/blobs` con `consistency: 'strong'`).
  - **Locale / Railway / VPS**: utilizza file JSON (`DATA_DIR` o root progetto).
- **Sessioni Stateless HMAC-SHA256 (`lib/security.js`)**: cookie `HttpOnly; SameSite=Lax` + Bearer token compatibili con ambienti serverless multi-istanza e con revoca istantanea per singolo album cliente (`clientSessionVersion`).
- **Palette Editor Fotografico (solo Admin)**: filtri rapidi, regolazioni colore, rotazione/riflessione su Canvas 2D con esportazione locale o aggiornamento su Drive (richiede permesso Editor sul Service Account).

---

## Deploy su Netlify (Gratis)

1. Collega il repository GitHub **`munnocarlo3-cpu/portale-carlo`** su Netlify (**Add new site → Import an existing project**).
2. Le impostazioni di build vengono lette automaticamente da `netlify.toml` (`publish = "public"`, `functions = "netlify/functions"`).
3. In **Site configuration → Environment variables** imposta:
   - `ADMIN_EMAIL`
   - `ADMIN_PASSWORD` *(usa una password robusta diversa da quella dei test locali)*
   - `ADMIN_NAME` (`Carlo Munno Photographer`)
   - `SESSION_SECRET` *(stringa casuale lunga almeno 32 caratteri)*
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `GOOGLE_PRIVATE_KEY` *(consigliato rigenerare una nuova chiave su Google Cloud prima di andare online)*
   - `GOOGLE_DRIVE_ROOT_FOLDER_ID`
4. Esegui il deploy, apri il sito, accedi come Admin e premi **Sincronizza da Google Drive**.

> **Nota sui file molto grandi su Netlify**: Netlify Functions v2 supporta risposte streaming fino a ~20 MB (e body JSON in ingresso fino a ~6 MB). Le miniature della griglia (`?thumb=1`) pesano pochi KB e sono sempre fluide; per salvare direttamente da Editor foto molto pesanti su Drive conviene usare **Scarica Copia**.

---

## Avvio in Locale

```powershell
npm install
copy .env.example .env
npm start
```
Poi apri `http://localhost:3000`.
