const API = ''; // same origin
const TOKEN_KEY = 'culinara_admin_token';

let allChefs = [];
let activeChefFilter = 'all';

// Catches literally any uncaught error anywhere on this page (a typo in a
// later feature, a browser extension interfering, whatever) and shows it
// on screen instead of leaving the dashboard looking like it did nothing.
// This is the single most useful thing standing between you and a mystery
// blank screen — if the login button ever seems to do nothing again, check
// this banner (and the browser console, F12) first.
window.addEventListener('error', (event) => {
  showFatalError(`Script error: ${event.message} (${event.filename}:${event.lineno})`);
});
window.addEventListener('unhandledrejection', (event) => {
  showFatalError(`Unhandled error: ${event.reason && event.reason.message ? event.reason.message : event.reason}`);
});

function showFatalError(message) {
  console.error('[dashboard fatal]', message);
  const banner = document.getElementById('fatalErrorBanner');
  if (!banner) { alert(message); return; } // page didn't even finish rendering — last resort
  banner.hidden = false;
  banner.textContent = `⚠ ${message}`;
}

document.addEventListener('DOMContentLoaded', () => {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) showApp(); else showLogin();

    document.getElementById('loginForm').addEventListener('submit', onLogin);
    document.getElementById('logoutBtn').addEventListener('click', logout);

    document.querySelectorAll('.app-tab').forEach(tab => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    document.querySelectorAll('#chefFilters .filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        activeChefFilter = chip.dataset.status;
        document.querySelectorAll('#chefFilters .filter-chip').forEach(c => c.classList.toggle('is-active', c === chip));
        renderChefTable();
      });
    });

    document.getElementById('chefModalClose').addEventListener('click', closeChefModal);
    document.getElementById('chefModalOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'chefModalOverlay') closeChefModal();
    });

    document.getElementById('refreshActivityBtn').addEventListener('click', loadActivity);
    wireSettingsForm();
  } catch (err) {
    // If setup itself fails, this is exactly the "nothing happens when I
    // click login" scenario — the form's submit listener never got
    // attached. Surface it loudly instead of leaving a dead page.
    showFatalError(`Dashboard failed to initialize: ${err.message}. Try a hard refresh (Ctrl/Cmd+Shift+R). If it persists, check the browser console (F12) and the server terminal for errors.`);
  }
});

/* ---------------- auth ---------------- */

