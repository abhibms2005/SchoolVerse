'use strict';
/* Shared frontend helpers for SchoolVerse pages. */

/* ---------- API ---------- */
async function apiFetch(path, options = {}) {
  const init = { headers: {}, ...options };
  if (init.body && !(init.body instanceof FormData)) {
    // Any non-multipart body is JSON — stringify objects and tell the server.
    if (typeof init.body !== 'string') init.body = JSON.stringify(init.body);
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, init);
  if (res.status === 401) {
    // Not signed in — send to the login page (only if we're not already there).
    if (!window.location.pathname.endsWith('/login.html')) {
      window.location.href = '/login.html';
    }
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------- Tiny DOM helpers ---------- */
function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}
function timeAgo(createdAt) {
  const t = new Date(String(createdAt).replace(' ', 'T') + 'Z');
  const s = Math.max(1, Math.floor((Date.now() - t.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/* ---------- States (loading / empty / error) ---------- */
function skeletonCard(container) {
  container.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const card = h('div', 'skeleton skel-card');
    container.appendChild(card);
  }
}

function emptyState(container, { title, hint, ctaText, ctaHref }) {
  container.innerHTML = '';
  const state = h('div', 'state');
  const icon = h('div', 'state-icon');
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v5M12 16h.01"/></svg>';
  state.appendChild(icon);
  state.appendChild(h('h3', '', title));
  state.appendChild(h('p', '', hint));
  if (ctaText && ctaHref) {
    const a = h('a', 'btn btn--gold', ctaText);
    a.href = ctaHref;
    state.appendChild(a);
  }
  container.appendChild(state);
}

function errorState(container, { message, onRetry }) {
  container.innerHTML = '';
  const state = h('div', 'state state--error');
  const icon = h('div', 'state-icon');
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>';
  state.appendChild(icon);
  state.appendChild(h('h3', '', 'Could not load this data'));
  state.appendChild(h('p', '', message || 'Something went wrong on our side.'));
  const btn = h('button', 'btn btn--gold', 'Try again');
  btn.addEventListener('click', onRetry);
  state.appendChild(btn);
  container.appendChild(state);
}

function errorBanner(message) {
  const banner = h('div', 'error-banner');
  banner.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>';
  banner.appendChild(h('span', '', message));
  const close = h('button', 'btn btn--small btn--ghost', 'Dismiss');
  close.addEventListener('click', () => banner.remove());
  banner.appendChild(close);
  return banner;
}

/* ---------- Notification card rendering ---------- */
const NOTIF_META = {
  clash:         { cls: 'urgent', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>' },
  pending_review: { cls: 'warn', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/></svg>' },
  staffing_gap:  { cls: 'warn', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/></svg>' },
};

const NOTIF_TAG = {
  clash: 'Urgent',
  pending_review: 'Needs review',
  staffing_gap: 'Staffing gap',
};

function notifIcon(n) { return (NOTIF_META[n.type] || NOTIF_META.pending_review).icon; }
function notifClass(n) { return n.resolved ? 'ok' : (NOTIF_META[n.type] || { cls: 'warn' }).cls; }

/**
 * Build a <li class="notif ..."> from a notification record.
 * @param {object} n  notification row
 * @param {function} [onResolve]  called with the notification when approved
 */
function buildNotifCard(n, onResolve) {
  const li = h('li', `notif notif--${notifClass(n)}`);
  if (n.resolved) li.classList.add('is-resolved');

  const icon = h('span', 'notif-icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = notifIcon(n);
  li.appendChild(icon);

  const tag = h('span', `badge badge--${notifClass(n)}`, n.resolved ? 'Resolved' : NOTIF_TAG[n.type] || 'Info');
  li.appendChild(tag);

  li.appendChild(h('h4', '', n.message));
  li.appendChild(h('p', '', notifDetail(n)));
  li.appendChild(h('div', 'notif-meta', `${timeAgo(n.created_at)} · ${n.type.replace('_', ' ')}`));

  if (!n.resolved && onResolve) {
    const actions = h('div', 'notif-actions');
    const btn = h('button', 'btn btn--small btn--gold btn--resolve', 'Mark resolved');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Working…';
      try {
        await onResolve(n);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Retry';
      }
    });
    actions.appendChild(btn);
    li.appendChild(actions);
  }
  return li;
}

function notifDetail(n) {
  if (n.type === 'clash') return 'Two classes need the same teacher or room at the same period.';
  if (n.type === 'staffing_gap') return 'A class has no teacher assigned for this slot.';
  return 'A digitised form is waiting for your sign-off.';
}

/* ---------- Timetable grid ---------- */
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const PERIODS = [1, 2, 3, 4, 5, 6];

/**
 * Render the weekly grid from API data into a <table class="tt">.
 * @param {object} data  { slots, rooms, staff }
 * @param {object} opts  { showFix:boolean, onFix:function(slot, roomId) }
 */
function buildTimetable(data, opts = {}) {
  const { slots = [], rooms = [] } = data;
  const table = h('table', 'tt');
  table.setAttribute('aria-label', 'Weekly timetable');

  const daysUsed = DAYS.map((_, i) => i).filter((d) => slots.some((s) => s.day === d));
  const thead = h('thead');
  const headRow = h('tr');
  headRow.appendChild(h('th', 'period-col', 'Period'));
  daysUsed.forEach((d) => headRow.appendChild(h('th', '', DAYS[d])));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = h('tbody');
  PERIODS.forEach((period) => {
    const row = h('tr');
    row.appendChild(h('th', '', `P${period} · ${periodLabel(period)}`));
    daysUsed.forEach((day) => {
      const cell = h('td', '');
      const cellSlots = slots.filter((s) => s.day === day && s.period === period);
      if (cellSlots.length === 0) {
        cell.classList.add('free');
        cell.textContent = '— free —';
      } else {
        const hasClash = cellSlots.some((s) => s.conflict === 1);
        const hasGap = cellSlots.some((s) => s.staff_id === null);
        const hasResolved = cellSlots.some((s) => s.resolved_from_conflict === 1 && !s.conflict);
        cell.classList.add('tt-cell');
        if (hasClash) cell.classList.add('tt-clash');
        else if (hasGap) cell.classList.add('tt-gap');
        else if (hasResolved) cell.classList.add('tt-resolved');

        cellSlots.forEach((s) => {
          const entry = h('div', '');
          entry.appendChild(h('span', 'tt-time', `${s.class_section}`));
          const strong = h('strong', '', `${s.subject}`);
          strong.title = `${s.staff_name || 'no teacher'} · ${s.room_name || 'no room'}`;
          entry.appendChild(strong);
          cell.appendChild(entry);
        });

        if (hasClash) {
          const badge = h('span', 'tt-badge', 'Clash detected');
          cell.appendChild(badge);
          if (opts.showFix && opts.onFix) {
            const fix = h('div', 'tt-fix');
            const select = h('select', '');
            select.setAttribute('aria-label', 'Reassign room');
            const blank = h('option', '', 'Move to…');
            blank.value = '';
            select.appendChild(blank);
            rooms.forEach((r) => {
              const opt = h('option', '', r.name);
              opt.value = r.id;
              select.appendChild(opt);
            });
            const go = h('button', 'btn btn--small btn--teal', 'Fix');
            go.addEventListener('click', () => {
              if (!select.value) return;
              const clashSlot = cellSlots.find((s) => s.conflict === 1);
              opts.onFix(clashSlot, Number(select.value));
            });
            fix.appendChild(select);
            fix.appendChild(go);
            cell.appendChild(fix);
          }
        } else if (hasGap) {
          const badge = h('span', 'tt-badge', 'No teacher');
          cell.appendChild(badge);
        } else if (hasResolved) {
          const badge = h('span', 'tt-badge', 'Auto-resolved');
          cell.appendChild(badge);
        }
      }
      row.appendChild(cell);
    });
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  return table;
}

function periodLabel(period) {
  const times = { 1: '08:30', 2: '09:20', 3: '10:20', 4: '11:20', 5: '12:10', 6: '13:30' };
  return times[period] || '';
}

/* ---------- Stat counters (count up once visible) ---------- */
function animateCount(el, target) {
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const decimals = (String(target).split('.')[1] || '').length;
  if (prefersReduced) { el.textContent = target.toFixed(decimals); return; }
  const duration = 1200;
  let start = null;
  function frame(ts) {
    if (start === null) start = ts;
    const p = Math.min((ts - start) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = (target * eased).toFixed(decimals);
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function countUpOnView(el, getTarget) {
  if (!('IntersectionObserver' in window)) { animateCount(el, getTarget()); return; }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        animateCount(el, getTarget());
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.4 });
  io.observe(el);
}

/* ---------- Landing reveals ---------- */
function initReveals() {
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const els = document.querySelectorAll('.reveal');
  if (prefersReduced || !('IntersectionObserver' in window)) {
    els.forEach((el) => el.classList.add('is-visible'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) { entry.target.classList.add('is-visible'); io.unobserve(entry.target); }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
  els.forEach((el) => io.observe(el));
}
