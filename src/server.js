const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const QRCode = require('qrcode');
const db = require('./db');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

const app = express();
const PORT = process.env.PORT || 3000;
const TEACHER_PIN = process.env.TEACHER_PIN || '0000';
// QR 회전 주기(초). 캡처 화면으로 원격 대리출석 하는 것을 막는다.
const QR_WINDOW_SEC = 30;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- 쿠키 헬퍼 ----------
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

// ---------- QR 토큰 (30초마다 회전) ----------
function qrToken(secret, windowIndex) {
  return crypto.createHmac('sha256', secret).update(String(windowIndex)).digest('hex').slice(0, 12);
}

function currentWindow() {
  return Math.floor(Date.now() / 1000 / QR_WINDOW_SEC);
}

function verifyQrToken(secret, token) {
  const w = currentWindow();
  // 현재 창과 직전 창까지 허용 (스캔 도중 회전되는 경우 대비)
  return token === qrToken(secret, w) || token === qrToken(secret, w - 1);
}

// ---------- 선생님 인증 ----------
// PIN을 쿠키에 직접 담지 않고, 로그인 시 무작위 세션 토큰을 발급해 DB에 보관한다.
const AUTH_TTL_HOURS = 12;

function isValidTeacher(req) {
  const token = parseCookies(req).teacher_session;
  if (!token) return false;
  const row = db.prepare('SELECT expires_at FROM teacher_sessions WHERE token = ?').get(token);
  if (!row) return false;
  if (new Date(row.expires_at.replace(' ', 'T')).getTime() < Date.now()) {
    db.prepare('DELETE FROM teacher_sessions WHERE token = ?').run(token);
    return false;
  }
  return true;
}

