/* CULINARA — account.html behavior
   Handles: login, forgot/reset password, and the logged-in chef/client
   profile views (contact details + chef portfolio uploads).

   API_BASE is empty because the backend (server/) serves this static site
   itself, so API calls are same-origin. If you ever host the frontend
   separately from the backend, set API_BASE to your backend's full URL,
   e.g. 'https://api.culinara.com'. */

const API_BASE = '';
const TOKEN_KEY = 'culinara_token';
const ROLE_KEY = 'culinara_role';

document.addEventListener('DOMContentLoaded', () => {
  wireLoginRoleTabs();
  wireLoginForm();
  wireForgotFlow();
  wireResetFlow();
  wireChefProfile();
  wireClientProfile();
  wireChefSearchLiveInput();
  wireMenuForm();
  wireBookingModal();
  wireMessageForms();

  routeOnLoad();
});

/* ---------------------------------------------------------------------
   Routing between views based on URL params + stored session
   ------------------------------------------------------------------- */

function views() {
  return {
    login: document.getElementById('view-login'),
    forgot: document.getElementById('view-forgot'),
    reset: document.getElementById('view-reset'),
    chef: document.getElementById('view-chef-profile'),
    client: document.getElementById('view-client-profile'),
  };
}

function showView(name) {
  const v = views();
  Object.entries(v).forEach(([key, el]) => { el.hidden = key !== name; });
}

function routeOnLoad() {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode');
  const role = params.get('role');

  // Arrived from the "reset password" email link
  if (mode === 'reset' && params.get('token')) {
    document.getElementById('resetForm').dataset.token = params.get('token');
    document.getElementById('resetForm').dataset.role = role || 'chef';
    showView('reset');
    return;
  }

  // Arrived from the "verify your email" link — exchange the short-lived
  // vtoken for a real session so the person lands logged in, instead of
  // having to type their password again right after verifying.
  const vtoken = params.get('vtoken');
  if (params.get('verified') === '1' && vtoken && (role === 'chef' || role === 'client')) {
    exchangeVerifyToken(vtoken, role);
    return;
  }

  const token = localStorage.getItem(TOKEN_KEY);
  const storedRole = localStorage.getItem(ROLE_KEY);

  if (token && storedRole === 'chef') return loadChefProfile();
  if (token && storedRole === 'client') return loadClientProfile();

  // Arrived from the "verify your email" link — preselect the right tab
  if (role === 'chef' || role === 'client') setLoginRole(role);
  showView('login');
}

async function exchangeVerifyToken(vtoken, role) {
  try {
    const data = await apiFetch('/api/auth/exchange', {
      method: 'POST',
      body: JSON.stringify({ vtoken }),
    });
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(ROLE_KEY, role);
    // Clean the token out of the URL bar now that it's been used.
    window.history.replaceState({}, '', 'account.html');
    if (role === 'chef') {
      await loadChefProfile();
      flashWelcomeBanner('chef');
    } else {
      await loadClientProfile();
      flashWelcomeBanner('client');
    }
  } catch (err) {
    // Link expired or already used — fall back to a normal login, with a
    // clear explanation instead of a dead end.
    setLoginRole(role);
    showView('login');
    const status = document.getElementById('login-status');
    status.classList.add('is-error');
    status.textContent = 'Your email is verified! That verification link already expired — please log in below.';
  }
}

function flashWelcomeBanner(role) {
  const heading = document.getElementById(role === 'chef' ? 'chefProfileName' : 'clientProfileName');
  if (!heading) return;
  const banner = document.createElement('p');
  banner.className = 'welcome-banner';
  banner.textContent = role === 'chef'
    ? "✓ Email verified! Complete your profile below — add your chef type, your rate, and post to your portfolio."
    : "✓ Email verified! Search for chefs below whenever you're ready.";
  heading.closest('.account-card').insertBefore(banner, heading.closest('.profile-head'));
  setTimeout(() => banner.remove(), 8000);
}

