// Admin Dashboard Client Script

let adminToken = localStorage.getItem('admin_token') || '';
let pollTimer = null;
let currentScannerStatus = 'idle';

// Helper: API Request wrapper
async function apiFetch(endpoint, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(adminToken ? { 'x-admin-token': adminToken } : {}),
    ...(options.headers || {}),
  };

  const res = await fetch(`/api/admin${endpoint}`, {
    ...options,
    headers,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && endpoint !== '/login') {
      handleLogout();
    }
    throw new Error(data.message || data.error || `HTTP ${res.status}`);
  }
  return data;
}

// -------------------------------------------------------------
// Authentication
// -------------------------------------------------------------
async function checkSession() {
  try {
    const res = await apiFetch('/session');
    if (res.authenticated) {
      showDashboard();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

function showLogin() {
  document.getElementById('loginSection').classList.remove('hidden');
  document.getElementById('dashboardSection').classList.add('hidden');
}

function showDashboard() {
  document.getElementById('loginSection').classList.add('hidden');
  document.getElementById('dashboardSection').classList.remove('hidden');
  refreshDashboard();
  startStatusPolling();
}

function handleLogout() {
  adminToken = '';
  localStorage.removeItem('admin_token');
  stopStatusPolling();
  fetch('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showLogin();
}

document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('adminPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.classList.add('hidden');

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }).then((r) => r.json());

    if (res.success && res.token) {
      adminToken = res.token;
      localStorage.setItem('admin_token', adminToken);
      showDashboard();
    } else {
      errEl.textContent = res.message || 'Password salah';
      errEl.classList.remove('hidden');
    }
  } catch (err) {
    errEl.textContent = err.message || 'Gagal terhubung ke server';
    errEl.classList.remove('hidden');
  }
});

document.getElementById('btnLogout')?.addEventListener('click', handleLogout);

// -------------------------------------------------------------
// Navigation Tabs
// -------------------------------------------------------------
function switchTab(tabId) {
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.tab === tabId);
  });

  document.querySelectorAll('.tab-content').forEach((tab) => {
    tab.classList.toggle('active', tab.id === tabId);
  });

  const titles = {
    'tab-overview': ['Dashboard Overview', 'Status sistem & statistik perpustakaan media'],
    'tab-credentials': ['Kelola Kredensial Google', 'Upload credentials.json, token.json, atau hubungkan OAuth'],
    'tab-scanner': ['Scanner & Logs', 'Kontrol proses scanning Google Drive & monitor live logs'],
    'tab-catalog': ['Kelola Katalog Media', 'Tambah, edit, cari, dan hapus media secara manual'],
    'tab-settings': ['Pengaturan Server', 'Kelola konfigurasi environment server (.env)'],
  };

  if (titles[tabId]) {
    document.getElementById('pageTitle').textContent = titles[tabId][0];
    document.getElementById('pageSubtitle').textContent = titles[tabId][1];
  }

  if (tabId === 'tab-settings') loadConfig();
  if (tabId === 'tab-credentials') loadAuthStatus();
  if (tabId === 'tab-catalog') loadCatalog();
}

document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => switchTab(item.dataset.tab));
});

// -------------------------------------------------------------
// Catalog CRUD State & Logic
// -------------------------------------------------------------
let currentCatalogType = 'movie';
let currentCatalogPage = 1;
let currentCatalogLimit = 15;
let currentCatalogSearch = '';
let currentCatalogTotal = 0;
let catalogItemsCache = [];