function requireTeacher(req, res, next) {
  if (isValidTeacher(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

// 로그인 시도 제한 (무차별 대입 방지). 로컬망 기준이라 전역 카운터로 충분.
const loginGuard = { fails: 0, lockedUntil: 0 };

app.post('/api/login', (req, res) => {
  const now = Date.now();
  if (now < loginGuard.lockedUntil) {
    const wait = Math.ceil((loginGuard.lockedUntil - now) / 1000);
    return res.status(429).json({ error: `로그인 시도가 많습니다. ${wait}초 후 다시 시도하세요.` });
  }
  const { pin } = req.body || {};
  // 타이밍 공격 방지를 위한 상수 시간 비교
  const given = Buffer.from(String(pin || ''));
  const expected = Buffer.from(TEACHER_PIN);
  const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!ok) {
    loginGuard.fails += 1;
    if (loginGuard.fails >= 5) {
      loginGuard.lockedUntil = now + 30 * 1000; // 5회 실패 시 30초 잠금
      loginGuard.fails = 0;
    }
    return res.status(401).json({ error: 'PIN이 올바르지 않습니다.' });
  }
  loginGuard.fails = 0;
  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(now + AUTH_TTL_HOURS * 60 * 60 * 1000)
    .toISOString().slice(0, 19).replace('T', ' ');
  db.prepare('INSERT INTO teacher_sessions (token, expires_at) VALUES (?, ?)').run(token, expires);
  res.setHeader('Set-Cookie',
    `teacher_session=${token}; Path=/; Max-Age=${AUTH_TTL_HOURS * 60 * 60}; SameSite=Lax; HttpOnly`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req).teacher_session;
  if (token) db.prepare('DELETE FROM teacher_sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', 'teacher_session=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ teacher: isValidTeacher(req) });
});

// 요일 배열(0~6, 0=일요일)을 검증해 저장용 콤마 문자열로 변환. 잘못된 값은 무시.
function normalizeWeekdays(input) {
  if (input == null) return null;
  const arr = Array.isArray(input) ? input : String(input).split(',');
  const days = [...new Set(arr
    .filter((v) => String(v).trim() !== '') // Number('')===0 이라 빈 값이 일요일로 둔갑하는 것 방지
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))];
  days.sort((a, b) => a - b);
  return days.join(',');
}

const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

// 오늘 요일(한국/서버 기준). 대시보드에서 "오늘 수업"을 가려내는 데 사용.
app.get('/api/admin/today', requireTeacher, (req, res) => {
  const weekday = new Date().getDay(); // 0=일요일 ... 6=토요일
  res.json({ weekday, label: `${WEEKDAY_LABELS[weekday]}요일` });
});

// ---------- 반(커리큘럼) 관리 ----------
app.get('/api/admin/classes', requireTeacher, (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id) AS student_count,
      (SELECT id FROM sessions WHERE class_id = c.id AND ended_at IS NULL ORDER BY id DESC LIMIT 1) AS active_session_id
    FROM classes c ORDER BY c.id
  `).all();
  res.json(rows);
});

app.post('/api/admin/classes', requireTeacher, (req, res) => {
  const { name, schedule_text = '', late_after_min = 10, duration_min = 90, weekdays } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: '반 이름을 입력하세요.' });
  const info = db.prepare(
    'INSERT INTO classes (name, schedule_text, late_after_min, duration_min, weekdays, nfc_token) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name.trim(), schedule_text.trim(), Number(late_after_min) || 10,
    Math.max(0, Number(duration_min) || 0), normalizeWeekdays(weekdays) || '',
    crypto.randomBytes(12).toString('hex'));
  res.json({ id: info.lastInsertRowid });
});

app.patch('/api/admin/classes/:id', requireTeacher, (req, res) => {
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(req.params.id);
  if (!cls) return res.status(404).json({ error: 'not found' });
  const { name, schedule_text, late_after_min, duration_min, weekdays } = req.body || {};
  const normalizedWeekdays = normalizeWeekdays(weekdays);
  db.prepare('UPDATE classes SET name = ?, schedule_text = ?, late_after_min = ?, duration_min = ?, weekdays = ? WHERE id = ?')
    .run(
      (name ?? cls.name).trim() || cls.name,
      (schedule_text ?? cls.schedule_text).trim(),
      late_after_min == null ? cls.late_after_min : Number(late_after_min) || 0,
      duration_min == null ? cls.duration_min : Math.max(0, Number(duration_min) || 0),
      normalizedWeekdays == null ? cls.weekdays : normalizedWeekdays,
      cls.id
    );
  res.json({ ok: true });
});

app.delete('/api/admin/classes/:id', requireTeacher, (req, res) => {
  db.prepare('DELETE FROM classes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/classes/:id', requireTeacher, (req, res) => {
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(req.params.id);
  if (!cls) return res.status(404).json({ error: 'not found' });
  const students = db.prepare(`
    SELECT s.*, EXISTS(SELECT 1 FROM devices d WHERE d.student_id = s.id) AS has_device
    FROM students s WHERE s.class_id = ? ORDER BY s.name
  `).all(cls.id);
  const sessions = db.prepare(`
    SELECT ss.*,
      (SELECT COUNT(*) FROM attendance a WHERE a.session_id = ss.id AND a.status IN ('present','late')) AS attended
    FROM sessions ss WHERE ss.class_id = ? ORDER BY ss.id DESC LIMIT 20
  `).all(cls.id);
  res.json({ ...cls, students, sessions });
});

// ---------- 학생 관리 ----------
app.post('/api/admin/classes/:id/students', requireTeacher, (req, res) => {
  const cls = db.prepare('SELECT id FROM classes WHERE id = ?').get(req.params.id);
  if (!cls) return res.status(404).json({ error: 'not found' });
  const { name, parent_phone = '' } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: '학생 이름을 입력하세요.' });
  const info = db.prepare('INSERT INTO students (class_id, name, parent_phone) VALUES (?, ?, ?)')
    .run(cls.id, name.trim(), parent_phone.trim());
  res.json({ id: info.lastInsertRowid });
});

app.delete('/api/admin/students/:id', requireTeacher, (req, res) => {
  db.prepare('DELETE FROM students WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// 기기 재등록 허용 (학생이 폰을 바꾼 경우)
app.post('/api/admin/students/:id/reset-device', requireTeacher, (req, res) => {
  db.prepare('DELETE FROM devices WHERE student_id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- 수업(출석 세션) ----------
app.post('/api/admin/classes/:id/sessions', requireTeacher, (req, res) => {
  const cls = db.prepare('SELECT id FROM classes WHERE id = ?').get(req.params.id);
  if (!cls) return res.status(404).json({ error: 'not found' });
  const existing = db.prepare('SELECT id FROM sessions WHERE class_id = ? AND ended_at IS NULL').get(cls.id);
  if (existing) return res.json({ id: existing.id, existing: true });
  const secret = crypto.randomBytes(16).toString('hex');
  const info = db.prepare('INSERT INTO sessions (class_id, qr_secret) VALUES (?, ?)').run(cls.id, secret);
  res.json({ id: info.lastInsertRowid });
});

// NFC 태그·인쇄 QR용 반별 고정 URL (+ 인쇄용 QR 이미지)
app.get('/api/admin/classes/:id/tap-info', requireTeacher, async (req, res) => {
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(req.params.id);
  if (!cls) return res.status(404).json({ error: 'not found' });
  const base = `${req.protocol}://${req.get('host')}`;
  const url = `${base}/checkin.html?c=${cls.nfc_token}`;
  const dataUrl = await QRCode.toDataURL(url, { width: 480, margin: 1 });
  res.json({ url, dataUrl });
});

app.get('/api/admin/sessions/:id', requireTeacher, (req, res) => {
  const ss = db.prepare(`
    SELECT ss.*, c.name AS class_name, c.late_after_min, c.duration_min FROM sessions ss
    JOIN classes c ON c.id = ss.class_id WHERE ss.id = ?
  `).get(req.params.id);
  if (!ss) return res.status(404).json({ error: 'not found' });
  const roster = db.prepare(`
    SELECT s.id, s.name, a.status, a.method, a.checked_at
    FROM students s
    LEFT JOIN attendance a ON a.student_id = s.id AND a.session_id = ?
    WHERE s.class_id = ? ORDER BY s.name
  `).all(ss.id, ss.class_id);
  delete ss.qr_secret;
  res.json({ ...ss, roster });
});

// 수업 종료: 미체크 학생은 결석 처리. auto=true면 '자동 마감'.
function endSession(sessionId, { auto = false } = {}) {
  const ss = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!ss || ss.ended_at) return false;
  const unchecked = db.prepare(`
    SELECT s.* FROM students s
    WHERE s.class_id = ? AND s.id NOT IN (SELECT student_id FROM attendance WHERE session_id = ?)
  `).all(ss.class_id, ss.id);
  const markAbsent = db.prepare(
    "INSERT INTO attendance (session_id, student_id, status, method) VALUES (?, ?, 'absent', 'manual')");
  const tx = db.transaction(() => {
    for (const st of unchecked) markAbsent.run(ss.id, st.id);
    db.prepare("UPDATE sessions SET ended_at = datetime('now', 'localtime') WHERE id = ?").run(ss.id);
  });
  tx();
  if (auto) console.log(`[자동 마감] 세션 ${ss.id} 종료, 미체크 ${unchecked.length}명 결석 처리`);
  return true;
}

