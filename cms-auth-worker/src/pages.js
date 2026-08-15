function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function assertHttpsOrigin(origin) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('origin required');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('origin required');
  }
  return parsed.origin;
}

export function renderSuccessHtml(githubToken, email, cmsOrigin) {
  const targetOrigin = assertHttpsOrigin(cmsOrigin);
  const payload = JSON.stringify({ token: githubToken, provider: 'github' });
  const message = `authorization:github:success:${payload}`;
  return `<!DOCTYPE html>
<html lang="uk"><head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>Авторизація успішна</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;padding:40px;}</style>
</head><body>
<h2>Авторизація успішна</h2>
<p>Користувач: <strong>${escapeHtml(email)}</strong></p>
<p>Це вікно закриється автоматично...</p>
<script>
(function(){
  var msg = ${JSON.stringify(message)};
  var target = ${JSON.stringify(targetOrigin)};
  function send(){
    if (window.opener) {
      try { window.opener.postMessage(msg, target); } catch (e) {}
      setTimeout(function(){ window.close(); }, 200);
    }
  }
  window.addEventListener('message', function(e){
    if (e.origin !== target) return;
    if (e.data === 'authorizing:github') send();
  });
  setTimeout(send, 50);
  setTimeout(send, 1000);
})();
</script>
</body></html>`;
}

export function renderErrorHtml(title, detail, cmsOrigin) {
  let targetOrigin = '';
  try {
    targetOrigin = assertHttpsOrigin(cmsOrigin);
  } catch {
    targetOrigin = '';
  }
  const payload = JSON.stringify({
    error: 'AUTH_FAILED',
    errorCode: 'AUTH_FAILED',
    message: 'AUTH_FAILED',
  });
  const message = `authorization:github:error:${payload}`;
  const notify = targetOrigin
    ? `(function(){
  var msg = ${JSON.stringify(message)};
  var target = ${JSON.stringify(targetOrigin)};
  if (window.opener) {
    try { window.opener.postMessage(msg, target); } catch (e) {}
  }
})();`
    : '';
  return `<!DOCTYPE html>
<html lang="uk"><head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;padding:40px;color:#333;}
.box{max-width:540px;margin:0 auto;background:#fff5f5;border:1px solid #f5c2c2;padding:25px;border-radius:8px;}
button{padding:10px 20px;background:#e74c3c;color:white;border:none;border-radius:4px;cursor:pointer;}</style>
</head><body>
<div class="box">
  <h2>${escapeHtml(title)}</h2>
  <p>${escapeHtml(detail)}</p>
  <button onclick="window.close()">Закрити вікно</button>
</div>
<script>${notify}</script>
</body></html>`;
}

export function successPage(githubToken, email, cmsOrigin) {
  return new Response(renderSuccessHtml(githubToken, email, cmsOrigin), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export function errorPage(title, detail, cmsOrigin) {
  return new Response(renderErrorHtml(title, detail, cmsOrigin || ''), {
    status: 401,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