/* ---------------------------------------------------------------------
   Login — role tabs + submit
   ------------------------------------------------------------------- */

function setLoginRole(role) {
  document.getElementById('role-chef-btn').classList.toggle('is-active', role === 'chef');
  document.getElementById('role-client-btn').classList.toggle('is-active', role === 'client');
  document.getElementById('loginForm').dataset.role = role;
}

function wireLoginRoleTabs() {
  document.getElementById('loginForm').dataset.role = 'chef';
  document.getElementById('role-chef-btn').addEventListener('click', () => setLoginRole('chef'));
  document.getElementById('role-client-btn').addEventListener('click', () => setLoginRole('client'));
}

function wireLoginForm() {
  const form = document.getElementById('loginForm');
  const status = document.getElementById('login-status');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = '';
    status.classList.remove('is-error');

    const role = form.dataset.role || 'chef';
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;

    try {
      const data = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password, role }),
      });
      localStorage.setItem(TOKEN_KEY, data.token);
      localStorage.setItem(ROLE_KEY, role);
      if (role === 'chef') loadChefProfile(); else loadClientProfile();
    } catch (err) {
      status.textContent = err.message;
      status.classList.add('is-error');
    }
  });

  document.getElementById('forgotLink').addEventListener('click', () => {
    document.getElementById('forgot-role').value = form.dataset.role || 'chef';
    showView('forgot');
  });
}

/* ---------------------------------------------------------------------
   Forgot / reset password
   ------------------------------------------------------------------- */

function wireForgotFlow() {
  const form = document.getElementById('forgotForm');
  const status = document.getElementById('forgot-status');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = '';
    try {
      const data = await apiFetch('/api/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('forgot-email').value.trim(),
          role: document.getElementById('forgot-role').value,
        }),
      });
      status.classList.remove('is-error');
      status.textContent = data.message;
    } catch (err) {
      status.classList.add('is-error');
      status.textContent = err.message;
    }
  });

  document.getElementById('backToLoginLink').addEventListener('click', () => showView('login'));
}

function wireResetFlow() {
  const form = document.getElementById('resetForm');
  const status = document.getElementById('reset-status');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = '';
    try {
      const data = await apiFetch('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({
          token: form.dataset.token,
          role: form.dataset.role,
          newPassword: document.getElementById('reset-password').value,
        }),
      });
      status.classList.remove('is-error');
      status.textContent = `${data.message} Redirecting to log in…`;
      setTimeout(() => { window.location.href = 'account.html'; }, 1800);
    } catch (err) {
      status.classList.add('is-error');
      status.textContent = err.message;
    }
  });
}

/* ---------------------------------------------------------------------
   Chef profile
   ------------------------------------------------------------------- */

function wireChefProfile() {
  document.getElementById('chefLogoutBtn').addEventListener('click', logout);

  document.getElementById('chefDetailsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = document.getElementById('chef-details-status');
    status.textContent = '';
    try {
      await authedFetch('/api/chefs/me', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: document.getElementById('chef-p-phone').value.trim(),
          chefType: document.getElementById('chef-p-type').value.trim(),
          priceNote: document.getElementById('chef-p-price').value.trim(),
          paymentMethodType: document.getElementById('chef-p-pay-type').value,
          paymentMethodValue: document.getElementById('chef-p-pay-value').value.trim(),
        }),
      });
      status.classList.remove('is-error');
      status.textContent = 'Saved.';
    } catch (err) {
      status.classList.add('is-error');
      status.textContent = err.message;
    }
  });

  wirePayValueLabel('chef-p-pay-type', 'chef-p-pay-value-label');

  const mediaInput = document.getElementById('media-file');
  mediaInput.addEventListener('change', () => {
    const nameEl = mediaInput.closest('.file-input').querySelector('.file-label-name');
    nameEl.textContent = mediaInput.files[0] ? mediaInput.files[0].name : nameEl.dataset.empty;
  });

  document.getElementById('mediaUploadForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = document.getElementById('media-status');
    status.textContent = '';

    const file = mediaInput.files[0];
    if (!file) {
      status.classList.add('is-error');
      status.textContent = 'Choose a photo or video first.';
      return;
    }

    const fd = new FormData();
    fd.append('file', file);
    fd.append('caption', document.getElementById('media-caption').value.trim());

    try {
      await authedFetch('/api/chefs/me/media', { method: 'POST', body: fd });
      status.classList.remove('is-error');
      status.textContent = 'Posted to your portfolio.';
      e.target.reset();
      mediaInput.closest('.file-input').querySelector('.file-label-name').textContent = 'No file selected';
      loadChefProfile();
    } catch (err) {
      status.classList.add('is-error');
      status.textContent = err.message;
    }
  });
}

