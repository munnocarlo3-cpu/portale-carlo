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

  const nowInit = new Date();
  const todayIsoInit = `${nowInit.getFullYear()}-${String(nowInit.getMonth() + 1).padStart(2, '0')}-${String(nowInit.getDate()).padStart(2, '0')}`;

  // === STATO APPLICAZIONE ===
  const state = {
    viewMode: CLIENT_SHARE_TOKEN ? 'client' : 'admin',
    shareToken: CLIENT_SHARE_TOKEN,
    role: null, // 'admin' | 'client' | null
    token: null,
    adminUser: null,
    runtime: 'node',
    driveConfigured: false,
    albums: [],
    photos: [],
    activities: [],
    calendarYear: nowInit.getFullYear(),
    calendarMonth: nowInit.getMonth(),
    calendarSelectedDate: todayIsoInit,
    calendarFilter: 'all', // 'all' | 'scheduled' | 'in_progress' | 'completed'
    calendarAgendaMode: 'day', // 'day' | 'upcoming'
    editingActivityId: null,
    transactions: [],
    cashTypeFilter: 'all', // 'all' | 'income' | 'expense' | 'pending'
    cashPeriodFilter: 'all',
    cashMethodFilter: 'all',
    cashSearchQuery: '',
    editingTxnId: null,
    txnModalType: 'income',
    services: [],
    servicesFilter: 'all', // 'all' | 'active' | 'hidden'
    servicesSearchQuery: '',
    editingServiceId: null,
    publicServices: [],
    musicTracks: [],
    musicSourceMode: 'upload', // 'upload' | 'url'
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

    // Controlli Musica di Sottofondo
    bgAudioPlayer: document.getElementById('bg-audio-player'),
    bgMusicWidget: document.getElementById('bg-music-widget'),
    bgMusicNoteIcon: document.getElementById('bg-music-note-icon'),
    bgMusicTitle: document.getElementById('bg-music-title'),
    btnMusicPrev: document.getElementById('btn-music-prev'),
    btnMusicToggle: document.getElementById('btn-music-toggle'),
    iconMusicPlay: document.getElementById('icon-music-play'),
    iconMusicPause: document.getElementById('icon-music-pause'),
    btnMusicNext: document.getElementById('btn-music-next'),
    btnMusicMute: document.getElementById('btn-music-mute'),
    iconMusicVol: document.getElementById('icon-music-vol'),
    iconMusicMuted: document.getElementById('icon-music-muted'),
    musicVolumeSlider: document.getElementById('music-volume-slider'),

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
    btnClientServicesOpen: document.getElementById('btn-client-services-open'),
    clientServicesBadge: document.getElementById('client-services-badge'),
    clientLoginServicesWrap: document.getElementById('client-login-services-wrap'),
    btnClientLoginServices: document.getElementById('btn-client-login-services'),
    clientLoginServicesCount: document.getElementById('client-login-services-count'),
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

    // Calendario Attività Admin
    calCountScheduled: document.getElementById('cal-count-scheduled'),
    calCountInProgress: document.getElementById('cal-count-inprogress'),
    btnOpenNewActivity: document.getElementById('btn-open-new-activity'),
    btnCalPrevMonth: document.getElementById('btn-cal-prev-month'),
    btnCalNextMonth: document.getElementById('btn-cal-next-month'),
    btnCalToday: document.getElementById('btn-cal-today'),
    calMonthLabel: document.getElementById('cal-month-label'),
    calFilterChips: document.getElementById('cal-filter-chips'),
    calDaysGrid: document.getElementById('cal-days-grid'),
    btnAgendaDay: document.getElementById('btn-agenda-day'),
    btnAgendaUpcoming: document.getElementById('btn-agenda-upcoming'),
    calSelectedDateLabel: document.getElementById('cal-selected-date-label'),
    calAgendaCount: document.getElementById('cal-agenda-count'),
    btnAddActivitySelectedDay: document.getElementById('btn-add-activity-selected-day'),
    calAgendaList: document.getElementById('cal-agenda-list'),
    calAgendaEmpty: document.getElementById('cal-agenda-empty'),
    calAgendaEmptyText: document.getElementById('cal-agenda-empty-text'),

    // Modale Attività Calendario
    modalActivity: document.getElementById('modal-activity'),
    btnCloseActivityModal: document.getElementById('btn-close-activity-modal'),
    btnCancelActivityModal: document.getElementById('btn-cancel-activity-modal'),
    activityModalTitle: document.getElementById('activity-modal-title'),
    activityModalSubtitle: document.getElementById('activity-modal-subtitle'),
    formActivity: document.getElementById('form-activity'),
    activityTitle: document.getElementById('activity-title'),
    activityTitleError: document.getElementById('activity-title-error'),
    activityStatus: document.getElementById('activity-status'),
    activityTime: document.getElementById('activity-time'),
    activityDate: document.getElementById('activity-date'),
    activityEndDate: document.getElementById('activity-end-date'),
    activityDateError: document.getElementById('activity-date-error'),
    activityClient: document.getElementById('activity-client'),
    activityLocation: document.getElementById('activity-location'),
    activityNotes: document.getElementById('activity-notes'),
    btnDeleteActivity: document.getElementById('btn-delete-activity'),
    btnSaveActivity: document.getElementById('btn-save-activity'),

    // Gestione Cassa & Contabilità Admin
    btnOpenCashAdmin: document.getElementById('btn-open-cash-admin'),
    modalCashManager: document.getElementById('modal-cash-manager'),
    btnCloseCashManager: document.getElementById('btn-close-cash-manager'),
    btnExportCashCsv: document.getElementById('btn-export-cash-csv'),
    btnNewIncome: document.getElementById('btn-new-income'),
    btnNewExpense: document.getElementById('btn-new-expense'),
    cashKpiBalance: document.getElementById('cash-kpi-balance'),
    cashKpiBalanceSub: document.getElementById('cash-kpi-balance-sub'),
    cashKpiIncome: document.getElementById('cash-kpi-income'),
    cashKpiIncomeSub: document.getElementById('cash-kpi-income-sub'),
    cashKpiExpense: document.getElementById('cash-kpi-expense'),
    cashKpiExpenseSub: document.getElementById('cash-kpi-expense-sub'),
    cashKpiPending: document.getElementById('cash-kpi-pending'),
    cashKpiPendingSub: document.getElementById('cash-kpi-pending-sub'),
    cashTypeChips: document.getElementById('cash-type-chips'),
    cashPeriodFilter: document.getElementById('cash-period-filter'),
    cashMethodFilter: document.getElementById('cash-method-filter'),
    cashSearchInput: document.getElementById('cash-search-input'),
    cashTable: document.getElementById('cash-table'),
    cashTableBody: document.getElementById('cash-table-body'),
    cashTableEmpty: document.getElementById('cash-table-empty'),

    // Modale Movimento Cassa
    modalTransaction: document.getElementById('modal-transaction'),
    btnCloseTxnModal: document.getElementById('btn-close-txn-modal'),
    btnCancelTxnModal: document.getElementById('btn-cancel-txn-modal'),
    txnModalTitle: document.getElementById('txn-modal-title'),
    txnModalSubtitle: document.getElementById('txn-modal-subtitle'),
    formTransaction: document.getElementById('form-transaction'),
    btnTxnTypeIncome: document.getElementById('btn-txn-type-income'),
    btnTxnTypeExpense: document.getElementById('btn-txn-type-expense'),
    txnDescription: document.getElementById('txn-description'),
    txnDescriptionError: document.getElementById('txn-description-error'),
    txnAmount: document.getElementById('txn-amount'),
    txnAmountError: document.getElementById('txn-amount-error'),
    txnDate: document.getElementById('txn-date'),
    txnDateError: document.getElementById('txn-date-error'),
    txnCategory: document.getElementById('txn-category'),
    txnMethod: document.getElementById('txn-method'),
    txnStatus: document.getElementById('txn-status'),
    txnInvoiceRef: document.getElementById('txn-invoice-ref'),
    txnClient: document.getElementById('txn-client'),
    txnNotes: document.getElementById('txn-notes'),
    btnDeleteTxn: document.getElementById('btn-delete-txn'),
    btnSaveTxn: document.getElementById('btn-save-txn'),

    // Servizi Offerti (Admin & Cliente)
    btnOpenServicesAdmin: document.getElementById('btn-open-services-admin'),
    modalServicesManager: document.getElementById('modal-services-manager'),
    btnCloseServicesManager: document.getElementById('btn-close-services-manager'),
    btnNewService: document.getElementById('btn-new-service'),
    servicesStatusChips: document.getElementById('services-status-chips'),
    adminServicesCount: document.getElementById('admin-services-count'),
    servicesSearchInput: document.getElementById('services-search-input'),
    adminServicesList: document.getElementById('admin-services-list'),
    adminServicesEmpty: document.getElementById('admin-services-empty'),
    modalServiceForm: document.getElementById('modal-service-form'),
    btnCloseServiceForm: document.getElementById('btn-close-service-form'),
    btnCancelServiceForm: document.getElementById('btn-cancel-service-form'),
    serviceFormTitle: document.getElementById('service-form-title'),
    serviceFormSubtitle: document.getElementById('service-form-subtitle'),
    formService: document.getElementById('form-service'),
    serviceName: document.getElementById('service-name'),
    serviceNameError: document.getElementById('service-name-error'),
    servicePrice: document.getElementById('service-price'),
    servicePriceError: document.getElementById('service-price-error'),
    servicePriceUnit: document.getElementById('service-price-unit'),
    serviceCategory: document.getElementById('service-category'),
    serviceDescription: document.getElementById('service-description'),
    serviceActive: document.getElementById('service-active'),
    btnDeleteService: document.getElementById('btn-delete-service'),
    btnSaveService: document.getElementById('btn-save-service'),
    modalClientServices: document.getElementById('modal-client-services'),
    btnCloseClientServices: document.getElementById('btn-close-client-services'),
    clientServicesList: document.getElementById('client-services-list'),
    clientServicesEmpty: document.getElementById('client-services-empty'),

    // Musiche di Sottofondo (Admin)
    btnOpenMusicAdmin: document.getElementById('btn-open-music-admin'),
    modalMusicManager: document.getElementById('modal-music-manager'),
    btnCloseMusicManager: document.getElementById('btn-close-music-manager'),
    formAddMusic: document.getElementById('form-add-music'),
    musicSourceTabs: document.getElementById('music-source-tabs'),
    musicTitle: document.getElementById('music-title'),
    musicTitleError: document.getElementById('music-title-error'),
    musicArtist: document.getElementById('music-artist'),
    musicUploadGroup: document.getElementById('music-upload-group'),
    musicFile: document.getElementById('music-file'),
    musicFileError: document.getElementById('music-file-error'),
    musicUrlGroup: document.getElementById('music-url-group'),
    musicUrl: document.getElementById('music-url'),
    musicUrlError: document.getElementById('music-url-error'),
    musicEnabled: document.getElementById('music-enabled'),
    btnSaveMusic: document.getElementById('btn-save-music'),
    adminMusicCount: document.getElementById('admin-music-count'),
    adminMusicList: document.getElementById('admin-music-list'),
    adminMusicEmpty: document.getElementById('admin-music-empty'),

    // Lightbox
    modalLightbox: document.getElementById('modal-lightbox'),
    lightboxCardContainer: document.getElementById('lightbox-card-container'),
    lightboxImgWrapper: document.getElementById('lightbox-img-wrapper'),
    lightboxImage: document.getElementById('lightbox-image'),
    lightboxVideo: document.getElementById('lightbox-video'),
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
    lightboxDownloadLabel: document.getElementById('lightbox-download-label'),
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
    if (
      trimmed.startsWith('/api/media/') ||
      trimmed.startsWith('/api/music/') ||
      trimmed.startsWith('https://')
    ) {
      return trimmed.replace(/["'()\\\r\n]/g, '');
    }
    return '';
  }

  function buildMediaUrl(driveFileId, { thumb = false, preview = false, download = false, version = '' } = {}) {
    if (!driveFileId) return '';
    const params = new URLSearchParams();
    if (thumb) params.set('thumb', '1');
    else if (preview) params.set('preview', '1');
    if (download) params.set('download', '1');
    if (version) params.set('v', String(version));
    const qs = params.toString();
    return `/api/media/${encodeURIComponent(driveFileId)}${qs ? '?' + qs : ''}`;
  }

  const preloadedUrls = new Set();
  function preloadImageUrl(url) {
    const safeUrl = sanitizeMediaUrl(url);
    if (!safeUrl || preloadedUrls.has(safeUrl)) return;
    if (preloadedUrls.size > 120) preloadedUrls.clear();
    preloadedUrls.add(safeUrl);
    const img = new Image();
    img.decoding = 'async';
    img.src = safeUrl;
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

  function isVideoItem(item) {
    if (!item) return false;
    if (item.mediaType === 'video') return true;
    return typeof item.mimeType === 'string' && item.mimeType.toLowerCase().startsWith('video/');
  }

  function formatDuration(durationMillis) {
    const ms = Number(durationMillis);
    if (!ms || ms <= 0) return '';
    const totalSec = Math.round(ms / 1000);
    const hours = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return hours > 0 ? `${hours}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`;
  }

  function formatMediaCounts(items) {
    const list = Array.isArray(items) ? items : [];
    let videos = 0;
    for (const item of list) {
      if (isVideoItem(item)) videos += 1;
    }
    const photos = list.length - videos;
    if (videos === 0) return `${photos} foto`;
    if (photos === 0) return `${videos} video`;
    return `${photos} foto • ${videos} video`;
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
          const items = Array.isArray(data.items)
            ? data.items.filter(item => !isVideoItem(item))
            : [];
          if (items.length > 0) {
            this.playlist = items.map(item => ({
              id: item.driveFileId,
              originalName: item.albumName ? `${item.albumName} • ${item.originalName}` : item.originalName,
              url: buildMediaUrl(item.driveFileId, { preview: true, version: item.updatedAt || '' })
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

      if (this.playlist.length > 1) {
        const nextItem = this.playlist[(this.currentIndex + 1) % this.playlist.length];
        if (nextItem?.url) preloadImageUrl(nextItem.url);
      }
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
  // GESTORE MUSICA DI SOTTOFONDO (HTML5 AUDIO + YOUTUBE IFRAME PLAYER API)
  // =========================================================================
  const YOUTUBE_HOSTS = new Set([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtu.be',
    'www.youtu.be',
    'youtube-nocookie.com',
    'www.youtube-nocookie.com'
  ]);
  const YOUTUBE_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

  function isYouTubeUrlHost(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl || '').trim());
      return YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  function extractYouTubeVideoId(rawUrl) {
    const trimmed = String(rawUrl || '').trim();
    if (!trimmed) return '';
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      return '';
    }
    const host = parsed.hostname.toLowerCase();
    if (!YOUTUBE_HOSTS.has(host)) return '';

    let candidate = '';
    if (host === 'youtu.be' || host === 'www.youtu.be') {
      candidate = parsed.pathname.split('/').filter(Boolean)[0] || '';
    } else if (parsed.pathname === '/watch' || parsed.pathname === '/watch/') {
      candidate = parsed.searchParams.get('v') || '';
    } else {
      const match = parsed.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
      candidate = match ? match[1] : '';
    }
    return YOUTUBE_ID_REGEX.test(candidate) ? candidate : '';
  }

  function getTrackYouTubeId(track) {
    if (!track) return '';
    if (track.youtubeVideoId && YOUTUBE_ID_REGEX.test(track.youtubeVideoId)) {
      return track.youtubeVideoId;
    }
    return extractYouTubeVideoId(track.url || track.streamUrl || '');
  }

  const musicPlayer = {
    playlist: [],
    currentIndex: 0,
    currentTrackId: null,
    activeEngine: null, // 'audio' | 'youtube' | null
    isPlaying: false,
    isMuted: false,
    volume: 0.35,
    ytPlayer: null,
    ytReady: false,
    ytApiPromise: null,
    ytPendingVideoId: '',
    ytPendingAutoplay: false,

    async init() {
      const savedVol = Number(localStorage.getItem('bg_music_volume'));
      if (Number.isFinite(savedVol) && savedVol >= 0 && savedVol <= 1) {
        this.volume = savedVol;
      }
      if (dom.musicVolumeSlider) {
        dom.musicVolumeSlider.value = String(Math.round(this.volume * 100));
      }
      if (dom.bgAudioPlayer) {
        dom.bgAudioPlayer.volume = this.volume;
      }
      this.bindEvents();
      await this.refreshFromServer();
    },

    loadYouTubeIframeApi() {
      if (window.YT && typeof window.YT.Player === 'function') {
        return Promise.resolve(window.YT);
      }
      if (this.ytApiPromise) return this.ytApiPromise;

      this.ytApiPromise = new Promise((resolve, reject) => {
        const prevReady = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => {
          if (typeof prevReady === 'function') {
            try { prevReady(); } catch {}
          }
          resolve(window.YT);
        };

        const existingScript = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
        if (!existingScript) {
          const script = document.createElement('script');
          script.src = 'https://www.youtube.com/iframe_api';
          script.async = true;
          script.onerror = () => {
            this.ytApiPromise = null;
            reject(new Error('Impossibile caricare la YouTube IFrame Player API.'));
          };
          document.head.appendChild(script);
        }
      });

      return this.ytApiPromise;
    },

    syncYouTubeVolume() {
      if (!this.ytPlayer || !this.ytReady) return;
      try {
        this.ytPlayer.setVolume(Math.round(this.volume * 100));
        if (this.isMuted || this.volume === 0) {
          this.ytPlayer.mute();
        } else {
          this.ytPlayer.unMute();
        }
      } catch {}
    },

    async loadYouTubeVideo(videoId, autoplay = false) {
      if (!videoId) return;
      this.ytPendingVideoId = videoId;
      this.ytPendingAutoplay = Boolean(autoplay);

      try {
        const YT = await this.loadYouTubeIframeApi();
        if (this.activeEngine !== 'youtube' || this.ytPendingVideoId !== videoId) return;

        if (this.ytPlayer && this.ytReady) {
          this.syncYouTubeVolume();
          if (autoplay) {
            this.ytPlayer.loadVideoById(videoId);
          } else {
            this.ytPlayer.cueVideoById(videoId);
          }
          return;
        }

        if (!this.ytPlayer) {
          const container = document.getElementById('bg-youtube-player');
          if (!container) return;
          this.ytPlayer = new YT.Player('bg-youtube-player', {
            height: '200',
            width: '200',
            videoId,
            playerVars: {
              autoplay: autoplay ? 1 : 0,
              controls: 0,
              disablekb: 1,
              fs: 0,
              modestbranding: 1,
              playsinline: 1,
              rel: 0,
              origin: window.location.origin
            },
            events: {
              onReady: () => {
                this.ytReady = true;
                this.syncYouTubeVolume();
                if (this.activeEngine === 'youtube' && this.ytPendingVideoId) {
                  if (this.ytPendingVideoId !== videoId) {
                    if (this.ytPendingAutoplay) {
                      this.ytPlayer.loadVideoById(this.ytPendingVideoId);
                    } else {
                      this.ytPlayer.cueVideoById(this.ytPendingVideoId);
                    }
                  } else if (this.ytPendingAutoplay) {
                    this.ytPlayer.playVideo();
                  }
                }
              },
              onStateChange: (event) => {
                if (this.activeEngine !== 'youtube') return;
                if (event.data === YT.PlayerState.PLAYING) {
                  this.isPlaying = true;
                  this.updateUI();
                  renderAdminMusic();
                } else if (event.data === YT.PlayerState.PAUSED) {
                  this.isPlaying = false;
                  this.updateUI();
                  renderAdminMusic();
                } else if (event.data === YT.PlayerState.ENDED) {
                  if (this.playlist.length > 1) {
                    this.loadTrack(this.currentIndex + 1, true);
                  } else if (this.playlist.length === 1) {
                    this.ytPlayer.seekTo(0, true);
                    this.ytPlayer.playVideo();
                  }
                }
              },
              onError: (event) => {
                if (this.activeEngine !== 'youtube') return;
                this.isPlaying = false;
                this.updateUI();
                renderAdminMusic();
                const code = Number(event?.data);
                const msg = (code === 101 || code === 150)
                  ? 'Il proprietario di questo video YouTube ha disabilitato la riproduzione incorporata.'
                  : (code === 100
                    ? 'Video YouTube non trovato o privato.'
                    : 'Impossibile riprodurre questo video YouTube.');
                showToast('error', 'Errore YouTube', msg);
              }
            }
          });
        }
      } catch (err) {
        this.isPlaying = false;
        this.updateUI();
        renderAdminMusic();
        if (autoplay) {
          showToast('error', 'Errore YouTube', err?.message || 'Impossibile avviare il player YouTube.');
        }
      }
    },

    pauseOtherEngines(targetEngine) {
      if (targetEngine !== 'audio' && dom.bgAudioPlayer) {
        dom.bgAudioPlayer.pause();
        dom.bgAudioPlayer.removeAttribute('src');
        dom.bgAudioPlayer.load();
      }
      if (targetEngine !== 'youtube' && this.ytPlayer && this.ytReady) {
        try {
          this.ytPlayer.pauseVideo();
        } catch {}
      }
    },

    async refreshFromServer() {
      try {
        const res = await fetch('/api/public/music');
        if (res.ok) {
          const data = await res.json();
          const tracks = Array.isArray(data.tracks) ? data.tracks : [];
          this.playlist = tracks;
          if (this.playlist.length === 0) {
            this.stop();
            dom.bgMusicWidget?.classList.add('hidden');
            return;
          }
          dom.bgMusicWidget?.classList.remove('hidden');
          const stillIdx = this.currentTrackId
            ? this.playlist.findIndex(t => t.id === this.currentTrackId)
            : -1;
          if (stillIdx !== -1) {
            this.currentIndex = stillIdx;
          } else {
            this.currentIndex = 0;
            this.loadTrack(0, false);
          }
          this.updateUI();
        }
      } catch {
        // Ignora errori di rete temporanei
      }
    },

    loadTrack(index, autoplay = false) {
      if (!this.playlist.length) return;
      this.currentIndex = (index + this.playlist.length) % this.playlist.length;
      const track = this.playlist[this.currentIndex];
      const ytId = getTrackYouTubeId(track);

      if (ytId) {
        this.pauseOtherEngines('youtube');
        this.activeEngine = 'youtube';
        this.currentTrackId = track.id;
        this.updateUI();
        this.loadYouTubeVideo(ytId, autoplay);
        return;
      }

      if (!dom.bgAudioPlayer) return;
      const safeUrl = sanitizeMediaUrl(track.streamUrl || track.url);
      if (!safeUrl) return;
      this.pauseOtherEngines('audio');
      this.activeEngine = 'audio';
      this.currentTrackId = track.id;
      dom.bgAudioPlayer.src = safeUrl;
      dom.bgAudioPlayer.volume = this.isMuted ? 0 : this.volume;
      this.updateUI();
      if (autoplay) {
        this.play();
      }
    },

    async play() {
      if (!this.activeEngine) {
        if (this.playlist.length === 0) return;
        this.loadTrack(this.currentIndex, true);
        return;
      }

      if (this.activeEngine === 'youtube') {
        this.ytPendingAutoplay = true;
        if (this.ytPlayer && this.ytReady) {
          try {
            this.syncYouTubeVolume();
            this.ytPlayer.playVideo();
            this.isPlaying = true;
            this.updateUI();
            renderAdminMusic();
          } catch {
            this.isPlaying = false;
            this.updateUI();
          }
        } else if (this.ytPendingVideoId) {
          await this.loadYouTubeVideo(this.ytPendingVideoId, true);
        }
        return;
      }

      if (!dom.bgAudioPlayer) return;
      if (!dom.bgAudioPlayer.src) {
        if (this.playlist.length === 0) return;
        this.loadTrack(this.currentIndex, false);
      }
      try {
        await dom.bgAudioPlayer.play();
        this.isPlaying = true;
        this.updateUI();
        renderAdminMusic();
      } catch {
        this.isPlaying = false;
        this.updateUI();
      }
    },

    pause() {
      if (this.activeEngine === 'youtube' && this.ytPlayer && this.ytReady) {
        try {
          this.ytPlayer.pauseVideo();
        } catch {}
        this.ytPendingAutoplay = false;
      } else if (dom.bgAudioPlayer) {
        dom.bgAudioPlayer.pause();
      }
      this.isPlaying = false;
      this.updateUI();
      renderAdminMusic();
    },

    stop() {
      if (dom.bgAudioPlayer) {
        dom.bgAudioPlayer.pause();
        dom.bgAudioPlayer.removeAttribute('src');
        dom.bgAudioPlayer.load();
      }
      if (this.ytPlayer && this.ytReady) {
        try {
          this.ytPlayer.stopVideo();
        } catch {}
      }
      this.ytPendingVideoId = '';
      this.ytPendingAutoplay = false;
      this.activeEngine = null;
      this.isPlaying = false;
      this.currentTrackId = null;
      this.updateUI();
      renderAdminMusic();
    },

    togglePlay() {
      if (this.isPlaying) {
        this.pause();
      } else {
        this.play();
      }
    },

    previewTrack(track) {
      if (!track) return;
      if (this.currentTrackId === track.id && this.isPlaying) {
        this.pause();
        return;
      }

      const idx = this.playlist.findIndex(t => t.id === track.id);
      if (idx !== -1) this.currentIndex = idx;

      const ytId = getTrackYouTubeId(track);
      if (ytId) {
        this.pauseOtherEngines('youtube');
        this.activeEngine = 'youtube';
        this.currentTrackId = track.id;
        if (dom.bgMusicTitle) {
          dom.bgMusicTitle.textContent = track.artist ? `${track.title} • ${track.artist}` : track.title;
        }
        this.updateUI();
        this.loadYouTubeVideo(ytId, true);
        return;
      }

      if (!dom.bgAudioPlayer) return;
      const safeUrl = sanitizeMediaUrl(track.streamUrl || track.url);
      if (!safeUrl) return;
      this.pauseOtherEngines('audio');
      this.activeEngine = 'audio';
      this.currentTrackId = track.id;
      dom.bgAudioPlayer.src = safeUrl;
      dom.bgAudioPlayer.volume = this.isMuted ? 0 : this.volume;
      if (dom.bgMusicTitle) {
        dom.bgMusicTitle.textContent = track.artist ? `${track.title} • ${track.artist}` : track.title;
      }
      this.play();
    },

    next() {
      if (!this.playlist.length) return;
      this.loadTrack(this.currentIndex + 1, this.isPlaying);
    },

    prev() {
      if (!this.playlist.length) return;
      this.loadTrack(this.currentIndex - 1, this.isPlaying);
    },

    toggleMute() {
      this.isMuted = !this.isMuted;
      if (dom.bgAudioPlayer) {
        dom.bgAudioPlayer.volume = this.isMuted ? 0 : this.volume;
      }
      this.syncYouTubeVolume();
      this.updateUI();
    },

    setVolume(val) {
      const clamped = Math.max(0, Math.min(1, Number(val) || 0));
      this.volume = clamped;
      this.isMuted = clamped === 0;
      localStorage.setItem('bg_music_volume', String(clamped));
      if (dom.bgAudioPlayer) {
        dom.bgAudioPlayer.volume = clamped;
      }
      this.syncYouTubeVolume();
      this.updateUI();
    },

    updateUI() {
      const activeTrack =
        this.playlist.find(t => t.id === this.currentTrackId) ||
        this.playlist[this.currentIndex] ||
        null;
      if (dom.bgMusicTitle) {
        dom.bgMusicTitle.textContent = activeTrack
          ? (activeTrack.artist ? `${activeTrack.title} • ${activeTrack.artist}` : activeTrack.title)
          : 'Musica di sottofondo';
      }
      dom.iconMusicPlay?.classList.toggle('hidden', this.isPlaying);
      dom.iconMusicPause?.classList.toggle('hidden', !this.isPlaying);
      dom.btnMusicToggle?.classList.toggle('is-playing', this.isPlaying);
      dom.bgMusicNoteIcon?.classList.toggle('is-playing', this.isPlaying);
      dom.iconMusicVol?.classList.toggle('hidden', this.isMuted || this.volume === 0);
      dom.iconMusicMuted?.classList.toggle('hidden', !(this.isMuted || this.volume === 0));
    },

    bindEvents() {
      dom.btnMusicToggle?.addEventListener('click', () => this.togglePlay());
      dom.btnMusicNext?.addEventListener('click', () => this.next());
      dom.btnMusicPrev?.addEventListener('click', () => this.prev());
      dom.btnMusicMute?.addEventListener('click', () => this.toggleMute());
      dom.musicVolumeSlider?.addEventListener('input', () => {
        this.setVolume(Number(dom.musicVolumeSlider.value) / 100);
      });
      dom.bgAudioPlayer?.addEventListener('ended', () => {
        if (this.activeEngine !== 'audio') return;
        if (this.playlist.length > 1) {
          this.loadTrack(this.currentIndex + 1, true);
        } else if (this.playlist.length === 1) {
          dom.bgAudioPlayer.currentTime = 0;
          this.play();
        }
      });
      dom.bgAudioPlayer?.addEventListener('error', () => {
        if (this.activeEngine !== 'audio') return;
        const wasPlaying = this.isPlaying;
        this.isPlaying = false;
        this.updateUI();
        renderAdminMusic();
        if (wasPlaying) {
          showToast('error', 'Errore Audio', 'Impossibile riprodurre questo brano audio.');
        }
      });
      // Pausa automatica della musica se l'utente avvia un video nel Lightbox
      dom.lightboxVideo?.addEventListener('play', () => {
        if (this.isPlaying) this.pause();
      });
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
        state.runtime = data.runtime || 'node';
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
      const res = await fetch('/api/me?scope=admin', {
        headers: savedToken ? { Authorization: `Bearer ${savedToken}` } : {}
      });
      if (res.ok) {
        const data = await res.json();
        if (data.role === 'admin' && data.user) {
          if (data.security && !data.security.sessionSecretConfigured && data.security.sessionSecretWarning) {
            console.warn('[SECURITY]', data.security.sessionSecretWarning);
          }
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
      const [albumsRes, photosRes, activitiesRes, transactionsRes, servicesRes, musicRes] = await Promise.all([
        fetch('/api/admin/albums', { headers: getAuthHeaders() }),
        fetch('/api/admin/photos', { headers: getAuthHeaders() }),
        fetch('/api/admin/activities', { headers: getAuthHeaders() }),
        fetch('/api/admin/transactions', { headers: getAuthHeaders() }),
        fetch('/api/admin/services', { headers: getAuthHeaders() }),
        fetch('/api/admin/music', { headers: getAuthHeaders() })
      ]);

      if (
        albumsRes.status === 401 || albumsRes.status === 403 ||
        photosRes.status === 401 || photosRes.status === 403 ||
        activitiesRes.status === 401 || activitiesRes.status === 403 ||
        transactionsRes.status === 401 || transactionsRes.status === 403 ||
        servicesRes.status === 401 || servicesRes.status === 403 ||
        musicRes.status === 401 || musicRes.status === 403
      ) {
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
      if (activitiesRes.ok) {
        const actData = await activitiesRes.json();
        state.activities = actData.activities || [];
      }
      if (transactionsRes.ok) {
        const txnData = await transactionsRes.json();
        state.transactions = txnData.transactions || [];
      }
      if (servicesRes.ok) {
        const srvData = await servicesRes.json();
        state.services = srvData.services || [];
      }
      if (musicRes.ok) {
        const musData = await musicRes.json();
        state.musicTracks = musData.tracks || [];
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
    const slideshowPhotosCount = state.photos.filter(
      p => slideshowAlbumIds.has(p.albumId) && !isVideoItem(p)
    ).length;

    dom.statAlbumsCount.textContent = `${state.albums.length} album`;
    dom.statPhotosCount.textContent = formatMediaCounts(state.photos);
    dom.statSharedCount.textContent = `${sharedCount} attivi`;
    dom.statSlideshowCount.textContent = `${slideshowPhotosCount} foto`;
    dom.adminAlbumsBadge.textContent = `${state.albums.length} album`;

    renderAdminCalendar();
    renderAdminCash();
    renderAdminServices();
    renderAdminMusic();
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
        const countText = formatMediaCounts(albumPhotos);
        badge.innerHTML = albumPhotos.length > 1
          ? `<span class="live-dot"></span> <span>${escapeHtml(countText)}</span>`
          : `<span>${escapeHtml(countText)}</span>`;
        preview.appendChild(badge);

        const previewCandidates = albumPhotos
          .filter(p => !isVideoItem(p) || p.hasThumbnail)
          .sort((a, b) => {
            const imgDiff = Number(!isVideoItem(b)) - Number(!isVideoItem(a));
            if (imgDiff !== 0) return imgDiff;
            return Number(Boolean(b.hasThumbnail)) - Number(Boolean(a.hasThumbnail));
          })
          .slice(0, 6);

        if (previewCandidates.length === 0) {
          const videoFallback = document.createElement('div');
          videoFallback.className = 'album-empty-placeholder';
          videoFallback.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            <span>${escapeHtml(countText)}</span>
          `;
          preview.appendChild(videoFallback);
        } else {
          const imgs = previewCandidates.map((photo, idx) => {
            const img = document.createElement('img');
            img.className = `album-slide-img ${idx === 0 ? 'active' : ''}`;
            const thumbUrl = sanitizeMediaUrl(buildMediaUrl(photo.driveFileId, { thumb: true, version: photo.updatedAt }));
            if (idx === 0) {
              img.src = thumbUrl;
            } else {
              img.dataset.src = thumbUrl;
            }
            img.alt = photo.originalName || '';
            img.loading = 'lazy';
            img.decoding = 'async';
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
                if (imgs[cur].dataset.src) {
                  imgs[cur].src = imgs[cur].dataset.src;
                  delete imgs[cur].dataset.src;
                }
                imgs[cur].classList.add('active');
              }
            });
          }
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
        <div class="album-card-actions">
          <button type="button" class="btn-album-action btn-open-lightbox" ${albumPhotos.length === 0 ? 'disabled' : ''} title="Apri le foto di questo album nel Lightbox">
            Apri Slideshow
          </button>
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
      });

      body.querySelector('.album-card-actions').addEventListener('click', (e) => {
        e.stopPropagation();
      });

      body.querySelector('.btn-open-lightbox').addEventListener('click', () => {
        state.selectedAlbumId = album.id;
        renderAdminDashboard();
        if (albumPhotos.length > 0) {
          openLightbox(albumPhotos[0], albumPhotos);
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

  const galleryObservers = new WeakMap();
  const GALLERY_BATCH_SIZE = 40;

  function renderGalleryGridProgressive(gridEl, items, buildCardFn) {
    const prevObserver = galleryObservers.get(gridEl);
    if (prevObserver) {
      prevObserver.disconnect();
      galleryObservers.delete(gridEl);
    }
    gridEl.innerHTML = '';
    if (!Array.isArray(items) || items.length === 0) return;

    let rendered = 0;
    let sentinel = null;

    function appendNextBatch() {
      const end = Math.min(rendered + GALLERY_BATCH_SIZE, items.length);
      const frag = document.createDocumentFragment();
      for (let i = rendered; i < end; i++) {
        frag.appendChild(buildCardFn(items[i]));
      }
      rendered = end;

      if (sentinel && sentinel.parentNode === gridEl) {
        gridEl.insertBefore(frag, sentinel);
      } else {
        gridEl.appendChild(frag);
      }

      if (rendered >= items.length) {
        const activeObs = galleryObservers.get(gridEl);
        if (activeObs) {
          activeObs.disconnect();
          galleryObservers.delete(gridEl);
        }
        if (sentinel && sentinel.parentNode) sentinel.remove();
      }
    }

    appendNextBatch();

    if (rendered < items.length) {
      if (typeof IntersectionObserver === 'function') {
        sentinel = document.createElement('div');
        sentinel.className = 'gallery-scroll-sentinel';
        sentinel.setAttribute('aria-hidden', 'true');
        gridEl.appendChild(sentinel);

        const obs = new IntersectionObserver(
          (entries) => {
            if (entries.some(e => e.isIntersecting)) {
              appendNextBatch();
            }
          },
          { rootMargin: '400px 0px' }
        );
        galleryObservers.set(gridEl, obs);
        obs.observe(sentinel);
      } else {
        while (rendered < items.length) appendNextBatch();
      }
    }
  }

  function renderAdminPhotoGrid() {
    const activeAlbum = state.selectedAlbumId
      ? state.albums.find(a => a.id === state.selectedAlbumId)
      : null;

    const filteredPhotos = activeAlbum
      ? state.photos.filter(p => p.albumId === activeAlbum.id)
      : state.photos;

    dom.adminGalleryTitle.textContent = activeAlbum ? `Album: ${activeAlbum.name}` : 'Tutti i contenuti';
    dom.adminGalleryCount.textContent = formatMediaCounts(filteredPhotos);

    if (dom.btnOpenAlbumLightbox) {
      dom.btnOpenAlbumLightbox.classList.toggle('hidden', filteredPhotos.length === 0);
      dom.btnOpenAlbumLightbox.onclick = () => {
        if (filteredPhotos.length > 0) {
          openLightbox(filteredPhotos[0], filteredPhotos);
        }
      };
    }

    if (filteredPhotos.length === 0) {
      renderGalleryGridProgressive(dom.adminGalleryGrid, [], () => document.createElement('div'));
      dom.adminGalleryEmpty.classList.remove('hidden');
      return;
    }
    dom.adminGalleryEmpty.classList.add('hidden');

    const albumNameById = new Map(state.albums.map(a => [a.id, a.name]));

    renderGalleryGridProgressive(dom.adminGalleryGrid, filteredPhotos, (photo) =>
      buildPhotoCardElement(photo, {
        albumLabel: albumNameById.get(photo.albumId) || '',
        onOpen: () => openLightbox(photo, filteredPhotos),
        onEdit: () => photoEditor.open(photo)
      })
    );
  }

  function buildPhotoCardElement(photo, { albumLabel = '', onOpen, onEdit = null }) {
    const isVideo = isVideoItem(photo);
    const card = document.createElement('div');
    card.className = `photo-card${isVideo ? ' is-video' : ''}`;

    const thumbUrl = sanitizeMediaUrl(buildMediaUrl(photo.driveFileId, { thumb: true, version: photo.updatedAt }));
    const downloadUrl = sanitizeMediaUrl(buildMediaUrl(photo.driveFileId, { download: true, version: photo.updatedAt }));
    const formattedDate = photo.uploadedAt ? new Date(photo.uploadedAt).toLocaleDateString('it-IT') : '';
    const durationLabel = isVideo ? formatDuration(photo.durationMillis) : '';
    const canShowThumbImg = !isVideo || Boolean(photo.hasThumbnail);

    const fallbackHtml = isVideo
      ? `
        <div class="photo-broken-fallback video-placeholder${canShowThumbImg ? ' hidden' : ''}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="2" y="4" width="20" height="16" rx="2"/>
            <polygon points="10 8.5 16 12 10 15.5 10 8.5" fill="currentColor" stroke="none"/>
          </svg>
          <span>${escapeHtml(durationLabel ? `Video • ${durationLabel}` : 'Video')}</span>
        </div>
      `
      : `
        <div class="photo-broken-fallback hidden">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <line x1="3" y1="3" x2="21" y2="21"/>
          </svg>
          <span>Anteprima non disponibile</span>
        </div>
      `;

    const zoomIconSvg = isVideo
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>';

    card.innerHTML = `
      <div class="photo-thumb-wrap${canShowThumbImg ? ' is-loading' : ''}">
        ${canShowThumbImg ? `<img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(photo.originalName)}" loading="lazy" decoding="async">` : ''}
        ${fallbackHtml}
        ${isVideo ? `
          <span class="video-badge-pill">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4"/></svg>
            <span>${escapeHtml(durationLabel || 'VIDEO')}</span>
          </span>
        ` : ''}
        <div class="photo-overlay">
          ${onEdit && !isVideo ? `
          <button type="button" class="btn-photo-action edit-action" title="Modifica con Palette Editor">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          </button>` : ''}
          <button type="button" class="btn-photo-action zoom-action" title="${isVideo ? 'Riproduci video' : 'Visualizza a schermo intero'}">
            ${zoomIconSvg}
          </button>
          <a href="${escapeHtml(downloadUrl)}" download="${escapeHtml(photo.originalName)}" class="btn-photo-action download-action" title="Scarica file originale">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </a>
        </div>
      </div>
      <div class="photo-meta">
        <div class="photo-title" title="${escapeHtml(photo.originalName)}">${escapeHtml(photo.originalName)}</div>
        <div class="photo-subinfo">
          <span>${escapeHtml(formatFileSize(photo.size))}${durationLabel ? ` • ${escapeHtml(durationLabel)}` : ''}</span>
          <span>${escapeHtml(formattedDate)}</span>
        </div>
        ${albumLabel ? `<span class="photo-album-tag">${escapeHtml(albumLabel)}</span>` : ''}
      </div>
    `;

    const thumbWrap = card.querySelector('.photo-thumb-wrap');
    const thumbImg = card.querySelector('.photo-thumb-wrap img');
    const brokenFallback = card.querySelector('.photo-broken-fallback');
    if (thumbImg) {
      const markThumbLoaded = () => {
        thumbWrap.classList.remove('is-loading');
        thumbImg.classList.add('is-loaded');
      };
      if (thumbImg.complete && thumbImg.naturalWidth > 0) {
        markThumbLoaded();
      } else {
        thumbImg.onload = markThumbLoaded;
      }
      thumbImg.onerror = () => {
        thumbWrap.classList.remove('is-loading');
        thumbImg.classList.add('hidden');
        brokenFallback.classList.remove('hidden');
      };
    }

    thumbWrap.addEventListener('click', onOpen);
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
        const totalVideos = Number(s.totalVideos) || 0;
        const videoStatPart = totalVideos > 0 ? ` • Video: ${totalVideos}` : '';
        showToast(
          'success',
          'Drive Sincronizzato!',
          `Album: +${s.addedAlbums || 0} / agg. ${s.updatedAlbums || 0} / rim. ${s.removedAlbums || 0} • Media: +${s.addedPhotos || 0} / rim. ${s.removedPhotos || 0}${videoStatPart}`
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
    if (!expired) {
      try {
        await fetch('/api/logout?scope=admin', { method: 'POST', headers: getAuthHeaders() });
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

  function ensureShareSavedBeforeCopy() {
    const album = state.albums.find(a => a.id === state.activeShareAlbumId);
    const hasUnsavedChanges =
      !album ||
      dom.shareEnabledToggle.checked !== Boolean(album.shareEnabled) ||
      dom.shareClientUsername.value.trim() !== (album.clientUsername || '') ||
      Boolean(dom.shareClientPassword.value) ||
      Boolean(dom.shareRegenerateToken.checked);

    if (hasUnsavedChanges) {
      showToast('error', 'Salva Prima la Condivisione', 'Clicca su "Salva Condivisione" per salvare e attivare questo link.');
      dom.btnSaveShareConfig.focus();
      return false;
    }
    if (!album.shareEnabled) {
      showToast('error', 'Condivisione Disattivata', 'Attiva il checkbox e clicca "Salva Condivisione" prima di copiare il link.');
      dom.shareEnabledToggle.focus();
      return false;
    }
    return true;
  }

  dom.btnCopyShareLink.addEventListener('click', () => {
    if (!ensureShareSavedBeforeCopy()) return;
    copyToClipboard(dom.shareLinkPreview.value, 'Link diretto cliente copiato.');
  });

  dom.btnCopyShareBundle.addEventListener('click', () => {
    if (!ensureShareSavedBeforeCopy()) return;
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

    loadPublicServices();

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
      const meRes = await fetch('/api/me?scope=client', {
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
        state.clientAlbum?.description || 'Clicca su una foto o un video per aprirlo a schermo intero o scaricare il file originale.';
      dom.clientGalleryCount.textContent = formatMediaCounts(state.clientPhotos);

      renderClientPhotoGrid();
    } catch (err) {
      showToast('error', 'Errore Galleria', err.message);
    }
  }

  function renderClientPhotoGrid() {
    if (dom.btnClientSlideshowOpen) {
      dom.btnClientSlideshowOpen.classList.toggle('hidden', state.clientPhotos.length === 0);
    }

    if (state.clientPhotos.length === 0) {
      renderGalleryGridProgressive(dom.clientGalleryGrid, [], () => document.createElement('div'));
      dom.clientGalleryEmpty.classList.remove('hidden');
      return;
    }
    dom.clientGalleryEmpty.classList.add('hidden');

    renderGalleryGridProgressive(dom.clientGalleryGrid, state.clientPhotos, (photo) =>
      buildPhotoCardElement(photo, {
        onOpen: () => openLightbox(photo, state.clientPhotos)
      })
    );
  }

  if (dom.btnClientSlideshowOpen) {
    dom.btnClientSlideshowOpen.addEventListener('click', () => {
      if (state.clientPhotos.length > 0) {
        openLightbox(state.clientPhotos[0], state.clientPhotos);
      }
    });
  }

  async function performClientLogout({ expired = false } = {}) {
    if (!expired) {
      try {
        await fetch('/api/logout?scope=client', { method: 'POST', headers: getAuthHeaders() });
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

  function resetLightboxVideo() {
    if (!dom.lightboxVideo) return;
    dom.lightboxVideo.onerror = null;
    try {
      dom.lightboxVideo.pause();
    } catch {}
    dom.lightboxVideo.removeAttribute('src');
    dom.lightboxVideo.removeAttribute('poster');
    dom.lightboxVideo.load();
    dom.lightboxVideo.classList.add('hidden');
  }

  function preloadLightboxNeighbors() {
    const list = state.lightboxPhotosList;
    if (!Array.isArray(list) || list.length <= 1) return;
    const neighborIndices = [
      (state.lightboxCurrentIndex + 1) % list.length,
      (state.lightboxCurrentIndex - 1 + list.length) % list.length
    ];
    for (const i of neighborIndices) {
      const item = list[i];
      if (!item || isVideoItem(item)) continue;
      preloadImageUrl(buildMediaUrl(item.driveFileId, { preview: true, version: item.updatedAt }));
    }
  }

  function updateLightboxView() {
    const photo = state.lightboxPhotosList[state.lightboxCurrentIndex] || state.activeLightboxPhoto;
    if (!photo) return;
    state.activeLightboxPhoto = photo;
    state.lightboxRotation = 0;

    const isVideo = isVideoItem(photo);
    const previewUrl = sanitizeMediaUrl(buildMediaUrl(photo.driveFileId, { preview: true, version: photo.updatedAt }));
    const fullUrl = sanitizeMediaUrl(buildMediaUrl(photo.driveFileId, { version: photo.updatedAt }));
    const thumbUrl = sanitizeMediaUrl(buildMediaUrl(photo.driveFileId, { thumb: true, version: photo.updatedAt }));
    const downloadUrl = sanitizeMediaUrl(buildMediaUrl(photo.driveFileId, { download: true, version: photo.updatedAt }));

    resetLightboxVideo();

    if (dom.lightboxRotateLeftBtn) {
      dom.lightboxRotateLeftBtn.classList.toggle('hidden', isVideo);
    }
    if (dom.lightboxRotateRightBtn) {
      dom.lightboxRotateRightBtn.classList.toggle('hidden', isVideo);
    }
    if (dom.lightboxEditBtn) {
      const canEdit = !isVideo && state.viewMode === 'admin' && state.role === 'admin';
      dom.lightboxEditBtn.classList.toggle('hidden', !canEdit);
    }
    if (dom.lightboxDownloadLabel) {
      dom.lightboxDownloadLabel.textContent = isVideo ? 'Scarica Video' : 'Scarica Foto';
    }

    if (isVideo) {
      dom.lightboxImgWrapper?.classList.remove('is-loading');
      dom.lightboxImage.onload = null;
      dom.lightboxImage.onerror = null;
      dom.lightboxImage.classList.remove('is-rotated-sideways');
      dom.lightboxImage.removeAttribute('src');
      dom.lightboxImage.style.transform = 'none';
      dom.lightboxImage.classList.add('hidden');

      if (dom.lightboxVideo) {
        if (photo.hasThumbnail && thumbUrl) {
          dom.lightboxVideo.poster = thumbUrl;
        }
        dom.lightboxVideo.onerror = () => {
          showToast('error', 'Video non riproducibile', `"${photo.originalName || 'Video'}" usa un codec non supportato dal browser. Puoi comunque scaricarlo.`);
        };
        dom.lightboxVideo.src = fullUrl;
        dom.lightboxVideo.classList.remove('hidden');
      }
    } else {
      dom.lightboxImgWrapper?.classList.add('is-loading');
      dom.lightboxImage.classList.remove('hidden');
      dom.lightboxImage.onload = () => {
        dom.lightboxImgWrapper?.classList.remove('is-loading');
        applyLightboxRotation();
      };
      dom.lightboxImage.onerror = () => {
        dom.lightboxImgWrapper?.classList.remove('is-loading');
        showToast('error', 'File non visualizzabile', `"${photo.originalName || 'Immagine'}" risulta corrotto o in un formato non leggibile dal browser.`);
      };
      dom.lightboxImage.src = previewUrl || fullUrl;
      if (dom.lightboxImage.complete && dom.lightboxImage.naturalWidth > 0) {
        dom.lightboxImgWrapper?.classList.remove('is-loading');
      }
      dom.lightboxImage.alt = photo.originalName || 'Foto';
      applyLightboxRotation();
    }

    dom.lightboxFilename.textContent = photo.originalName || (isVideo ? 'video.mp4' : 'foto.jpg');
    const albumName =
      state.viewMode === 'client'
        ? (state.clientAlbum?.name || 'Galleria')
        : (state.albums.find(a => a.id === photo.albumId)?.name || 'Album');
    const dateStr = photo.uploadedAt ? new Date(photo.uploadedAt).toLocaleDateString('it-IT') : '';
    const durationStr = isVideo ? formatDuration(photo.durationMillis) : '';
    dom.lightboxInfo.textContent = `${formatFileSize(photo.size)}${durationStr ? ' • ' + durationStr : ''} • ${albumName}${dateStr ? ' • ' + dateStr : ''}`;

    dom.lightboxCounterBadge.textContent = `${state.lightboxCurrentIndex + 1} di ${state.lightboxPhotosList.length}`;
    dom.lightboxBtnPrev.style.display = state.lightboxPhotosList.length > 1 ? 'flex' : 'none';
    dom.lightboxBtnNext.style.display = state.lightboxPhotosList.length > 1 ? 'flex' : 'none';

    dom.lightboxDownloadLink.href = downloadUrl || '#';
    dom.lightboxDownloadLink.download = photo.originalName || (isVideo ? 'video.mp4' : 'foto.jpg');

    preloadLightboxNeighbors();
  }

  function applyLightboxRotation() {
    if (isVideoItem(state.activeLightboxPhoto)) return;
    const isSideways = Math.abs(state.lightboxRotation) % 180 !== 0;
    dom.lightboxImage.classList.toggle('is-rotated-sideways', isSideways);
    if (!isSideways) {
      dom.lightboxImage.style.transform = state.lightboxRotation === 0 ? 'none' : `rotate(${state.lightboxRotation}deg)`;
      return;
    }

    const w = dom.lightboxImage.offsetWidth;
    const h = dom.lightboxImage.offsetHeight;
    const wrapW = dom.lightboxImgWrapper.clientWidth * 0.92;
    const wrapH = dom.lightboxImgWrapper.clientHeight * 0.92;
    if (w > 0 && h > 0 && wrapW > 0 && wrapH > 0) {
      const fitScale = Math.min(wrapW / h, wrapH / w);
      dom.lightboxImage.style.transform = `rotate(${state.lightboxRotation}deg) scale(${fitScale.toFixed(4)})`;
    } else {
      dom.lightboxImage.style.transform = `rotate(${state.lightboxRotation}deg)`;
    }
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
    if (isVideoItem(photo) || state.lightboxRotation === 0) {
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

      const exportMime = ['image/png', 'image/webp'].includes(photo.mimeType)
        ? photo.mimeType
        : 'image/jpeg';

      tempCanvas.toBlob((blob) => {
        if (!blob) {
          showToast('error', 'Download Bloccato', 'Impossibile esportare la versione ruotata.');
          return;
        }
        const objUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = `ruotata_${photo.originalName || 'foto.jpg'}`;
        link.href = objUrl;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
        showToast('success', 'Download Avviato', `Scaricata versione ruotata di "${photo.originalName}".`);
      }, exportMime, 0.94);
    };
    tempImg.onerror = () => {
      showToast('error', 'Errore Download', 'Impossibile scaricare l\'immagine ruotata.');
    };
    tempImg.src = sanitizeMediaUrl(buildMediaUrl(photo.driveFileId, { version: photo.updatedAt }));
  }

  function closeLightbox() {
    dom.modalLightbox.classList.add('hidden');
    state.activeLightboxPhoto = null;
    state.lightboxPhotosList = [];
    state.lightboxRotation = 0;
    if (state.isLightboxFullscreen) {
      toggleLightboxFullscreen();
    }
    resetLightboxVideo();
    dom.lightboxImgWrapper?.classList.remove('is-loading');
    dom.lightboxImage.onload = null;
    dom.lightboxImage.onerror = null;
    dom.lightboxImage.classList.remove('is-rotated-sideways');
    dom.lightboxImage.classList.remove('hidden');
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
    if (!dom.modalLightbox.classList.contains('hidden')) {
      requestAnimationFrame(() => applyLightboxRotation());
    }
  });

  window.addEventListener('resize', () => {
    if (!dom.modalLightbox.classList.contains('hidden')) {
      applyLightboxRotation();
    }
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
  const EDITOR_PREVIEW_MAX_SIDE = 1600;
  const NETLIFY_SAFE_UPLOAD_BYTES = Math.floor(5.5 * 1024 * 1024);

  const photoEditor = {
    activePhoto: null,
    imageObj: null,
    previewSource: null,
    previewScale: 1,
    loadSeq: 0,
    renderRafId: null,
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
          const editablePhotos = state.photos.filter(p => !isVideoItem(p));
          const candidates = state.selectedAlbumId
            ? editablePhotos.filter(p => p.albumId === state.selectedAlbumId)
            : editablePhotos;
          const preferred = candidates.find(p => p.hasThumbnail) || candidates[0] || editablePhotos[0];
          if (!preferred) {
            showToast('info', 'Nessuna Foto Modificabile', 'L\'editor supporta solo immagini. Sincronizza almeno una foto da Google Drive.');
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
        this.scheduleRender();
      });
      dom.sliderContrast.addEventListener('input', (e) => {
        this.contrast = Number(e.target.value);
        dom.valContrast.textContent = `${this.contrast}%`;
        this.scheduleRender();
      });
      dom.sliderSaturation.addEventListener('input', (e) => {
        this.saturation = Number(e.target.value);
        dom.valSaturation.textContent = `${this.saturation}%`;
        this.scheduleRender();
      });
      dom.sliderSepia.addEventListener('input', (e) => {
        this.sepia = Number(e.target.value);
        dom.valSepia.textContent = `${this.sepia}%`;
        this.scheduleRender();
      });
      dom.sliderBlur.addEventListener('input', (e) => {
        this.blur = Number(e.target.value);
        dom.valBlur.textContent = `${this.blur}px`;
        this.scheduleRender();
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
      if (state.viewMode !== 'admin' || state.role !== 'admin' || !photo || isVideoItem(photo)) return;
      this.populatePhotoSelector(photo.id);
      dom.modalPhotoEditor.classList.remove('hidden');
      this.loadPhoto(photo);
    },

    close() {
      if (this.renderRafId) {
        cancelAnimationFrame(this.renderRafId);
        this.renderRafId = null;
      }
      this.previewSource = null;
      dom.modalPhotoEditor.classList.add('hidden');
    },

    populatePhotoSelector(selectedId) {
      const albumNames = new Map(state.albums.map(a => [a.id, a.name]));
      dom.editorPhotoSelect.innerHTML = state.photos
        .filter(p => !isVideoItem(p))
        .map(p => {
          const alb = albumNames.get(p.albumId) || 'Album';
          return `<option value="${escapeHtml(p.id)}">${escapeHtml(alb)} — ${escapeHtml(p.originalName)}</option>`;
        })
        .join('');
      if (selectedId) dom.editorPhotoSelect.value = selectedId;
    },

    buildScaledSource(img, maxSide) {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const longest = Math.max(w, h);
      if (!maxSide || longest <= maxSide) {
        return { source: img, scale: 1 };
      }
      const scale = maxSide / longest;
      const scaledCanvas = document.createElement('canvas');
      scaledCanvas.width = Math.max(1, Math.round(w * scale));
      scaledCanvas.height = Math.max(1, Math.round(h * scale));
      const sctx = scaledCanvas.getContext('2d');
      sctx.drawImage(img, 0, 0, scaledCanvas.width, scaledCanvas.height);
      return { source: scaledCanvas, scale };
    },

    loadPhoto(photo) {
      const seq = ++this.loadSeq;
      if (this.renderRafId) {
        cancelAnimationFrame(this.renderRafId);
        this.renderRafId = null;
      }
      this.activePhoto = photo;
      this.imageObj = null;
      this.previewSource = null;
      this.previewScale = 1;
      dom.editorPhotoLabel.textContent = `Caricamento di "${photo.originalName}"...`;

      const ctx = dom.editorCanvas.getContext('2d');
      ctx.clearRect(0, 0, dom.editorCanvas.width, dom.editorCanvas.height);

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (seq !== this.loadSeq) return;
        this.imageObj = img;
        const scaled = this.buildScaledSource(img, EDITOR_PREVIEW_MAX_SIDE);
        this.previewSource = scaled.source;
        this.previewScale = scaled.scale;
        this.resetAdjustments();
        this.render();
        dom.editorPhotoLabel.textContent = `Modifica: ${photo.originalName} (${img.naturalWidth}×${img.naturalHeight}px)`;
      };
      img.onerror = () => {
        if (seq !== this.loadSeq) return;
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

    scheduleRender() {
      if (this.renderRafId !== null) return;
      this.renderRafId = requestAnimationFrame(() => {
        this.renderRafId = null;
        this.render();
      });
    },

    drawToCanvas(canvas, source, blurScale = 1) {
      const ctx = canvas.getContext('2d');
      const srcW = source.naturalWidth || source.width;
      const srcH = source.naturalHeight || source.height;
      const isSideways = (Math.abs(this.rotation) % 180 !== 0);
      canvas.width = isSideways ? srcH : srcW;
      canvas.height = isSideways ? srcW : srcH;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((this.rotation * Math.PI) / 180);
      ctx.scale(this.flipH, this.flipV);
      if ('filter' in ctx) {
        const scaledBlur = Math.max(0, Number((this.blur * blurScale).toFixed(2)));
        ctx.filter = `brightness(${this.brightness}%) contrast(${this.contrast}%) saturate(${this.saturation}%) sepia(${this.sepia}%) blur(${scaledBlur}px)`;
      }
      ctx.drawImage(source, -srcW / 2, -srcH / 2);
      ctx.restore();
    },

    render() {
      const src = this.previewSource || this.imageObj;
      if (!src) return;
      this.drawToCanvas(dom.editorCanvas, src, this.previewScale || 1);
    },

    getPreferredExportMime() {
      if (!this.activePhoto) return 'image/jpeg';
      return ['image/png', 'image/webp'].includes(this.activePhoto.mimeType)
        ? this.activePhoto.mimeType
        : 'image/jpeg';
    },

    async exportBlob({ mimeType = null, quality = 0.92, maxSide = 0 } = {}) {
      if (!this.activePhoto || !this.imageObj) return null;
      const targetMime = mimeType || this.getPreferredExportMime();
      const { source, scale } = this.buildScaledSource(this.imageObj, maxSide);
      const exportCanvas = document.createElement('canvas');
      this.drawToCanvas(exportCanvas, source, scale);

      return new Promise((resolve, reject) => {
        exportCanvas.toBlob(
          (blob) => {
            if (blob) resolve(blob);
            else reject(new Error('Impossibile generare il file immagine esportato.'));
          },
          targetMime,
          quality
        );
      });
    },

    async downloadCopy() {
      if (!this.activePhoto || !this.imageObj) {
        showToast('error', 'Nessuna Foto', 'Carica prima una foto valida nell\'editor.');
        return;
      }
      try {
        const blob = await this.exportBlob({ quality: 0.92 });
        const objUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = `modificata_${this.activePhoto.originalName || 'foto.jpg'}`;
        link.href = objUrl;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
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
        const preferredMime = this.getPreferredExportMime();
        let blob = await this.exportBlob({ mimeType: preferredMime, quality: 0.92 });

        if (state.runtime === 'netlify' && blob.size > NETLIFY_SAFE_UPLOAD_BYTES) {
          if (preferredMime !== 'image/png') {
            for (const q of [0.84, 0.75]) {
              const smaller = await this.exportBlob({ mimeType: preferredMime, quality: q });
              if (smaller.size <= blob.size) blob = smaller;
              if (blob.size <= NETLIFY_SAFE_UPLOAD_BYTES) break;
            }
          }

          if (blob.size > NETLIFY_SAFE_UPLOAD_BYTES) {
            const mbSize = (blob.size / (1024 * 1024)).toFixed(1);
            const confirmed = window.confirm(
              `Questa foto esportata pesa ${mbSize} MB e supera il limite di ~6 MB di Netlify Functions.\n\n` +
              'Vuoi ridimensionarla automaticamente (max 2800px, JPEG) per salvarla su Google Drive?\n' +
              'Premi Annulla per usare invece "Scarica Copia" alla risoluzione originale.'
            );
            if (!confirmed) return;

            blob = await this.exportBlob({ mimeType: 'image/jpeg', quality: 0.88, maxSide: 2800 });
            if (blob.size > NETLIFY_SAFE_UPLOAD_BYTES) {
              blob = await this.exportBlob({ mimeType: 'image/jpeg', quality: 0.82, maxSide: 2200 });
            }
            if (blob.size > NETLIFY_SAFE_UPLOAD_BYTES) {
              throw new Error('La foto resta oltre il limite di 6 MB di Netlify. Usa "Scarica Copia".');
            }
          }
        }

        const res = await fetch(`/api/admin/photos/${encodeURIComponent(this.activePhoto.id)}/save`, {
          method: 'POST',
          headers: {
            'Content-Type': blob.type || preferredMime,
            ...getAuthHeaders()
          },
          body: blob
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

  // =========================================================================
  // CALENDARIO ATTIVITÀ ADMIN (PROGRAMMATE ED IN CORSO)
  // =========================================================================
  const IT_MONTHS = [
    'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
    'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'
  ];
  const IT_WEEKDAYS_LONG = [
    'Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'
  ];
  const ACTIVITY_STATUS_LABELS = {
    scheduled: 'Programmata',
    in_progress: 'In corso',
    completed: 'Completata'
  };

  function toIsoDateLocal(dateObj) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function parseIsoDateLocal(isoStr) {
    if (!isoStr || !/^\d{4}-\d{2}-\d{2}$/.test(isoStr)) return new Date();
    const [y, m, d] = isoStr.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function formatItalianDateLong(isoStr) {
    const dt = parseIsoDateLocal(isoStr);
    return `${IT_WEEKDAYS_LONG[dt.getDay()]} ${dt.getDate()} ${IT_MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
  }

  function formatItalianDateShort(isoStr) {
    if (!isoStr || !/^\d{4}-\d{2}-\d{2}$/.test(isoStr)) return '';
    const [y, m, d] = isoStr.split('-');
    return `${d}/${m}/${y}`;
  }

  function activityOccursOnDate(activity, isoDate) {
    if (!activity || !activity.date) return false;
    const end = activity.endDate || activity.date;
    return isoDate >= activity.date && isoDate <= end;
  }

  function getFilteredActivities() {
    if (state.calendarFilter === 'all') return state.activities;
    return state.activities.filter(a => a.status === state.calendarFilter);
  }

  function sortActivitiesClient(list) {
    return [...list].sort((a, b) => {
      const dateCmp = String(a.date || '').localeCompare(String(b.date || ''));
      if (dateCmp !== 0) return dateCmp;
      const timeCmp = String(a.time || '99:99').localeCompare(String(b.time || '99:99'));
      if (timeCmp !== 0) return timeCmp;
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });
  }

  function renderAdminCalendar() {
    if (!dom.calDaysGrid) return;

    const scheduledCount = state.activities.filter(a => a.status === 'scheduled').length;
    const inProgressCount = state.activities.filter(a => a.status === 'in_progress').length;
    if (dom.calCountScheduled) {
      dom.calCountScheduled.textContent = `${scheduledCount} ${scheduledCount === 1 ? 'programmata' : 'programmate'}`;
    }
    if (dom.calCountInProgress) {
      dom.calCountInProgress.textContent = `${inProgressCount} in corso`;
    }

    if (dom.calMonthLabel) {
      dom.calMonthLabel.textContent = `${IT_MONTHS[state.calendarMonth]} ${state.calendarYear}`;
    }

    if (dom.calFilterChips) {
      dom.calFilterChips.querySelectorAll('.cal-filter-chip').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === state.calendarFilter);
      });
    }

    const filtered = getFilteredActivities();
    const todayIso = toIsoDateLocal(new Date());
    const firstOfMonth = new Date(state.calendarYear, state.calendarMonth, 1);
    const startOffset = (firstOfMonth.getDay() + 6) % 7; // Lunedì = 0
    const gridStart = new Date(state.calendarYear, state.calendarMonth, 1 - startOffset);

    dom.calDaysGrid.innerHTML = '';

    for (let i = 0; i < 42; i++) {
      const cellDate = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      const cellIso = toIsoDateLocal(cellDate);
      const isCurrentMonth = cellDate.getMonth() === state.calendarMonth;
      const isToday = cellIso === todayIso;
      const isSelected = cellIso === state.calendarSelectedDate;

      const dayActivities = filtered.filter(a => activityOccursOnDate(a, cellIso));

      const cell = document.createElement('div');
      cell.className = 'calendar-day-cell';
      if (!isCurrentMonth) cell.classList.add('other-month');
      if (isToday) cell.classList.add('today');
      if (isSelected) cell.classList.add('selected');
      cell.dataset.date = cellIso;

      const top = document.createElement('div');
      top.className = 'cal-day-top';
      const num = document.createElement('span');
      num.className = 'cal-day-num';
      num.textContent = String(cellDate.getDate());
      top.appendChild(num);
      cell.appendChild(top);

      if (dayActivities.length > 0) {
        const eventsWrap = document.createElement('div');
        eventsWrap.className = 'cal-day-events';

        const maxVisible = 3;
        dayActivities.slice(0, maxVisible).forEach(act => {
          const pill = document.createElement('button');
          pill.type = 'button';
          pill.className = `cal-event-pill status-${act.status || 'scheduled'}`;
          pill.title = `${act.time ? act.time + ' • ' : ''}${act.title} (${ACTIVITY_STATUS_LABELS[act.status] || 'Programmata'})`;
          pill.innerHTML = `
            <span class="cal-event-dot"></span>
            <span class="cal-event-title-text">${act.time ? escapeHtml(act.time) + ' ' : ''}${escapeHtml(act.title)}</span>
          `;
          pill.addEventListener('click', (e) => {
            e.stopPropagation();
            openActivityModal(act);
          });
          eventsWrap.appendChild(pill);
        });

        if (dayActivities.length > maxVisible) {
          const more = document.createElement('span');
          more.className = 'cal-more-indicator';
          more.textContent = `+${dayActivities.length - maxVisible} altre`;
          eventsWrap.appendChild(more);
        }

        cell.appendChild(eventsWrap);
      }

      cell.addEventListener('click', () => {
        state.calendarSelectedDate = cellIso;
        state.calendarAgendaMode = 'day';
        if (!isCurrentMonth) {
          state.calendarYear = cellDate.getFullYear();
          state.calendarMonth = cellDate.getMonth();
        }
        renderAdminCalendar();
      });

      cell.addEventListener('dblclick', () => {
        state.calendarSelectedDate = cellIso;
        openActivityModal(null, cellIso);
      });

      dom.calDaysGrid.appendChild(cell);
    }

    renderCalendarAgenda();
  }

  function renderCalendarAgenda() {
    if (!dom.calAgendaList) return;

    if (dom.btnAgendaDay) dom.btnAgendaDay.classList.toggle('active', state.calendarAgendaMode === 'day');
    if (dom.btnAgendaUpcoming) dom.btnAgendaUpcoming.classList.toggle('active', state.calendarAgendaMode === 'upcoming');

    const todayIso = toIsoDateLocal(new Date());
    let items = [];

    if (state.calendarAgendaMode === 'upcoming') {
      if (dom.calSelectedDateLabel) dom.calSelectedDateLabel.textContent = 'Attività in corso & Prossime';
      items = sortActivitiesClient(
        state.activities.filter(a => {
          if (state.calendarFilter !== 'all' && a.status !== state.calendarFilter) return false;
          if (a.status === 'in_progress') return true;
          const end = a.endDate || a.date;
          return a.status === 'scheduled' && end >= todayIso;
        })
      );
      if (dom.calAgendaEmptyText) {
        dom.calAgendaEmptyText.textContent = 'Nessuna attività in corso o programmata nei prossimi giorni.';
      }
    } else {
      if (dom.calSelectedDateLabel) {
        dom.calSelectedDateLabel.textContent = formatItalianDateLong(state.calendarSelectedDate);
      }
      items = sortActivitiesClient(
        getFilteredActivities().filter(a => activityOccursOnDate(a, state.calendarSelectedDate))
      );
      if (dom.calAgendaEmptyText) {
        dom.calAgendaEmptyText.textContent = 'Nessuna attività segnata per questa data.';
      }
    }

    if (dom.calAgendaCount) {
      dom.calAgendaCount.textContent = `${items.length} ${items.length === 1 ? 'attività' : 'attività'}`;
    }

    dom.calAgendaList.innerHTML = '';

    if (items.length === 0) {
      if (dom.calAgendaEmpty) dom.calAgendaEmpty.classList.remove('hidden');
      return;
    }

    if (dom.calAgendaEmpty) dom.calAgendaEmpty.classList.add('hidden');

    items.forEach(act => {
      const card = document.createElement('div');
      card.className = `activity-card status-${act.status || 'scheduled'}`;

      const statusLabel = ACTIVITY_STATUS_LABELS[act.status] || 'Programmata';
      const dateRange =
        act.endDate && act.endDate !== act.date
          ? `${formatItalianDateShort(act.date)} → ${formatItalianDateShort(act.endDate)}`
          : formatItalianDateShort(act.date);

      const metaParts = [];
      metaParts.push(`<span class="activity-meta-item">📅 ${escapeHtml(dateRange)}</span>`);
      if (act.time) metaParts.push(`<span class="activity-meta-item">🕒 ${escapeHtml(act.time)}</span>`);
      if (act.client) metaParts.push(`<span class="activity-meta-item">👤 ${escapeHtml(act.client)}</span>`);
      if (act.location) metaParts.push(`<span class="activity-meta-item">📍 ${escapeHtml(act.location)}</span>`);

      card.innerHTML = `
        <div class="activity-card-top">
          <div class="activity-card-title">${escapeHtml(act.title)}</div>
          <span class="activity-status-badge status-${escapeHtml(act.status || 'scheduled')}">${escapeHtml(statusLabel)}</span>
        </div>
        <div class="activity-card-meta">${metaParts.join('')}</div>
        ${act.notes ? `<div class="activity-card-notes">${escapeHtml(act.notes)}</div>` : ''}
      `;

      const actionsRow = document.createElement('div');
      actionsRow.className = 'activity-card-actions';

      const statusBtn = document.createElement('button');
      statusBtn.type = 'button';
      if (act.status === 'scheduled') {
        statusBtn.className = 'btn-activity-mini btn-status-next';
        statusBtn.textContent = 'Segna In corso';
        statusBtn.addEventListener('click', () => quickUpdateActivityStatus(act, 'in_progress'));
      } else if (act.status === 'in_progress') {
        statusBtn.className = 'btn-activity-mini btn-status-done';
        statusBtn.textContent = 'Segna Completata';
        statusBtn.addEventListener('click', () => quickUpdateActivityStatus(act, 'completed'));
      } else {
        statusBtn.className = 'btn-activity-mini';
        statusBtn.textContent = 'Riprogramma';
        statusBtn.addEventListener('click', () => quickUpdateActivityStatus(act, 'scheduled'));
      }

      const rightBtns = document.createElement('div');
      rightBtns.className = 'activity-card-btns';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn-activity-mini';
      editBtn.textContent = 'Modifica';
      editBtn.addEventListener('click', () => openActivityModal(act));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-activity-mini btn-delete-mini';
      delBtn.textContent = 'Elimina';
      delBtn.addEventListener('click', () => deleteActivityById(act.id, act.title));

      rightBtns.appendChild(editBtn);
      rightBtns.appendChild(delBtn);

      actionsRow.appendChild(statusBtn);
      actionsRow.appendChild(rightBtns);
      card.appendChild(actionsRow);

      dom.calAgendaList.appendChild(card);
    });
  }

  function openActivityModal(activity = null, defaultDate = null) {
    if (!dom.modalActivity) return;
    clearErrors();

    if (activity) {
      state.editingActivityId = activity.id;
      dom.activityModalTitle.textContent = 'Modifica Attività';
      dom.activityModalSubtitle.textContent = 'Aggiorna stato, data o dettagli dell\'attività';
      const saveLabel = dom.btnSaveActivity?.querySelector('.btn-text');
      if (saveLabel) saveLabel.textContent = 'Salva Modifiche';
      dom.activityTitle.value = activity.title || '';
      dom.activityStatus.value = activity.status || 'scheduled';
      dom.activityTime.value = activity.time || '';
      dom.activityDate.value = activity.date || state.calendarSelectedDate;
      dom.activityEndDate.value = activity.endDate && activity.endDate !== activity.date ? activity.endDate : '';
      dom.activityClient.value = activity.client || '';
      dom.activityLocation.value = activity.location || '';
      dom.activityNotes.value = activity.notes || '';
      dom.btnDeleteActivity.classList.remove('hidden');
    } else {
      state.editingActivityId = null;
      const targetDate = defaultDate || state.calendarSelectedDate || toIsoDateLocal(new Date());
      dom.activityModalTitle.textContent = 'Nuova Attività';
      dom.activityModalSubtitle.textContent = 'Segna un\'attività programmata o in corso sul calendario';
      const saveLabel = dom.btnSaveActivity?.querySelector('.btn-text');
      if (saveLabel) saveLabel.textContent = 'Salva Attività';
      dom.activityTitle.value = '';
      dom.activityStatus.value = 'scheduled';
      dom.activityTime.value = '';
      dom.activityDate.value = targetDate;
      dom.activityEndDate.value = '';
      dom.activityClient.value = '';
      dom.activityLocation.value = '';
      dom.activityNotes.value = '';
      dom.btnDeleteActivity.classList.add('hidden');
    }

    dom.modalActivity.classList.remove('hidden');
    dom.activityTitle.focus();
  }

  function closeActivityModal() {
    if (!dom.modalActivity) return;
    dom.modalActivity.classList.add('hidden');
    state.editingActivityId = null;
  }

  async function quickUpdateActivityStatus(activity, nextStatus) {
    try {
      const res = await fetch(`/api/admin/activities/${encodeURIComponent(activity.id)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify({ status: nextStatus })
      });
      const data = await res.json();
      if (res.status === 401 || res.status === 403) {
        await performAdminLogout({ expired: true });
        return;
      }
      if (!res.ok) throw new Error(data.message || 'Errore aggiornamento stato.');

      if (data.activity) {
        const idx = state.activities.findIndex(a => a.id === data.activity.id);
        if (idx !== -1) state.activities[idx] = data.activity;
      }
      renderAdminCalendar();
      showToast('success', 'Stato Aggiornato', `"${activity.title}" → ${ACTIVITY_STATUS_LABELS[nextStatus]}.`);
    } catch (err) {
      showToast('error', 'Errore', err.message || 'Impossibile aggiornare lo stato.');
    }
  }

  async function deleteActivityById(activityId, activityTitle = '') {
    const label = activityTitle ? `"${activityTitle}"` : 'questa attività';
    if (!window.confirm(`Vuoi davvero eliminare ${label} dal calendario?`)) return;

    try {
      const res = await fetch(`/api/admin/activities/${encodeURIComponent(activityId)}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (res.status === 401 || res.status === 403) {
        await performAdminLogout({ expired: true });
        return;
      }
      if (!res.ok) throw new Error(data.message || 'Errore eliminazione attività.');

      state.activities = state.activities.filter(a => a.id !== activityId);
      if (state.editingActivityId === activityId) {
        closeActivityModal();
      }
      renderAdminCalendar();
      showToast('success', 'Attività Eliminata', data.message || 'Rimossa dal calendario.');
    } catch (err) {
      showToast('error', 'Errore Eliminazione', err.message || 'Impossibile eliminare l\'attività.');
    }
  }

  function bindAdminCalendarEvents() {
    if (!dom.calDaysGrid) return;

    dom.btnOpenNewActivity?.addEventListener('click', () => {
      openActivityModal(null, state.calendarSelectedDate);
    });

    dom.btnAddActivitySelectedDay?.addEventListener('click', () => {
      openActivityModal(null, state.calendarSelectedDate);
    });

    dom.btnCalPrevMonth?.addEventListener('click', () => {
      if (state.calendarMonth === 0) {
        state.calendarMonth = 11;
        state.calendarYear -= 1;
      } else {
        state.calendarMonth -= 1;
      }
      renderAdminCalendar();
    });

    dom.btnCalNextMonth?.addEventListener('click', () => {
      if (state.calendarMonth === 11) {
        state.calendarMonth = 0;
        state.calendarYear += 1;
      } else {
        state.calendarMonth += 1;
      }
      renderAdminCalendar();
    });

    dom.btnCalToday?.addEventListener('click', () => {
      const now = new Date();
      state.calendarYear = now.getFullYear();
      state.calendarMonth = now.getMonth();
      state.calendarSelectedDate = toIsoDateLocal(now);
      state.calendarAgendaMode = 'day';
      renderAdminCalendar();
    });

    dom.calFilterChips?.addEventListener('click', (e) => {
      const btn = e.target.closest('.cal-filter-chip');
      if (!btn || !btn.dataset.filter) return;
      state.calendarFilter = btn.dataset.filter;
      renderAdminCalendar();
    });

    dom.btnAgendaDay?.addEventListener('click', () => {
      state.calendarAgendaMode = 'day';
      renderCalendarAgenda();
    });

    dom.btnAgendaUpcoming?.addEventListener('click', () => {
      state.calendarAgendaMode = 'upcoming';
      renderCalendarAgenda();
    });

    dom.btnCloseActivityModal?.addEventListener('click', closeActivityModal);
    dom.btnCancelActivityModal?.addEventListener('click', closeActivityModal);
    dom.modalActivity?.addEventListener('click', (e) => {
      if (e.target === dom.modalActivity) closeActivityModal();
    });

    dom.btnDeleteActivity?.addEventListener('click', () => {
      if (!state.editingActivityId) return;
      const current = state.activities.find(a => a.id === state.editingActivityId);
      deleteActivityById(state.editingActivityId, current?.title || '');
    });

    dom.formActivity?.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearErrors();

      const title = dom.activityTitle.value.trim();
      const status = dom.activityStatus.value;
      const date = dom.activityDate.value.trim();
      const endDate = dom.activityEndDate.value.trim();
      const time = dom.activityTime.value.trim();
      const client = dom.activityClient.value.trim();
      const location = dom.activityLocation.value.trim();
      const notes = dom.activityNotes.value.trim();

      let valid = true;
      if (!title || title.length < 2) {
        setError(dom.activityTitle, dom.activityTitleError, 'Inserisci un titolo (almeno 2 caratteri).');
        valid = false;
      }
      if (!date) {
        setError(dom.activityDate, dom.activityDateError, 'Seleziona una data di inizio.');
        valid = false;
      } else if (endDate && endDate < date) {
        setError(dom.activityEndDate, dom.activityDateError, 'La data di fine non può precedere la data di inizio.');
        valid = false;
      }
      if (!valid) return;

      const isEditing = Boolean(state.editingActivityId);
      const endpoint = isEditing
        ? `/api/admin/activities/${encodeURIComponent(state.editingActivityId)}`
        : '/api/admin/activities';
      const method = isEditing ? 'PUT' : 'POST';

      setButtonLoading(dom.btnSaveActivity, true);
      try {
        const res = await fetch(endpoint, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders()
          },
          body: JSON.stringify({ title, status, date, endDate, time, client, location, notes })
        });
        const data = await res.json();
        if (res.status === 401 || res.status === 403) {
          await performAdminLogout({ expired: true });
          return;
        }
        if (!res.ok) throw new Error(data.message || 'Errore salvataggio attività.');

        if (data.activity) {
          if (isEditing) {
            const idx = state.activities.findIndex(a => a.id === data.activity.id);
            if (idx !== -1) state.activities[idx] = data.activity;
            else state.activities.push(data.activity);
          } else {
            state.activities.push(data.activity);
          }
          state.activities = sortActivitiesClient(state.activities);
          state.calendarSelectedDate = data.activity.date;
          const dt = parseIsoDateLocal(data.activity.date);
          state.calendarYear = dt.getFullYear();
          state.calendarMonth = dt.getMonth();
        }

        closeActivityModal();
        renderAdminCalendar();
        showToast('success', isEditing ? 'Attività Aggiornata' : 'Attività Aggiunta', data.message);
      } catch (err) {
        showToast('error', 'Errore Salvataggio', err.message || 'Impossibile salvare l\'attività.');
      } finally {
        setButtonLoading(dom.btnSaveActivity, false);
      }
    });
  }

  // =========================================================================
  // GESTIONE CASSA & CONTABILITÀ ADMIN
  // =========================================================================
  const EURO_FORMATTER = new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  const PAYMENT_METHOD_LABELS = {
    cash: 'Contanti',
    bank_transfer: 'Bonifico',
    card: 'Carta / POS',
    other: 'Altro'
  };

  function formatEuro(amount) {
    return EURO_FORMATTER.format(Number(amount) || 0);
  }

  function sortTransactionsClient(list) {
    return [...list].sort((a, b) => {
      const dateCmp = String(b.date || '').localeCompare(String(a.date || ''));
      if (dateCmp !== 0) return dateCmp;
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
  }

  function matchesCashPeriod(isoDate, period) {
    if (!period || period === 'all') return true;
    if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return false;
    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = now.getMonth() + 1;
    const [y, m] = isoDate.split('-').map(Number);

    if (period === 'this_month') return y === curYear && m === curMonth;
    if (period === 'this_year') return y === curYear;
    if (period === 'last_month') {
      const prevYear = curMonth === 1 ? curYear - 1 : curYear;
      const prevMonth = curMonth === 1 ? 12 : curMonth - 1;
      return y === prevYear && m === prevMonth;
    }
    return true;
  }

  function getCashBaseFilteredTransactions() {
    const q = state.cashSearchQuery.trim().toLowerCase();
    return state.transactions.filter((t) => {
      if (!matchesCashPeriod(t.date, state.cashPeriodFilter)) return false;
      if (state.cashMethodFilter !== 'all' && t.paymentMethod !== state.cashMethodFilter) return false;
      if (q) {
        const hay = `${t.description || ''} ${t.category || ''} ${t.clientOrVendor || ''} ${t.invoiceRef || ''} ${t.notes || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function getFilteredTransactions() {
    const base = getCashBaseFilteredTransactions();
    if (state.cashTypeFilter === 'income') return base.filter(t => t.type === 'income');
    if (state.cashTypeFilter === 'expense') return base.filter(t => t.type === 'expense');
    if (state.cashTypeFilter === 'pending') return base.filter(t => t.status === 'pending');
    return base;
  }

  function renderAdminCash() {
    if (!dom.cashTableBody) return;

    if (dom.cashTypeChips) {
      dom.cashTypeChips.querySelectorAll('.cal-filter-chip').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.type === state.cashTypeFilter);
      });
    }

    const baseList = getCashBaseFilteredTransactions();
    let paidIncome = 0;
    let paidIncomeCount = 0;
    let paidExpense = 0;
    let paidExpenseCount = 0;
    let pendingIncome = 0;
    let pendingExpense = 0;

    for (const t of baseList) {
      const amt = Number(t.amount) || 0;
      if (t.status === 'pending') {
        if (t.type === 'expense') pendingExpense += amt;
        else pendingIncome += amt;
      } else if (t.type === 'expense') {
        paidExpense += amt;
        paidExpenseCount += 1;
      } else {
        paidIncome += amt;
        paidIncomeCount += 1;
      }
    }

    const balance = paidIncome - paidExpense;
    const totalPending = pendingIncome + pendingExpense;

    if (dom.cashKpiBalance) {
      dom.cashKpiBalance.textContent = formatEuro(balance);
      dom.cashKpiBalance.classList.toggle('is-positive', balance > 0);
      dom.cashKpiBalance.classList.toggle('is-negative', balance < 0);
    }
    if (dom.cashKpiBalanceSub) {
      dom.cashKpiBalanceSub.textContent = `${baseList.length} ${baseList.length === 1 ? 'movimento' : 'movimenti'} nel periodo`;
    }
    if (dom.cashKpiIncome) dom.cashKpiIncome.textContent = formatEuro(paidIncome);
    if (dom.cashKpiIncomeSub) {
      dom.cashKpiIncomeSub.textContent = `${paidIncomeCount} ${paidIncomeCount === 1 ? 'entrata incassata' : 'entrate incassate'}`;
    }
    if (dom.cashKpiExpense) dom.cashKpiExpense.textContent = formatEuro(paidExpense);
    if (dom.cashKpiExpenseSub) {
      dom.cashKpiExpenseSub.textContent = `${paidExpenseCount} ${paidExpenseCount === 1 ? 'uscita pagata' : 'uscite pagate'}`;
    }
    if (dom.cashKpiPending) dom.cashKpiPending.textContent = formatEuro(totalPending);
    if (dom.cashKpiPendingSub) {
      dom.cashKpiPendingSub.textContent = `Da incassare: ${formatEuro(pendingIncome)} • Da pagare: ${formatEuro(pendingExpense)}`;
    }

    const list = sortTransactionsClient(getFilteredTransactions());
    dom.cashTableBody.innerHTML = '';

    if (list.length === 0) {
      if (dom.cashTable) dom.cashTable.classList.add('hidden');
      if (dom.cashTableEmpty) dom.cashTableEmpty.classList.remove('hidden');
      return;
    }

    if (dom.cashTable) dom.cashTable.classList.remove('hidden');
    if (dom.cashTableEmpty) dom.cashTableEmpty.classList.add('hidden');

    list.forEach((txn) => {
      const tr = document.createElement('tr');
      const isExpense = txn.type === 'expense';
      const isPending = txn.status === 'pending';
      const methodLabel = PAYMENT_METHOD_LABELS[txn.paymentMethod] || 'Altro';
      const statusLabel = isPending ? 'In sospeso' : (isExpense ? 'Pagato' : 'Incassato');
      const sign = isExpense ? '- ' : '+ ';

      const tdDate = document.createElement('td');
      tdDate.textContent = formatItalianDateShort(txn.date);

      const tdDesc = document.createElement('td');
      tdDesc.innerHTML = `
        <div class="cash-desc-title">${escapeHtml(txn.description)}</div>
        <div class="cash-desc-meta">
          <span class="cash-cat-pill">${escapeHtml(txn.category || 'Altro')}</span>
          ${txn.invoiceRef ? `<span>Rif. ${escapeHtml(txn.invoiceRef)}</span>` : ''}
          ${txn.notes ? `<span>• ${escapeHtml(txn.notes.length > 60 ? txn.notes.slice(0, 60) + '…' : txn.notes)}</span>` : ''}
        </div>
      `;

      const tdClient = document.createElement('td');
      tdClient.textContent = txn.clientOrVendor || '—';

      const tdMethod = document.createElement('td');
      tdMethod.textContent = methodLabel;

      const tdStatus = document.createElement('td');
      const statusBtn = document.createElement('button');
      statusBtn.type = 'button';
      statusBtn.className = `cash-status-pill ${isPending ? 'pending' : 'paid'}`;
      statusBtn.title = isPending ? 'Clicca per segnare come incassato/pagato' : 'Clicca per segnare in sospeso';
      statusBtn.textContent = statusLabel;
      statusBtn.addEventListener('click', () => toggleTransactionStatus(txn));
      tdStatus.appendChild(statusBtn);

      const tdAmount = document.createElement('td');
      tdAmount.className = `text-right cash-amount ${isExpense ? 'expense' : 'income'}`;
      tdAmount.textContent = `${sign}${formatEuro(txn.amount)}`;

      const tdActions = document.createElement('td');
      tdActions.className = 'text-right';
      const actionsWrap = document.createElement('div');
      actionsWrap.className = 'cash-row-actions';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn-activity-mini btn-edit-mini';
      editBtn.textContent = 'Modifica';
      editBtn.addEventListener('click', () => openTransactionModal(txn));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-activity-mini btn-delete-mini';
      delBtn.textContent = 'Elimina';
      delBtn.addEventListener('click', () => deleteTransactionById(txn.id, txn.description));

      actionsWrap.appendChild(editBtn);
      actionsWrap.appendChild(delBtn);
      tdActions.appendChild(actionsWrap);

      tr.appendChild(tdDate);
      tr.appendChild(tdDesc);
      tr.appendChild(tdClient);
      tr.appendChild(tdMethod);
      tr.appendChild(tdStatus);
      tr.appendChild(tdAmount);
      tr.appendChild(tdActions);
      dom.cashTableBody.appendChild(tr);
    });
  }

  function setTxnModalType(type) {
    state.txnModalType = type === 'expense' ? 'expense' : 'income';
    if (dom.btnTxnTypeIncome) {
      dom.btnTxnTypeIncome.classList.toggle('active-income', state.txnModalType === 'income');
    }
    if (dom.btnTxnTypeExpense) {
      dom.btnTxnTypeExpense.classList.toggle('active-expense', state.txnModalType === 'expense');
    }
  }

  function openTransactionModal(txn = null, defaultType = 'income') {
    if (!dom.modalTransaction) return;
    clearErrors();

    if (txn) {
      state.editingTxnId = txn.id;
      setTxnModalType(txn.type);
      dom.txnModalTitle.textContent = 'Modifica Movimento Cassa';
      dom.txnModalSubtitle.textContent = 'Aggiorna importo, stato o dettagli del movimento contabile';
      const saveLabel = dom.btnSaveTxn?.querySelector('.btn-text');
      if (saveLabel) saveLabel.textContent = 'Salva Modifiche';
      dom.txnDescription.value = txn.description || '';
      dom.txnAmount.value = Number(txn.amount || 0).toFixed(2);
      dom.txnDate.value = txn.date || toIsoDateLocal(new Date());
      dom.txnCategory.value = txn.category || '';
      dom.txnMethod.value = txn.paymentMethod || 'bank_transfer';
      dom.txnStatus.value = txn.status || 'paid';
      dom.txnInvoiceRef.value = txn.invoiceRef || '';
      dom.txnClient.value = txn.clientOrVendor || '';
      dom.txnNotes.value = txn.notes || '';
      dom.btnDeleteTxn.classList.remove('hidden');
    } else {
      state.editingTxnId = null;
      setTxnModalType(defaultType);
      dom.txnModalTitle.textContent = defaultType === 'expense' ? 'Nuova Uscita' : 'Nuova Entrata';
      dom.txnModalSubtitle.textContent = 'Registra un movimento nella contabilità dello studio';
      const saveLabel = dom.btnSaveTxn?.querySelector('.btn-text');
      if (saveLabel) saveLabel.textContent = 'Salva Movimento';
      dom.txnDescription.value = '';
      dom.txnAmount.value = '';
      dom.txnDate.value = toIsoDateLocal(new Date());
      dom.txnCategory.value = '';
      dom.txnMethod.value = 'bank_transfer';
      dom.txnStatus.value = 'paid';
      dom.txnInvoiceRef.value = '';
      dom.txnClient.value = '';
      dom.txnNotes.value = '';
      dom.btnDeleteTxn.classList.add('hidden');
    }

    dom.modalTransaction.classList.remove('hidden');
    dom.txnDescription.focus();
  }

  function closeTransactionModal() {
    if (!dom.modalTransaction) return;
    dom.modalTransaction.classList.add('hidden');
    state.editingTxnId = null;
  }

  async function toggleTransactionStatus(txn) {
    const nextStatus = txn.status === 'pending' ? 'paid' : 'pending';
    try {
      const res = await fetch(`/api/admin/transactions/${encodeURIComponent(txn.id)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify({ status: nextStatus })
      });
      const data = await res.json();
      if (res.status === 401 || res.status === 403) {
        await performAdminLogout({ expired: true });
        return;
      }
      if (!res.ok) throw new Error(data.message || 'Errore aggiornamento stato.');

      if (data.transaction) {
        const idx = state.transactions.findIndex(t => t.id === data.transaction.id);
        if (idx !== -1) state.transactions[idx] = data.transaction;
      }
      renderAdminCash();
      showToast(
        'success',
        'Stato Aggiornato',
        `"${txn.description}" segnato come ${nextStatus === 'paid' ? (txn.type === 'expense' ? 'Pagato' : 'Incassato') : 'In sospeso'}.`
      );
    } catch (err) {
      showToast('error', 'Errore', err.message || 'Impossibile aggiornare lo stato.');
    }
  }

  async function deleteTransactionById(txnId, description = '') {
    const label = description ? `"${description}"` : 'questo movimento';
    if (!window.confirm(`Vuoi davvero eliminare ${label} dalla cassa?`)) return;

    try {
      const res = await fetch(`/api/admin/transactions/${encodeURIComponent(txnId)}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (res.status === 401 || res.status === 403) {
        await performAdminLogout({ expired: true });
        return;
      }
      if (!res.ok) throw new Error(data.message || 'Errore eliminazione movimento.');

      state.transactions = state.transactions.filter(t => t.id !== txnId);
      if (state.editingTxnId === txnId) {
        closeTransactionModal();
      }
      renderAdminCash();
      showToast('success', 'Movimento Eliminato', data.message || 'Rimosso dalla cassa.');
    } catch (err) {
      showToast('error', 'Errore Eliminazione', err.message || 'Impossibile eliminare il movimento.');
    }
  }

  function exportCashCsv() {
    const list = sortTransactionsClient(getFilteredTransactions());
    if (list.length === 0) {
      showToast('info', 'Esportazione CSV', 'Nessun movimento da esportare con i filtri attuali.');
      return;
    }

    const csvEscape = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;
    const header = ['Data', 'Tipo', 'Descrizione', 'Categoria', 'Cliente/Fornitore', 'Metodo', 'Stato', 'Rif. Fattura', 'Importo (EUR)', 'Note'];
    const rows = list.map((t) => {
      const signed = t.type === 'expense' ? -Math.abs(Number(t.amount) || 0) : Math.abs(Number(t.amount) || 0);
      return [
        t.date,
        t.type === 'expense' ? 'Uscita' : 'Entrata',
        t.description,
        t.category || 'Altro',
        t.clientOrVendor || '',
        PAYMENT_METHOD_LABELS[t.paymentMethod] || 'Altro',
        t.status === 'pending' ? 'In sospeso' : (t.type === 'expense' ? 'Pagato' : 'Incassato'),
        t.invoiceRef || '',
        signed.toFixed(2).replace('.', ','),
        t.notes || ''
      ].map(csvEscape).join(';');
    });

    const csvContent = '\uFEFF' + [header.map(csvEscape).join(';'), ...rows].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `cassa_contabilita_${toIsoDateLocal(new Date())}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast('success', 'CSV Esportato', `${list.length} movimenti esportati in formato CSV.`);
  }

  function openCashManagerModal() {
    if (!dom.modalCashManager) return;
    renderAdminCash();
    dom.modalCashManager.classList.remove('hidden');
  }

  function closeCashManagerModal() {
    if (!dom.modalCashManager) return;
    dom.modalCashManager.classList.add('hidden');
  }

  function bindAdminCashEvents() {
    if (!dom.cashTableBody) return;

    dom.btnOpenCashAdmin?.addEventListener('click', openCashManagerModal);
    dom.btnCloseCashManager?.addEventListener('click', closeCashManagerModal);
    dom.modalCashManager?.addEventListener('click', (e) => {
      if (e.target === dom.modalCashManager) closeCashManagerModal();
    });

    dom.btnNewIncome?.addEventListener('click', () => openTransactionModal(null, 'income'));
    dom.btnNewExpense?.addEventListener('click', () => openTransactionModal(null, 'expense'));
    dom.btnExportCashCsv?.addEventListener('click', exportCashCsv);

    dom.cashTypeChips?.addEventListener('click', (e) => {
      const btn = e.target.closest('.cal-filter-chip');
      if (!btn || !btn.dataset.type) return;
      state.cashTypeFilter = btn.dataset.type;
      renderAdminCash();
    });

    dom.cashPeriodFilter?.addEventListener('change', () => {
      state.cashPeriodFilter = dom.cashPeriodFilter.value || 'all';
      renderAdminCash();
    });

    dom.cashMethodFilter?.addEventListener('change', () => {
      state.cashMethodFilter = dom.cashMethodFilter.value || 'all';
      renderAdminCash();
    });

    dom.cashSearchInput?.addEventListener('input', () => {
      state.cashSearchQuery = dom.cashSearchInput.value || '';
      renderAdminCash();
    });

    dom.btnTxnTypeIncome?.addEventListener('click', () => setTxnModalType('income'));
    dom.btnTxnTypeExpense?.addEventListener('click', () => setTxnModalType('expense'));

    dom.btnCloseTxnModal?.addEventListener('click', closeTransactionModal);
    dom.btnCancelTxnModal?.addEventListener('click', closeTransactionModal);
    dom.modalTransaction?.addEventListener('click', (e) => {
      if (e.target === dom.modalTransaction) closeTransactionModal();
    });

    dom.btnDeleteTxn?.addEventListener('click', () => {
      if (!state.editingTxnId) return;
      const cur = state.transactions.find(t => t.id === state.editingTxnId);
      deleteTransactionById(state.editingTxnId, cur?.description || '');
    });

    dom.formTransaction?.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearErrors();

      const type = state.txnModalType;
      const description = dom.txnDescription.value.trim();
      const amount = Number(String(dom.txnAmount.value || '').replace(',', '.'));
      const date = dom.txnDate.value.trim();
      const category = dom.txnCategory.value.trim() || 'Altro';
      const paymentMethod = dom.txnMethod.value;
      const status = dom.txnStatus.value;
      const invoiceRef = dom.txnInvoiceRef.value.trim();
      const clientOrVendor = dom.txnClient.value.trim();
      const notes = dom.txnNotes.value.trim();

      let valid = true;
      if (!description || description.length < 2) {
        setError(dom.txnDescription, dom.txnDescriptionError, 'Inserisci una descrizione (almeno 2 caratteri).');
        valid = false;
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        setError(dom.txnAmount, dom.txnAmountError, 'Inserisci un importo valido maggiore di 0.');
        valid = false;
      }
      if (!date) {
        setError(dom.txnDate, dom.txnDateError, 'Seleziona una data.');
        valid = false;
      }
      if (!valid) return;

      const isEditing = Boolean(state.editingTxnId);
      const endpoint = isEditing
        ? `/api/admin/transactions/${encodeURIComponent(state.editingTxnId)}`
        : '/api/admin/transactions';
      const method = isEditing ? 'PUT' : 'POST';

      setButtonLoading(dom.btnSaveTxn, true);
      try {
        const res = await fetch(endpoint, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders()
          },
          body: JSON.stringify({
            type,
            description,
            amount,
            date,
            category,
            paymentMethod,
            status,
            invoiceRef,
            clientOrVendor,
            notes
          })
        });
        const data = await res.json();
        if (res.status === 401 || res.status === 403) {
          await performAdminLogout({ expired: true });
          return;
        }
        if (!res.ok) throw new Error(data.message || 'Errore salvataggio movimento.');

        if (data.transaction) {
          if (isEditing) {
            const idx = state.transactions.findIndex(t => t.id === data.transaction.id);
            if (idx !== -1) state.transactions[idx] = data.transaction;
            else state.transactions.push(data.transaction);
          } else {
            state.transactions.push(data.transaction);
          }
          state.transactions = sortTransactionsClient(state.transactions);
        }

        closeTransactionModal();
        renderAdminCash();
        showToast('success', isEditing ? 'Movimento Aggiornato' : 'Movimento Registrato', data.message);
      } catch (err) {
        showToast('error', 'Errore Salvataggio', err.message || 'Impossibile salvare il movimento.');
      } finally {
        setButtonLoading(dom.btnSaveTxn, false);
      }
    });
  }

  // =========================================================================
  // SERVIZI OFFERTI & LISTINO PREZZI (ADMIN + CLIENTE)
  // =========================================================================
  function formatServicePrice(price) {
    const num = Number(price) || 0;
    if (num === 0) return 'Su preventivo';
    return formatEuro(num);
  }

  function sortServicesClient(list) {
    return [...list].sort((a, b) => {
      const catCmp = String(a.category || '').localeCompare(String(b.category || ''), 'it');
      if (catCmp !== 0) return catCmp;
      return String(a.name || '').localeCompare(String(b.name || ''), 'it');
    });
  }

  function getFilteredAdminServices() {
    const query = String(state.servicesSearchQuery || '').trim().toLowerCase();
    return state.services.filter((srv) => {
      if (state.servicesFilter === 'active' && srv.active === false) return false;
      if (state.servicesFilter === 'hidden' && srv.active !== false) return false;
      if (query) {
        const haystack = [srv.name, srv.category, srv.description, srv.priceUnit]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }

  function renderAdminServices() {
    if (!dom.adminServicesList) return;

    dom.servicesStatusChips?.querySelectorAll('.cal-filter-chip').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.filter === state.servicesFilter);
    });

    const filtered = sortServicesClient(getFilteredAdminServices());
    if (dom.adminServicesCount) {
      dom.adminServicesCount.textContent = `${state.services.length} ${state.services.length === 1 ? 'servizio' : 'servizi'}`;
    }

    dom.adminServicesList.innerHTML = '';
    if (filtered.length === 0) {
      dom.adminServicesEmpty?.classList.remove('hidden');
      return;
    }
    dom.adminServicesEmpty?.classList.add('hidden');

    filtered.forEach((srv) => {
      const card = document.createElement('div');
      card.className = `service-card${srv.active === false ? ' is-hidden-service' : ''}`;

      const top = document.createElement('div');
      top.className = 'service-card-top';

      const titleWrap = document.createElement('div');
      titleWrap.className = 'service-card-title-wrap';
      titleWrap.innerHTML = `
        <span class="cash-cat-pill">${escapeHtml(srv.category || 'Servizio Fotografico')}</span>
        <div class="service-card-name">${escapeHtml(srv.name)}</div>
      `;

      const priceBox = document.createElement('div');
      priceBox.className = 'service-price-box';
      priceBox.innerHTML = `
        <span class="service-price-val">${escapeHtml(formatServicePrice(srv.price))}</span>
        ${srv.priceUnit ? `<span class="service-price-unit">${escapeHtml(srv.priceUnit)}</span>` : ''}
      `;

      top.appendChild(titleWrap);
      top.appendChild(priceBox);
      card.appendChild(top);

      if (srv.description) {
        const desc = document.createElement('p');
        desc.className = 'service-card-desc';
        desc.textContent = srv.description;
        card.appendChild(desc);
      }

      const footer = document.createElement('div');
      footer.className = 'service-card-footer';

      const visBtn = document.createElement('button');
      visBtn.type = 'button';
      visBtn.className = `cash-status-pill ${srv.active === false ? 'pending' : 'paid'}`;
      visBtn.textContent = srv.active === false ? 'Nascosto' : 'Visibile ai clienti';
      visBtn.title = 'Clicca per mostrare o nascondere questo servizio nel link cliente';
      visBtn.addEventListener('click', () => toggleServiceActive(srv));

      const actions = document.createElement('div');
      actions.className = 'cash-row-actions';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn-activity-mini btn-edit-mini';
      editBtn.textContent = 'Modifica';
      editBtn.addEventListener('click', () => openServiceFormModal(srv));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-activity-mini btn-delete-mini';
      delBtn.textContent = 'Elimina';
      delBtn.addEventListener('click', () => deleteServiceById(srv.id, srv.name));

      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      footer.appendChild(visBtn);
      footer.appendChild(actions);
      card.appendChild(footer);

      dom.adminServicesList.appendChild(card);
    });
  }

  function openServicesManagerModal() {
    if (!dom.modalServicesManager) return;
    renderAdminServices();
    dom.modalServicesManager.classList.remove('hidden');
  }

  function closeServicesManagerModal() {
    dom.modalServicesManager?.classList.add('hidden');
  }

  function openServiceFormModal(srv = null) {
    if (!dom.modalServiceForm) return;
    clearErrors();

    if (srv) {
      state.editingServiceId = srv.id;
      dom.serviceFormTitle.textContent = 'Modifica Servizio';
      dom.serviceFormSubtitle.textContent = 'Aggiorna nome, prezzo o visibilità del servizio nel listino clienti';
      const saveLabel = dom.btnSaveService?.querySelector('.btn-text');
      if (saveLabel) saveLabel.textContent = 'Salva Modifiche';
      dom.serviceName.value = srv.name || '';
      dom.servicePrice.value = Number(srv.price || 0).toFixed(2);
      dom.servicePriceUnit.value = srv.priceUnit || '';
      dom.serviceCategory.value = srv.category || '';
      dom.serviceDescription.value = srv.description || '';
      dom.serviceActive.checked = srv.active !== false;
      dom.btnDeleteService?.classList.remove('hidden');
    } else {
      state.editingServiceId = null;
      dom.serviceFormTitle.textContent = 'Nuovo Servizio';
      dom.serviceFormSubtitle.textContent = 'Aggiungi un servizio e il relativo prezzo al listino visibile ai clienti';
      const saveLabel = dom.btnSaveService?.querySelector('.btn-text');
      if (saveLabel) saveLabel.textContent = 'Salva Servizio';
      dom.serviceName.value = '';
      dom.servicePrice.value = '';
      dom.servicePriceUnit.value = '';
      dom.serviceCategory.value = '';
      dom.serviceDescription.value = '';
      dom.serviceActive.checked = true;
      dom.btnDeleteService?.classList.add('hidden');
    }

    dom.modalServiceForm.classList.remove('hidden');
    dom.serviceName.focus();
  }

  function closeServiceFormModal() {
    dom.modalServiceForm?.classList.add('hidden');
    state.editingServiceId = null;
  }

  async function toggleServiceActive(srv) {
    const nextActive = srv.active === false;
    try {
      const res = await fetch(`/api/admin/services/${encodeURIComponent(srv.id)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify({ active: nextActive })
      });
      const data = await res.json();
      if (res.status === 401 || res.status === 403) {
        await performAdminLogout({ expired: true });
        return;
      }
      if (!res.ok) throw new Error(data.message || 'Errore aggiornamento servizio.');
      if (data.service) {
        const idx = state.services.findIndex(s => s.id === data.service.id);
        if (idx !== -1) state.services[idx] = data.service;
      }
      renderAdminServices();
      showToast('success', 'Visibilità Aggiornata', `"${srv.name}" ${nextActive ? 'ora è visibile ai clienti' : 'è stato nascosto ai clienti'}.`);
    } catch (err) {
      showToast('error', 'Errore', err.message || 'Impossibile aggiornare il servizio.');
    }
  }

  async function deleteServiceById(serviceId, name = '') {
    const label = name ? `"${name}"` : 'questo servizio';
    if (!window.confirm(`Vuoi davvero eliminare ${label} dal listino?`)) return;

    try {
      const res = await fetch(`/api/admin/services/${encodeURIComponent(serviceId)}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (res.status === 401 || res.status === 403) {
        await performAdminLogout({ expired: true });
        return;
      }
      if (!res.ok) throw new Error(data.message || 'Errore eliminazione servizio.');

      state.services = state.services.filter(s => s.id !== serviceId);
      if (state.editingServiceId === serviceId) {
        closeServiceFormModal();
      }
      renderAdminServices();
      showToast('success', 'Servizio Eliminato', data.message || 'Rimosso dal listino.');
    } catch (err) {
      showToast('error', 'Errore Eliminazione', err.message || 'Impossibile eliminare il servizio.');
    }
  }

  function bindAdminServicesEvents() {
    dom.btnOpenServicesAdmin?.addEventListener('click', openServicesManagerModal);
    dom.btnCloseServicesManager?.addEventListener('click', closeServicesManagerModal);
    dom.modalServicesManager?.addEventListener('click', (e) => {
      if (e.target === dom.modalServicesManager) closeServicesManagerModal();
    });

    dom.btnNewService?.addEventListener('click', () => openServiceFormModal(null));
    dom.btnCloseServiceForm?.addEventListener('click', closeServiceFormModal);
    dom.btnCancelServiceForm?.addEventListener('click', closeServiceFormModal);
    dom.modalServiceForm?.addEventListener('click', (e) => {
      if (e.target === dom.modalServiceForm) closeServiceFormModal();
    });

    dom.servicesStatusChips?.addEventListener('click', (e) => {
      const btn = e.target.closest('.cal-filter-chip');
      if (!btn || !btn.dataset.filter) return;
      state.servicesFilter = btn.dataset.filter;
      renderAdminServices();
    });

    dom.servicesSearchInput?.addEventListener('input', () => {
      state.servicesSearchQuery = dom.servicesSearchInput.value || '';
      renderAdminServices();
    });

    dom.btnDeleteService?.addEventListener('click', () => {
      if (!state.editingServiceId) return;
      const cur = state.services.find(s => s.id === state.editingServiceId);
      deleteServiceById(state.editingServiceId, cur?.name || '');
    });

    dom.formService?.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearErrors();

      const name = dom.serviceName.value.trim();
      const rawPriceStr = String(dom.servicePrice.value || '').trim().replace(',', '.');
      const price = rawPriceStr === '' ? NaN : Number(rawPriceStr);
      const priceUnit = dom.servicePriceUnit.value.trim();
      const category = dom.serviceCategory.value.trim() || 'Servizio Fotografico';
      const description = dom.serviceDescription.value.trim();
      const active = dom.serviceActive.checked;

      let valid = true;
      if (!name || name.length < 2) {
        setError(dom.serviceName, dom.serviceNameError, 'Inserisci il nome del servizio (almeno 2 caratteri).');
        valid = false;
      }
      if (!Number.isFinite(price) || price < 0) {
        setError(dom.servicePrice, dom.servicePriceError, 'Inserisci un prezzo valido (0 o superiore).');
        valid = false;
      }
      if (!valid) return;

      const isEditing = Boolean(state.editingServiceId);
      const endpoint = isEditing
        ? `/api/admin/services/${encodeURIComponent(state.editingServiceId)}`
        : '/api/admin/services';
      const method = isEditing ? 'PUT' : 'POST';

      setButtonLoading(dom.btnSaveService, true);
      try {
        const res = await fetch(endpoint, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders()
          },
          body: JSON.stringify({ name, price, priceUnit, category, description, active })
        });
        const data = await res.json();
        if (res.status === 401 || res.status === 403) {
          await performAdminLogout({ expired: true });
          return;
        }
        if (!res.ok) throw new Error(data.message || 'Errore salvataggio servizio.');

        if (data.service) {
          if (isEditing) {
            const idx = state.services.findIndex(s => s.id === data.service.id);
            if (idx !== -1) state.services[idx] = data.service;
            else state.services.push(data.service);
          } else {
            state.services.push(data.service);
          }
          state.services = sortServicesClient(state.services);
        }

        closeServiceFormModal();
        renderAdminServices();
        showToast('success', isEditing ? 'Servizio Aggiornato' : 'Servizio Aggiunto', data.message);
      } catch (err) {
        showToast('error', 'Errore Salvataggio', err.message || 'Impossibile salvare il servizio.');
      } finally {
        setButtonLoading(dom.btnSaveService, false);
      }
    });
  }

  // Vista Cliente: caricamento e modale listino servizi offerti
  async function loadPublicServices() {
    try {
      const res = await fetch('/api/public/services');
      if (!res.ok) return;
      const data = await res.json();
      state.publicServices = Array.isArray(data.services) ? data.services : [];
      const count = state.publicServices.length;

      if (dom.clientServicesBadge) dom.clientServicesBadge.textContent = String(count);
      if (dom.clientLoginServicesCount) dom.clientLoginServicesCount.textContent = String(count);

      dom.btnClientServicesOpen?.classList.toggle('hidden', count === 0);
      dom.clientLoginServicesWrap?.classList.toggle('hidden', count === 0);
    } catch {
      // Non blocca il caricamento della galleria cliente
    }
  }

  function renderClientServicesList() {
    if (!dom.clientServicesList) return;
    dom.clientServicesList.innerHTML = '';

    if (state.publicServices.length === 0) {
      dom.clientServicesEmpty?.classList.remove('hidden');
      return;
    }
    dom.clientServicesEmpty?.classList.add('hidden');

    state.publicServices.forEach((srv) => {
      const card = document.createElement('div');
      card.className = 'service-card';

      const top = document.createElement('div');
      top.className = 'service-card-top';
      top.innerHTML = `
        <div class="service-card-title-wrap">
          <span class="cash-cat-pill">${escapeHtml(srv.category || 'Servizio Fotografico')}</span>
          <div class="service-card-name">${escapeHtml(srv.name)}</div>
        </div>
        <div class="service-price-box">
          <span class="service-price-val">${escapeHtml(formatServicePrice(srv.price))}</span>
          ${srv.priceUnit ? `<span class="service-price-unit">${escapeHtml(srv.priceUnit)}</span>` : ''}
        </div>
      `;
      card.appendChild(top);

      if (srv.description) {
        const desc = document.createElement('p');
        desc.className = 'service-card-desc';
        desc.textContent = srv.description;
        card.appendChild(desc);
      }

      dom.clientServicesList.appendChild(card);
    });
  }

  function openClientServicesModal() {
    if (!dom.modalClientServices) return;
    renderClientServicesList();
    dom.modalClientServices.classList.remove('hidden');
  }

  function closeClientServicesModal() {
    dom.modalClientServices?.classList.add('hidden');
  }

  function bindClientServicesEvents() {
    dom.btnClientServicesOpen?.addEventListener('click', openClientServicesModal);
    dom.btnClientLoginServices?.addEventListener('click', openClientServicesModal);
    dom.btnCloseClientServices?.addEventListener('click', closeClientServicesModal);
    dom.modalClientServices?.addEventListener('click', (e) => {
      if (e.target === dom.modalClientServices) closeClientServicesModal();
    });
  }

  // =========================================================================
  // GESTIONE MUSICHE DI SOTTOFONDO (ADMIN)
  // =========================================================================
  function setMusicSourceMode(mode) {
    state.musicSourceMode = mode === 'url' ? 'url' : 'upload';
    dom.musicSourceTabs?.querySelectorAll('.cal-filter-chip').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.source === state.musicSourceMode);
    });
    dom.musicUploadGroup?.classList.toggle('hidden', state.musicSourceMode !== 'upload');
    dom.musicUrlGroup?.classList.toggle('hidden', state.musicSourceMode !== 'url');
  }

  function renderAdminMusic() {
    if (!dom.adminMusicList) return;
    const count = state.musicTracks.length;
    if (dom.adminMusicCount) {
      dom.adminMusicCount.textContent = `${count} ${count === 1 ? 'brano' : 'brani'}`;
    }

    dom.adminMusicList.innerHTML = '';
    if (count === 0) {
      dom.adminMusicEmpty?.classList.remove('hidden');
      return;
    }
    dom.adminMusicEmpty?.classList.add('hidden');

    state.musicTracks.forEach((track) => {
      const isPlayingThis = musicPlayer.isPlaying && musicPlayer.currentTrackId === track.id;
      const row = document.createElement('div');
      row.className = `music-track-row${isPlayingThis ? ' is-playing' : ''}`;

      const left = document.createElement('div');
      left.className = 'music-track-left';

      const playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = `btn-music-preview${isPlayingThis ? ' is-playing' : ''}`;
      playBtn.title = isPlayingThis ? 'Metti in pausa' : 'Ascolta anteprima';
      playBtn.innerHTML = isPlayingThis
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
      playBtn.addEventListener('click', () => musicPlayer.previewTrack(track));

      const meta = document.createElement('div');
      meta.className = 'music-track-meta';
      const sourceBadge = getTrackYouTubeId(track)
        ? 'YouTube'
        : (track.sourceType === 'url' ? 'Link HTTPS' : 'File Audio');
      const sizePart = track.size > 0 ? `<span>${escapeHtml(formatFileSize(track.size))}</span>` : '';
      const artistPart = track.artist ? `<span>${escapeHtml(track.artist)}</span>` : '';
      meta.innerHTML = `
        <div class="music-track-title" title="${escapeHtml(track.title)}">${escapeHtml(track.title)}</div>
        <div class="music-track-sub">
          <span class="cash-cat-pill">${sourceBadge}</span>
          ${artistPart}
          ${sizePart}
        </div>
      `;

      left.appendChild(playBtn);
      left.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'music-track-actions';

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = `cash-status-pill ${track.enabled === false ? 'pending' : 'paid'}`;
      toggleBtn.textContent = track.enabled === false ? 'Disattivata' : 'Attiva';
      toggleBtn.title = 'Clicca per attivare o disattivare nella playlist di sottofondo';
      toggleBtn.addEventListener('click', () => toggleMusicEnabled(track));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-activity-mini btn-delete-mini';
      delBtn.textContent = 'Elimina';
      delBtn.addEventListener('click', () => deleteMusicTrackById(track.id, track.title));

      actions.appendChild(toggleBtn);
      actions.appendChild(delBtn);

      row.appendChild(left);
      row.appendChild(actions);
      dom.adminMusicList.appendChild(row);
    });
  }

  function openMusicManagerModal() {
    if (!dom.modalMusicManager) return;
    renderAdminMusic();
    dom.modalMusicManager.classList.remove('hidden');
  }

  function closeMusicManagerModal() {
    dom.modalMusicManager?.classList.add('hidden');
  }

  async function toggleMusicEnabled(track) {
    const nextEnabled = track.enabled === false;
    try {
      const res = await fetch(`/api/admin/music/${encodeURIComponent(track.id)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify({ enabled: nextEnabled })
      });
      const data = await res.json();
      if (res.status === 401 || res.status === 403) {
        await performAdminLogout({ expired: true });
        return;
      }
      if (!res.ok) throw new Error(data.message || 'Errore aggiornamento brano.');

      if (data.track) {
        const idx = state.musicTracks.findIndex(t => t.id === data.track.id);
        if (idx !== -1) state.musicTracks[idx] = data.track;
      }
      renderAdminMusic();
      await musicPlayer.refreshFromServer();
      showToast('success', 'Playlist Aggiornata', `"${track.title}" ${nextEnabled ? 'attivato' : 'disattivato'}.`);
    } catch (err) {
      showToast('error', 'Errore', err.message || 'Impossibile aggiornare il brano.');
    }
  }

  async function deleteMusicTrackById(trackId, title = '') {
    const label = title ? `"${title}"` : 'questo brano';
    if (!window.confirm(`Vuoi davvero eliminare ${label} dalle musiche di sottofondo?`)) return;

    try {
      const res = await fetch(`/api/admin/music/${encodeURIComponent(trackId)}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (res.status === 401 || res.status === 403) {
        await performAdminLogout({ expired: true });
        return;
      }
      if (!res.ok) throw new Error(data.message || 'Errore eliminazione brano.');

      state.musicTracks = state.musicTracks.filter(t => t.id !== trackId);
      if (musicPlayer.currentTrackId === trackId) {
        musicPlayer.stop();
      }
      renderAdminMusic();
      await musicPlayer.refreshFromServer();
      showToast('success', 'Brano Eliminato', data.message || 'Rimosso dalla playlist.');
    } catch (err) {
      showToast('error', 'Errore Eliminazione', err.message || 'Impossibile eliminare il brano.');
    }
  }

  function bindAdminMusicEvents() {
    dom.btnOpenMusicAdmin?.addEventListener('click', openMusicManagerModal);
    dom.btnCloseMusicManager?.addEventListener('click', closeMusicManagerModal);
    dom.modalMusicManager?.addEventListener('click', (e) => {
      if (e.target === dom.modalMusicManager) closeMusicManagerModal();
    });

    dom.musicSourceTabs?.addEventListener('click', (e) => {
      const btn = e.target.closest('.cal-filter-chip');
      if (!btn || !btn.dataset.source) return;
      clearErrors();
      setMusicSourceMode(btn.dataset.source);
    });

    dom.musicFile?.addEventListener('change', () => {
      const file = dom.musicFile.files?.[0];
      if (file && !dom.musicTitle.value.trim()) {
        dom.musicTitle.value = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
      }
    });

    dom.formAddMusic?.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearErrors();

      const title = dom.musicTitle.value.trim();
      const artist = dom.musicArtist.value.trim();
      const enabled = dom.musicEnabled.checked;

      let valid = true;
      if (!title || title.length < 2) {
        setError(dom.musicTitle, dom.musicTitleError, 'Inserisci il titolo del brano (almeno 2 caratteri).');
        valid = false;
      }

      if (state.musicSourceMode === 'url') {
        const url = dom.musicUrl.value.trim();
        if (!url || !url.startsWith('https://')) {
          setError(dom.musicUrl, dom.musicUrlError, 'Inserisci un URL HTTPS valido (es. link YouTube o https://.../brano.mp3).');
          valid = false;
        } else if (isYouTubeUrlHost(url) && !extractYouTubeVideoId(url)) {
          setError(dom.musicUrl, dom.musicUrlError, 'Link YouTube non valido: inserisci l\'URL di un video (es. https://www.youtube.com/watch?v=...).');
          valid = false;
        }
        if (!valid) return;

        setButtonLoading(dom.btnSaveMusic, true);
        try {
          const res = await fetch('/api/admin/music', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...getAuthHeaders()
            },
            body: JSON.stringify({ title, artist, url, enabled })
          });
          const data = await res.json();
          if (res.status === 401 || res.status === 403) {
            await performAdminLogout({ expired: true });
            return;
          }
          if (!res.ok) throw new Error(data.message || 'Errore salvataggio brano.');

          if (data.track) state.musicTracks.push(data.track);
          dom.formAddMusic.reset();
          dom.musicEnabled.checked = true;
          renderAdminMusic();
          await musicPlayer.refreshFromServer();
          showToast('success', 'Brano Aggiunto', data.message);
        } catch (err) {
          showToast('error', 'Errore Caricamento', err.message || 'Impossibile aggiungere il brano.');
        } finally {
          setButtonLoading(dom.btnSaveMusic, false);
        }
        return;
      }

      const file = dom.musicFile?.files?.[0];
      if (!file) {
        setError(dom.musicFile, dom.musicFileError, 'Seleziona un file audio (MP3, WAV, OGG, M4A, AAC).');
        valid = false;
      } else if (file.size > 15 * 1024 * 1024) {
        setError(dom.musicFile, dom.musicFileError, 'Il file supera il limite massimo di 15 MB.');
        valid = false;
      }
      if (!valid) return;

      setButtonLoading(dom.btnSaveMusic, true);
      try {
        const qs = new URLSearchParams({
          title,
          artist,
          filename: file.name,
          enabled: enabled ? '1' : '0'
        });
        const res = await fetch(`/api/admin/music?${qs.toString()}`, {
          method: 'POST',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            ...getAuthHeaders()
          },
          body: file
        });
        const data = await res.json();
        if (res.status === 401 || res.status === 403) {
          await performAdminLogout({ expired: true });
          return;
        }
        if (!res.ok) throw new Error(data.message || 'Errore upload file audio.');

        if (data.track) state.musicTracks.push(data.track);
        dom.formAddMusic.reset();
        dom.musicEnabled.checked = true;
        renderAdminMusic();
        await musicPlayer.refreshFromServer();
        showToast('success', 'Brano Caricato', data.message);
      } catch (err) {
        showToast('error', 'Errore Upload', err.message || 'Impossibile caricare il file audio.');
      } finally {
        setButtonLoading(dom.btnSaveMusic, false);
      }
    });
  }

  window.addEventListener('keydown', (e) => {
    if (!dom.modalLightbox.classList.contains('hidden')) {
      if (e.target === dom.lightboxVideo && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === ' ')) {
        return;
      }
      if (e.key === 'ArrowLeft') prevLightboxPhoto();
      else if (e.key === 'ArrowRight') nextLightboxPhoto();
      else if (e.key === 'f' || e.key === 'F') toggleLightboxFullscreen();
      else if ((e.key === 'r' || e.key === 'R') && !isVideoItem(state.activeLightboxPhoto)) rotateLightboxPhoto(90);
      else if (e.key === 'Escape') closeLightbox();
      return;
    }
    if (e.key === 'Escape' && dom.modalPhotoEditor && !dom.modalPhotoEditor.classList.contains('hidden')) {
      photoEditor.close();
      return;
    }
    if (e.key === 'Escape' && dom.modalServiceForm && !dom.modalServiceForm.classList.contains('hidden')) {
      closeServiceFormModal();
      return;
    }
    if (e.key === 'Escape' && dom.modalServicesManager && !dom.modalServicesManager.classList.contains('hidden')) {
      closeServicesManagerModal();
      return;
    }
    if (e.key === 'Escape' && dom.modalClientServices && !dom.modalClientServices.classList.contains('hidden')) {
      closeClientServicesModal();
      return;
    }
    if (e.key === 'Escape' && dom.modalMusicManager && !dom.modalMusicManager.classList.contains('hidden')) {
      closeMusicManagerModal();
      return;
    }
    if (e.key === 'Escape' && dom.modalTransaction && !dom.modalTransaction.classList.contains('hidden')) {
      closeTransactionModal();
      return;
    }
    if (e.key === 'Escape' && dom.modalCashManager && !dom.modalCashManager.classList.contains('hidden')) {
      closeCashManagerModal();
      return;
    }
    if (e.key === 'Escape' && dom.modalActivity && !dom.modalActivity.classList.contains('hidden')) {
      closeActivityModal();
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
    dom.shareClientPassword,
    dom.activityTitle,
    dom.activityDate,
    dom.activityEndDate,
    dom.txnDescription,
    dom.txnAmount,
    dom.txnDate,
    dom.serviceName,
    dom.servicePrice,
    dom.musicTitle,
    dom.musicUrl,
    dom.musicFile
  ].forEach(inp => {
    if (!inp) return;
    inp.addEventListener('input', () => {
      inp.classList.remove('has-error');
      const errId = inp === dom.activityEndDate ? 'activity-date-error' : `${inp.id}-error`;
      const err = document.getElementById(errId);
      if (err) {
        err.textContent = '';
        err.classList.remove('visible');
      }
    });
  });

  // =========================================================================
  // AVVIO APPLICAZIONE
  // =========================================================================
  bindAdminCalendarEvents();
  bindAdminCashEvents();
  bindAdminServicesEvents();
  bindClientServicesEvents();
  bindAdminMusicEvents();
  photoEditor.init();
  await bgManager.init();
  await musicPlayer.init();
  if (state.viewMode === 'client') {
    await initClientView();
  } else {
    await initAdminView();
  }
});