app.post('/api/admin/sessions/:id/end', requireTeacher, (req, res) => {
  const ss = db.prepare('SELECT id FROM sessions WHERE id = ?').get(req.params.id);
  if (!ss) return res.status(404).json({ error: 'not found' });
  endSession(ss.id);
  res.json({ ok: true });
});

// 수동 정정 (선생님이 직접 출석/지각/결석 변경)
app.post('/api/admin/sessions/:id/mark', requireTeacher, (req, res) => {
  const { student_id, status } = req.body || {};
  if (!['present', 'late', 'absent'].includes(status)) return res.status(400).json({ error: 'bad status' });
  const ss = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!ss) return res.status(404).json({ error: 'not found' });
  const student = db.prepare('SELECT * FROM students WHERE id = ? AND class_id = ?').get(student_id, ss.class_id);
  if (!student) return res.status(404).json({ error: 'student not in class' });
  db.prepare(`
    INSERT INTO attendance (session_id, student_id, status, method) VALUES (?, ?, ?, 'manual')
    ON CONFLICT (session_id, student_id)
    DO UPDATE SET status = excluded.status, method = 'manual', checked_at = datetime('now', 'localtime')
  `).run(ss.id, student_id, status);
  res.json({ ok: true });
});

// 키오스크용 현재 QR 이미지 (30초마다 회전)
app.get('/api/admin/sessions/:id/qr', requireTeacher, async (req, res) => {
  const ss = db.prepare('SELECT * FROM sessions WHERE id = ? AND ended_at IS NULL').get(req.params.id);
  if (!ss) return res.status(404).json({ error: '진행 중인 수업이 아닙니다.' });
  const w = currentWindow();
  const token = qrToken(ss.qr_secret, w);
  const base = `${req.protocol}://${req.get('host')}`;
  const url = `${base}/checkin.html?s=${ss.id}&t=${token}`;
  const dataUrl = await QRCode.toDataURL(url, { width: 480, margin: 1 });
  const expiresIn = QR_WINDOW_SEC - (Math.floor(Date.now() / 1000) % QR_WINDOW_SEC);
  res.json({ dataUrl, url, expiresIn });
});