async function loadChefProfile() {
  try {
    const data = await authedFetch('/api/chefs/me');
    showView('chef');

    document.getElementById('chefProfileName').textContent = data.profile.fullName;
    document.getElementById('chef-p-phone').value = data.profile.phone || '';
    document.getElementById('chef-p-type').value = data.profile.chefType || '';
    document.getElementById('chef-p-price').value = data.profile.priceNote || '';
    document.getElementById('chef-p-pay-type').value = data.profile.paymentMethodType || '';
    document.getElementById('chef-p-pay-value').value = data.profile.paymentMethodValue || '';

    const badge = document.getElementById('chefStatusBadge');
    badge.textContent = data.profile.status;
    document.getElementById('chefPendingNote').hidden = data.profile.status !== 'pending';
    document.getElementById('chefRejectedNote').hidden = data.profile.status !== 'rejected';

    renderMediaList(data.media);
    renderMenuList(data.menu);
    loadBookings('chef');
    initMessaging('chef', data.profile.id);
  } catch (err) {
    logout();
  }
}

/* ---------------------------------------------------------------------
   Chef menu builder
   ------------------------------------------------------------------- */

function wireMenuForm() {
  document.getElementById('menuAddForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = document.getElementById('menu-status');
    status.textContent = '';
    const name = document.getElementById('menu-name').value.trim();
    try {
      await authedFetch('/api/chefs/me/menu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description: document.getElementById('menu-description').value.trim(),
          price: document.getElementById('menu-price').value.trim(),
        }),
      });
      status.classList.remove('is-error');
      status.textContent = 'Added.';
      e.target.reset();
      loadChefProfile();
    } catch (err) {
      status.classList.add('is-error');
      status.textContent = err.message;
    }
  });
}

