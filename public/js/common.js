// 공통 헬퍼: API 호출 + 선생님 PIN 로그인 처리
async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showLogin();
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(data.error || '요청에 실패했습니다.');
  return data;
}

function showLogin() {
  if (document.getElementById('login-overlay')) return;
  const div = document.createElement('div');
  div.id = 'login-overlay';
  div.style.cssText =
    'position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;z-index:100;';
  div.innerHTML = `
    <div class="card" style="width:320px;text-align:center;">
      <h2>선생님 로그인</h2>
      <p class="muted" style="margin-bottom:12px;">관리자 PIN을 입력하세요</p>
      <input id="pin-input" type="password" inputmode="numeric" placeholder="PIN"
        style="width:100%;text-align:center;font-size:20px;margin-bottom:10px;">
      <button class="big" id="pin-btn">로그인</button>
      <p class="error" id="pin-error" style="display:none;"></p>
    </div>`;
  document.body.appendChild(div);
  const doLogin = async () => {
    const pin = document.getElementById('pin-input').value;
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    if (res.ok) location.reload();
    else {
      const err = document.getElementById('pin-error');
      err.textContent = 'PIN이 올바르지 않습니다.';
      err.style.display = 'block';
    }
  };
  document.getElementById('pin-btn').onclick = doLogin;
  document.getElementById('pin-input').onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
  document.getElementById('pin-input').focus();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STATUS_LABEL = { present: '출석', late: '지각', absent: '결석' };

function statusBadge(status) {
  if (!status) return '<span class="badge none">미체크</span>';
  return `<span class="badge ${status}">${STATUS_LABEL[status]}</span>`;
}