async function loadCatalog() {
  const tbody = document.getElementById('catalogTableBody');
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-20">Memuat data katalog...</td></tr>';

  try {
    const query = new URLSearchParams({
      type: currentCatalogType,
      page: currentCatalogPage,
      limit: currentCatalogLimit,
      q: currentCatalogSearch,
    });

    const data = await apiFetch(`/catalog/list?${query.toString()}`);
    currentCatalogTotal = data.total || 0;
    catalogItemsCache = data.items || [];

    renderCatalogTable(data.items || []);
    updateCatalogPagination();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger py-20">Gagal memuat katalog: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderCatalogTable(items) {
  const tbody = document.getElementById('catalogTableBody');
  const thead = document.getElementById('catalogTableHead');
  if (!tbody || !thead) return;

  if (currentCatalogType === 'episode') {
    thead.innerHTML = `
      <th>Poster / Series</th>
      <th>Judul Episode</th>
      <th>Season / Ep</th>
      <th>Resolusi</th>
      <th>Drive File ID</th>
      <th class="text-right">Aksi</th>
    `;
  } else {
    thead.innerHTML = `
      <th>Poster</th>
      <th>Judul</th>
      <th>Tahun</th>
      <th>Genre</th>
      <th>Resolusi</th>
      <th>Drive File ID</th>
      <th class="text-right">Aksi</th>
    `;
  }

  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-20">Tidak ada data katalog ditemukan.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  items.forEach((item) => {
    const tr = document.createElement('tr');

    const posterUrl = item.poster || 'https://via.placeholder.com/36x52/1e293b/64748b?text=No+Img';
    const driveId = item.driveFileId || item._id || '-';
    const idKey = item._id || item.driveFileId;

    if (currentCatalogType === 'episode') {
      const epNum = `S${String(item.season || 1).padStart(2, '0')}E${String(item.episode || 1).padStart(2, '0')}`;
      const seriesTitle = item.seriesTitle ? `<br><small class="text-muted">${escapeHtml(item.seriesTitle)}</small>` : '';
      tr.innerHTML = `
        <td><img src="${escapeHtml(posterUrl)}" class="poster-thumb" onerror="this.src='https://via.placeholder.com/36x52/1e293b/64748b?text=TV'"></td>
        <td><strong>${escapeHtml(item.title || item.fileName || 'Untitled')}</strong>${seriesTitle}</td>
        <td><span class="badge badge-warning">${epNum}</span></td>
        <td>${escapeHtml(item.resolution || '-')}</td>
        <td><code class="code-sm">${escapeHtml(driveId)}</code></td>
        <td class="text-right">
          <button class="btn btn-secondary btn-sm btn-edit" data-id="${escapeHtml(idKey)}">Edit</button>
          <button class="btn btn-danger btn-sm btn-delete" data-id="${escapeHtml(idKey)}">Hapus</button>
        </td>
      `;
    } else {
      const genres = Array.isArray(item.genres) ? item.genres.slice(0, 2).join(', ') : '-';
      tr.innerHTML = `
        <td><img src="${escapeHtml(posterUrl)}" class="poster-thumb" onerror="this.src='https://via.placeholder.com/36x52/1e293b/64748b?text=Film'"></td>
        <td><strong>${escapeHtml(item.title || 'Untitled')}</strong></td>
        <td>${item.year || '-'}</td>
        <td><span class="text-xs text-muted">${escapeHtml(genres)}</span></td>
        <td>${escapeHtml(item.resolution || '-')}</td>
        <td><code class="code-sm">${escapeHtml(driveId)}</code></td>
        <td class="text-right">
          <button class="btn btn-secondary btn-sm btn-edit" data-id="${escapeHtml(idKey)}">Edit</button>
          <button class="btn btn-danger btn-sm btn-delete" data-id="${escapeHtml(idKey)}">Hapus</button>
        </td>
      `;
    }

    // Attach button event listeners
    tr.querySelector('.btn-edit')?.addEventListener('click', () => openCrudModal('edit', item));
    tr.querySelector('.btn-delete')?.addEventListener('click', () => deleteCatalogItem(currentCatalogType, idKey, item.title || item.fileName));

    tbody.appendChild(tr);
  });
}

function updateCatalogPagination() {
  const totalPages = Math.max(1, Math.ceil(currentCatalogTotal / currentCatalogLimit));
  document.getElementById('catalogPaginationInfo').textContent = `Halaman ${currentCatalogPage} dari ${totalPages} (Total: ${currentCatalogTotal})`;

  document.getElementById('btnPrevPage').disabled = currentCatalogPage <= 1;
  document.getElementById('btnNextPage').disabled = currentCatalogPage >= totalPages;
}

// Type Selector Pills
document.querySelectorAll('.pill-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pill-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentCatalogType = btn.dataset.catalogType;
    currentCatalogPage = 1;
    loadCatalog();
  });
});