async function onLogin(e) {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const status = document.getElementById('loginStatus');
  const submitBtn = e.target.querySelector('button[type="submit"]');

  status.textContent = 'Logging in…';
  status.classList.remove('is-error');
  submitBtn.disabled = true;

  // Safety net: if something hangs (server unreachable, network stalls),
  // don't leave the person staring at "Logging in…" forever with no way to
  // tell what's wrong.
  const timeout = setTimeout(() => {
    status.classList.add('is-error');
    status.textContent = `Still waiting on the server after 8 seconds — is "npm start" running? Check the terminal window where you launched the server for errors.`;
  }, 8000);

  try {
    const res = await fetch(`${API}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    let data = {};
    try { data = await res.json(); } catch (parseErr) {
      throw new Error(`Server returned an unexpected response (status ${res.status}). Is the server running at ${window.location.origin}?`);
    }
    if (!res.ok) throw new Error(data.error || `Login failed (status ${res.status}).`);

    clearTimeout(timeout);
    localStorage.setItem(TOKEN_KEY, data.token);
    status.textContent = '';
    showApp();
  } catch (err) {
    clearTimeout(timeout);
    console.error('[admin login]', err);
    status.classList.add('is-error');
    if (err instanceof TypeError) {
      // fetch() throws a plain TypeError for network-level failures (server
      // not running, wrong URL, DNS, CORS rejection, etc) — give a much
      // more actionable message than the raw "Failed to fetch".
      status.textContent = `Can't reach the server at ${window.location.origin}. Make sure "npm start" is running in the server folder, and that you opened this page as http://localhost:4000/dashboard — not as a local file (check the address bar starts with http://, not file://).`;
    } else {
      status.textContent = err.message;
    }
  } finally {
    submitBtn.disabled = false;
  }
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  showLogin();
}

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem(TOKEN_KEY)}` };
}

function showLogin() {
  document.getElementById('loginScreen').hidden = false;
  document.getElementById('appScreen').hidden = true;
}

function showApp() {
  document.getElementById('loginScreen').hidden = true;
  document.getElementById('appScreen').hidden = false;
  loadStats();
  loadChefs();
  loadClients();
  loadBookings();
  loadActivity();
  loadEarnings();
  loadSettings();
}

/* ---------------- tabs ---------------- */

function switchTab(name) {
  document.querySelectorAll('.app-tab').forEach(t => t.classList.toggle('is-active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('is-active', p.id === `tab-${name}`));
}

/* ---------------- data loading ---------------- */

async function apiGet(url) {
  const res = await fetch(`${API}${url}`, { headers: authHeaders() });
  if (res.status === 401 || res.status === 403) { logout(); throw new Error('Session expired'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

async function apiPut(url, body) {
  const res = await fetch(`${API}${url}`, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) { logout(); throw new Error('Session expired'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

async function loadStats() {
  try {
    const s = await apiGet('/api/admin/stats');
    document.getElementById('statPending').textContent = s.chefsPending;
    document.getElementById('statApproved').textContent = s.chefsApproved;
    document.getElementById('statRejected').textContent = s.chefsRejected;
    document.getElementById('statClients').textContent = s.clients;
    document.getElementById('statMedia').textContent = s.mediaPosts;
    document.getElementById('statBookingsPending').textContent = s.bookingsPending;
    document.getElementById('statBookingsTotal').textContent = s.bookingsTotal;
    document.getElementById('statMessages').textContent = s.messagesTotal;
  } catch (err) { console.error(err); }
}

async function loadChefs() {
  try {
    allChefs = await apiGet('/api/admin/chefs');
    renderChefTable();
  } catch (err) { console.error(err); }
}

async function loadClients() {
  try {
    const clients = await apiGet('/api/admin/clients');
    const tbody = document.getElementById('clientTableBody');
    tbody.innerHTML = '';
    document.getElementById('clientEmptyNote').hidden = clients.length > 0;

    clients.forEach(c => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${esc(c.fullName)}</td>
        <td>${esc(c.email)}</td>
        <td>${esc(c.phone || '—')}</td>
        <td>${esc(c.occasion || '—')}</td>
        <td class="${c.emailVerified ? 'badge-yes' : 'badge-no'}">${c.emailVerified ? 'Verified' : 'Unverified'}</td>
        <td>${formatDate(c.createdAt)}</td>
        <td><button class="row-link" data-delete-client="${c.id}">Remove</button></td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('[data-delete-client]').forEach(btn => {
      btn.addEventListener('click', () => deleteClient(btn.dataset.deleteClient));
    });
  } catch (err) { console.error(err); }
}

/* ---------------- bookings ---------------- */

async function loadBookings() {
  try {
    const bookings = await apiGet('/api/admin/bookings');
    const tbody = document.getElementById('bookingTableBody');
    tbody.innerHTML = '';
    document.getElementById('bookingEmptyNote').hidden = bookings.length > 0;

    bookings.forEach(b => {
      const tr = document.createElement('tr');
      const currency = 'KES';
      const paymentOptions = ['unpaid', 'paid_to_platform', 'released_to_chef', 'refunded']
        .map(s => `<option value="${s}" ${b.paymentStatus === s ? 'selected' : ''}>${s.replace(/_/g, ' ')}</option>`)
        .join('');
      tr.innerHTML = `
        <td>${esc(b.eventDate)}</td>
        <td>${esc(b.clientName)}<br><span style="color:var(--paper-ink-soft);font-size:12px;">${esc(b.clientEmail)}</span></td>
        <td>${esc(b.chefName)}<br><span style="color:var(--paper-ink-soft);font-size:12px;">${esc(b.chefEmail)}</span></td>
        <td>${b.agreedAmount != null ? `${currency} ${Number(b.agreedAmount).toLocaleString()}` : '—'}</td>
        <td>${b.commissionAmount != null ? `${currency} ${Number(b.commissionAmount).toLocaleString()} (${b.commissionRate}%)` : '—'}</td>
        <td>${b.chefPayoutAmount != null ? `${currency} ${Number(b.chefPayoutAmount).toLocaleString()}` : '—'}</td>
        <td><span class="badge badge-${b.status}">${esc(b.status)}</span></td>
        <td>
          <select class="payment-status-select" data-booking-id="${b.id}" ${b.agreedAmount == null ? 'disabled' : ''}>
            ${paymentOptions}
          </select>
        </td>
        <td></td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.payment-status-select').forEach(select => {
      select.addEventListener('change', async () => {
        const bookingId = select.dataset.bookingId;
        const newStatus = select.value;
        let reference = '';
        if (newStatus === 'paid_to_platform' || newStatus === 'released_to_chef') {
          reference = prompt('Optional: paste an M-Pesa transaction code or note for your records.') || '';
        }
        try {
          await apiPut(`/api/bookings/${bookingId}/payment`, { paymentStatus: newStatus, reference });
          loadEarnings();
        } catch (err) {
          alert('Failed to update payment status: ' + err.message);
          loadBookings();
        }
      });
    });
  } catch (err) { console.error(err); }
}