function getAcademyToken() {
  return db.prepare("SELECT value FROM settings WHERE key = 'academy_token'").get().value;
}

const ACTIVE_SESSION_SQL = `
  SELECT ss.*, c.name AS class_name, c.late_after_min FROM sessions ss
  JOIN classes c ON c.id = ss.class_id`;

// ---------- 학생 체크인 (공개, PIN 불필요) ----------
// 세 가지 진입 경로:
//  - 회전 QR: session_id + qr_token (30초 회전, method 'qr')
//  - 반별 NFC 태그/인쇄 QR: class_token (고정, method 'tap') → 진행 중인 세션 자동 선택
//  - 학원 공용 태그: academy_token (고정, method 'tap') → 진행 중인 수업 중에서 선택
function resolveCheckinTarget(body) {
  const { session_id, qr_token, class_token, academy_token } = body || {};
  if (academy_token) {
    if (String(academy_token) !== getAcademyToken()) {
      return { error: '등록되지 않은 태그입니다. 선생님께 문의하세요.' };
    }
    const ss = db.prepare(`${ACTIVE_SESSION_SQL} WHERE ss.id = ? AND ss.ended_at IS NULL`).get(session_id);
    if (!ss) return { error: '진행 중인 수업이 아닙니다. 다시 태그해 주세요.' };
    return { ss, method: 'tap' };
  }
  if (class_token) {
    const cls = db.prepare('SELECT id FROM classes WHERE nfc_token = ?').get(String(class_token));
    if (!cls) return { error: '등록되지 않은 태그입니다. 선생님께 문의하세요.' };
    const ss = db.prepare(`
      SELECT ss.*, c.name AS class_name, c.late_after_min FROM sessions ss
      JOIN classes c ON c.id = ss.class_id
      WHERE ss.class_id = ? AND ss.ended_at IS NULL ORDER BY ss.id DESC LIMIT 1
    `).get(cls.id);
    if (!ss) return { error: '지금은 진행 중인 수업이 없습니다. 수업 시간에 다시 태그해 주세요.' };
    return { ss, method: 'tap' };
  }
  const ss = db.prepare(`
    SELECT ss.*, c.name AS class_name, c.late_after_min FROM sessions ss
    JOIN classes c ON c.id = ss.class_id WHERE ss.id = ?
  `).get(session_id);
  if (!ss || ss.ended_at) return { error: '진행 중인 수업이 아닙니다. 선생님께 문의하세요.' };
  if (!verifyQrToken(ss.qr_secret, String(qr_token || ''))) {
    return { error: 'QR코드가 만료되었습니다. 교실의 QR코드를 다시 스캔해 주세요.' };
  }
  return { ss, method: 'qr' };
}