// Search handler
document.getElementById('btnSearchCatalog')?.addEventListener('click', () => {
  currentCatalogSearch = document.getElementById('catalogSearchInput').value.trim();
  currentCatalogPage = 1;
  loadCatalog();
});

document.getElementById('catalogSearchInput')?.addEventListener('keyup', (e) => {
  if (e.key === 'Enter') {
    currentCatalogSearch = e.target.value.trim();
    currentCatalogPage = 1;
    loadCatalog();
  }
});

// Pagination handler
document.getElementById('btnPrevPage')?.addEventListener('click', () => {
  if (currentCatalogPage > 1) {
    currentCatalogPage -= 1;
    loadCatalog();
  }
});

document.getElementById('btnNextPage')?.addEventListener('click', () => {
  const totalPages = Math.ceil(currentCatalogTotal / currentCatalogLimit);
  if (currentCatalogPage < totalPages) {
    currentCatalogPage += 1;
    loadCatalog();
  }
});

// CRUD Modal Controls
const modal = document.getElementById('catalogModal');

function openCrudModal(mode, itemData = null) {
  document.getElementById('crudItemType').value = currentCatalogType;
  document.getElementById('crudItemId').value = itemData ? (itemData._id || itemData.driveFileId) : '';

  const modalTitle = document.getElementById('modalTitle');
  const alertEl = document.getElementById('crudAlert');
  alertEl.classList.add('hidden');

  const tmdbInput = document.getElementById('tmdbFetchInput');
  const tmdbStatus = document.getElementById('tmdbFetchStatus');
  if (tmdbInput) tmdbInput.value = '';
  if (tmdbStatus) {
    tmdbStatus.textContent = '';
    tmdbStatus.className = 'text-xs text-muted';
  }

  const epFields = document.getElementById('episodeSpecificFields');
  if (currentCatalogType === 'episode') {
    epFields.classList.remove('hidden');
    document.getElementById('driveIdReq').classList.remove('hidden');
  } else if (currentCatalogType === 'movie') {
    epFields.classList.add('hidden');
    document.getElementById('driveIdReq').classList.remove('hidden');
  } else {
    epFields.classList.add('hidden');
    document.getElementById('driveIdReq').classList.add('hidden');
  }

  if (mode === 'edit' && itemData) {
    modalTitle.textContent = `Edit Data ${currentCatalogType.toUpperCase()}`;
    document.getElementById('crudTitle').value = itemData.title || itemData.fileName || '';
    document.getElementById('crudYear').value = itemData.year || '';
    document.getElementById('crudRating').value = itemData.rating || '';
    document.getElementById('crudDriveFileId').value = itemData.driveFileId || '';
    document.getElementById('crudResolution').value = itemData.resolution || '';
    document.getElementById('crudSeason').value = itemData.season || 1;
    document.getElementById('crudEpisode').value = itemData.episode || 1;
    document.getElementById('crudGenres').value = Array.isArray(itemData.genres) ? itemData.genres.join(', ') : (itemData.genres || '');
    document.getElementById('crudOverview').value = itemData.overview || '';
    document.getElementById('crudPoster').value = itemData.poster || '';
    document.getElementById('crudBackdrop').value = itemData.backdrop || '';
    document.getElementById('crudTmdbId').value = itemData.tmdbId || '';
    document.getElementById('crudImdbId').value = itemData.imdbId || '';
    if (tmdbInput && itemData.tmdbId) tmdbInput.value = itemData.tmdbId;
  } else {
    modalTitle.textContent = `Tambah Data ${currentCatalogType.toUpperCase()} Baru`;
    document.getElementById('catalogForm').reset();
    document.getElementById('crudItemType').value = currentCatalogType;
    document.getElementById('crudItemId').value = '';
  }

  modal.classList.remove('hidden');
}

