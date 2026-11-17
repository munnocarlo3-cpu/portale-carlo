/**
 * Frontend SPA - Carlo Munno Photographer
 * Modalità supportate:
 *  - Admin (/)             : Login proprietario, Sincronizzazione Google Drive, gestione Slideshow e Condivisione Clienti
 *  - Cliente (/?album=...) : Login isolato per singolo album e Galleria/Lightbox con download originali via Proxy sicuro
 */

document.addEventListener('DOMContentLoaded', async () => {
  // === SFONDI PREDEFINITI DI FALLBACK (se nessuno slideshow Drive è attivo) ===
  const DEFAULT_BACKGROUNDS = [
    {
      id: 'bg_def_01',
      originalName: 'Scatto d\'Autore - Tramonto sulle Dolomiti',
      url: 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=1920&q=80'
    },
    {
      id: 'bg_def_02',
      originalName: 'Fotografia Notturna & Luci Urbane',
      url: 'https://images.unsplash.com/photo-1519501025264-65ba15a82390?auto=format&fit=crop&w=1920&q=80'
    },
    {
      id: 'bg_def_03',
      originalName: 'Paesaggio Silvestre & Atmosfera Nebbiosa',
      url: 'https://images.unsplash.com/photo-1448375240586-882707db888b?auto=format&fit=crop&w=1920&q=80'
    },
    {
      id: 'bg_def_04',
      originalName: 'Scatto Costiero & Orizzonte Marino',
      url: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1920&q=80'
    }
  ];

  const RESERVED_SHARE_SLUGS = new Set([
    'api',
    'share',
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

  function normalizeShareSlug(username) {
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

  function isValidClientRouteSlug(val) {
    if (!val || typeof val !== 'string') return false;
    const clean = val.trim();
    if (/^[a-f0-9]{16,128}$/i.test(clean)) return true;
    const lower = clean.toLowerCase();
    return /^[a-z0-9][a-z0-9_-]{1,127}$/.test(lower) && !RESERVED_SHARE_SLUGS.has(lower);
  }

  // Rileva se la pagina è stata aperta tramite link cliente (/<nomecliente>, /share/<token> o /?album=<token>)
  function detectShareTokenFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const queryToken = params.get('album');
    if (queryToken && isValidClientRouteSlug(queryToken)) {
      return queryToken.trim();
    }
    const legacyMatch = window.location.pathname.match(/^\/share\/([^/]+)\/?$/i);
    if (legacyMatch && isValidClientRouteSlug(legacyMatch[1])) {
      return legacyMatch[1];
    }
    const rootSlugMatch = window.location.pathname.match(/^\/([^/]+)\/?$/i);
    if (rootSlugMatch && isValidClientRouteSlug(rootSlugMatch[1])) {
      return rootSlugMatch[1];
    }
    return null;
  }

  const CLIENT_SHARE_TOKEN = detectShareTokenFromUrl();

  // === STATO APPLICAZIONE ===
  const state = {
    viewMode: CLIENT_SHARE_TOKEN ? 'client' : 'admin',
    shareToken: CLIENT_SHARE_TOKEN,
    role: null, // 'admin' | 'client' | null
    token: null,
    adminUser: null,
    driveConfigured: false,
    albums: [],
    photos: [],
    selectedAlbumId: null,
    clientAlbum: null,
    clientPhotos: [],
    activeShareAlbumId: null,
    lastSetClientPassword: '',
    activeLightboxPhoto: null,
    lightboxPhotosList: [],
    lightboxCurrentIndex: 0,
    lightboxRotation: 0,
    isLightboxFullscreen: false
  };

  // === RIFERIMENTI DOM ===
  const dom = {
    // Sfondo Dinamico
    bgSlide1: document.getElementById('bg-slide-1'),
    bgSlide2: document.getElementById('bg-slide-2'),
    bgCurrentName: document.getElementById('bg-current-name'),
    btnBgPrev: document.getElementById('btn-bg-prev'),
    btnBgNext: document.getElementById('btn-bg-next'),
    btnBgTogglePlay: document.getElementById('btn-bg-toggle-play'),
    iconBgPause: document.getElementById('icon-bg-pause'),
    iconBgPlay: document.getElementById('icon-bg-play'),

    // Header & Toast
    toastContainer: document.getElementById('toast-container'),
    statusBadge: document.getElementById('connection-status'),
    statusText: document.getElementById('status-text'),
    btnLogoutHeader: document.getElementById('btn-logout-header'),

    // Vista 1: Login Admin
    adminLoginCard: document.getElementById('admin-login-card'),
    formAdminLogin: document.getElementById('form-admin-login'),
    adminEmail: document.getElementById('admin-email'),
    adminPassword: document.getElementById('admin-password'),
    adminEmailError: document.getElementById('admin-email-error'),
    adminPasswordError: document.getElementById('admin-password-error'),
    adminRememberMe: document.getElementById('admin-remember-me'),
    btnAdminLoginSubmit: document.getElementById('btn-admin-login-submit'),

    // Vista 2: Dashboard Admin
    adminDashboardCard: document.getElementById('admin-dashboard-card'),
    dashAdminAvatar: document.getElementById('dash-admin-avatar'),
    dashAdminName: document.getElementById('dash-admin-name'),
    dashAdminEmail: document.getElementById('dash-admin-email'),
    btnDriveSync: document.getElementById('btn-drive-sync'),
    btnOpenEditorAdmin: document.getElementById('btn-open-editor-admin'),
    btnRefreshAdmin: document.getElementById('btn-refresh-admin'),
    btnLogoutAdmin: document.getElementById('btn-logout-admin'),
    driveConfigWarning: document.getElementById('drive-config-warning'),
    statAlbumsCount: document.getElementById('stat-albums-count'),
    statPhotosCount: document.getElementById('stat-photos-count'),
    statSharedCount: document.getElementById('stat-shared-count'),
    statSlideshowCount: document.getElementById('stat-slideshow-count'),
    adminAlbumsBadge: document.getElementById('admin-albums-badge'),
    adminAlbumChips: document.getElementById('admin-album-chips'),
    adminAlbumsGrid: document.getElementById('admin-albums-grid'),
    adminAlbumsEmpty: document.getElementById('admin-albums-empty'),
    adminGalleryTitle: document.getElementById('admin-gallery-title'),
    adminGalleryCount: document.getElementById('admin-gallery-count'),
    btnOpenAlbumLightbox: document.getElementById('btn-open-album-lightbox'),
    adminGalleryGrid: document.getElementById('admin-gallery-grid'),
    adminGalleryEmpty: document.getElementById('admin-gallery-empty'),

    // Vista 3A: Login Cliente
    clientLoginCard: document.getElementById('client-login-card'),
    clientLoginAlbumName: document.getElementById('client-login-album-name'),
    clientLoginAlbumDesc: document.getElementById('client-login-album-desc'),
    clientUnavailableBox: document.getElementById('client-unavailable-box'),
    clientUnavailableMsg: document.getElementById('client-unavailable-msg'),
    formClientLogin: document.getElementById('form-client-login'),
    clientUsername: document.getElementById('client-username'),
    clientPassword: document.getElementById('client-password'),
    clientUsernameError: document.getElementById('client-username-error'),
    clientPasswordError: document.getElementById('client-password-error'),
    btnClientLoginSubmit: document.getElementById('btn-client-login-submit'),

    // Vista 3B: Galleria Cliente
    clientGalleryCard: document.getElementById('client-gallery-card'),
    clientGalleryTitle: document.getElementById('client-gallery-title'),
    clientGalleryDesc: document.getElementById('client-gallery-desc'),
    clientGalleryCount: document.getElementById('client-gallery-count'),
    btnClientSlideshowOpen: document.getElementById('btn-client-slideshow-open'),
    btnClientLogout: document.getElementById('btn-client-logout'),
    clientGalleryGrid: document.getElementById('client-gallery-grid'),
    clientGalleryEmpty: document.getElementById('client-gallery-empty'),

    // Modale Condivisione Album
    modalShareAlbum: document.getElementById('modal-share-album'),
    btnCloseShareModal: document.getElementById('btn-close-share-modal'),
    btnCancelShareModal: document.getElementById('btn-cancel-share-modal'),
    shareModalAlbumName: document.getElementById('share-modal-album-name'),
    formShareAlbum: document.getElementById('form-share-album'),
    shareEnabledToggle: document.getElementById('share-enabled-toggle'),
    shareClientUsername: document.getElementById('share-client-username'),
    shareClientUsernameError: document.getElementById('share-client-username-error'),
    shareClientPassword: document.getElementById('share-client-password'),
    shareClientPasswordError: document.getElementById('share-client-password-error'),
    btnGenerateClientPwd: document.getElementById('btn-generate-client-pwd'),
    shareRegenerateToken: document.getElementById('share-regenerate-token'),
    shareResultBox: document.getElementById('share-result-box'),
    shareLinkPreview: document.getElementById('share-link-preview'),
    btnCopyShareLink: document.getElementById('btn-copy-share-link'),
    btnCopyShareBundle: document.getElementById('btn-copy-share-bundle'),
    btnSaveShareConfig: document.getElementById('btn-save-share-config'),

    // Lightbox
    modalLightbox: document.getElementById('modal-lightbox'),
    lightboxCardContainer: document.getElementById('lightbox-card-container'),
    lightboxImage: document.getElementById('lightbox-image'),
    lightboxFilename: document.getElementById('lightbox-filename'),
    lightboxInfo: document.getElementById('lightbox-info'),
    lightboxCounterBadge: document.getElementById('lightbox-counter-badge'),
    lightboxRotateLeftBtn: document.getElementById('lightbox-rotate-left-btn'),
    lightboxRotateRightBtn: document.getElementById('lightbox-rotate-right-btn'),
    lightboxFullscreenToggle: document.getElementById('lightbox-fullscreen-toggle'),
    iconEnterFullscreen: document.getElementById('icon-enter-fullscreen'),
    iconExitFullscreen: document.getElementById('icon-exit-fullscreen'),
    lightboxBtnPrev: document.getElementById('lightbox-btn-prev'),
    lightboxBtnNext: document.getElementById('lightbox-btn-next'),
    lightboxEditBtn: document.getElementById('lightbox-edit-btn'),
    lightboxDownloadLink: document.getElementById('lightbox-download-link'),
    btnCloseLightbox: document.getElementById('btn-close-lightbox'),

    // Palette Editor Fotografico (Admin)
    modalPhotoEditor: document.getElementById('modal-photo-editor'),
    btnCloseEditor: document.getElementById('btn-close-editor'),
    editorPhotoSelect: document.getElementById('editor-photo-select'),
    editorCanvas: document.getElementById('photo-editor-canvas'),
    editorPhotoLabel: document.getElementById('editor-photo-label'),
    sliderBrightness: document.getElementById('slider-brightness'),
    valBrightness: document.getElementById('val-brightness'),
    sliderContrast: document.getElementById('slider-contrast'),
    valContrast: document.getElementById('val-contrast'),
    sliderSaturation: document.getElementById('slider-saturation'),
    valSaturation: document.getElementById('val-saturation'),
    sliderSepia: document.getElementById('slider-sepia'),
    valSepia: document.getElementById('val-sepia'),
    sliderBlur: document.getElementById('slider-blur'),
    valBlur: document.getElementById('val-blur'),
    btnRotateLeft: document.getElementById('btn-rotate-left'),
    btnRotateRight: document.getElementById('btn-rotate-right'),
    btnFlipH: document.getElementById('btn-flip-h'),
    btnFlipV: document.getElementById('btn-flip-v'),
    btnResetEditor: document.getElementById('btn-reset-editor'),
    btnDownloadEditedPhoto: document.getElementById('btn-download-edited-photo'),
    btnSaveEditedPhoto: document.getElementById('btn-save-edited-photo')
  };

  // =========================================================================
  // UTILITY DI SICUREZZA, TOAST & FORMATTAZIONE
  // =========================================================================
  function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sanitizeMediaUrl(url) {
    if (!url || typeof url !== 'string') return '';
    const trimmed = url.trim();
    if (trimmed.startsWith('/api/media/') || trimmed.startsWith('https://')) {
      return trimmed.replace(/["'()\\\r\n]/g, '');
    }
    return '';
  }

  function buildMediaUrl(driveFileId, { thumb = false, download = false, version = '' } = {}) {
    if (!driveFileId) return '';
    const params = new URLSearchParams();
    if (thumb) params.set('thumb', '1');
    if (download) params.set('download', '1');
    if (version) params.set('v', String(version));
    const qs = params.toString();
    return `/api/media/${encodeURIComponent(driveFileId)}${qs ? '?' + qs : ''}`;
  }

  function showToast(type, title, message, duration = 4200) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    let iconSvg = '';
    if (type === 'success') {
      iconSvg = '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
    } else if (type === 'error') {
      iconSvg = '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
    } else {
      iconSvg = '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
    }

    toast.innerHTML = `
      ${iconSvg}
      <div class="toast-content">
        <div class="toast-title">${escapeHtml(title)}</div>
        <div class="toast-message">${escapeHtml(message)}</div>
      </div>
    `;

    dom.toastContainer.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 400);
    }, duration);
  }

  function formatFileSize(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }

  function setButtonLoading(btn, isLoading) {
    if (!btn) return;
    btn.classList.toggle('loading', isLoading);
    btn.disabled = isLoading;
  }

  function setError(input, errEl, msg) {
    if (input) input.classList.add('has-error');
    if (errEl) {
      errEl.textContent = msg;
      errEl.classList.add('visible');
    }
  }

  function clearErrors() {
    document.querySelectorAll('.field-error').forEach(el => {
      el.textContent = '';
      el.classList.remove('visible');
    });
    document.querySelectorAll('input').forEach(el => el.classList.remove('has-error'));
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function getAuthHeaders() {
    return state.token ? { Authorization: `Bearer ${state.token}` } : {};
  }

  // =========================================================================
  // GESTORE SFONDO DINAMICO KEN BURNS (ALIMENTATO DA /api/public/slideshow)
  // =========================================================================
  const bgManager = {
    playlist: [...DEFAULT_BACKGROUNDS],
    currentIndex: 0,
    isPlaying: true,
    timer: null,
    activeLayer: 1,

    async init() {
      await this.refreshFromServer();
      this.showSlide(0);
      this.startTimer();
      this.bindEvents();
    },

    async refreshFromServer() {
      try {
        const res = await fetch('/api/public/slideshow');
        if (res.ok) {
          const data = await res.json();
          const items = Array.isArray(data.items) ? data.items : [];
          if (items.length > 0) {
            this.playlist = items.map(item => ({
              id: item.driveFileId,
              originalName: item.albumName ? `${item.albumName} • ${item.originalName}` : item.originalName,
              url: buildMediaUrl(item.driveFileId)
            }));
            this.showSlide(0);
            return;
          }
        }
      } catch {
        // Fallback agli sfondi predefiniti
      }
      this.playlist = [...DEFAULT_BACKGROUNDS];
    },

    showSlide(index) {
      if (!this.playlist.length) return;
      this.currentIndex = (index + this.playlist.length) % this.playlist.length;
      const item = this.playlist[this.currentIndex];

      const currentLayer = this.activeLayer === 1 ? dom.bgSlide1 : dom.bgSlide2;
      const nextLayer = this.activeLayer === 1 ? dom.bgSlide2 : dom.bgSlide1;

      const safeUrl = sanitizeMediaUrl(item.url);
      nextLayer.style.backgroundImage = safeUrl ? `url("${safeUrl}")` : 'none';
      nextLayer.classList.add('active');
      currentLayer.classList.remove('active');

      this.activeLayer = this.activeLayer === 1 ? 2 : 1;
      dom.bgCurrentName.textContent = item.originalName || 'Sfondo Dinamico';
    },

    next() {
      this.showSlide(this.currentIndex + 1);
    },

    prev() {
      this.showSlide(this.currentIndex - 1);
    },

    startTimer() {
      this.clearTimer();
      if (!this.isPlaying) return;
      this.timer = setInterval(() => this.next(), 6500);
    },

    clearTimer() {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    },

    togglePlay() {
      this.isPlaying = !this.isPlaying;
      if (this.isPlaying) {
        dom.iconBgPause.classList.remove('hidden');
        dom.iconBgPlay.classList.add('hidden');
        this.startTimer();
        showToast('info', 'Rotazione Sfondo', 'Riproduzione automatica avviata.');
      } else {
        dom.iconBgPause.classList.add('hidden');
        dom.iconBgPlay.classList.remove('hidden');
        this.clearTimer();
        showToast('info', 'Rotazione Sfondo', 'Rotazione messa in pausa.');
      }
    },

    bindEvents() {
      dom.btnBgNext.addEventListener('click', () => {
        this.next();
        if (this.isPlaying) this.startTimer();
      });
      dom.btnBgPrev.addEventListener('click', () => {
        this.prev();
        if (this.isPlaying) this.startTimer();
      });
      dom.btnBgTogglePlay.addEventListener('click', () => this.togglePlay());
    }
  };

  // =========================================================================
  // GESTIONE VISTE & STORAGE TOKEN SEPARATI PER ADMIN / CLIENTE
  // =========================================================================
  function hideAllMainViews() {
    dom.adminLoginCard.classList.add('hidden');
    dom.adminDashboardCard.classList.add('hidden');
    dom.clientLoginCard.classList.add('hidden');
    dom.clientGalleryCard.classList.add('hidden');
  }

  function saveAdminToken(token, rememberMe) {
    clearAdminToken();
    const storage = rememberMe ? localStorage : sessionStorage;
    storage.setItem('admin_auth_token', token);
  }

  function getStoredAdminToken() {
    return localStorage.getItem('admin_auth_token') || sessionStorage.getItem('admin_auth_token') || '';
  }

  function clearAdminToken() {
    localStorage.removeItem('admin_auth_token');
    sessionStorage.removeItem('admin_auth_token');
  }

  function getClientTokenKey(shareToken) {
    return `client_auth_token_${shareToken}`;
  }

  function saveClientToken(shareToken, token) {
    sessionStorage.setItem(getClientTokenKey(shareToken), token);
  }

  function getStoredClientToken(shareToken) {
    return sessionStorage.getItem(getClientTokenKey(shareToken)) || '';
  }

  function clearClientToken(shareToken) {
    if (shareToken) sessionStorage.removeItem(getClientTokenKey(shareToken));
  }

  // =========================================================================
  // MODALITÀ ADMIN: HEALTH, LOGIN, SYNC GOOGLE DRIVE, SLIDESHOW, CONDIVISIONE
  // =========================================================================
  async function checkBackendHealth() {
    if (state.viewMode !== 'admin') return;
    dom.statusBadge.classList.remove('hidden');
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        const data = await res.json();
        state.driveConfigured = Boolean(data.driveConfigured);
        dom.statusBadge.classList.add('connected');
        dom.statusText.textContent = state.driveConfigured
          ? 'Server & Drive Pronti'
          : 'Server Attivo (Configura .env)';
        if (dom.driveConfigWarning) {
          dom.driveConfigWarning.classList.toggle('hidden', state.driveConfigured);
        }
        return;
      }
    } catch {}
    dom.statusBadge.classList.remove('connected');
    dom.statusText.textContent = 'Backend Offline';
  }

  async function initAdminView() {
    await checkBackendHealth();
    const savedToken = getStoredAdminToken();

    try {
      const res = await fetch('/api/me', {
        headers: savedToken ? { Authorization: `Bearer ${savedToken}` } : {}
      });
      if (res.ok) {
        const data = await res.json();
        if (data.role === 'admin' && data.user) {
          state.role = 'admin';
          state.token = savedToken || null;
          state.adminUser = data.user;
          await showAdminDashboard();
          return;
        }
      }
    } catch {}

    clearAdminToken();
    showAdminLoginView();
  }

  function showAdminLoginView() {
    hideAllMainViews();
    state.role = null;
    state.token = null;
    state.adminUser = null;
    dom.btnLogoutHeader.classList.add('hidden');
    dom.adminLoginCard.classList.remove('hidden');
    clearErrors();
  }

  async function showAdminDashboard() {
    hideAllMainViews();
    dom.adminDashboardCard.classList.remove('hidden');
    dom.btnLogoutHeader.classList.remove('hidden');

    const user = state.adminUser || { name: 'Carlo Munno', email: '' };
    dom.dashAdminName.textContent = user.name || 'Amministratore';
    dom.dashAdminEmail.textContent = user.email || '';
    dom.dashAdminAvatar.textContent = (user.name ? user.name[0] : 'A').toUpperCase();

    await loadAdminData();
  }

  async function loadAdminData() {
    try {
      const [albumsRes, photosRes] = await Promise.all([
        fetch('/api/admin/albums', { headers: getAuthHeaders() }),
        fetch('/api/admin/photos', { headers: getAuthHeaders() })
      ]);

      if (albumsRes.status === 401 || albumsRes.status === 403 || photosRes.status === 401 || photosRes.status === 403) {
        await performAdminLogout({ expired: true });
        return;
      }

      if (albumsRes.ok) {
        const albData = await albumsRes.json();
        state.albums = albData.albums || [];
      }
      if (photosRes.ok) {
        const phData = await photosRes.json();
        state.photos = phData.photos || [];
      }

      if (state.selectedAlbumId && !state.albums.some(a => a.id === state.selectedAlbumId)) {
        state.selectedAlbumId = null;
      }

      renderAdminDashboard();
    } catch (err) {
      showToast('error', 'Errore Caricamento', err.message || 'Impossibile caricare i dati Admin.');
    }
  }

  let albumSlideshowTimer = null;

  function renderAdminDashboard() {
    const sharedCount = state.albums.filter(a => a.shareEnabled).length;
    const slideshowAlbumIds = new Set(state.albums.filter(a => a.slideshowEnabled).map(a => a.id));
    const slideshowPhotosCount = state.photos.filter(p => slideshowAlbumIds.has(p.albumId)).length;

    dom.statAlbumsCount.textContent = `${state.albums.length} album`;
    dom.statPhotosCount.textContent = `${state.photos.length} foto`;
    dom.statSharedCount.textContent = `${sharedCount} attivi`;
    dom.statSlideshowCount.textContent = `${slideshowPhotosCount} foto`;
    dom.adminAlbumsBadge.textContent = `${state.albums.length} album`;

    renderAdminAlbumChips();
    renderAdminAlbumCards();
    renderAdminPhotoGrid();
  }

  function renderAdminAlbumChips() {
    dom.adminAlbumChips.innerHTML = '';

    const allChip = document.createElement('button');
    allChip.type = 'button';
    allChip.className = `album-chip ${state.selectedAlbumId === null ? 'active' : ''}`;
    allChip.innerHTML = `<span>Tutti gli Album</span> <span class="chip-count">${state.photos.length}</span>`;
    allChip.addEventListener('click', () => {
      state.selectedAlbumId = null;
      renderAdminDashboard();
    });
    dom.adminAlbumChips.appendChild(allChip);

    state.albums.forEach(album => {
      const count = state.photos.filter(p => p.albumId === album.id).length;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `album-chip ${state.selectedAlbumId === album.id ? 'active' : ''}`;
      chip.innerHTML = `<span>${escapeHtml(album.name)}</span> <span class="chip-count">${count}</span>`;
      chip.addEventListener('click', () => {
        state.selectedAlbumId = album.id;
        renderAdminDashboard();
      });
      dom.adminAlbumChips.appendChild(chip);
    });
  }

  function renderAdminAlbumCards() {
    dom.adminAlbumsGrid.innerHTML = '';
    if (albumSlideshowTimer) {
      clearInterval(albumSlideshowTimer);
      albumSlideshowTimer = null;
    }

    if (state.albums.length === 0) {
      dom.adminAlbumsEmpty.classList.remove('hidden');
      return;
    }
    dom.adminAlbumsEmpty.classList.add('hidden');

    const controllers = [];

    state.albums.forEach(album => {
      const albumPhotos = state.photos.filter(p => p.albumId === album.id);
      const isActive = state.selectedAlbumId === album.id;

      const card = document.createElement('div');
      card.className = `album-card-item ${isActive ? 'active' : ''}`;

      const preview = document.createElement('div');
      preview.className = 'album-preview-slideshow';

      if (albumPhotos.length === 0) {
        preview.innerHTML = `
          <div class="album-empty-placeholder">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <circle cx="8.5" cy="8.5" r="1.5"/>
              <polyline points="21 15 16 10 5 21"/>
            </svg>
            <span>Cartella vuota su Drive</span>
          </div>
        `;
      } else {
        const badge = document.createElement('div');
        badge.className = 'album-indicator-badge';
        badge.innerHTML = albumPhotos.length > 1
          ? `<span class="live-dot"></span> <span>${albumPhotos.length} foto</span>`
          : '<span>1 foto</span>';
        preview.appendChild(badge);

        const previewSlice = [...albumPhotos]
          .sort((a, b) => Number(Boolean(b.hasThumbnail)) - Number(Boolean(a.hasThumbnail)))
          .slice(0, 6);
        const imgs = previewSlice.map((photo, idx) => {
          const img = document.createElement('img');
          img.className = `album-slide-img ${idx === 0 ? 'active' : ''}`;
          img.src = sanitizeMediaUrl(buildMediaUrl(photo.driveFileId, { thumb: true, version: photo.updatedAt }));
          img.alt = photo.originalName || '';
          img.loading = 'lazy';
          img.onerror = () => {
            img.style.display = 'none';
          };
          preview.appendChild(img);
          return img;
        });

        if (imgs.length > 1) {
          let cur = 0;
          controllers.push({
            next() {
              imgs[cur].classList.remove('active');
              cur = (cur + 1) % imgs.length;
              imgs[cur].classList.add('active');
            }
          });
        }
      }

      const shareBadgeHtml = album.shareEnabled
        ? '<span class="status-pill shared">Condiviso</span>'
        : '<span class="status-pill private">Privato</span>';
      const slideshowBadgeHtml = album.slideshowEnabled
        ? '<span class="status-pill slideshow">Sfondo Home</span>'
        : '';

      const body = document.createElement('div');
      body.className = 'album-card-body';
      body.innerHTML = `
        <div class="album-card-name" title="${escapeHtml(album.name)}">${escapeHtml(album.name)}</div>
        <div class="album-card-desc" title="${escapeHtml(album.description || 'Sincronizzato da Google Drive')}">
          ${escapeHtml(album.description || 'Cartella Google Drive')}
        </div>
        <div class="album-badges-row">
          ${shareBadgeHtml}
          ${slideshowBadgeHtml}
        </div>
        <div class="album-card-actions" onclick="event.stopPropagation()">
          <button type="button" class="btn-album-action btn-share-client" title="Configura link e credenziali per il cliente">
            Condividi con Cliente
          </button>
          <button type="button" class="btn-album-action btn-toggle-slideshow ${album.slideshowEnabled ? 'is-on' : ''}" title="Usa le foto di questo album nello sfondo dinamico">
            ${album.slideshowEnabled ? 'Rimuovi da Sfondo' : 'Usa in Sfondo'}
          </button>
        </div>
      `;

      card.appendChild(preview);
      card.appendChild(body);

      card.addEventListener('click', () => {
        state.selectedAlbumId = album.id;
        renderAdminDashboard();
        if (albumPhotos.length > 0) {
          openLightbox(albumPhotos[0], albumPhotos, { canDownload: true });
        }
      });

      body.querySelector('.btn-share-client').addEventListener('click', () => {
        openShareModal(album);
      });

      body.querySelector('.btn-toggle-slideshow').addEventListener('click', () => {
        toggleAlbumSlideshow(album);
      });

      dom.adminAlbumsGrid.appendChild(card);
    });

    if (controllers.length > 0) {
      albumSlideshowTimer = setInterval(() => {
        controllers.forEach(c => c.next());
      }, 3500);
    }
  }

  function renderAdminPhotoGrid() {
    dom.adminGalleryGrid.innerHTML = '';

    const activeAlbum = state.selectedAlbumId
      ? state.albums.find(a => a.id === state.selectedAlbumId)
      : null;

    const filteredPhotos = activeAlbum
      ? state.photos.filter(p => p.albumId === activeAlbum.id)
      : state.photos;

    dom.adminGalleryTitle.textContent = activeAlbum ? `Album: ${activeAlbum.name}` : 'Tutte le foto';
    dom.adminGalleryCount.textContent = `${filteredPhotos.length} foto`;

    if (dom.btnOpenAlbumLightbox) {
      dom.btnOpenAlbumLightbox.classList.toggle('hidden', filteredPhotos.length === 0);
      dom.btnOpenAlbumLightbox.onclick = () => {
        if (filteredPhotos.length > 0) {
          openLightbox(filteredPhotos[0], filteredPhotos, { canDownload: true });
        }
      };
    }

    if (filteredPhotos.length === 0) {
      dom.adminGalleryEmpty.classList.remove('hidden');
      return;
    }
    dom.adminGalleryEmpty.classList.add('hidden');

    const albumNameById = new Map(state.albums.map(a => [a.id, a.name]));

    filteredPhotos.forEach(photo => {
      const card = buildPhotoCardElement(photo, {
        albumLabel: albumNameById.get(photo.albumId) || '',
        onOpen: () => openLightbox(photo, filteredPhotos, { canDownload: true }),
        onEdit: () => photoEditor.open(photo)
      });
      dom.adminGalleryGrid.appendChild(card);
    });
  }

  function buildPhotoCardElement(photo, { albumLabel = '', onOpen, onEdit = null }) {
    const card = document.createElement('div');
    card.className = 'photo-card';

    const thumbUrl = sanitizeMediaUrl(buildMediaUrl(photo.driveFileId, { thumb: true, version: photo.updatedAt }));
    const downloadUrl = sanitizeMediaUrl(buildMediaUrl(photo.driveFileId, { download: true, version: photo.updatedAt }));
    const formattedDate = photo.uploadedAt ? new Date(photo.uploadedAt).toLocaleDateString('it-IT') : '';

    card.innerHTML = `
      <div class="photo-thumb-wrap">
        <img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(photo.originalName)}" loading="lazy">
        <div class="photo-broken-fallback hidden">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <line x1="3" y1="3" x2="21" y2="21"/>
          </svg>
          <span>Anteprima non disponibile</span>
        </div>
        <div class="photo-overlay">
          ${onEdit ? `
          <button type="button" class="btn-photo-action edit-action" title="Modifica con Palette Editor">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          </button>` : ''}
          <button type="button" class="btn-photo-action zoom-action" title="Visualizza a schermo intero">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          </button>
          <a href="${escapeHtml(downloadUrl)}" download="${escapeHtml(photo.originalName)}" class="btn-photo-action download-action" title="Scarica file originale">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </a>
        </div>
      </div>
      <div class="photo-meta">
        <div class="photo-title" title="${escapeHtml(photo.originalName)}">${escapeHtml(photo.originalName)}</div>
        <div class="photo-subinfo">
          <span>${escapeHtml(formatFileSize(photo.size))}</span>
          <span>${escapeHtml(formattedDate)}</span>
        </div>
        ${albumLabel ? `<span class="photo-album-tag">${escapeHtml(albumLabel)}</span>` : ''}
      </div>
    `;

    const thumbImg = card.querySelector('.photo-thumb-wrap img');
    const brokenFallback = card.querySelector('.photo-broken-fallback');
    thumbImg.onerror = () => {
      thumbImg.classList.add('hidden');
      brokenFallback.classList.remove('hidden');
    };

    card.querySelector('.photo-thumb-wrap').addEventListener('click', onOpen);
    const editBtn = card.querySelector('.edit-action');
    if (editBtn && onEdit) {
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onEdit();
      });
    }
    card.querySelector('.zoom-action').addEventListener('click', (e) => {
      e.stopPropagation();
      onOpen();
    });
    card.querySelector('.download-action').addEventListener('click', (e) => {
      e.stopPropagation();
    });

    return card;
  }

  async function toggleAlbumSlideshow(album) {
    try {
      const res = await fetch(`/api/admin/albums/${encodeURIComponent(album.id)}/slideshow`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify({ slideshowEnabled: !album.slideshowEnabled })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Errore aggiornamento slideshow.');

      const idx = state.albums.findIndex(a => a.id === album.id);
      if (idx !== -1 && data.album) state.albums[idx] = data.album;

      renderAdminDashboard();
      await bgManager.refreshFromServer();
      showToast('success', 'Sfondo Aggiornato', data.message);
    } catch (err) {
      showToast('error', 'Errore Slideshow', err.message);
    }
  }

  // Sincronizzazione Google Drive
  if (dom.btnDriveSync) {
    dom.btnDriveSync.addEventListener('click', async () => {
      setButtonLoading(dom.btnDriveSync, true);
      try {
        const res = await fetch('/api/admin/drive/sync', {
          method: 'POST',
          headers: getAuthHeaders()
        });
        const data = await res.json();
        if (res.status === 401 || res.status === 403) {
          await performAdminLogout({ expired: true });
          return;
        }
        if (!res.ok) throw new Error(data.message || 'Errore sincronizzazione Google Drive.');

        state.albums = data.albums || [];
        state.photos = data.photos || [];
        renderAdminDashboard();
        await bgManager.refreshFromServer();

        const s = data.stats || {};
        showToast(
          'success',
          'Drive Sincronizzato!',
          `Album: +${s.addedAlbums || 0} / agg. ${s.updatedAlbums || 0} / rim. ${s.removedAlbums || 0} • Foto: +${s.addedPhotos || 0} / rim. ${s.removedPhotos || 0}`
        );
      } catch (err) {
        showToast('error', 'Sincronizzazione Fallita', err.message, 6000);
      } finally {
        setButtonLoading(dom.btnDriveSync, false);
      }
    });
  }

  if (dom.btnRefreshAdmin) {
    dom.btnRefreshAdmin.addEventListener('click', async () => {
      await loadAdminData();
      showToast('info', 'Aggiornato', 'Dati sincronizzati dal server.');
    });
  }

  // Login Admin Submit
  dom.formAdminLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();

    const email = dom.adminEmail.value.trim();
    const password = dom.adminPassword.value;
    let valid = true;

    if (!email || !isValidEmail(email)) {
      setError(dom.adminEmail, dom.adminEmailError, 'Inserisci un indirizzo email valido.');
      valid = false;
    }
    if (!password) {
      setError(dom.adminPassword, dom.adminPasswordError, 'Inserisci la password amministratore.');
      valid = false;
    }
    if (!valid) return;

    setButtonLoading(dom.btnAdminLoginSubmit, true);
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          rememberMe: dom.adminRememberMe.checked
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Credenziali non valide.');

      state.role = 'admin';
      state.token = data.token;
      state.adminUser = data.user;
      saveAdminToken(data.token, dom.adminRememberMe.checked);

      showToast('success', 'Accesso Effettuato', `Benvenuto, ${data.user?.name || data.user?.email}`);
      await showAdminDashboard();
    } catch (err) {
      setError(dom.adminPassword, dom.adminPasswordError, err.message);
      showToast('error', 'Accesso Negato', err.message);
    } finally {
      setButtonLoading(dom.btnAdminLoginSubmit, false);
    }
  });

  async function performAdminLogout({ expired = false } = {}) {
    if (state.token && !expired) {
      try {
        await fetch('/api/logout', { method: 'POST', headers: getAuthHeaders() });
      } catch {}
    }
    clearAdminToken();
    state.albums = [];
    state.photos = [];
    state.selectedAlbumId = null;
    dom.adminPassword.value = '';
    showAdminLoginView();
    showToast(
      'info',
      expired ? 'Sessione Scaduta' : 'Disconnesso',
      expired ? 'Effettua nuovamente il login Admin.' : 'Sei uscito dal pannello amministratore.'
    );
  }

  dom.btnLogoutAdmin.addEventListener('click', () => performAdminLogout());

  // =========================================================================
  // MODALE CONDIVISIONE ALBUM CON CLIENTE
  // =========================================================================
  function openShareModal(album) {
    clearErrors();
    state.activeShareAlbumId = album.id;
    state.lastSetClientPassword = '';

    dom.shareModalAlbumName.textContent = `Album: ${album.name}`;
    dom.shareEnabledToggle.checked = Boolean(album.shareEnabled);
    dom.shareClientUsername.value = album.clientUsername || '';
    dom.shareClientPassword.value = '';
    dom.shareRegenerateToken.checked = false;

    const isLegacyRandomToken = /^[a-f0-9]{48}$/i.test(album.shareToken || '');
    const slugFromUser = normalizeShareSlug(album.clientUsername || '');
    const fallbackSlug = !isLegacyRandomToken && album.shareToken ? album.shareToken : slugFromUser;
    const previewUrl = album.shareUrl && !isLegacyRandomToken
      ? album.shareUrl
      : (fallbackSlug ? `${window.location.origin}/${fallbackSlug}` : '');
    dom.shareLinkPreview.value = previewUrl;
    dom.modalShareAlbum.classList.remove('hidden');
  }

  function updateSharePreviewFromUsername() {
    const slug = normalizeShareSlug(dom.shareClientUsername.value);
    dom.shareLinkPreview.value =
      slug && slug.length >= 2 && !RESERVED_SHARE_SLUGS.has(slug)
        ? `${window.location.origin}/${slug}`
        : '';
  }

  dom.shareClientUsername.addEventListener('input', updateSharePreviewFromUsername);

  function closeShareModal() {
    dom.modalShareAlbum.classList.add('hidden');
    state.activeShareAlbumId = null;
  }

  function generateSecurePassword(length = 12) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
    const array = new Uint32Array(length);
    window.crypto.getRandomValues(array);
    let out = '';
    for (let i = 0; i < length; i++) {
      out += chars[array[i] % chars.length];
    }
    return out;
  }

  dom.btnCloseShareModal.addEventListener('click', closeShareModal);
  dom.btnCancelShareModal.addEventListener('click', closeShareModal);
  dom.modalShareAlbum.addEventListener('click', (e) => {
    if (e.target === dom.modalShareAlbum) closeShareModal();
  });

  dom.btnGenerateClientPwd.addEventListener('click', () => {
    dom.shareClientPassword.value = generateSecurePassword(12);
    dom.shareClientPassword.classList.remove('has-error');
    dom.shareClientPasswordError.textContent = '';
    dom.shareClientPasswordError.classList.remove('visible');
  });

  dom.formShareAlbum.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();
    if (!state.activeShareAlbumId) return;

    const shareEnabled = dom.shareEnabledToggle.checked;
    const clientUsername = dom.shareClientUsername.value.trim();
    const clientPassword = dom.shareClientPassword.value;
    const regenerateToken = dom.shareRegenerateToken.checked;
    const existingAlbum = state.albums.find(a => a.id === state.activeShareAlbumId);

    if (shareEnabled) {
      if (!clientUsername || clientUsername.length < 2) {
        setError(dom.shareClientUsername, dom.shareClientUsernameError, 'Inserisci uno username cliente (minimo 2 caratteri).');
        return;
      }
      if (!clientPassword && !existingAlbum?.hasClientPassword) {
        setError(dom.shareClientPassword, dom.shareClientPasswordError, 'Imposta una password iniziale per il cliente (minimo 6 caratteri).');
        return;
      }
    }
    if (clientPassword && clientPassword.length < 6) {
      setError(dom.shareClientPassword, dom.shareClientPasswordError, 'La password deve avere almeno 6 caratteri.');
      return;
    }

    setButtonLoading(dom.btnSaveShareConfig, true);
    try {
      const res = await fetch(`/api/admin/albums/${encodeURIComponent(state.activeShareAlbumId)}/share`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify({
          shareEnabled,
          clientUsername,
          clientPassword: clientPassword || undefined,
          regenerateToken
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Errore salvataggio condivisione.');

      const idx = state.albums.findIndex(a => a.id === state.activeShareAlbumId);
      if (idx !== -1 && data.album) {
        state.albums[idx] = data.album;
      }

      if (clientPassword) {
        state.lastSetClientPassword = clientPassword;
      }

      dom.shareLinkPreview.value = data.shareUrl || '';
      dom.shareRegenerateToken.checked = false;
      renderAdminDashboard();
      showToast('success', 'Condivisione Salvata', data.message);
    } catch (err) {
      showToast('error', 'Errore Condivisione', err.message);
    } finally {
      setButtonLoading(dom.btnSaveShareConfig, false);
    }
  });

  async function copyToClipboard(text, successMsg) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showToast('success', 'Copiato negli Appunti', successMsg);
    } catch {
      showToast('error', 'Copia non riuscita', 'Copia manualmente il testo selezionato.');
    }
  }

  dom.btnCopyShareLink.addEventListener('click', () => {
    copyToClipboard(dom.shareLinkPreview.value, 'Link diretto cliente copiato.');
  });

  dom.btnCopyShareBundle.addEventListener('click', () => {
    const album = state.albums.find(a => a.id === state.activeShareAlbumId);
    const link = dom.shareLinkPreview.value;
    const username = dom.shareClientUsername.value.trim();
    const pwd = dom.shareClientPassword.value || state.lastSetClientPassword || '(password impostata in precedenza)';
    const msg = [
      `📸 Galleria Fotografica Riservata - ${album ? album.name : 'Carlo Munno Photographer'}`,
      `🔗 Link: ${link}`,
      `👤 Username: ${username}`,
      `🔑 Password: ${pwd}`
    ].join('\n');
    copyToClipboard(msg, 'Messaggio con link e credenziali pronto da inviare.');
  });

  // =========================================================================
  // MODALITÀ CLIENTE: /?album=<shareToken> O /share/<shareToken>
  // =========================================================================
  async function initClientView() {
    hideAllMainViews();
    // Nasconde completamente il badge di stato backend Admin in vista cliente
    dom.statusBadge.classList.add('hidden');
    dom.btnLogoutHeader.classList.add('hidden');

    const shareToken = state.shareToken;
    try {
      const metaRes = await fetch(`/api/share/${encodeURIComponent(shareToken)}/meta`);
      const meta = await metaRes.json();

      if (!metaRes.ok || !meta.active) {
        showClientUnavailable(meta.albumName || 'Galleria Riservata', meta.message);
        return;
      }

      dom.clientLoginAlbumName.textContent = meta.albumName || 'Galleria Riservata';
      dom.clientLoginAlbumDesc.textContent =
        meta.description || 'Inserisci le credenziali ricevute per accedere ai tuoi scatti.';
      dom.clientUnavailableBox.classList.add('hidden');
      dom.formClientLogin.classList.remove('hidden');

      const savedToken = getStoredClientToken(shareToken);
      const meRes = await fetch('/api/me', {
        headers: savedToken ? { Authorization: `Bearer ${savedToken}` } : {}
      });
      if (meRes.ok) {
        const me = await meRes.json();
        if (me.role === 'client' && String(me.shareToken || '').toLowerCase() === shareToken.toLowerCase()) {
          state.role = 'client';
          state.token = savedToken || null;
          await loadClientGallery();
          return;
        }
      }

      clearClientToken(shareToken);
      dom.clientLoginCard.classList.remove('hidden');
    } catch {
      showClientUnavailable('Errore di Connessione', 'Impossibile verificare la galleria in questo momento.');
    }
  }

  function showClientUnavailable(title, message) {
    hideAllMainViews();
    dom.clientLoginAlbumName.textContent = title;
    dom.clientLoginAlbumDesc.textContent = '';
    dom.formClientLogin.classList.add('hidden');
    dom.clientUnavailableMsg.textContent =
      message || 'Questo link non è attivo o è stato revocato dal fotografo.';
    dom.clientUnavailableBox.classList.remove('hidden');
    dom.clientLoginCard.classList.remove('hidden');
  }

  dom.formClientLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();

    const username = dom.clientUsername.value.trim();
    const password = dom.clientPassword.value;
    let valid = true;

    if (!username) {
      setError(dom.clientUsername, dom.clientUsernameError, 'Inserisci lo username dell\'album.');
      valid = false;
    }
    if (!password) {
      setError(dom.clientPassword, dom.clientPasswordError, 'Inserisci la password dell\'album.');
      valid = false;
    }
    if (!valid) return;

    setButtonLoading(dom.btnClientLoginSubmit, true);
    try {
      const res = await fetch(`/api/share/${encodeURIComponent(state.shareToken)}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Credenziali non valide.');

      state.role = 'client';
      state.token = data.token;
      state.clientAlbum = data.album;
      saveClientToken(state.shareToken, data.token);

      showToast('success', 'Accesso Consentito', data.message);
      await loadClientGallery();
    } catch (err) {
      setError(dom.clientPassword, dom.clientPasswordError, err.message);
      showToast('error', 'Accesso Negato', err.message);
    } finally {
      setButtonLoading(dom.btnClientLoginSubmit, false);
    }
  });

  async function loadClientGallery() {
    try {
      const res = await fetch(`/api/share/${encodeURIComponent(state.shareToken)}/photos`, {
        headers: getAuthHeaders()
      });
      if (res.status === 401 || res.status === 403) {
        await performClientLogout({ expired: true });
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Impossibile caricare la galleria.');

      state.clientAlbum = data.album;
      state.clientPhotos = data.photos || [];

      hideAllMainViews();
      dom.clientGalleryCard.classList.remove('hidden');
      dom.btnLogoutHeader.classList.remove('hidden');

      dom.clientGalleryTitle.textContent = state.clientAlbum?.name || 'Galleria Riservata';
      dom.clientGalleryDesc.textContent =
        state.clientAlbum?.description || 'Clicca su una foto per aprirla a schermo intero o scaricare il file originale.';
      dom.clientGalleryCount.textContent = `${state.clientPhotos.length} foto`;

      renderClientPhotoGrid();
    } catch (err) {
      showToast('error', 'Errore Galleria', err.message);
    }
  }

  function renderClientPhotoGrid() {
    dom.clientGalleryGrid.innerHTML = '';

    if (dom.btnClientSlideshowOpen) {
      dom.btnClientSlideshowOpen.classList.toggle('hidden', state.clientPhotos.length === 0);
    }

    if (state.clientPhotos.length === 0) {
      dom.clientGalleryEmpty.classList.remove('hidden');
      return;
    }
    dom.clientGalleryEmpty.classList.add('hidden');

    state.clientPhotos.forEach(photo => {
      const card = buildPhotoCardElement(photo, {
        onOpen: () => openLightbox(photo, state.clientPhotos, { canDownload: true })
      });
      dom.clientGalleryGrid.appendChild(card);
    });
  }

  if (dom.btnClientSlideshowOpen) {
    dom.btnClientSlideshowOpen.addEventListener('click', () => {
      if (state.clientPhotos.length > 0) {
        openLightbox(state.clientPhotos[0], state.clientPhotos, { canDownload: true });
      }
    });
  }

  async function performClientLogout({ expired = false } = {}) {
    if (state.token && !expired) {
      try {
        await fetch('/api/logout', { method: 'POST', headers: getAuthHeaders() });
      } catch {}
    }
    clearClientToken(state.shareToken);
    state.role = null;
    state.token = null;
    state.clientPhotos = [];
    dom.clientPassword.value = '';
    dom.btnLogoutHeader.classList.add('hidden');
    hideAllMainViews();
    dom.clientLoginCard.classList.remove('hidden');
    showToast(
      'info',
      expired ? 'Sessione Scaduta' : 'Disconnesso',
      expired ? 'Inserisci nuovamente le credenziali della galleria.' : 'Sei uscito dalla galleria riservata.'
    );
  }

  dom.btnClientLogout.addEventListener('click', () => performClientLogout());

  // Header Logout condiviso in base al ruolo attivo
  dom.btnLogoutHeader.addEventListener('click', () => {
    if (state.viewMode === 'client') {
      performClientLogout();
    } else {
      performAdminLogout();
    }
  });

  // =========================================================================
  // LIGHTBOX A SCHERMO INTERO CON ROTAZIONE & DOWNLOAD ORIGINALE
  // =========================================================================
  function openLightbox(photo, photoList = null) {
    if (!photo) return;
    state.activeLightboxPhoto = photo;
    state.lightboxPhotosList = (photoList && photoList.length > 0) ? photoList : [photo];
    const idx = state.lightboxPhotosList.findIndex(p => p.driveFileId === photo.driveFileId);
    state.lightboxCurrentIndex = idx !== -1 ? idx : 0;
    state.lightboxRotation = 0;

    updateLightboxView();
    dom.modalLightbox.classList.remove('hidden');
  }

  function updateLightboxView() {
    const photo = state.lightboxPhotosList[state.lightboxCurrentIndex] || state.activeLightboxPhoto;
    if (!photo) return;
    state.activeLightboxPhoto = photo;
    state.lightboxRotation = 0;

    const fullUrl = sanitizeMediaUrl(buildMediaUrl(photo.driveFileId, { version: photo.updatedAt }));
    const downloadUrl = sanitizeMediaUrl(buildMediaUrl(photo.driveFileId, { download: true, version: photo.updatedAt }));

    if (dom.lightboxEditBtn) {
      const canEdit = state.viewMode === 'admin' && state.role === 'admin';
      dom.lightboxEditBtn.classList.toggle('hidden', !canEdit);
    }

    dom.lightboxImage.onerror = () => {
      showToast('error', 'File non visualizzabile', `"${photo.originalName || 'Immagine'}" risulta corrotto o in un formato non leggibile dal browser.`);
    };
    dom.lightboxImage.src = fullUrl;
    dom.lightboxImage.alt = photo.originalName || 'Foto';
    applyLightboxRotation();

    dom.lightboxFilename.textContent = photo.originalName || 'foto.jpg';
    const albumName =
      state.viewMode === 'client'
        ? (state.clientAlbum?.name || 'Galleria')
        : (state.albums.find(a => a.id === photo.albumId)?.name || 'Album');
    const dateStr = photo.uploadedAt ? new Date(photo.uploadedAt).toLocaleDateString('it-IT') : '';
    dom.lightboxInfo.textContent = `${formatFileSize(photo.size)} • ${albumName}${dateStr ? ' • ' + dateStr : ''}`;

    dom.lightboxCounterBadge.textContent = `${state.lightboxCurrentIndex + 1} di ${state.lightboxPhotosList.length}`;
    dom.lightboxBtnPrev.style.display = state.lightboxPhotosList.length > 1 ? 'flex' : 'none';
    dom.lightboxBtnNext.style.display = state.lightboxPhotosList.length > 1 ? 'flex' : 'none';

    dom.lightboxDownloadLink.href = downloadUrl || '#';
    dom.lightboxDownloadLink.download = photo.originalName || 'foto.jpg';
  }

  function applyLightboxRotation() {
    dom.lightboxImage.style.transform = `rotate(${state.lightboxRotation}deg)`;
  }

  function rotateLightboxPhoto(delta) {
    state.lightboxRotation = (state.lightboxRotation + delta) % 360;
    applyLightboxRotation();
  }

  function prevLightboxPhoto() {
    if (state.lightboxPhotosList.length <= 1) return;
    state.lightboxCurrentIndex = (state.lightboxCurrentIndex - 1 + state.lightboxPhotosList.length) % state.lightboxPhotosList.length;
    updateLightboxView();
  }

  function nextLightboxPhoto() {
    if (state.lightboxPhotosList.length <= 1) return;
    state.lightboxCurrentIndex = (state.lightboxCurrentIndex + 1) % state.lightboxPhotosList.length;
    updateLightboxView();
  }

  function toggleLightboxFullscreen() {
    state.isLightboxFullscreen = !state.isLightboxFullscreen;
    dom.lightboxCardContainer.classList.toggle('fullscreen-mode', state.isLightboxFullscreen);
    dom.iconEnterFullscreen.classList.toggle('hidden', state.isLightboxFullscreen);
    dom.iconExitFullscreen.classList.toggle('hidden', !state.isLightboxFullscreen);

    if (state.isLightboxFullscreen) {
      if (dom.modalLightbox.requestFullscreen) {
        dom.modalLightbox.requestFullscreen().catch(() => {});
      }
    } else if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
  }

  function downloadCurrentLightboxPhoto(e) {
    const photo = state.activeLightboxPhoto;
    if (!photo) return;
    if (state.lightboxRotation === 0) {
      // Lascia procedere il download nativo verso /api/media/:driveFileId?download=1
      return;
    }

    e.preventDefault();
    const tempImg = new Image();
    tempImg.crossOrigin = 'anonymous';
    tempImg.onload = () => {
      const tempCanvas = document.createElement('canvas');
      const rot = (state.lightboxRotation + 360) % 360;
      const isSideways = (rot === 90 || rot === 270);
      tempCanvas.width = isSideways ? tempImg.naturalHeight : tempImg.naturalWidth;
      tempCanvas.height = isSideways ? tempImg.naturalWidth : tempImg.naturalHeight;

      const ctx = tempCanvas.getContext('2d');
      ctx.translate(tempCanvas.width / 2, tempCanvas.height / 2);
      ctx.rotate((rot * Math.PI) / 180);
      ctx.drawImage(tempImg, -tempImg.naturalWidth / 2, -tempImg.naturalHeight / 2);

      const link = document.createElement('a');
      link.download = `ruotata_${photo.originalName || 'foto.jpg'}`;
      try {
        link.href = tempCanvas.toDataURL('image/jpeg', 0.95);
      } catch {
        showToast('error', 'Download Bloccato', 'Impossibile esportare la versione ruotata.');
        return;
      }
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showToast('success', 'Download Avviato', `Scaricata versione ruotata di "${photo.originalName}".`);
    };
    tempImg.onerror = () => {
      showToast('error', 'Errore Download', 'Impossibile scaricare l\'immagine ruotata.');
    };
    tempImg.src = sanitizeMediaUrl(buildMediaUrl(photo.driveFileId));
  }

  function closeLightbox() {
    dom.modalLightbox.classList.add('hidden');
    state.activeLightboxPhoto = null;
    state.lightboxPhotosList = [];
    state.lightboxRotation = 0;
    if (state.isLightboxFullscreen) {
      toggleLightboxFullscreen();
    }
    dom.lightboxImage.onerror = null;
    dom.lightboxImage.removeAttribute('src');
    dom.lightboxImage.style.transform = 'none';
  }

  dom.lightboxRotateLeftBtn.addEventListener('click', () => rotateLightboxPhoto(-90));
  dom.lightboxRotateRightBtn.addEventListener('click', () => rotateLightboxPhoto(90));
  dom.lightboxFullscreenToggle.addEventListener('click', toggleLightboxFullscreen);
  dom.lightboxBtnPrev.addEventListener('click', prevLightboxPhoto);
  dom.lightboxBtnNext.addEventListener('click', nextLightboxPhoto);
  dom.lightboxDownloadLink.addEventListener('click', downloadCurrentLightboxPhoto);
  dom.btnCloseLightbox.addEventListener('click', closeLightbox);
  dom.modalLightbox.addEventListener('click', (e) => {
    if (e.target === dom.modalLightbox) closeLightbox();
  });

  document.addEventListener('fullscreenchange', () => {
    const isNowFullscreen = Boolean(document.fullscreenElement);
    state.isLightboxFullscreen = isNowFullscreen;
    dom.lightboxCardContainer.classList.toggle('fullscreen-mode', isNowFullscreen);
    dom.iconEnterFullscreen.classList.toggle('hidden', isNowFullscreen);
    dom.iconExitFullscreen.classList.toggle('hidden', !isNowFullscreen);
  });

  if (dom.lightboxEditBtn) {
    dom.lightboxEditBtn.addEventListener('click', () => {
      if (state.viewMode !== 'admin' || state.role !== 'admin' || !state.activeLightboxPhoto) return;
      const targetPhoto = state.activeLightboxPhoto;
      closeLightbox();
      photoEditor.open(targetPhoto);
    });
  }

  // =========================================================================
  // PALETTE EDITOR FOTOGRAFICO (SOLO ADMIN - CANVAS 2D)
  // =========================================================================
  const photoEditor = {
    activePhoto: null,
    imageObj: null,
    rotation: 0,
    flipH: 1,
    flipV: 1,
    brightness: 100,
    contrast: 100,
    saturation: 100,
    sepia: 0,
    blur: 0,
    preset: 'normal',

    init() {
      if (!dom.modalPhotoEditor) return;

      dom.btnCloseEditor.addEventListener('click', () => this.close());
      dom.modalPhotoEditor.addEventListener('click', (e) => {
        if (e.target === dom.modalPhotoEditor) this.close();
      });

      if (dom.btnOpenEditorAdmin) {
        dom.btnOpenEditorAdmin.addEventListener('click', () => {
          const candidates = state.selectedAlbumId
            ? state.photos.filter(p => p.albumId === state.selectedAlbumId)
            : state.photos;
          const preferred = candidates.find(p => p.hasThumbnail) || candidates[0] || state.photos[0];
          if (!preferred) {
            showToast('info', 'Nessuna Foto', 'Sincronizza prima almeno una foto da Google Drive.');
            return;
          }
          this.open(preferred);
        });
      }

      dom.editorPhotoSelect.addEventListener('change', () => {
        const chosen = state.photos.find(p => p.id === dom.editorPhotoSelect.value);
        if (chosen) this.loadPhoto(chosen);
      });

      dom.sliderBrightness.addEventListener('input', (e) => {
        this.brightness = Number(e.target.value);
        dom.valBrightness.textContent = `${this.brightness}%`;
        this.render();
      });
      dom.sliderContrast.addEventListener('input', (e) => {
        this.contrast = Number(e.target.value);
        dom.valContrast.textContent = `${this.contrast}%`;
        this.render();
      });
      dom.sliderSaturation.addEventListener('input', (e) => {
        this.saturation = Number(e.target.value);
        dom.valSaturation.textContent = `${this.saturation}%`;
        this.render();
      });
      dom.sliderSepia.addEventListener('input', (e) => {
        this.sepia = Number(e.target.value);
        dom.valSepia.textContent = `${this.sepia}%`;
        this.render();
      });
      dom.sliderBlur.addEventListener('input', (e) => {
        this.blur = Number(e.target.value);
        dom.valBlur.textContent = `${this.blur}px`;
        this.render();
      });

      document.querySelectorAll('#modal-photo-editor .btn-preset').forEach(btn => {
        btn.addEventListener('click', () => this.applyPreset(btn.dataset.preset));
      });

      dom.btnRotateLeft.addEventListener('click', () => {
        this.rotation = (this.rotation - 90) % 360;
        this.render();
      });
      dom.btnRotateRight.addEventListener('click', () => {
        this.rotation = (this.rotation + 90) % 360;
        this.render();
      });
      dom.btnFlipH.addEventListener('click', () => {
        this.flipH *= -1;
        this.render();
      });
      dom.btnFlipV.addEventListener('click', () => {
        this.flipV *= -1;
        this.render();
      });
      dom.btnResetEditor.addEventListener('click', () => {
        this.resetAdjustments();
        this.render();
      });
      dom.btnDownloadEditedPhoto.addEventListener('click', () => this.downloadCopy());
      dom.btnSaveEditedPhoto.addEventListener('click', () => this.saveToDrive());
    },

    open(photo) {
      if (state.viewMode !== 'admin' || state.role !== 'admin' || !photo) return;
      this.populatePhotoSelector(photo.id);
      dom.modalPhotoEditor.classList.remove('hidden');
      this.loadPhoto(photo);
    },

    close() {
      dom.modalPhotoEditor.classList.add('hidden');
    },

    populatePhotoSelector(selectedId) {
      const albumNames = new Map(state.albums.map(a => [a.id, a.name]));
      dom.editorPhotoSelect.innerHTML = state.photos
        .map(p => {
          const alb = albumNames.get(p.albumId) || 'Album';
          return `<option value="${escapeHtml(p.id)}">${escapeHtml(alb)} — ${escapeHtml(p.originalName)}</option>`;
        })
        .join('');
      if (selectedId) dom.editorPhotoSelect.value = selectedId;
    },

    loadPhoto(photo) {
      this.activePhoto = photo;
      this.imageObj = null;
      dom.editorPhotoLabel.textContent = `Caricamento di "${photo.originalName}"...`;

      const ctx = dom.editorCanvas.getContext('2d');
      ctx.clearRect(0, 0, dom.editorCanvas.width, dom.editorCanvas.height);

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        this.imageObj = img;
        this.resetAdjustments();
        this.render();
        dom.editorPhotoLabel.textContent = `Modifica: ${photo.originalName} (${img.naturalWidth}×${img.naturalHeight}px)`;
      };
      img.onerror = () => {
        dom.editorPhotoLabel.textContent = `Impossibile decodificare "${photo.originalName}"`;
        showToast('error', 'File non modificabile', `"${photo.originalName}" risulta corrotto o illeggibile.`);
      };
      img.src = sanitizeMediaUrl(buildMediaUrl(photo.driveFileId, { version: photo.updatedAt }));
    },

    resetAdjustments() {
      this.rotation = 0;
      this.flipH = 1;
      this.flipV = 1;
      this.brightness = 100;
      this.contrast = 100;
      this.saturation = 100;
      this.sepia = 0;
      this.blur = 0;
      this.preset = 'normal';
      this.syncInputs();
    },

    syncInputs() {
      dom.sliderBrightness.value = this.brightness;
      dom.valBrightness.textContent = `${this.brightness}%`;
      dom.sliderContrast.value = this.contrast;
      dom.valContrast.textContent = `${this.contrast}%`;
      dom.sliderSaturation.value = this.saturation;
      dom.valSaturation.textContent = `${this.saturation}%`;
      dom.sliderSepia.value = this.sepia;
      dom.valSepia.textContent = `${this.sepia}%`;
      dom.sliderBlur.value = this.blur;
      dom.valBlur.textContent = `${this.blur}px`;

      document.querySelectorAll('#modal-photo-editor .btn-preset').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.preset === this.preset);
      });
    },

    applyPreset(presetName) {
      this.preset = presetName;
      switch (presetName) {
        case 'normal':
          this.brightness = 100; this.contrast = 100; this.saturation = 100; this.sepia = 0; this.blur = 0;
          break;
        case 'vivid':
          this.brightness = 105; this.contrast = 125; this.saturation = 150; this.sepia = 0;
          break;
        case 'bw':
          this.brightness = 100; this.contrast = 120; this.saturation = 0; this.sepia = 0;
          break;
        case 'vintage':
          this.brightness = 95; this.contrast = 90; this.saturation = 80; this.sepia = 50;
          break;
        case 'warm':
          this.brightness = 105; this.contrast = 105; this.saturation = 120; this.sepia = 25;
          break;
        case 'cyber':
          this.brightness = 110; this.contrast = 135; this.saturation = 170; this.sepia = 0;
          break;
      }
      this.syncInputs();
      this.render();
    },

    render() {
      if (!this.imageObj) return;
      const canvas = dom.editorCanvas;
      const ctx = canvas.getContext('2d');
      const img = this.imageObj;

      const isSideways = (Math.abs(this.rotation) % 180 !== 0);
      canvas.width = isSideways ? img.naturalHeight : img.naturalWidth;
      canvas.height = isSideways ? img.naturalWidth : img.naturalHeight;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((this.rotation * Math.PI) / 180);
      ctx.scale(this.flipH, this.flipV);
      ctx.filter = `brightness(${this.brightness}%) contrast(${this.contrast}%) saturate(${this.saturation}%) sepia(${this.sepia}%) blur(${this.blur}px)`;
      ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
      ctx.restore();
    },

    exportDataUrl() {
      if (!this.activePhoto || !this.imageObj) return null;
      const exportMime = ['image/png', 'image/webp'].includes(this.activePhoto.mimeType)
        ? this.activePhoto.mimeType
        : 'image/jpeg';
      return dom.editorCanvas.toDataURL(exportMime, 0.92);
    },

    downloadCopy() {
      if (!this.activePhoto || !this.imageObj) {
        showToast('error', 'Nessuna Foto', 'Carica prima una foto valida nell\'editor.');
        return;
      }
      try {
        const dataUrl = this.exportDataUrl();
        const link = document.createElement('a');
        link.download = `modificata_${this.activePhoto.originalName || 'foto.jpg'}`;
        link.href = dataUrl;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        showToast('success', 'Copia Scaricata', `"${link.download}" salvata sul dispositivo.`);
      } catch (err) {
        showToast('error', 'Errore Esportazione', err.message || 'Impossibile esportare l\'immagine.');
      }
    },

    async saveToDrive() {
      if (!this.activePhoto || !this.imageObj) {
        showToast('error', 'Nessuna Foto', 'Seleziona prima una foto valida da salvare.');
        return;
      }

      setButtonLoading(dom.btnSaveEditedPhoto, true);
      try {
        const base64 = this.exportDataUrl();
        const res = await fetch(`/api/admin/photos/${encodeURIComponent(this.activePhoto.id)}/save`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders()
          },
          body: JSON.stringify({ base64 })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Errore salvataggio su Google Drive.');

        if (data.photo) {
          const idx = state.photos.findIndex(p => p.id === data.photo.id);
          if (idx !== -1) state.photos[idx] = data.photo;
          this.activePhoto = data.photo;
        }

        renderAdminDashboard();
        await bgManager.refreshFromServer();
        showToast('success', 'Salvata su Drive!', data.message);
      } catch (err) {
        showToast('error', 'Salvataggio su Drive', err.message, 6000);
      } finally {
        setButtonLoading(dom.btnSaveEditedPhoto, false);
      }
    }
  };

  window.addEventListener('keydown', (e) => {
    if (!dom.modalLightbox.classList.contains('hidden')) {
      if (e.key === 'ArrowLeft') prevLightboxPhoto();
      else if (e.key === 'ArrowRight') nextLightboxPhoto();
      else if (e.key === 'f' || e.key === 'F') toggleLightboxFullscreen();
      else if (e.key === 'r' || e.key === 'R') rotateLightboxPhoto(90);
      else if (e.key === 'Escape') closeLightbox();
      return;
    }
    if (e.key === 'Escape' && dom.modalPhotoEditor && !dom.modalPhotoEditor.classList.contains('hidden')) {
      photoEditor.close();
      return;
    }
    if (e.key === 'Escape' && !dom.modalShareAlbum.classList.contains('hidden')) {
      closeShareModal();
    }
  });

  // =========================================================================
  // TOGGLE PASSWORD & PULIZIA ERRORI INPUT
  // =========================================================================
  document.querySelectorAll('.toggle-password').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      const isPwd = input.type === 'password';
      input.type = isPwd ? 'text' : 'password';
      btn.classList.toggle('showing', isPwd);
    });
  });

  [
    dom.adminEmail,
    dom.adminPassword,
    dom.clientUsername,
    dom.clientPassword,
    dom.shareClientUsername,
    dom.shareClientPassword
  ].forEach(inp => {
    if (!inp) return;
    inp.addEventListener('input', () => {
      inp.classList.remove('has-error');
      const err = document.getElementById(`${inp.id}-error`);
      if (err) {
        err.textContent = '';
        err.classList.remove('visible');
      }
    });
  });

  // =========================================================================
  // AVVIO APPLICAZIONE
  // =========================================================================
  photoEditor.init();
  await bgManager.init();
  if (state.viewMode === 'client') {
    await initClientView();
  } else {
    await initAdminView();
  }
});
