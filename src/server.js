const express = require('express');
const crypto = require('crypto');
const path = require('path');
const QRCode = require('qrcode');
const db = require('./db');

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
function requireTeacher(req, res, next) {
  const cookies = parseCookies(req);
  if (cookies.teacher_pin === TEACHER_PIN) return next();
  res.status(401).json({ error: 'unauthorized' });
}

app.post('/api/login', (req, res) => {
  const { pin } = req.body || {};
  if (pin !== TEACHER_PIN) return res.status(401).json({ error: 'PIN이 올바르지 않습니다.' });
  res.setHeader('Set-Cookie', `teacher_pin=${encodeURIComponent(pin)}; Path=/; Max-Age=${60 * 60 * 12}; SameSite=Lax`);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const cookies = parseCookies(req);
  res.json({ teacher: cookies.teacher_pin === TEACHER_PIN });
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
  const { name, schedule_text = '', late_after_min = 10 } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: '반 이름을 입력하세요.' });
  const info = db.prepare('INSERT INTO classes (name, schedule_text, late_after_min, nfc_token) VALUES (?, ?, ?, ?)')
    .run(name.trim(), schedule_text.trim(), Number(late_after_min) || 10, crypto.randomBytes(12).toString('hex'));
  res.json({ id: info.lastInsertRowid });
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
    SELECT ss.*, c.name AS class_name, c.late_after_min FROM sessions ss
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

// 수업 종료: 미체크 학생은 결석 처리 + 학부모 알림 대기열 등록
app.post('/api/admin/sessions/:id/end', requireTeacher, (req, res) => {
  const ss = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!ss) return res.status(404).json({ error: 'not found' });
  if (!ss.ended_at) {
    const unchecked = db.prepare(`
      SELECT s.* FROM students s
      WHERE s.class_id = ? AND s.id NOT IN (SELECT student_id FROM attendance WHERE session_id = ?)
    `).all(ss.class_id, ss.id);
    const markAbsent = db.prepare(
      "INSERT INTO attendance (session_id, student_id, status, method) VALUES (?, ?, 'absent', 'manual')");
    const tx = db.transaction(() => {
      for (const st of unchecked) {
        markAbsent.run(ss.id, st.id);
        queueNotification(st, `[학원 알림] ${st.name} 학생이 오늘 수업에 출석하지 않았습니다.`);
      }
      db.prepare("UPDATE sessions SET ended_at = datetime('now', 'localtime') WHERE id = ?").run(ss.id);
    });
    tx();
  }
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

// ---------- 알림 ----------
function queueNotification(student, message) {
  if (!student.parent_phone) return;
  db.prepare('INSERT INTO notifications (student_id, phone, message) VALUES (?, ?, ?)')
    .run(student.id, student.parent_phone, message);
  // TODO: 실제 발송은 여기서 알림톡/SMS API(예: 카카오 비즈메시지, NHN Cloud) 호출로 교체
  console.log(`[알림 대기열] ${student.parent_phone}: ${message}`);
}

app.get('/api/admin/notifications', requireTeacher, (req, res) => {
  const rows = db.prepare(`
    SELECT n.*, s.name AS student_name FROM notifications n
    JOIN students s ON s.id = n.student_id ORDER BY n.id DESC LIMIT 50
  `).all();
  res.json(rows);
});

// ---------- 학생 체크인 (공개, PIN 불필요) ----------
// 두 가지 진입 경로:
//  - 회전 QR: session_id + qr_token (30초 회전, method 'qr')
//  - NFC 태그/인쇄 QR: class_token (반별 고정, method 'tap') → 진행 중인 세션 자동 선택
function resolveCheckinTarget(body) {
  const { session_id, qr_token, class_token } = body || {};
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

function recordAttendance(ss, student, method = 'qr') {
  const already = db.prepare('SELECT * FROM attendance WHERE session_id = ? AND student_id = ?').get(ss.id, student.id);
  if (already) return { status: already.status, checked_at: already.checked_at, duplicate: true };
  const startedMs = new Date(ss.started_at.replace(' ', 'T')).getTime();
  const late = Date.now() - startedMs > ss.late_after_min * 60 * 1000;
  const status = late ? 'late' : 'present';
  db.prepare('INSERT INTO attendance (session_id, student_id, status, method) VALUES (?, ?, ?, ?)')
    .run(ss.id, student.id, status, method);
  const row = db.prepare('SELECT checked_at FROM attendance WHERE session_id = ? AND student_id = ?').get(ss.id, student.id);
  const label = late ? '지각' : '출석';
  queueNotification(student, `[학원 알림] ${student.name} 학생이 ${row.checked_at.slice(11, 16)}에 등원했습니다. (${label})`);
  return { status, checked_at: row.checked_at, duplicate: false };
}

// 스캔/태그 직후 호출: 등록된 기기면 자동 출석, 아니면 명단 반환
app.post('/api/checkin', (req, res) => {
  const { ss, method, error } = resolveCheckinTarget(req.body);
  if (error) return res.status(400).json({ error });

  // 기기 쿠키는 반별로 분리 저장 — 한 학생이 여러 반에 다녀도 충돌하지 않음
  const cookies = parseCookies(req);
  const deviceToken = cookies[`dt_${ss.class_id}`];
  if (deviceToken) {
    const student = db.prepare(`
      SELECT s.* FROM devices d JOIN students s ON s.id = d.student_id
      WHERE d.token = ? AND s.class_id = ?
    `).get(deviceToken, ss.class_id);
    if (student) {
      const result = recordAttendance(ss, student, method);
      return res.json({ mode: 'checked', class_name: ss.class_name, student_name: student.name, ...result });
    }
  }

  // 미등록 기기: 아직 이 수업에 출석 안 한 학생 명단을 보여줌 (최초 1회 등록용)
  const roster = db.prepare(`
    SELECT s.id, s.name FROM students s
    WHERE s.class_id = ?
      AND s.id NOT IN (SELECT student_id FROM attendance WHERE session_id = ?)
      AND s.id NOT IN (SELECT student_id FROM devices)
    ORDER BY s.name
  `).all(ss.class_id, ss.id);
  res.json({ mode: 'register', class_name: ss.class_name, roster });
});

// 최초 1회 기기 등록(동의) + 출석 처리
app.post('/api/register', (req, res) => {
  const { student_id } = req.body || {};
  const { ss, method, error } = resolveCheckinTarget(req.body);
  if (error) return res.status(400).json({ error });
  const student = db.prepare('SELECT * FROM students WHERE id = ? AND class_id = ?').get(student_id, ss.class_id);
  if (!student) return res.status(404).json({ error: '학생을 찾을 수 없습니다.' });
  const existing = db.prepare('SELECT 1 FROM devices WHERE student_id = ?').get(student.id);
  if (existing) return res.status(400).json({ error: '이미 다른 기기가 등록된 학생입니다. 선생님께 기기 재등록을 요청하세요.' });

  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO devices (student_id, token) VALUES (?, ?)').run(student.id, token);
  const result = recordAttendance(ss, student, method);
  // 1년 유지 — 이후 스캔은 클릭 없이 자동 출석 (반별 쿠키)
  res.setHeader('Set-Cookie',
    `dt_${ss.class_id}=${token}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax; HttpOnly`);
  res.json({ mode: 'checked', class_name: ss.class_name, student_name: student.name, ...result });
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

app.listen(PORT, () => {
  console.log(`출석체크 서버 실행 중: http://localhost:${PORT} (선생님 PIN: ${TEACHER_PIN})`);
});

module.exports = app;