// TMDB Auto-Fetch Button Handler
document.getElementById('btnFetchTmdb')?.addEventListener('click', async () => {
  const inputVal = document.getElementById('tmdbFetchInput').value.trim();
  const statusEl = document.getElementById('tmdbFetchStatus');
  const alertEl = document.getElementById('crudAlert');
  alertEl.classList.add('hidden');

  if (!inputVal) {
    statusEl.textContent = 'Masukkan TMDB ID atau Judul terlebih dahulu!';
    statusEl.className = 'text-xs text-danger';
    return;
  }

  statusEl.textContent = 'Mengambil data dari TMDB...';
  statusEl.className = 'text-xs text-indigo';

  try {
    const isNum = /^\d+$/.test(inputVal);
    const params = new URLSearchParams({
      type: currentCatalogType,
      ...(isNum ? { tmdbId: inputVal } : { query: inputVal }),
    });

    const res = await apiFetch(`/tmdb/fetch?${params.toString()}`);
    if (res.ok && res.metadata) {
      const m = res.metadata;
      if (m.title) document.getElementById('crudTitle').value = m.title;
      if (m.year) document.getElementById('crudYear').value = m.year;
      if (m.rating) document.getElementById('crudRating').value = m.rating;
      if (m.genres && m.genres.length) document.getElementById('crudGenres').value = m.genres.join(', ');
      if (m.overview) document.getElementById('crudOverview').value = m.overview;
      if (m.poster) document.getElementById('crudPoster').value = m.poster;
      if (m.backdrop) document.getElementById('crudBackdrop').value = m.backdrop;
      if (m.tmdbId) document.getElementById('crudTmdbId').value = m.tmdbId;
      if (m.imdbId) document.getElementById('crudImdbId').value = m.imdbId;

      statusEl.textContent = `Berhasil! TMDB ID ${m.tmdbId} di-fetch`;
      statusEl.className = 'text-xs text-emerald font-bold';
    } else {
      throw new Error(res.message || 'Gagal mengambil data TMDB');
    }
  } catch (err) {
    statusEl.textContent = err.message || 'Gagal mengambil data TMDB';
    statusEl.className = 'text-xs text-danger';
  }
});

function closeCrudModal() {
  modal.classList.add('hidden');
}

document.getElementById('btnOpenAddModal')?.addEventListener('click', () => openCrudModal('add'));
document.getElementById('btnCloseModal')?.addEventListener('click', closeCrudModal);
document.getElementById('btnCancelModal')?.addEventListener('click', closeCrudModal);

document.getElementById('catalogForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const alertEl = document.getElementById('crudAlert');
  alertEl.classList.add('hidden');

  const type = document.getElementById('crudItemType').value;
  const itemId = document.getElementById('crudItemId').value;

  const payload = {
    title: document.getElementById('crudTitle').value,
    year: document.getElementById('crudYear').value,
    rating: document.getElementById('crudRating').value,
    driveFileId: document.getElementById('crudDriveFileId').value,
    resolution: document.getElementById('crudResolution').value,
    season: document.getElementById('crudSeason').value,
    episode: document.getElementById('crudEpisode').value,
    genres: document.getElementById('crudGenres').value,
    overview: document.getElementById('crudOverview').value,
    poster: document.getElementById('crudPoster').value,
    backdrop: document.getElementById('crudBackdrop').value,
    tmdbId: document.getElementById('crudTmdbId').value,
    imdbId: document.getElementById('crudImdbId').value,
  };

  try {
    let res;
    if (itemId) {
      // Update
      res = await apiFetch(`/catalog/${type}/${itemId}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    } else {
      // Create
      res = await apiFetch(`/catalog/${type}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }

    alertEl.textContent = res.message || 'Data berhasil disimpan.';
    alertEl.className = 'alert alert-success mt-15';
    alertEl.classList.remove('hidden');

    setTimeout(() => {
      closeCrudModal();
      loadCatalog();
      refreshDashboard();
    }, 800);
  } catch (err) {
    alertEl.textContent = err.message || 'Gagal menyimpan data.';
    alertEl.className = 'alert alert-danger mt-15';
    alertEl.classList.remove('hidden');
  }
});

async function deleteCatalogItem(type, id, name) {
  if (!confirm(`Apakah Anda yakin ingin menghapus "${name || id}"?`)) return;

  try {
    const res = await apiFetch(`/catalog/${type}/${id}`, { method: 'DELETE' });
    alert(res.message || 'Item berhasil dihapus.');
    loadCatalog();
    refreshDashboard();
  } catch (err) {
    alert(`Gagal menghapus item: ${err.message}`);
  }
}