/* ---------------- earnings & settings ---------------- */

async function loadEarnings() {
  try {
    const e = await apiGet('/api/admin/earnings');
    const c = e.currency;
    document.getElementById('earnCommission').textContent = `${c} ${e.totalCommissionEarned.toLocaleString()}`;
    document.getElementById('earnClientFees').textContent = `${c} ${e.totalClientFeesEarned.toLocaleString()}`;
    document.getElementById('earnCollected').textContent = `${c} ${e.totalRevenueCollected.toLocaleString()}`;
    document.getElementById('earnOwed').textContent = `${c} ${e.owedToChefs.toLocaleString()}`;
    document.getElementById('earnPaidOut').textContent = `${c} ${e.paidToChefs.toLocaleString()}`;
    document.getElementById('earnAwaiting').textContent = e.awaitingPayoutCount;
  } catch (err) { console.error(err); }
}

async function loadSettings() {
  try {
    const s = await apiGet('/api/admin/settings');
    document.getElementById('setting-commission').value = s.commissionRate;
    document.getElementById('setting-fee-type').value = s.clientFeeType;
    document.getElementById('setting-fee-value').value = s.clientFeeValue;
  } catch (err) { console.error(err); }
}

function wireSettingsForm() {
  document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = document.getElementById('settingsStatus');
    status.textContent = '';
    try {
      await apiPut('/api/admin/settings', {
        commissionRate: Number(document.getElementById('setting-commission').value),
        clientFeeType: document.getElementById('setting-fee-type').value,
        clientFeeValue: Number(document.getElementById('setting-fee-value').value),
      });
      status.classList.remove('is-error');
      status.textContent = 'Saved — new bookings will use these rates.';
    } catch (err) {
      status.classList.add('is-error');
      status.textContent = err.message;
    }
  });
}

/* ---------------- activity feed ---------------- */

const ACTIVITY_ICONS = { chef_applied: '👨‍🍳', client_signup: '👋', booking: '📅', message: '💬' };

async function loadActivity() {
  const feed = document.getElementById('activityFeed');
  try {
    const activity = await apiGet('/api/admin/activity?limit=40');
    if (!activity.length) {
      feed.innerHTML = '<p class="empty-note">Nothing has happened on the platform yet.</p>';
      return;
    }
    feed.innerHTML = '';
    activity.forEach(a => {
      const row = document.createElement('div');
      row.className = 'activity-row';
      row.innerHTML = `
        <span class="activity-icon">${ACTIVITY_ICONS[a.type] || '•'}</span>
        <span class="activity-label">${esc(a.label)}</span>
        <span class="activity-time">${formatDate(a.at)}</span>
      `;
      feed.appendChild(row);
    });
  } catch (err) {
    feed.innerHTML = `<p class="empty-note">Couldn't load activity: ${esc(err.message)}</p>`;
  }
}

