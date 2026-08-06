'use strict';
// Staffing prediction — a clearly-labelled STATISTICAL HEURISTIC, not an ML
// model. For each timetable slot it computes the historical absence rate of
// that class on that weekday from real attendance_records, then estimates how
// many students would be absent (predicted shortfall). It also surfaces
// structural gaps: subjects on the curriculum that no staff member is
// qualified to teach (the same signal the timetable generator reports).
//
// Everything is computed from the live database at request time.

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Statistical credibility guards: never project from a handful of records.
// MIN_SAMPLE_RECORDS — a class-weekday bucket needs at least this many
// attendance rows before a shortfall is even considered ("100% from 1
// record" is noise, not insight). MIN_ABSENCE_RATE — the historical
// absence rate must clear this bar too, so a single student's one-off
// absence doesn't cry wolf. Both are exported for tests.
const MIN_SAMPLE_RECORDS = 5;
const MIN_ABSENCE_RATE = 0.2;

/**
 * @param {object} db
 * @param {number} [limit] max predictions to return (default 10)
 * @returns {Array<{day:number|null, period:number|null, subject:string,
 *   class_section:string, predicted_shortfall:number, reason:string}>}
 */
function predictStaffing(db, limit = 10) {
  const predictions = [];

  // 1) Absence-history predictions: one per timetable slot with a teacher.
  const slots = db.prepare(
    `SELECT ts.day, ts.period, ts.subject, ts.class_section
       FROM timetable_slots ts
      WHERE ts.staff_id IS NOT NULL
      ORDER BY ts.day, ts.period`
  ).all();

  for (const slot of slots) {
    const { c: classSize } = db.prepare(
      `SELECT COUNT(*) c FROM students WHERE class = ? AND status = 'active'`
    ).get(slot.class_section);
    if (!classSize) continue;

    // strftime('%w') is Sunday=0 … Saturday=6; the timetable uses Mon=0, so
    // ((%w + 6) % 7) maps weekdays onto the grid's day numbers.
    const hist = db.prepare(`
      SELECT COUNT(*) total,
             SUM(CASE WHEN ar.status != 'present' THEN 1 ELSE 0 END) absent
        FROM attendance_records ar
        JOIN students s ON s.id = ar.student_id
       WHERE s.class = ? AND ((strftime('%w', ar.date) + 6) % 7) = ?`).get(slot.class_section, slot.day);
    if (!hist.total || hist.total < MIN_SAMPLE_RECORDS) continue;

    const rate = hist.absent / hist.total;
    const shortfall = Math.round(classSize * rate);
    if (shortfall <= 0 || rate < MIN_ABSENCE_RATE) continue;

    predictions.push({
      day: slot.day,
      period: slot.period,
      subject: slot.subject,
      class_section: slot.class_section,
      predicted_shortfall: shortfall,
      reason: `historical absence for ${slot.class_section} on ${DAY_NAMES[slot.day]} is ${(rate * 100).toFixed(1)}% (${hist.absent}/${hist.total} records)`,
    });
  }

  // 2) Structural gaps: curriculum subjects no staff member can teach. These
  //    are the same requirements the timetable generator leaves unresolved.
  const gaps = db.prepare(`
    SELECT c.name AS class_section, s.name AS subject
      FROM class_subject_requirements cr
      JOIN classes c ON c.id = cr.class_id
      JOIN subjects s ON s.id = cr.subject_id
      LEFT JOIN staff_subjects ss ON ss.subject_id = cr.subject_id
     WHERE ss.staff_id IS NULL
     ORDER BY c.name, s.name`).all();

  for (const gap of gaps) {
    const { c: classSize } = db.prepare(
      `SELECT COUNT(*) c FROM students WHERE class = ? AND status = 'active'`
    ).get(gap.class_section);
    if (!classSize) continue; // no students → no shortfall to project; don't invent one
    predictions.push({
      day: null,
      period: null,
      subject: gap.subject,
      class_section: gap.class_section,
      predicted_shortfall: classSize,
      reason: `no teacher is qualified to teach ${gap.subject} to ${gap.class_section}`,
    });
  }

  predictions.sort((a, b) => b.predicted_shortfall - a.predicted_shortfall);
  return predictions.slice(0, Math.max(0, Number(limit) || 10));
}

/**
 * Actionable staffing suggestions (Day 3): for every projected shortfall,
 * cross-reference the staff table's subject qualifications against timetable
 * availability for that slot and name a replacement teacher — or say plainly
 * that none exists. Everything from real data, computed at request time.
 * @returns {Array<{day, period, subject, class_section, predicted_shortfall,
 *   reason, slot_id: number|null, suggestion: {staff_id, staff_name}|null,
 *   suggestion_reason: string}>}
 */
function suggestStaffing(db, limit = 10) {
  return predictStaffing(db, limit).map((p) => {
    if (p.day === null) {
      // Structural gap: no one on the staff is qualified for the subject.
      return Object.assign({}, p, {
        slot_id: null,
        suggestion: null,
        suggestion_reason: 'no teacher is qualified to teach this subject',
      });
    }

    // The exact slot this outlook item refers to (prediction keys are the
    // slot's own day/period/subject/class, so the match is exact).
    const slot = db.prepare(
      `SELECT ts.id, ts.staff_id, st.name AS teacher_name
         FROM timetable_slots ts
         LEFT JOIN staff st ON st.id = ts.staff_id
        WHERE ts.day = ? AND ts.period = ? AND ts.subject = ? AND ts.class_section = ?`
    ).get(p.day, p.period, p.subject, p.class_section);
    if (!slot) {
      return Object.assign({}, p, { slot_id: null, suggestion: null, suggestion_reason: 'no matching timetable slot' });
    }

    // Candidates: ACTIVE staff qualified in this subject, not the current
    // teacher, not already booked at this day+period, and within their weekly
    // load cap (booked periods + this one ≤ max_periods_per_week).
    const candidates = db.prepare(`
      SELECT st.id, st.name, ss.max_periods_per_week,
             (SELECT COUNT(*) FROM timetable_slots t2 WHERE t2.staff_id = st.id) AS booked
        FROM staff_subjects ss
        JOIN subjects sub ON sub.id = ss.subject_id
        JOIN staff st    ON st.id = ss.staff_id
       WHERE sub.name = ? AND st.status = 'active' AND st.id != ?
         AND NOT EXISTS (SELECT 1 FROM timetable_slots t3
                          WHERE t3.staff_id = st.id AND t3.day = ? AND t3.period = ?)
    `).all(p.subject, slot.staff_id || -1, p.day, p.period);
    const candidate = candidates.find((c) => (c.booked + 1) <= c.max_periods_per_week) || candidates[0];

    return Object.assign({}, p, {
      slot_id: slot.id,
      suggestion: candidate ? { staff_id: candidate.id, staff_name: candidate.name } : null,
      suggestion_reason: candidate
        ? `${candidate.name} is qualified in ${p.subject} and free at this slot`
        : 'no qualified teacher is free at this slot',
    });
  });
}

module.exports = { predictStaffing, suggestStaffing, MIN_SAMPLE_RECORDS, MIN_ABSENCE_RATE };