// -------------------------------------------------------------
// Dashboard Refresh & Data Loading
// -------------------------------------------------------------
async function refreshDashboard() {
  try {
    const data = await apiFetch('/status');

    // Stat Cards
    document.getElementById('statMovies').textContent = Number(data.counts?.movies || 0).toLocaleString();
    document.getElementById('statSeries').textContent = Number(data.counts?.series || 0).toLocaleString();
    document.getElementById('statEpisodes').textContent = Number(data.counts?.episodes || 0).toLocaleString();
    document.getElementById('statPlays').textContent = Number(data.counts?.plays || 0).toLocaleString();

    // Auth status
    const auth = data.auth || {};
    const authBadge = document.getElementById('authStatusBadge');
    if (auth.isReady) {
      authBadge.textContent = 'Google OAuth Ready';
      authBadge.className = 'badge badge-success';
    } else if (auth.hasCredentials) {
      authBadge.textContent = 'Token Missing (Otorisasi Diperlukan)';
      authBadge.className = 'badge badge-warning';
    } else {
      authBadge.textContent = 'Credentials Missing';
      authBadge.className = 'badge badge-warning';
    }

    const credSrc = auth.credSource === 'mongodb' ? 'MongoDB' : (auth.credSource === 'file' ? 'File' : '');
    const tokenSrc = auth.tokenSource === 'mongodb' ? 'MongoDB' : (auth.tokenSource === 'file' ? 'File' : '');

    document.getElementById('statusCreds').textContent = auth.hasCredentials ? `Ada (${credSrc})` : 'Belum Ada (Kosong)';
    document.getElementById('statusToken').textContent = auth.hasToken ? `Aktif (${tokenSrc})` : 'Belum Otorisasi';
    document.getElementById('statusClientId').textContent = auth.clientId ? auth.clientId.slice(0, 25) + '...' : '-';

    // Server & Cache status
    document.getElementById('statusFolderId').textContent = data.env?.DRIVE_FOLDER_ID || '(Belum diset)';
    const cacheSizeMb = (Number(data.cache?.usedBytes || 0) / (1024 * 1024)).toFixed(1);
    document.getElementById('statusCacheSize').textContent = `${cacheSizeMb} MB`;
    document.getElementById('statusCacheFiles').textContent = `${data.cache?.fileCount || 0} file`;

    // Scanner Status Badge
    updateScannerState(data.scanner);
  } catch (err) {
    console.error('Failed to refresh dashboard:', err);
  }
}

document.getElementById('btnRefresh')?.addEventListener('click', refreshDashboard);

// -------------------------------------------------------------
// Credentials & OAuth Flow
// -------------------------------------------------------------
async function loadAuthStatus() {
  try {
    const auth = await apiFetch('/credentials');
    document.getElementById('statusCreds').textContent = auth.hasCredentials ? 'Ada (Ada)' : 'Belum Ada (Kosong)';
    document.getElementById('statusToken').textContent = auth.hasToken ? 'Aktif (Valid)' : 'Belum Otorisasi';
  } catch (e) {
    console.error('loadAuthStatus error:', e);
  }
}

// Drag and drop setup
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');

if (dropzone && fileInput) {
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = 'var(--accent-indigo)';
  });
  dropzone.addEventListener('dragleave', () => {
    dropzone.style.borderColor = 'var(--border-color)';
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = 'var(--border-color)';
    if (e.dataTransfer.files.length) {
      readFile(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) readFile(e.target.files[0]);
  });
}

function readFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById('jsonContent').value = e.target.result;
  };
  reader.readAsText(file);
}

document.getElementById('btnUploadCreds')?.addEventListener('click', async () => {
  const type = document.getElementById('uploadType').value;
  const content = document.getElementById('jsonContent').value;
  const alertEl = document.getElementById('uploadAlert');
  alertEl.classList.add('hidden');

  if (!content.trim()) {
    alertEl.textContent = 'Pilih file atau tempel isi JSON terlebih dahulu.';
    alertEl.className = 'alert alert-danger mt-10';
    alertEl.classList.remove('hidden');
    return;
  }

  try {
    const res = await apiFetch('/credentials/upload', {
      method: 'POST',
      body: JSON.stringify({ type, content }),
    });

    alertEl.textContent = res.message || 'Berhasil disimpan.';
    alertEl.className = 'alert alert-success mt-10';
    alertEl.classList.remove('hidden');
    refreshDashboard();
  } catch (err) {
    alertEl.textContent = err.message || 'Gagal menyimpan kredensial.';
    alertEl.className = 'alert alert-danger mt-10';
    alertEl.classList.remove('hidden');
  }
});

