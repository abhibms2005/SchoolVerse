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

/* ---------- Tiny observable store (pub-sub) ----------
 * createStore gives the dashboard a single source of truth for shared data:
 * set() merges a patch into the state and notifies every subscriber, which
 * re-renders only when its slice changed (unchanged slices keep their object
 * identity, so subscribers can diff cheaply). ~15 lines, no framework.
 */
function createStore(initial = {}) {
  let state = initial;
  const subs = new Set();
  function set(patch) {
    state = Object.assign({}, state, patch);
    subs.forEach((fn) => fn(state));
    return state;
  }
  function subscribe(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
  }
  return { get: () => state, set, subscribe };
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
  fee_overdue:   { cls: 'warn', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>' },
  staffing_suggestion: { cls: 'warn', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5M8 21H3v-5M21 3l-7 7M3 21l7-7"/></svg>' },
  absence:       { cls: 'warn', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" y1="8" x2="22" y2="13"/><line x1="22" y1="8" x2="17" y2="13"/></svg>' },
};

const NOTIF_TAG = {
  clash: 'Urgent',
  pending_review: 'Needs review',
  staffing_gap: 'Staffing gap',
  fee_overdue: 'Fee overdue',
  staffing_suggestion: 'Staffing suggestion',
  absence: 'Absence alert',
};

function notifIcon(n) { return (NOTIF_META[n.type] || NOTIF_META.pending_review).icon; }
function notifClass(n) { return n.resolved ? 'ok' : (NOTIF_META[n.type] || { cls: 'warn' }).cls; }

/**
 * Build a <li class="notif ..."> from a notification record.
 * @param {object} n  notification row (may carry slot_id/staff_id for
 *   staffing-suggestion cards)
 * @param {object} [handlers]  { onResolve(n), onAccept(n) } — onResolve is
 *   the standard "Mark resolved"; onAccept renders a one-click "Accept
 *   suggestion" button that reassigns the suggested teacher via the existing
 *   slot-edit write path.
 */
function buildNotifCard(n, handlers = {}) {
  if (!handlers) handlers = {}; // explicit null (e.g. read-only previews) must behave like the default
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

  if (!n.resolved) {
    const actions = h('div', 'notif-actions');
    // One-click accept for staffing suggestions: reassigns the slot to the
    // suggested teacher through PATCH /api/timetable/slots/:id/reassign — the
    // SAME write path as the manual editor, so no parallel code exists.
    if (n.type === 'staffing_suggestion' && handlers.onAccept && n.slot_id && n.staff_id) {
      const accept = h('button', 'btn btn--small btn--teal', 'Accept suggestion');
      accept.addEventListener('click', async () => {
        accept.disabled = true;
        accept.textContent = 'Applying…';
        try {
          await handlers.onAccept(n);
        } catch (err) {
          accept.disabled = false;
          accept.textContent = 'Retry'; // h('button') loses the original label on retry
        }
      });
      actions.appendChild(accept);
    }
    if (handlers.onResolve) {
      const btn = h('button', 'btn btn--small btn--gold btn--resolve', 'Mark resolved');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Working…';
        try {
          await handlers.onResolve(n);
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Retry';
        }
      });
      actions.appendChild(btn);
    }
    if (actions.childElementCount) li.appendChild(actions);
  }
  return li;
}

function notifDetail(n) {
  if (n.type === 'clash') return 'Two classes need the same teacher or room at the same period.';
  if (n.type === 'staffing_gap') return 'A class has no teacher assigned for this slot.';
  if (n.type === 'fee_overdue') return 'A student\u2019s fees are flagged as overdue — update their fee status when settled.';
  if (n.type === 'staffing_suggestion') return n.staff_id ? 'A qualified teacher is free at this slot — accepting applies the reassignment.' : 'No qualified teacher is free at this slot right now.';
  if (n.type === 'absence') return 'A student has missed several consecutive school days.';
  return 'A digitised form is waiting for your sign-off.';
}

/* ---------- Timetable grid ---------- */
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const PERIODS = [1, 2, 3, 4, 5, 6];

/**
 * Render the weekly grid from API data into a <table class="tt">.
 * @param {object} data  { slots, rooms, staff }
 * @param {object} opts  { showFix, onFix(slot, roomId), showEdit, onEdit(slot) }
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

        // Single-slot editor: every OCCUPIED cell gets an Edit control (not
        // just clash cells) — opens the modal to change any field.
        if (opts.showEdit && opts.onEdit) {
          cellSlots.forEach((s) => {
            const edit = h('button', 'btn btn--small btn--ghost tt-edit', 'Edit');
            edit.setAttribute('aria-label', 'Edit ' + s.class_section + ' ' + s.subject);
            edit.addEventListener('click', () => opts.onEdit(s));
            cell.appendChild(edit);
          });
        }
      }
      row.appendChild(cell);
    });
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  return table;
}

/**
 * Render ONE section's weekly grid (rows = periods, columns = Mon-Fri).
 * Each occupied cell shows subject (primary) with teacher/room (secondary),
 * a compact clash/gap/resolved badge when present, and — when showEdit is
 * set — a single Edit control per slot. Empty cells read as a clean "—".
 * Used by the admin timetable tab: the section selector + this grid replace
 * the old all-sections-at-once view.
 * @param {object} data  { slots } — slots for the selected section only
 * @param {object} opts  { showEdit, onEdit(slot) }
 */
function buildSectionTimetable(data, opts = {}) {
  const { slots = [] } = data;
  const table = h('table', 'tt tt--section');
  table.setAttribute('aria-label', 'Weekly timetable');

  const thead = h('thead');
  const headRow = h('tr');
  headRow.appendChild(h('th', 'period-col', 'Period'));
  DAYS.slice(0, 5).forEach((d) => headRow.appendChild(h('th', '', d)));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = h('tbody');
  PERIODS.forEach((period) => {
    const row = h('tr');
    row.appendChild(h('th', '', `P${period} · ${periodLabel(period)}`));
    // Iterate day INDICES (0-4), not names — slot.day is the numeric weekday.
    DAYS.slice(0, 5).forEach((_, day) => {
      const cellSlots = slots.filter((s) => s.day === day && s.period === period);
      const cell = h('td', '');
      if (cellSlots.length === 0) {
        cell.classList.add('free');
        cell.textContent = '—';
        cell.title = 'Free period';
      } else {
        const hasClash = cellSlots.some((s) => s.conflict === 1);
        const hasGap = cellSlots.some((s) => s.staff_id == null);
        const hasResolved = cellSlots.some((s) => s.resolved_from_conflict === 1 && !s.conflict);
        cell.classList.add('tt-cell');
        if (hasClash) cell.classList.add('tt-clash');
        else if (hasGap) cell.classList.add('tt-gap');
        else if (hasResolved) cell.classList.add('tt-resolved');

        cellSlots.forEach((s) => {
          const entry = h('div', 'tt-entry');
          entry.appendChild(h('strong', '', s.subject));
          entry.appendChild(h('span', 'tt-sub', s.staff_id != null ? (s.staff_name || '—') : 'No teacher'));
          entry.appendChild(h('span', 'tt-sub tt-sub--room', s.room_name || '—'));
          cell.appendChild(entry);
        });
        if (hasClash) cell.appendChild(h('span', 'tt-badge', 'Clash'));
        else if (hasGap) cell.appendChild(h('span', 'tt-badge', 'No teacher'));
        else if (hasResolved) cell.appendChild(h('span', 'tt-badge', 'Auto-resolved'));

        if (opts.showEdit && opts.onEdit) {
          cellSlots.forEach((s) => {
            const edit = h('button', 'btn btn--small btn--ghost tt-edit', 'Edit');
            edit.setAttribute('aria-label', `Edit ${s.subject}`);
            edit.addEventListener('click', () => opts.onEdit(s));
            cell.appendChild(edit);
          });
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

/* Expose to Node for unit tests (browser <script> loads skip this entirely). */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createStore };
}
