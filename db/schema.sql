-- ============================================================
-- SchoolVerse schema (portable SQL — intended to be easily
-- migrated to PostgreSQL later; avoids SQLite-only features
-- except the AUTOINCREMENT / JSON TEXT storage idioms).
-- ============================================================

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS students (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  class            TEXT NOT NULL,          -- e.g. '10A'
  section          TEXT NOT NULL DEFAULT '',
  guardian_contact TEXT,
  admission_date   TEXT NOT NULL DEFAULT (date('now')),
  fee_status       TEXT NOT NULL DEFAULT 'pending'
    CHECK (fee_status IN ('paid', 'pending', 'overdue')),
  status           TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'left'))
);

CREATE TABLE IF NOT EXISTS staff (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,
  subject TEXT NOT NULL,
  contact TEXT,
  status  TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive'))   -- soft-delete flag
);

CREATE TABLE IF NOT EXISTS rooms (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL UNIQUE,
  capacity  INTEGER NOT NULL DEFAULT 0,
  room_type TEXT NOT NULL DEFAULT 'classroom'
    CHECK (room_type IN ('classroom', 'lab')),
  status    TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive'))   -- soft-delete flag
);

-- Timetable generator inputs. class_subject_requirements says how many
-- periods each class needs of each subject and whether it needs a lab;
-- staff_subjects says who is qualified to teach what and their weekly cap.
-- These are plain data tables (seeded in dev, editable in production).
CREATE TABLE IF NOT EXISTS classes (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS subjects (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS class_subject_requirements (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id         INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id       INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  periods_per_week INTEGER NOT NULL CHECK (periods_per_week > 0),
  room_type        TEXT NOT NULL DEFAULT 'classroom'
    CHECK (room_type IN ('classroom', 'lab')),
  UNIQUE (class_id, subject_id)
);

CREATE TABLE IF NOT EXISTS staff_subjects (
  staff_id             INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  subject_id           INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  max_periods_per_week INTEGER NOT NULL DEFAULT 25,
  PRIMARY KEY (staff_id, subject_id)
);

CREATE TABLE IF NOT EXISTS timetable_slots (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  day                 INTEGER NOT NULL CHECK (day BETWEEN 0 AND 6),   -- 0 = Monday … 6 = Sunday
  period              INTEGER NOT NULL CHECK (period BETWEEN 1 AND 8),
  subject             TEXT NOT NULL,
  staff_id            INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  room_id             INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  class_section       TEXT NOT NULL,
  conflict            INTEGER NOT NULL DEFAULT 0,        -- flagged by conflict detector
  conflict_reason     TEXT,                               -- e.g. 'Room double-booked'
  resolved_from_conflict INTEGER NOT NULL DEFAULT 0,      -- was a clash, now auto-fixed
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Conflict detection queries scan day+period for the same staff or room.
CREATE INDEX IF NOT EXISTS idx_slots_day_period_staff ON timetable_slots (day, period, staff_id);
CREATE INDEX IF NOT EXISTS idx_slots_day_period_room  ON timetable_slots (day, period, room_id);

CREATE TABLE IF NOT EXISTS attendance_records (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'present'
    CHECK (status IN ('present', 'absent', 'late')),
  method     TEXT NOT NULL DEFAULT 'manual'
    CHECK (method IN ('manual', 'RFID', 'CV')),
  room_id    INTEGER REFERENCES rooms(id) ON DELETE SET NULL,  -- scanner location
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attendance_student_date ON attendance_records (student_id, date);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance_records (date);

CREATE TABLE IF NOT EXISTS uploaded_forms (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id            INTEGER REFERENCES students(id) ON DELETE SET NULL,
  form_type             TEXT NOT NULL DEFAULT 'admission',
  file_path             TEXT NOT NULL,
  extracted_data        TEXT,                      -- JSON payload; null until extraction runs
  extraction_status     TEXT NOT NULL DEFAULT 'pending'
    CHECK (extraction_status IN ('pending', 'done', 'failed')),
  extraction_confidence REAL,                       -- 0..1 from the model; null until done
  status                TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'verified', 'rejected')),
  uploaded_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_forms_status ON uploaded_forms (status);

CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL CHECK (type IN ('clash', 'pending_review', 'staffing_gap', 'fee_overdue', 'staffing_suggestion', 'absence')),
  message     TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'warning'
    CHECK (severity IN ('urgent', 'warning', 'ok')),
  resolved    INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT NOT NULL UNIQUE,         -- dedupes repeated scans
  student_id  INTEGER REFERENCES students(id) ON DELETE SET NULL,  -- scopes teacher views / absence alerts
  slot_id     INTEGER REFERENCES timetable_slots(id) ON DELETE SET NULL,  -- staffing suggestions target a slot
  staff_id    INTEGER REFERENCES staff(id) ON DELETE SET NULL,     -- staffing suggestions name a teacher
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_unresolved ON notifications (resolved, created_at);

-- Users table (role column turns the single-admin tool into a multi-role
-- platform). A 'teacher' account links to a staff row so its scope — own
-- timetable, own students — derives from real data, not duplicated config.
CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin'
    CHECK (role IN ('admin', 'teacher')),
  staff_id      INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Small key/value store for system-level facts surfaced by /api/status
-- (last background scan time, last timetable generation, …).
CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