// OAuth URL generation
document.getElementById('btnGetAuthUrl')?.addEventListener('click', async () => {
  const box = document.getElementById('authUrlBox');
  const alertEl = document.getElementById('oauthAlert');
  alertEl.classList.add('hidden');

  try {
    const data = await apiFetch('/oauth/url');
    document.getElementById('authUrlInput').value = data.authUrl;
    document.getElementById('authUrlLink').href = data.authUrl;
    box.classList.remove('hidden');
  } catch (err) {
    alertEl.textContent = err.message || 'Gagal membuat Auth URL. Pastikan credentials.json sudah di-upload.';
    alertEl.className = 'alert alert-danger mt-10';
    alertEl.classList.remove('hidden');
  }
});

// Exchange Code for Token
document.getElementById('btnSubmitCode')?.addEventListener('click', async () => {
  const code = document.getElementById('oauthCodeInput').value;
  const alertEl = document.getElementById('oauthAlert');
  alertEl.classList.add('hidden');

  if (!code.trim()) {
    alertEl.textContent = 'Kode otorisasi tidak boleh kosong.';
    alertEl.className = 'alert alert-danger mt-10';
    alertEl.classList.remove('hidden');
    return;
  }

  try {
    const res = await apiFetch('/oauth/code', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });

    alertEl.textContent = res.message || 'Token berhasil dibuat & disimpan!';
    alertEl.className = 'alert alert-success mt-10';
    alertEl.classList.remove('hidden');
    refreshDashboard();
  } catch (err) {
    alertEl.textContent = err.message || 'Gagal menukarkan kode otorisasi.';
    alertEl.className = 'alert alert-danger mt-10';
    alertEl.classList.remove('hidden');
  }
});

// -------------------------------------------------------------
// Scanner Control & Live Logs
// -------------------------------------------------------------
function updateScannerState(scanner) {
  if (!scanner) return;
  currentScannerStatus = scanner.status;

  const badge = document.getElementById('scannerBadge');
  const statusTxt = document.getElementById('scanProgressStatus');

  badge.textContent = `Scanner: ${scanner.status.toUpperCase()}`;
  badge.className = `status-badge status-${scanner.status}`;

  statusTxt.textContent = `Status: ${scanner.status.toUpperCase()} (Mode: ${scanner.mode})`;
  document.getElementById('scanProgressTime').textContent = `Durasi: ${scanner.durationSeconds || 0}s`;

  // Start / Stop Buttons
  const btnStart = document.getElementById('btnStartScan');
  const btnStop = document.getElementById('btnStopScan');

  if (scanner.status === 'running' || scanner.status === 'cancelling') {
    btnStart.classList.add('hidden');
    btnStop.classList.remove('hidden');
  } else {
    btnStart.classList.remove('hidden');
    btnStop.classList.add('hidden');
  }

  // Update Mini Live Stats
  const p = scanner.progress || {};
  document.getElementById('liveScanned').textContent = p.scanned || 0;
  document.getElementById('liveFolders').textContent = p.scannedFolders || 0;
  document.getElementById('liveDetected').textContent = p.detected || 0;
  document.getElementById('liveSaved').textContent = p.saved || 0;
  document.getElementById('liveSkipped').textContent = p.skipped || 0;

  // Progress Bar simulation
  const bar = document.getElementById('scanProgressBar');
  if (scanner.status === 'running') {
    bar.style.width = `${Math.min(100, Math.max(10, ((p.saved || 0) % 100)))}%`;
  } else if (scanner.status === 'completed') {
    bar.style.width = '100%';
  } else {
    bar.style.width = '0%';
  }

  // Render recent logs
  if (Array.isArray(scanner.recentLogs)) {
    renderTerminalLogs(scanner.recentLogs);
  }
}