// 태그/스캔 1회 처리. 이미 출석했으면 duplicate=true로 기존 기록을 그대로 반환.
function recordAttendance(ss, student, method = 'qr') {
  const already = db.prepare('SELECT * FROM attendance WHERE session_id = ? AND student_id = ?').get(ss.id, student.id);
  if (already) {
    return { status: already.status, checked_at: already.checked_at, duplicate: true };
  }
  const startedMs = new Date(ss.started_at.replace(' ', 'T')).getTime();
  const late = Date.now() - startedMs > ss.late_after_min * 60 * 1000;
  const status = late ? 'late' : 'present';
  db.prepare('INSERT INTO attendance (session_id, student_id, status, method) VALUES (?, ?, ?, ?)')
    .run(ss.id, student.id, status, method);
  const row = db.prepare('SELECT checked_at FROM attendance WHERE session_id = ? AND student_id = ?').get(ss.id, student.id);
  return { status, checked_at: row.checked_at, duplicate: false };
}

// 기기 쿠키(반별 분리 저장)로 등록된 학생 찾기 — 한 학생이 여러 반에 다녀도 충돌하지 않음
function findStudentByDevice(req, ss) {
  const deviceToken = parseCookies(req)[`dt_${ss.class_id}`];
  if (!deviceToken) return null;
  return db.prepare(`
    SELECT s.* FROM devices d JOIN students s ON s.id = d.student_id
    WHERE d.token = ? AND s.class_id = ?
  `).get(deviceToken, ss.class_id) || null;
}

// 스캔/태그 직후 호출: 등록된 기기면 자동 출석, 아니면 수업 선택/명단 반환
app.post('/api/checkin', (req, res) => {
  const body = req.body || {};

  // 학원 공용 태그로 진입, 아직 수업 미선택: 진행 중인 수업 목록 제시 (등록 기기는 자동 매칭)
  if (body.academy_token && !body.session_id) {
    if (String(body.academy_token) !== getAcademyToken()) {
      return res.status(400).json({ error: '등록되지 않은 태그입니다. 선생님께 문의하세요.' });
    }
    const active = db.prepare(`${ACTIVE_SESSION_SQL} WHERE ss.ended_at IS NULL ORDER BY ss.started_at DESC`).all();
    if (!active.length) {
      return res.status(400).json({ error: '지금은 진행 중인 수업이 없습니다. 수업 시간에 다시 태그해 주세요.' });
    }
    for (const ss of active) {
      const student = findStudentByDevice(req, ss);
      if (student) {
        const result = recordAttendance(ss, student, 'tap');
        return res.json({ mode: 'checked', class_name: ss.class_name, student_name: student.name, ...result });
      }
    }
    if (active.length > 1) {
      return res.json({
        mode: 'select_class',
        sessions: active.map((s) => ({ session_id: s.id, class_name: s.class_name, started_at: s.started_at })),
      });
    }
    body.session_id = active[0].id; // 수업이 하나뿐이면 바로 그 수업으로 진행
  }

  const { ss, method, error } = resolveCheckinTarget(body);
  if (error) return res.status(400).json({ error });

  const student = findStudentByDevice(req, ss);
  if (student) {
    const result = recordAttendance(ss, student, method);
    return res.json({ mode: 'checked', class_name: ss.class_name, student_name: student.name, ...result });
  }

  // 미등록 기기: 아직 이 수업에 출석 안 한 학생 명단을 보여줌 (최초 1회 등록용)
  const roster = db.prepare(`
    SELECT s.id, s.name FROM students s
    WHERE s.class_id = ?
      AND s.id NOT IN (SELECT student_id FROM attendance WHERE session_id = ?)
      AND s.id NOT IN (SELECT student_id FROM devices)
    ORDER BY s.name
  `).all(ss.class_id, ss.id);
  res.json({ mode: 'register', class_name: ss.class_name, session_id: ss.id, roster });
});