function renderChefTable() {
  const tbody = document.getElementById('chefTableBody');
  tbody.innerHTML = '';

  const filtered = activeChefFilter === 'all' ? allChefs : allChefs.filter(c => c.status === activeChefFilter);
  document.getElementById('chefEmptyNote').hidden = filtered.length > 0;

  filtered.forEach(c => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(c.fullName)}</td>
      <td>${esc(c.email)}</td>
      <td>${esc(c.chefType || '—')}</td>
      <td class="${c.emailVerified ? 'badge-yes' : 'badge-no'}">${c.emailVerified ? 'Verified' : 'Unverified'}</td>
      <td><span class="badge badge-${c.status}">${c.status}</span></td>
      <td>${formatDate(c.createdAt)}</td>
      <td><button class="row-link" data-view-chef="${c.id}">View</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('[data-view-chef]').forEach(btn => {
    btn.addEventListener('click', () => openChefModal(btn.dataset.viewChef));
  });
}

/* ---------------- chef detail modal ---------------- */

async function openChefModal(id) {
  try {
    const chef = await apiGet(`/api/admin/chefs/${id}`);
    const token = localStorage.getItem(TOKEN_KEY);
    const body = document.getElementById('chefModalBody');

    const mediaHtml = chef.media.length
      ? `<div class="media-grid">${chef.media.map(m => m.type === 'video'
          ? `<video src="${m.url}" muted></video>`
          : `<img src="${m.url}" alt="${esc(m.caption || '')}">`).join('')}</div>`
      : `<p style="font-size:13.5px;color:var(--paper-ink-soft);margin-bottom:24px;">No portfolio photos or videos posted yet.</p>`;

    body.innerHTML = `
      <div class="chef-detail">
        <h3>${esc(chef.fullName)}</h3>
        <p class="type">${esc(chef.chefType || 'Type not specified')} · <span class="badge badge-${chef.status}">${chef.status}</span></p>
        <div class="meta-row">
          <span>${esc(chef.email)}</span>
          <span>${esc(chef.phone || 'No phone provided')}</span>
          <span>Applied ${formatDate(chef.createdAt)}</span>
        </div>
        <div class="why-box">${esc(chef.whyJoin || '')}</div>
        <div class="doc-links">
          <a href="${chef.cvUrl}&token=${token}" target="_blank" rel="noopener">Download CV / résumé</a>
          <a href="${chef.coverLetterUrl}&token=${token}" target="_blank" rel="noopener">Download cover letter</a>
        </div>
        <p style="font-family:var(--font-mono);font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:var(--paper-ink-soft);margin-bottom:12px;">Portfolio</p>
        ${mediaHtml}
        <div class="action-row">
          <button class="action-btn action-approve" data-status="approved">Approve</button>
          <button class="action-btn action-reject" data-status="rejected">Reject</button>
          <button class="action-btn action-delete" data-delete-chef="${chef.id}">Delete application</button>
        </div>
      </div>
    `;

    body.querySelectorAll('[data-status]').forEach(btn => {
      btn.addEventListener('click', () => setChefStatus(chef.id, btn.dataset.status));
    });
    body.querySelector('[data-delete-chef]').addEventListener('click', () => deleteChef(chef.id));

    document.getElementById('chefModalOverlay').hidden = false;
  } catch (err) {
    alert(err.message);
  }
}

function closeChefModal() {
  document.getElementById('chefModalOverlay').hidden = true;
}

async function setChefStatus(id, status) {
  try {
    const res = await fetch(`${API}/api/admin/chefs/${id}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ status }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    closeChefModal();
    loadChefs();
    loadStats();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteChef(id) {
  if (!confirm('Permanently delete this chef application? This cannot be undone.')) return;
  try {
    const res = await fetch(`${API}/api/admin/chefs/${id}`, { method: 'DELETE', headers: authHeaders() });
    if (!res.ok) throw new Error((await res.json()).error);
    closeChefModal();
    loadChefs();
    loadStats();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteClient(id) {
  if (!confirm('Permanently remove this client? This cannot be undone.')) return;
  try {
    const res = await fetch(`${API}/api/admin/clients/${id}`, { method: 'DELETE', headers: authHeaders() });
    if (!res.ok) throw new Error((await res.json()).error);
    loadClients();
    loadStats();
  } catch (err) {
    alert(err.message);
  }
}

/* ---------------- helpers ---------------- */

function esc(str = '') {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