function renderMenuList(menu) {
  const list = document.getElementById('menuItemList');
  if (!menu.length) {
    list.innerHTML = '<p class="search-status">No dishes added yet.</p>';
    return;
  }
  list.innerHTML = '';
  menu.forEach(item => {
    const row = document.createElement('div');
    row.className = 'menu-item-row';
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(item.name)}</strong>
        ${item.price ? `<span class="menu-item-price">${escapeHtml(item.price)}</span>` : ''}
        ${item.description ? `<p class="menu-item-desc">${escapeHtml(item.description)}</p>` : ''}
      </div>
      <button type="button" class="remove-btn" data-id="${item.id}" aria-label="Remove dish">×</button>
    `;
    row.querySelector('.remove-btn').addEventListener('click', async () => {
      if (!confirm('Remove this dish from your menu?')) return;
      try {
        await authedFetch(`/api/chefs/me/menu/${item.id}`, { method: 'DELETE' });
        loadChefProfile();
      } catch (err) {
        alert(err.message);
      }
    });
    list.appendChild(row);
  });
}

function renderMediaList(media) {
  const list = document.getElementById('mediaList');
  list.innerHTML = '';
  media.forEach(m => {
    const div = document.createElement('div');
    div.className = 'media-item';
    div.innerHTML = `
      ${m.type === 'video' ? `<video src="${m.url}" muted controls preload="metadata"></video>` : `<img src="${m.url}" alt="${escapeHtml(m.caption || 'Chef portfolio photo')}" loading="lazy" decoding="async">`}
      <button class="remove-btn" aria-label="Remove" data-id="${m.id}">×</button>
      ${m.caption ? `<p class="caption">${escapeHtml(m.caption)}</p>` : ''}
    `;
    div.querySelector('.remove-btn').addEventListener('click', () => removeMedia(m.id));
    list.appendChild(div);
  });
}

async function removeMedia(id) {
  if (!confirm('Remove this from your portfolio?')) return;
  try {
    await authedFetch(`/api/chefs/me/media/${id}`, { method: 'DELETE' });
    loadChefProfile();
  } catch (err) {
    alert(err.message);
  }
}

/* ---------------------------------------------------------------------
   Client profile
   ------------------------------------------------------------------- */

function wireClientProfile() {
  document.getElementById('clientLogoutBtn').addEventListener('click', logout);

  document.getElementById('clientDetailsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = document.getElementById('client-details-status');
    status.textContent = '';
    try {
      await authedFetch('/api/clients/me', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: document.getElementById('client-p-phone').value.trim(),
          occasion: document.getElementById('client-p-occasion').value.trim(),
          paymentMethodType: document.getElementById('client-p-pay-type').value,
          paymentMethodValue: document.getElementById('client-p-pay-value').value.trim(),
        }),
      });
      status.classList.remove('is-error');
      status.textContent = 'Saved.';
    } catch (err) {
      status.classList.add('is-error');
      status.textContent = err.message;
    }
  });

  wirePayValueLabel('client-p-pay-type', 'client-p-pay-value-label');

  document.getElementById('chefSearchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    runChefSearch();
  });
}

function wirePayValueLabel(selectId, labelId) {
  const select = document.getElementById(selectId);
  const label = document.getElementById(labelId);
  const update = () => {
    if (select.value === 'paypal') label.textContent = 'PayPal email';
    else if (select.value === 'mpesa') label.textContent = 'M-Pesa phone number';
    else label.textContent = 'PayPal email / M-Pesa number';
  };
  select.addEventListener('change', update);
  update();
}

let searchDebounce = null;
function wireChefSearchLiveInput() {
  const input = document.getElementById('chef-search-q');
  input.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(runChefSearch, 350);
  });
}

async function runChefSearch() {
  const q = document.getElementById('chef-search-q').value.trim();
  const results = document.getElementById('chefSearchResults');
  results.innerHTML = '<p class="search-status">Searching…</p>';
  try {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    const chefs = await apiFetch(`/api/chefs?${params.toString()}`);
    renderChefResults(chefs);
  } catch (err) {
    results.innerHTML = `<p class="search-status is-error">${escapeHtml(err.message)}</p>`;
  }
}

function renderChefResults(chefs) {
  const results = document.getElementById('chefSearchResults');
  if (!chefs.length) {
    results.innerHTML = '<p class="search-status">No approved chefs match yet — check back soon, or try a different search.</p>';
    return;
  }
  results.innerHTML = '';
  chefs.forEach(c => {
    const card = document.createElement('div');
    card.className = 'chef-result-card';
    card.innerHTML = `
      <h3>${escapeHtml(c.fullName)}</h3>
      <p class="chef-result-type">${escapeHtml(c.chefType || 'Private chef')}</p>
      ${c.priceNote ? `<p class="chef-result-price">${escapeHtml(c.priceNote)}</p>` : ''}
      <div class="chef-result-actions">
        <button type="button" class="btn btn-ghost btn-small message-chef-btn">Message</button>
        <button type="button" class="btn btn-primary btn-small book-chef-btn">Book</button>
      </div>
    `;
    card.querySelector('.message-chef-btn').addEventListener('click', () => openConversationWith('client', c.id, c.fullName));
    card.querySelector('.book-chef-btn').addEventListener('click', () => openBookingModal(c.id, c.fullName));
    results.appendChild(card);
  });
}

async function loadClientProfile() {
  try {
    const data = await authedFetch('/api/clients/me');
    showView('client');
    document.getElementById('clientProfileName').textContent = data.fullName;
    document.getElementById('client-p-phone').value = data.phone || '';
    document.getElementById('client-p-occasion').value = data.occasion || '';
    document.getElementById('client-p-pay-type').value = data.paymentMethodType || '';
    document.getElementById('client-p-pay-value').value = data.paymentMethodValue || '';
    runChefSearch();
    loadBookings('client');
    initMessaging('client', data.id);
  } catch (err) {
    logout();
  }
}

/* ---------------------------------------------------------------------
   Bookings (shared by both roles)
   ------------------------------------------------------------------- */

let cachedPlatformSettings = null;

async function getPlatformSettings() {
  if (cachedPlatformSettings) return cachedPlatformSettings;
  try {
    cachedPlatformSettings = await apiFetch('/api/bookings/platform-fees');
  } catch (err) {
    cachedPlatformSettings = { commissionRate: 20, clientFeeType: 'percent', clientFeeValue: 5, currency: 'KES' };
  }
  return cachedPlatformSettings;
}

function wireBookingModal() {
  const overlay = document.getElementById('bookingModalOverlay');
  document.getElementById('bookingModalClose').addEventListener('click', closeBookingModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeBookingModal(); });

  document.getElementById('booking-amount').addEventListener('input', updateBookingFeeBreakdown);

  document.getElementById('bookingForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = document.getElementById('booking-status');
    status.textContent = '';
    try {
      const data = await authedFetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chefId: Number(document.getElementById('booking-chef-id').value),
          eventDate: document.getElementById('booking-date').value,
          agreedAmount: Number(document.getElementById('booking-amount').value),
          note: document.getElementById('booking-note').value.trim(),
        }),
      });
      status.classList.remove('is-error');
      status.textContent = data.message;
      setTimeout(() => {
        closeBookingModal();
        loadBookings('client');
      }, 1200);
    } catch (err) {
      status.classList.add('is-error');
      status.textContent = err.message;
    }
  });
}

async function updateBookingFeeBreakdown() {
  const amount = Number(document.getElementById('booking-amount').value);
  const breakdown = document.getElementById('bookingFeeBreakdown');
  if (!amount || amount <= 0) { breakdown.textContent = ''; return; }

  const settings = await getPlatformSettings();
  const clientFee = settings.clientFeeType === 'percent'
    ? Math.round(amount * settings.clientFeeValue) / 100
    : settings.clientFeeValue;
  const total = amount + clientFee;
  breakdown.textContent = `${settings.currency} ${amount.toLocaleString()} to the chef + ${settings.currency} ${clientFee.toLocaleString()} service fee = ${settings.currency} ${total.toLocaleString()} total. You'll pay this directly to the chef/platform as arranged — CULINARA tracks it here.`;
}

async function openBookingModal(chefId, chefName) {
  document.getElementById('bookingModalTitle').textContent = `Book ${chefName}`;
  document.getElementById('booking-chef-id').value = chefId;
  document.getElementById('booking-date').value = '';
  document.getElementById('booking-amount').value = '';
  document.getElementById('booking-note').value = '';
  document.getElementById('booking-status').textContent = '';
  document.getElementById('bookingFeeBreakdown').textContent = '';
  const hint = document.getElementById('bookingDatesHint');
  hint.textContent = 'Checking availability…';

  document.getElementById('bookingModalOverlay').hidden = false;

  try {
    const dates = await apiFetch(`/api/bookings/chef/${chefId}/dates`);
    if (dates.length) {
      const taken = dates.map(d => d.date).join(', ');
      hint.textContent = `Already requested/booked: ${taken}`;
    } else {
      hint.textContent = 'No dates booked yet — pick any date.';
    }
  } catch (err) {
    hint.textContent = '';
  }
}

function closeBookingModal() {
  document.getElementById('bookingModalOverlay').hidden = true;
}

async function loadBookings(role) {
  const listEl = document.getElementById(role === 'chef' ? 'chefBookingList' : 'clientBookingList');
  try {
    const bookings = await authedFetch('/api/bookings/mine');
    if (!bookings.length) {
      listEl.innerHTML = '<p class="search-status">No bookings yet.</p>';
      return;
    }
    listEl.innerHTML = '';
    bookings.forEach(b => {
      const row = document.createElement('div');
      row.className = 'booking-row';
      const counterpart = role === 'chef' ? b.clientName : b.chefName;
      const currency = 'KES'; // matches the platform's configured currency
      const moneyLine = role === 'chef'
        ? `Agreed: ${currency} ${Number(b.agreedAmount).toLocaleString()} · Your payout: <strong>${currency} ${Number(b.chefPayoutAmount).toLocaleString()}</strong> (after ${b.commissionRate}% commission)`
        : `Agreed: ${currency} ${Number(b.agreedAmount).toLocaleString()} + ${currency} ${Number(b.clientFeeAmount).toLocaleString()} fee = <strong>${currency} ${Number(b.totalClientCharge).toLocaleString()} total</strong>`;
      row.innerHTML = `
        <div>
          <strong>${escapeHtml(b.eventDate)}</strong> — ${escapeHtml(counterpart)}
          <span class="badge booking-status-${b.status}">${escapeHtml(b.status)}</span>
          ${b.note ? `<p class="menu-item-desc">${escapeHtml(b.note)}</p>` : ''}
          ${b.agreedAmount ? `<p class="booking-money-line">${moneyLine}</p>` : ''}
          ${b.paymentStatus && b.paymentStatus !== 'unpaid' ? `<span class="badge payment-status-${b.paymentStatus}">${escapeHtml(b.paymentStatus.replace(/_/g, ' '))}</span>` : ''}
        </div>
        <div class="booking-actions"></div>
      `;
      const actions = row.querySelector('.booking-actions');
      if (role === 'chef' && b.status === 'pending') {
        actions.innerHTML = `<button type="button" class="btn btn-primary btn-small" data-action="confirmed">Confirm</button>
                              <button type="button" class="btn btn-ghost btn-small" data-action="declined">Decline</button>`;
      } else if (role === 'client' && b.status === 'pending') {
        actions.innerHTML = `<button type="button" class="btn btn-ghost btn-small" data-action="cancelled">Cancel</button>`;
      }
      actions.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            await authedFetch(`/api/bookings/${b.id}/status`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: btn.dataset.action }),
            });
            loadBookings(role);
          } catch (err) {
            alert(err.message);
          }
        });
      });
      listEl.appendChild(row);
    });
  } catch (err) {
    listEl.innerHTML = `<p class="search-status is-error">${escapeHtml(err.message)}</p>`;
  }
}

