/* CULINARA — site behavior
   No build step required. Vanilla JS only.

   API_BASE is empty because the backend (server/) serves this static site
   itself, so API calls are same-origin — just run `npm start` inside
   server/ and open the URL it prints. If you ever host this frontend
   separately from the backend, set API_BASE to the backend's full URL. */

const API_BASE = '';

document.addEventListener('DOMContentLoaded', () => {

  /* ---------- Sticky header ---------- */
  const header = document.getElementById('siteHeader');
  const onScroll = () => {
    header.classList.toggle('is-scrolled', window.scrollY > 12);
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  /* ---------- Mobile nav toggle ---------- */
  const navToggle = document.getElementById('navToggle');
  const mainNav = document.getElementById('mainNav');
  navToggle.addEventListener('click', () => {
    const isOpen = mainNav.classList.toggle('is-open');
    navToggle.setAttribute('aria-expanded', String(isOpen));
  });
  mainNav.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      mainNav.classList.remove('is-open');
      navToggle.setAttribute('aria-expanded', 'false');
    });
  });

  /* ---------- Join tabs (chef / client) ---------- */
  const tabs = document.querySelectorAll('.join-tab');
  const panels = {
    'tab-chef': document.getElementById('panel-chef'),
    'tab-client': document.getElementById('panel-client'),
  };

  function activateTab(tab) {
    tabs.forEach(t => {
      const isActive = t === tab;
      t.classList.toggle('is-active', isActive);
      t.setAttribute('aria-selected', String(isActive));
      t.tabIndex = isActive ? 0 : -1;
    });
    Object.entries(panels).forEach(([id, panel]) => {
      const isActive = id === tab.id;
      panel.classList.toggle('is-active', isActive);
      panel.hidden = !isActive;
    });
  }

  tabs.forEach(tab => {
    tab.addEventListener('click', () => activateTab(tab));
  });

  /* ---------- File input labels ---------- */
  document.querySelectorAll('.file-input input[type="file"]').forEach(input => {
    input.addEventListener('change', () => {
      const nameEl = input.closest('.file-input').querySelector('.file-label-name');
      if (input.files && input.files.length > 0) {
        nameEl.textContent = input.files[0].name;
      } else {
        nameEl.textContent = nameEl.dataset.empty;
      }
    });
  });

  /* ---------- Chef application submit ---------- */
  const chefForm = document.getElementById('panel-chef');
  const chefStatus = document.getElementById('chef-status');

  chefForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    chefStatus.classList.remove('is-error');

    if (!chefForm.checkValidity()) {
      chefForm.reportValidity();
      return;
    }

    const password = document.getElementById('chef-password').value;
    const confirm = document.getElementById('chef-password-confirm').value;
    if (password !== confirm) {
      setStatus(chefStatus, "Passwords don't match.", true);
      return;
    }
    if (password.length < 8) {
      setStatus(chefStatus, 'Password must be at least 8 characters.', true);
      return;
    }

    const fd = new FormData();
    fd.append('fullName', document.getElementById('chef-name').value.trim());
    fd.append('email', document.getElementById('chef-email').value.trim());
    fd.append('phone', document.getElementById('chef-phone').value.trim());
    fd.append('chefType', document.getElementById('chef-type').value.trim());
    fd.append('why', document.getElementById('chef-why').value.trim());
    fd.append('password', password);
    fd.append('cv', document.getElementById('chef-cv').files[0]);
    fd.append('coverLetter', document.getElementById('chef-cover').files[0]);

    setSubmitting(chefForm, true);
    try {
      const res = await fetch(`${API_BASE}/api/chefs/apply`, { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');

      setStatus(chefStatus, 'Application received — redirecting you…', false);
      chefForm.reset();
      chefForm.querySelectorAll('.file-label-name').forEach(el => { el.textContent = el.dataset.empty; });
      window.location.href = 'thank-you.html?role=chef';
      return;
    } catch (err) {
      setStatus(chefStatus, err.message, true);
    } finally {
      setSubmitting(chefForm, false);
    }
  });

  /* ---------- Client signup submit ---------- */
  const clientForm = document.getElementById('panel-client');
  const clientStatus = document.getElementById('client-status');

  clientForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clientStatus.classList.remove('is-error');

    if (!clientForm.checkValidity()) {
      clientForm.reportValidity();
      return;
    }

    const password = document.getElementById('client-password').value;
    const confirm = document.getElementById('client-password-confirm').value;
    if (password !== confirm) {
      setStatus(clientStatus, "Passwords don't match.", true);
      return;
    }
    if (password.length < 8) {
      setStatus(clientStatus, 'Password must be at least 8 characters.', true);
      return;
    }

    const payload = {
      fullName: document.getElementById('client-name').value.trim(),
      email: document.getElementById('client-email').value.trim(),
      phone: document.getElementById('client-phone').value.trim(),
      occasion: document.getElementById('client-occasion').value.trim(),
      password,
    };

    setSubmitting(clientForm, true);
    try {
      const res = await fetch(`${API_BASE}/api/clients/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');

      setStatus(clientStatus, 'Check your email to verify your address, then log in — redirecting you…', false);
      clientForm.reset();
      window.location.href = 'thank-you.html?role=client';
      return;
    } catch (err) {
      setStatus(clientStatus, err.message, true);
    } finally {
      setSubmitting(clientForm, false);
    }
  });

  function setStatus(el, message, isError) {
    el.textContent = message;
    el.classList.toggle('is-error', !!isError);
  }

  function setSubmitting(form, isSubmitting) {
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = isSubmitting;
    btn.dataset.originalText = btn.dataset.originalText || btn.textContent;
    btn.textContent = isSubmitting ? 'Submitting…' : btn.dataset.originalText;
  }

  /* ---------- Privacy / Terms modal ---------- */
  const overlay = document.getElementById('modalOverlay');
  const modalTitle = document.getElementById('modalTitle');
  const modalClose = document.getElementById('modalClose');
  let lastFocused = null;

  const titles = {
    privacy: 'Privacy Policy & Terms',
    terms: 'Terms of Service',
  };

  function openModal(key) {
    lastFocused = document.activeElement;
    modalTitle.textContent = titles[key] || titles.privacy;
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    modalClose.focus();
  }

  function closeModal() {
    overlay.hidden = true;
    document.body.style.overflow = '';
    if (lastFocused) lastFocused.focus();
  }

  document.querySelectorAll('[data-open-modal]').forEach(btn => {
    btn.addEventListener('click', () => openModal(btn.dataset.openModal));
  });

  modalClose.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) closeModal();
  });

  /* ---------- Scroll reveal ---------- */
  const revealTargets = document.querySelectorAll(
    '.section-title, .menu-item, .chef-ticket, .about-copy, .about-side, .join-card, .story-card, .review-card, .faq-item'
  );
  revealTargets.forEach(el => el.classList.add('reveal'));

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -60px 0px' });

    revealTargets.forEach(el => io.observe(el));
  } else {
    revealTargets.forEach(el => el.classList.add('is-visible'));
  }

  /* ---------- Sticky mobile CTA ---------- */
  // Hides itself once the real "Join" section/form is already on screen,
  // so it never floats redundantly over the form it's pointing at.
  const stickyCta = document.getElementById('stickyCta');
  const joinSection = document.getElementById('join');
  if (stickyCta && joinSection && 'IntersectionObserver' in window) {
    const ctaObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        stickyCta.classList.toggle('is-hidden', entry.isIntersecting);
      });
    }, { threshold: 0.05 });
    ctaObserver.observe(joinSection);
  }

});