// 기기 등록(동의) + 출석 처리 + 반별 장기 쿠키 발급 (register/self-register 공통)
function registerDeviceAndCheckin(res, ss, student, method) {
  const existing = db.prepare('SELECT 1 FROM devices WHERE student_id = ?').get(student.id);
  if (existing) {
    res.status(400).json({ error: '이미 다른 기기가 등록된 학생입니다. 선생님께 기기 재등록을 요청하세요.' });
    return;
  }
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO devices (student_id, token) VALUES (?, ?)').run(student.id, token);
  const result = recordAttendance(ss, student, method);
  // 1년 유지 — 이후 스캔은 클릭 없이 자동 출석 (반별 쿠키)
  res.setHeader('Set-Cookie',
    `dt_${ss.class_id}=${token}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax; HttpOnly`);
  res.json({ mode: 'checked', class_name: ss.class_name, student_name: student.name, ...result });
}

// 최초 1회 기기 등록(동의) + 출석 처리 — 명단에서 학생을 선택한 경우
app.post('/api/register', (req, res) => {
  const { student_id } = req.body || {};
  const { ss, method, error } = resolveCheckinTarget(req.body);
  if (error) return res.status(400).json({ error });
  const student = db.prepare('SELECT * FROM students WHERE id = ? AND class_id = ?').get(student_id, ss.class_id);
  if (!student) return res.status(404).json({ error: '학생을 찾을 수 없습니다.' });
  registerDeviceAndCheckin(res, ss, student, method);
});

// 이름을 직접 입력해 등록 — 선생님이 등록한 명단에 있는 이름만 허용 (없으면 오류)
app.post('/api/self-register', (req, res) => {
  const { name } = req.body || {};
  const { ss, method, error } = resolveCheckinTarget(req.body);
  if (error) return res.status(400).json({ error });
  const trimmed = (name || '').trim();
  if (!trimmed) return res.status(400).json({ error: '이름을 입력해 주세요.' });
  // 공백/대소문자 차이를 무시하고 명단과 매칭
  const matches = db.prepare('SELECT * FROM students WHERE class_id = ?').all(ss.class_id)
    .filter((s) => s.name.replace(/\s/g, '').toLowerCase() === trimmed.replace(/\s/g, '').toLowerCase());
  if (matches.length === 0) {
    return res.status(404).json({ error: '명단에 없는 이름입니다. 이름을 다시 확인하거나 선생님께 문의하세요.' });
  }
  if (matches.length > 1) {
    return res.status(400).json({ error: '같은 이름의 학생이 여러 명입니다. 선생님께 문의하세요.' });
  }
  registerDeviceAndCheckin(res, ss, matches[0], method);
});

// 학원 공용 태그 URL (+ 인쇄용 QR) — 모든 반 공통, 태그 시 진행 중인 수업 선택
app.get('/api/admin/academy-tap-info', requireTeacher, async (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const url = `${base}/checkin.html?a=${getAcademyToken()}`;
  const dataUrl = await QRCode.toDataURL(url, { width: 480, margin: 1 });
  res.json({ url, dataUrl });
});

// 일별 통계: 그날의 수업별 출석자/지각/결석자 명단
app.get('/api/admin/stats', requireTeacher, (req, res) => {
  const q = String(req.query.date || '');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(q)
    ? q
    : db.prepare("SELECT date('now', 'localtime') AS d").get().d;
  const sessions = db.prepare(`
    ${ACTIVE_SESSION_SQL} WHERE date(ss.started_at) = ? ORDER BY ss.started_at
  `).all(date);
  const rosterStmt = db.prepare(`
    SELECT s.id, s.name, a.status, a.method, a.checked_at
    FROM students s
    LEFT JOIN attendance a ON a.student_id = s.id AND a.session_id = ?
    WHERE s.class_id = ? ORDER BY s.name
  `);
  const out = sessions.map((ss) => ({
    id: ss.id,
    class_id: ss.class_id,
    class_name: ss.class_name,
    started_at: ss.started_at,
    ended_at: ss.ended_at,
    roster: rosterStmt.all(ss.id, ss.class_id),
  }));
  res.json({ date, sessions: out });
});

