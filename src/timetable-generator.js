'use strict';
// Dependency-free timetable generation: a constraint-satisfaction solver with
// greedy MRV (fewest-eligible-teachers-first) ordering and bounded backtracking.
//
// Guarantees by construction (verified in tests against the real conflict
// detector):
//   - one class per (day, period) slot cell
//   - a teacher is never booked twice in the same (day, period)
//   - a room is never booked twice in the same (day, period)
//   - room type matches the subject requirement (lab vs classroom)
//   - each teacher's weekly load cap is respected
//
// Anything that genuinely cannot be placed (e.g. a subject nobody teaches) is
// returned in `unresolved` — never silently dropped, never crash.

const DEFAULT_DAYS = 5;          // Mon–Fri
const DEFAULT_PERIODS = 6;

/**
 * Generate a conflict-free timetable.
 * @param {object} input
 * @param {Array<{id:number, name:string, room_type?:'classroom'|'lab'}>} input.rooms
 * @param {Array<{id:number, name:string, subjects:string[], max_periods_per_week?:number}>} input.staff
 * @param {Array<{class_section:string, subject:string, periods_per_week:number, room_type?:'classroom'|'lab'}>} input.requirements
 * @param {number} [input.periodsPerDay]
 * @param {number} [input.daysPerWeek]
 * @returns {{slots:Array, unresolved:Array, summary:object}}
 */
