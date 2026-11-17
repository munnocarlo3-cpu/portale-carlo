# Carlo Munno Photographer — Portale Gallerie Google Drive

Applicazione web Node.js per la gestione di album fotografici sincronizzati da **Google Drive** (tramite Service Account), sfondo dinamico Ken Burns e condivisione riservata ai clienti tramite link dedicato + credenziali.

## Architettura

- **Unico account Admin (Proprietario)**: configurato tramite `.env` (`ADMIN_EMAIL`, `ADMIN_PASSWORD`), cifrato in `users.json` con `crypto.scryptSync` + salt casuale. Nessuna registrazione pubblica.
- **Sorgente unica Google Drive API v3**:
  - Ogni sottocartella dentro `GOOGLE_DRIVE_ROOT_FOLDER_ID` diventa un **Album** in `albums.json`.
  - Ogni immagine (`JPG`, `PNG`, `WEBP`, `GIF`) diventa una **Foto** in `photos.json`.
- **Proxy Media Sicuro (`GET /api/media/:driveFileId`)**: streamma i file da Google Drive previa verifica della sessione (Admin, Slideshow pubblico, oppure Cliente autorizzato su quel singolo album).
- **Accesso Clienti Isolato (`/?album=<shareToken>` o `/share/<shareToken>`)**: login dedicato per singolo album con username/password, cookie `HttpOnly; SameSite=Lax`, token Bearer e isolamento rigoroso tra album diversi e rotte Admin.

## Configurazione Rapida

1. Installa le dipendenze:
   ```powershell
   npm install
   ```
2. Copia `.env.example` in `.env` e compila tutte le variabili:
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_DRIVE_ROOT_FOLDER_ID`
3. Avvia il server:
   ```powershell
   npm start
   ```
4. Apri `http://localhost:3000`, accedi come Admin e clicca **Sincronizza da Google Drive**.