// 월별 학생 개인별 출석률 리포트 (반별)
app.get('/api/admin/classes/:id/report', requireTeacher, (req, res) => {
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(req.params.id);
  if (!cls) return res.status(404).json({ error: 'not found' });
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || ''))
    ? req.query.month
    : db.prepare("SELECT strftime('%Y-%m', 'now', 'localtime') AS m").get().m;

  const totalSessions = db.prepare(
    "SELECT COUNT(*) AS n FROM sessions WHERE class_id = ? AND strftime('%Y-%m', started_at) = ?"
  ).get(cls.id, month).n;

  const students = db.prepare('SELECT id, name FROM students WHERE class_id = ? ORDER BY name').all(cls.id);
  const countStmt = db.prepare(`
    SELECT a.status, COUNT(*) AS n FROM attendance a
    JOIN sessions ss ON ss.id = a.session_id
    WHERE a.student_id = ? AND ss.class_id = ? AND strftime('%Y-%m', ss.started_at) = ?
    GROUP BY a.status
  `);
  const rows = students.map((st) => {
    const c = { present: 0, late: 0, absent: 0 };
    for (const r of countStmt.all(st.id, cls.id, month)) c[r.status] = r.n;
    const attended = c.present + c.late; // 출석+지각을 출석으로 집계
    const rate = totalSessions ? Math.round((attended / totalSessions) * 100) : 0;
    return { id: st.id, name: st.name, ...c, total: totalSessions, rate };
  });
  res.json({ month, class_name: cls.name, total_sessions: totalSessions, students: rows });
});