/* ---------------------------------------------------------------------
   Real-time messaging (REST for history, WebSocket for live delivery)
   ------------------------------------------------------------------- */

let messagingState = { role: null, selfId: null, activeCounterpartId: null, socket: null };

function wireMessageForms() {
  ['chef', 'client'].forEach(role => {
    document.getElementById(`${role}MessageForm`).addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById(`${role}-message-input`);
      const body = input.value.trim();
      if (!body || !messagingState.activeCounterpartId) return;
      input.value = '';
      try {
        const msg = await authedFetch('/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ counterpartId: messagingState.activeCounterpartId, body }),
        });
        appendMessageToConversation(role, { senderRole: role, body: msg.body, createdAt: msg.createdAt });
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

function initMessaging(role, selfId) {
  messagingState.role = role;
  messagingState.selfId = selfId;
  messagingState.activeCounterpartId = null;
  loadThreads(role);
  connectMessagingSocket(role);
}

async function loadThreads(role) {
  const listEl = document.getElementById(`${role}ThreadList`);
  try {
    const threads = await authedFetch('/api/messages/threads');
    if (!threads.length) {
      listEl.innerHTML = '<p class="search-status">No conversations yet — message a chef from search results, or wait for a client to reach out.</p>';
      return;
    }
    listEl.innerHTML = '';
    threads.forEach(t => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'thread-item';
      item.innerHTML = `
        <span class="thread-name">${escapeHtml(t.counterpartName)}</span>
        <span class="thread-preview">${escapeHtml(t.lastMessage || '')}</span>
        ${t.unread ? `<span class="thread-unread-dot"></span>` : ''}
      `;
      item.addEventListener('click', () => openConversationWith(role, t.counterpartId, t.counterpartName));
      listEl.appendChild(item);
    });
  } catch (err) {
    listEl.innerHTML = `<p class="search-status is-error">${escapeHtml(err.message)}</p>`;
  }
}

async function openConversationWith(role, counterpartId, counterpartName) {
  messagingState.activeCounterpartId = counterpartId;
  const messagesEl = document.getElementById(`${role}ConversationMessages`);
  const formEl = document.getElementById(`${role}MessageForm`);
  messagesEl.innerHTML = '<p class="search-status">Loading…</p>';
  formEl.hidden = false;

  try {
    const history = await authedFetch(`/api/messages/thread/${counterpartId}`);
    messagesEl.innerHTML = '';
    const heading = document.createElement('p');
    heading.className = 'conversation-heading';
    heading.textContent = counterpartName;
    messagesEl.appendChild(heading);
    history.forEach(m => appendMessageToConversation(role, m, false));
    messagesEl.scrollTop = messagesEl.scrollHeight;
    loadThreads(role); // refresh unread counts
  } catch (err) {
    messagesEl.innerHTML = `<p class="search-status is-error">${escapeHtml(err.message)}</p>`;
  }
}

function appendMessageToConversation(role, msg, scroll = true) {
  const messagesEl = document.getElementById(`${role}ConversationMessages`);
  const bubble = document.createElement('div');
  const isSystem = msg.senderRole === 'system';
  bubble.className = `message-bubble ${isSystem ? 'is-system' : (msg.senderRole === role ? 'is-mine' : 'is-theirs')}`;
  bubble.innerHTML = `<p>${escapeHtml(msg.body).replace(/\n/g, '<br>')}</p><time>${new Date(msg.createdAt).toLocaleString()}</time>`;
  messagesEl.appendChild(bubble);
  if (scroll) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function connectMessagingSocket(role) {
  if (messagingState.socket) { try { messagingState.socket.close(); } catch (e) {} }
  const token = localStorage.getItem(TOKEN_KEY);
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);

  socket.addEventListener('message', (event) => {
    let payload;
    try { payload = JSON.parse(event.data); } catch (e) { return; }
    if (payload.type !== 'message') return;

    // If this message belongs to the conversation currently open, show it
    // immediately; either way, refresh the thread list so previews/unread
    // counts stay current.
    if (messagingState.activeCounterpartId === payload.from) {
      appendMessageToConversation(role, payload);
    }
    loadThreads(role);
  });

  socket.addEventListener('close', () => {
    // Reconnect after a short delay if the tab is still on this profile —
    // covers the server restarting or a brief network drop.
    setTimeout(() => {
      if (messagingState.role === role) connectMessagingSocket(role);
    }, 3000);
  });

  messagingState.socket = socket;
}

/* ---------------------------------------------------------------------
   Shared helpers
   ------------------------------------------------------------------- */

function logout() {
  if (messagingState.socket) { try { messagingState.socket.close(); } catch (e) {} }
  messagingState = { role: null, selfId: null, activeCounterpartId: null, socket: null };
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ROLE_KEY);
  window.location.href = 'account.html';
}

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

// Like apiFetch, but attaches the logged-in user's token. Leaves headers
// alone when the body is FormData (the browser sets the multipart
// Content-Type itself, with the correct boundary).
async function authedFetch(path, options = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  const isFormData = options.body instanceof FormData;
  const headers = { Authorization: `Bearer ${token}`, ...(options.headers || {}) };
  if (!isFormData && options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

function escapeHtml(str = '') {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