function renderTerminalLogs(logs) {
  const terminal = document.getElementById('terminalConsole');
  if (!terminal) return;

  terminal.innerHTML = '';
  if (logs.length === 0) {
    terminal.innerHTML = '<div class="terminal-line text-muted">[system] Logs kosong.</div>';
    return;
  }

  logs.forEach((log) => {
    const line = document.createElement('div');
    line.className = 'terminal-line';

    let colorClass = '';
    if (log.message.includes('[detect]')) colorClass = 'text-indigo';
    else if (log.message.includes('[db] movie saved') || log.message.includes('[db] episode saved')) colorClass = 'text-emerald';
    else if (log.message.includes('[tmdb]')) colorClass = 'text-purple';
    else if (log.message.includes('[skip]') || log.message.includes('failed')) colorClass = 'text-danger';

    line.innerHTML = `<span class="time">[${log.time}]</span><span class="${colorClass}">${escapeHtml(log.message)}</span>`;
    terminal.appendChild(line);
  });

  terminal.scrollTop = terminal.scrollHeight;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

document.getElementById('btnStartScan')?.addEventListener('click', async () => {
  const mode = document.getElementById('scanMode').value;
  const driveFolderId = document.getElementById('scanFolderId').value;
  const concurrency = document.getElementById('scanConcurrency').value;

  try {
    const res = await apiFetch('/scan/start', {
      method: 'POST',
      body: JSON.stringify({ mode, driveFolderId, concurrency }),
    });
    updateScannerState(res.status);
  } catch (err) {
    alert(`Gagal memulai scan: ${err.message}`);
  }
});

document.getElementById('btnStopScan')?.addEventListener('click', async () => {
  try {
    const res = await apiFetch('/scan/stop', { method: 'POST' });
    updateScannerState(res.status);
  } catch (err) {
    alert(`Gagal menghentikan scan: ${err.message}`);
  }
});

document.getElementById('btnClearLogs')?.addEventListener('click', () => {
  document.getElementById('terminalConsole').innerHTML = '<div class="terminal-line text-muted">[system] Console dibersihkan.</div>';
});

// -------------------------------------------------------------
// Settings / Environment Config
// -------------------------------------------------------------
async function loadConfig() {
  try {
    const cfg = await apiFetch('/config');
    document.getElementById('cfgFolderId').value = cfg.DRIVE_FOLDER_ID || '';
    document.getElementById('cfgTmdbKey').value = cfg.TMDB_API_KEY || '';
    document.getElementById('cfgMongoUri').value = cfg.MONGO_URI || '';
    document.getElementById('cfgPlayerUrl').value = cfg.PLAYER_BASE_URL || '';
    document.getElementById('cfgConcurrency').value = cfg.CONCURRENCY || '5';
  } catch (err) {
    console.error('loadConfig error:', err);
  }
}

document.getElementById('settingsForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const alertEl = document.getElementById('configAlert');
  alertEl.classList.add('hidden');

  const updates = {
    DRIVE_FOLDER_ID: document.getElementById('cfgFolderId').value,
    TMDB_API_KEY: document.getElementById('cfgTmdbKey').value,
    MONGO_URI: document.getElementById('cfgMongoUri').value,
    PLAYER_BASE_URL: document.getElementById('cfgPlayerUrl').value,
    CONCURRENCY: document.getElementById('cfgConcurrency').value,
    ADMIN_PASSWORD: document.getElementById('cfgAdminPass').value,
  };

  try {
    const res = await apiFetch('/config', {
      method: 'POST',
      body: JSON.stringify(updates),
    });
    alertEl.textContent = res.message || 'Pengaturan berhasil disimpan.';
    alertEl.className = 'alert alert-success mt-15';
    alertEl.classList.remove('hidden');
    refreshDashboard();
  } catch (err) {
    alertEl.textContent = err.message || 'Gagal menyimpan pengaturan.';
    alertEl.className = 'alert alert-danger mt-15';
    alertEl.classList.remove('hidden');
  }
});

// -------------------------------------------------------------
// Polling Loop
// -------------------------------------------------------------
function startStatusPolling() {
  stopStatusPolling();
  pollTimer = setInterval(async () => {
    try {
      const scanStatus = await apiFetch('/scan/status');
      updateScannerState(scanStatus);
    } catch {
      // ignore
    }
  }, 2500);
}

function stopStatusPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// Initial session check on page load
checkSession();