// 월별 출석부 CSV 내보내기 (반별). 엑셀에서 바로 열 수 있도록 UTF-8 BOM 포함.
app.get('/api/admin/classes/:id/export', requireTeacher, (req, res) => {
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(req.params.id);
  if (!cls) return res.status(404).json({ error: 'not found' });
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || ''))
    ? req.query.month
    : db.prepare("SELECT strftime('%Y-%m', 'now', 'localtime') AS m").get().m;

  const sessions = db.prepare(
    "SELECT * FROM sessions WHERE class_id = ? AND strftime('%Y-%m', started_at) = ? ORDER BY started_at"
  ).all(cls.id, month);
  const students = db.prepare('SELECT * FROM students WHERE class_id = ? ORDER BY name').all(cls.id);
  const attStmt = db.prepare('SELECT status FROM attendance WHERE session_id = ? AND student_id = ?');
  const LABEL = { present: '출석', late: '지각', absent: '결석' };

  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['이름', ...sessions.map((s) => s.started_at.slice(5, 16)), '출석', '지각', '결석'];
  const lines = [header.map(esc).join(',')];
  for (const st of students) {
    const cells = [st.name];
    const tally = { present: 0, late: 0, absent: 0 };
    for (const ss of sessions) {
      const a = attStmt.get(ss.id, st.id);
      if (a && tally[a.status] !== undefined) tally[a.status] += 1;
      cells.push(a ? (LABEL[a.status] || '') : '-');
    }
    cells.push(tally.present, tally.late, tally.absent);
    lines.push(cells.map(esc).join(','));
  }
  const csv = '﻿' + lines.join('\r\n');
  const fname = encodeURIComponent(`출석부_${cls.name}_${month}.csv`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${fname}`);
  res.send(csv);
});

// 태블릿 터치 출석: 입구 태블릿(선생님 기기)에서 학생이 자기 이름을 터치
app.post('/api/admin/sessions/:id/kiosk-checkin', requireTeacher, (req, res) => {
  const ss = db.prepare(`
    SELECT ss.*, c.name AS class_name, c.late_after_min FROM sessions ss
    JOIN classes c ON c.id = ss.class_id WHERE ss.id = ? AND ss.ended_at IS NULL
  `).get(req.params.id);
  if (!ss) return res.status(400).json({ error: '진행 중인 수업이 아닙니다.' });
  const student = db.prepare('SELECT * FROM students WHERE id = ? AND class_id = ?')
    .get(req.body?.student_id, ss.class_id);
  if (!student) return res.status(404).json({ error: '학생을 찾을 수 없습니다.' });
  const result = recordAttendance(ss, student, 'kiosk');
  res.json({ student_name: student.name, class_name: ss.class_name, ...result });
});

// ---------- 자동 마감 스케줄러 ----------
// 진행 중인 수업 중 (지금 - 시작) > 반의 duration_min 이면 자동 마감.
// duration_min이 0인 반은 자동 마감하지 않는다.
function runAutoClose() {
  const rows = db.prepare(`
    SELECT ss.id, ss.started_at, c.duration_min FROM sessions ss
    JOIN classes c ON c.id = ss.class_id
    WHERE ss.ended_at IS NULL AND c.duration_min > 0
  `).all();
  const now = Date.now();
  for (const r of rows) {
    const startedMs = new Date(r.started_at.replace(' ', 'T')).getTime();
    if (now - startedMs >= r.duration_min * 60 * 1000) {
      try { endSession(r.id, { auto: true }); } catch (e) { console.error('자동 마감 실패:', e.message); }
    }
  }
  // 만료된 로그인 세션도 함께 청소
  db.prepare("DELETE FROM teacher_sessions WHERE expires_at < datetime('now', 'localtime')").run();
}

// ---------- 자동 백업 스케줄러 ----------
// 하루 1회 data/backups/attendance-YYYYMMDD.db 로 복사. 최근 14개만 보관.
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
function runBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const target = path.join(BACKUP_DIR, `attendance-${today}.db`);
    if (fs.existsSync(target)) return; // 오늘 이미 백업함
    // better-sqlite3 온라인 백업 (WAL 포함 일관된 복사본)
    db.backup(target).then(() => {
      const files = fs.readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith('attendance-') && f.endsWith('.db')).sort();
      for (const f of files.slice(0, -14)) fs.unlinkSync(path.join(BACKUP_DIR, f));
      console.log(`[백업] ${target}`);
    }).catch((e) => console.error('백업 실패:', e.message));
  } catch (e) {
    console.error('백업 실패:', e.message);
  }
}

// 같은 Wi-Fi의 학생 폰이 접속할 수 있는 이 컴퓨터의 LAN IP 목록
function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

app.listen(PORT, () => {
  console.log('');
  console.log('  ─────────────────────────────────────────────');
  console.log('   출석체크 서버가 실행 중입니다.');
  console.log('');
  console.log(`   선생님용 (이 컴퓨터): http://localhost:${PORT}`);
  const ips = lanAddresses();
  if (ips.length) {
    console.log('   학생 폰 접속 주소 (같은 Wi-Fi):');
    for (const ip of ips) console.log(`     → http://${ip}:${PORT}`);
    console.log('');
    console.log('   ※ NFC/QR 주소를 복사할 때는 반드시 위의 학생용 주소로');
    console.log('     접속한 화면에서 복사하세요 (localhost 주소는 학생 폰에서 안 열립니다)');
  } else {
    console.log('   ⚠ 네트워크 연결이 없어 학생 폰 접속 주소를 찾지 못했습니다.');
    console.log('     Wi-Fi 또는 랜선 연결 후 서버를 다시 실행해 주세요.');
  }
  console.log('  ─────────────────────────────────────────────');
  console.log('');
  runAutoClose();
  runBackup();
  setInterval(runAutoClose, 60 * 1000);      // 1분마다 자동 마감 점검
  setInterval(runBackup, 6 * 60 * 60 * 1000); // 6시간마다 백업 점검(날짜 바뀌면 생성)
});

module.exports = app;
