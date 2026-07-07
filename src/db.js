const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'attendance.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  schedule_text TEXT DEFAULT '',
  late_after_min INTEGER NOT NULL DEFAULT 10,
  -- 수업 시작 후 이 시간(분)이 지나면 자동으로 수업 마감(미체크 → 결석). 0이면 자동 마감 안 함.
  duration_min INTEGER NOT NULL DEFAULT 90,
  -- 이 반이 열리는 요일. 콤마로 구분된 0~6 (0=일요일 ... 6=토요일, JS Date.getDay() 기준).
  -- 빈 문자열이면 요일 제한 없음(매일 표시).
  weekdays TEXT NOT NULL DEFAULT '',
  -- NFC 태그/인쇄 QR에 담기는 반별 고정 토큰 (문 옆 태그에 1회 기록해두면 됨)
  nfc_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  parent_phone TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 학생 기기 등록: 최초 1회 이름 선택(동의) 시 발급되는 토큰.
-- 이후 같은 기기로 스캔하면 클릭 없이 자동 출석.
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  qr_secret TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  ended_at TEXT
);

-- 선생님 로그인 세션 토큰 (PIN을 쿠키에 직접 담지 않기 위함)
CREATE TABLE IF NOT EXISTS teacher_sessions (
  token TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('present', 'late', 'absent')),
  -- qr: 회전 QR 스캔 / tap: NFC 태그·고정 QR / kiosk: 태블릿 이름 터치 / manual: 선생님 수동
  method TEXT NOT NULL DEFAULT 'qr' CHECK (method IN ('qr', 'tap', 'kiosk', 'manual')),
  checked_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE (session_id, student_id)
);

-- 시스템 설정 (학원 공용 태그 토큰 등)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// ---------- 기존 DB 마이그레이션 ----------
const crypto = require('crypto');

// classes.nfc_token 컬럼이 없던 DB에 추가하고 토큰 채우기
const clsCols = db.prepare("PRAGMA table_info(classes)").all().map((c) => c.name);
if (!clsCols.includes('nfc_token')) {
  db.exec('ALTER TABLE classes ADD COLUMN nfc_token TEXT');
}
const fillToken = db.prepare('UPDATE classes SET nfc_token = ? WHERE id = ?');
for (const row of db.prepare('SELECT id FROM classes WHERE nfc_token IS NULL').all()) {
  fillToken.run(crypto.randomBytes(12).toString('hex'), row.id);
}

// classes.duration_min (자동 마감 시간) 컬럼 추가
if (!clsCols.includes('duration_min')) {
  db.exec('ALTER TABLE classes ADD COLUMN duration_min INTEGER NOT NULL DEFAULT 90');
}

// classes.weekdays (요일) 컬럼 추가
if (!clsCols.includes('weekdays')) {
  db.exec("ALTER TABLE classes ADD COLUMN weekdays TEXT NOT NULL DEFAULT ''");
}

// 학원 공용 태그 토큰 발급 (최초 1회)
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('academy_token', ?)")
  .run(crypto.randomBytes(12).toString('hex'));

// attendance.method CHECK 제약에 tap/kiosk가 없던 DB는 테이블 재생성
const attSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'attendance'").get();
if (attSql && !attSql.sql.includes("'tap'")) {
  db.exec(`
    BEGIN;
    ALTER TABLE attendance RENAME TO attendance_old;
    CREATE TABLE attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('present', 'late', 'absent')),
      method TEXT NOT NULL DEFAULT 'qr' CHECK (method IN ('qr', 'tap', 'kiosk', 'manual')),
      checked_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE (session_id, student_id)
    );
    INSERT INTO attendance (id, session_id, student_id, status, method, checked_at)
      SELECT id, session_id, student_id, status, method, checked_at FROM attendance_old;
    DROP TABLE attendance_old;
    COMMIT;
  `);
}

// attendance.left_at (하원 시각) — 하원 기능 제거로 더 이상 사용하지 않아 정리
const attCols = db.prepare("PRAGMA table_info(attendance)").all().map((c) => c.name);
if (attCols.includes('left_at')) {
  db.exec('ALTER TABLE attendance DROP COLUMN left_at');
}

// notifications 테이블 — 학부모 알림 기능 제거로 더 이상 사용하지 않아 정리
db.exec('DROP TABLE IF EXISTS notifications');

module.exports = db;