function generateTimetable(input) {
  const rooms = (input.rooms || []).map((r) => ({
    id: r.id,
    name: r.name,
    room_type: r.room_type === 'lab' ? 'lab' : 'classroom',
  }));
  const staff = (input.staff || []).map((s) => ({
    id: s.id,
    name: s.name,
    subjects: new Set(s.subjects || []),
    max: Math.max(1, Number(s.max_periods_per_week) || 25),
  }));
  const requirements = (input.requirements || [])
    .filter((r) => (Number(r.periods_per_week) || 0) > 0)
    .map((r) => ({
      class_section: String(r.class_section),
      subject: String(r.subject),
      periods: Number(r.periods_per_week),
      room_type: r.room_type === 'lab' ? 'lab' : 'classroom',
    }));
  const periodsPerDay = Math.max(1, Number(input.periodsPerDay) || DEFAULT_PERIODS);
  const daysPerWeek = Math.min(7, Math.max(1, Number(input.daysPerWeek) || DEFAULT_DAYS));

  // Index teachers by subject, rooms by type.
  const staffBySubject = new Map();
  for (const s of staff) {
    for (const subj of s.subjects) {
      if (!staffBySubject.has(subj)) staffBySubject.set(subj, []);
      staffBySubject.get(subj).push(s);
    }
  }
  const roomsByType = {
    lab: rooms.filter((r) => r.room_type === 'lab'),
    classroom: rooms.filter((r) => r.room_type !== 'lab'),
  };

  // Expand requirements into one task per weekly period, then order hardest
  // first (fewest eligible teachers) so scarce staff are placed early.
  const tasks = [];
  for (const r of requirements) {
    const eligible = staffBySubject.get(r.subject) || [];
    for (let i = 0; i < r.periods; i++) {
      tasks.push({ class_section: r.class_section, subject: r.subject, room_type: r.room_type, eligible });
    }
  }
  tasks.sort((a, b) => a.eligible.length - b.eligible.length);

  // Requirements with no qualified teacher can never be placed regardless of
  // ordering — surface them as unresolved and solve the rest.
  const unsolvable = [];
  const solvable = [];
  for (const task of tasks) {
    if (task.eligible.length === 0) unsolvable.push(task);
    else solvable.push(task);
  }

  const busyTeacher = new Set(); // `${day}:${period}:${staffId}`
  const busyRoom = new Set();    // `${day}:${period}:${roomId}`
  const busyClass = new Set();   // `${day}:${period}:${classSection}` — one class per cell
  const load = new Map();        // staffId -> periods placed this week
  const loadOf = (id) => load.get(id) || 0;
  const roomUse = new Map();
  const roomUseOf = (id) => roomUse.get(id) || 0;

  const slots = [];
  const MAX_EXPANSIONS = 250000;
  let expansions = 0;
  // Best partial solution seen (for impossible instances) — a snapshot of
  // `slots` at the deepest recursion level reached.
  let best = { depth: -1, slots: [] };

  function optionsFor(task) {
    const opts = [];
    for (let day = 0; day < daysPerWeek; day++) {
      for (let p = 0; p < periodsPerDay; p++) {
        const period = p + 1;
        if (busyClass.has(`${day}:${period}:${task.class_section}`)) continue;
        for (const teacher of task.eligible) {
          if (loadOf(teacher.id) >= teacher.max) continue;
          if (busyTeacher.has(`${day}:${period}:${teacher.id}`)) continue;
          for (const room of roomsByType[task.room_type]) {
            if (busyRoom.has(`${day}:${period}:${room.id}`)) continue;
            opts.push({ day, period, teacher, room });
          }
        }
      }
    }
    // Deterministic heuristic: least-loaded teacher, then least-used room,
    // then earliest day/period — spreads load and keeps the grid tidy.
    opts.sort((a, b) => {
      const dl = loadOf(a.teacher.id) - loadOf(b.teacher.id);
      if (dl !== 0) return dl;
      const dr = roomUseOf(a.room.id) - roomUseOf(b.room.id);
      if (dr !== 0) return dr;
      return (a.day * periodsPerDay + a.period) - (b.day * periodsPerDay + b.period);
    });
    return opts;
  }

  function tryPlace(ti) {
    if (ti > best.depth) { best.depth = ti; best.slots = slots.slice(); }
    if (ti >= solvable.length) return true;
    if (++expansions > MAX_EXPANSIONS) return false;

    const task = solvable[ti];
    const opts = optionsFor(task);
    if (opts.length === 0) return false; // no free slot right now → backtrack

    for (const o of opts) {
      const tk = `${o.day}:${o.period}:${o.teacher.id}`;
      const rk = `${o.day}:${o.period}:${o.room.id}`;
      const ck = `${o.day}:${o.period}:${task.class_section}`;
      slots.push({ day: o.day, period: o.period, subject: task.subject, class_section: task.class_section, staff_id: o.teacher.id, room_id: o.room.id });
      busyTeacher.add(tk); busyRoom.add(rk); busyClass.add(ck);
      load.set(o.teacher.id, loadOf(o.teacher.id) + 1);
      roomUse.set(o.room.id, roomUseOf(o.room.id) + 1);
      if (tryPlace(ti + 1)) return true;
      slots.pop();
      busyTeacher.delete(tk); busyRoom.delete(rk); busyClass.delete(ck);
      load.set(o.teacher.id, loadOf(o.teacher.id) - 1);
      roomUse.set(o.room.id, roomUseOf(o.room.id) - 1);
    }
    return false;
  }

  const solved = tryPlace(0);
  const finalSlots = solved ? slots : best.slots;

  const unresolved = unsolvable.map((t) => ({
    class_section: t.class_section,
    subject: t.subject,
    room_type: t.room_type,
    reason: 'no qualified teacher assigned',
  }));
  if (!solved) {
    // The solver gave up (impossible combination or budget) — every task past
    // the best partial solution is reported, never dropped.
    for (let i = finalSlots.length; i < solvable.length; i++) {
      const t = solvable[i];
      unresolved.push({
        class_section: t.class_section,
        subject: t.subject,
        room_type: t.room_type,
        reason: 'no free (day, period, room, teacher) combination — capacity exhausted',
      });
    }
  }

  return {
    slots: finalSlots,
    unresolved,
    summary: {
      requirements_total: tasks.length,
      slots_placed: finalSlots.length,
      unresolved: unresolved.length,
      // By construction the solver never double-books; the caller re-runs the
      // real conflict detector over the inserted rows as belt-and-braces.
      conflicts: 0,
    },
  };
}

module.exports = { generateTimetable };
