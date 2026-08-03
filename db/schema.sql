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
  status           TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'left'))
);

CREATE TABLE IF NOT EXISTS staff (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,
  subject TEXT NOT NULL,
  contact TEXT
);

CREATE TABLE IF NOT EXISTS rooms (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL UNIQUE,
  capacity INTEGER NOT NULL DEFAULT 0
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attendance_student_date ON attendance_records (student_id, date);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance_records (date);

CREATE TABLE IF NOT EXISTS uploaded_forms (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id     INTEGER REFERENCES students(id) ON DELETE SET NULL,
  form_type      TEXT NOT NULL DEFAULT 'admission',
  file_path      TEXT NOT NULL,
  extracted_data TEXT,                      -- JSON payload; null until OCR extraction runs
  status         TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'verified', 'rejected')),
  uploaded_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_forms_status ON uploaded_forms (status);

CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL CHECK (type IN ('clash', 'pending_review', 'staffing_gap')),
  message     TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'warning'
    CHECK (severity IN ('urgent', 'warning', 'ok')),
  resolved    INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT NOT NULL UNIQUE,         -- dedupes repeated scans
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_unresolved ON notifications (resolved, created_at);

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
