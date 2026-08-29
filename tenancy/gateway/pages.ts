export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
}

const style = `<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e6e8ec;font:15px/1.5 system-ui,sans-serif}main{width:min(380px,calc(100% - 32px));padding:28px;border:1px solid #2a303b;border-radius:12px;background:#161a21}h1{font-size:21px;margin:0 0 18px}label{display:block;color:#aab1bd;margin:12px 0 5px}input,button{width:100%;border-radius:7px;padding:10px 12px;font:inherit}input{border:1px solid #394150;background:#0f1115;color:inherit}button{margin-top:18px;border:0;background:#e7e9ed;color:#11151b;font-weight:650;cursor:pointer}.hint,#error{color:#929aaa;font-size:13px}#error{color:#f08b8b}</style>`;

function shell(title: string, body: string, refresh = false, status = 200): Response {
  return new Response(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="5">' : ""}<title>${esc(title)}</title>${style}</head><body><main>${body}</main></body></html>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

const formScript = `<script>document.querySelector("form").onsubmit=async e=>{e.preventDefault();let r=await fetch(e.target.action,{method:"POST",body:new FormData(e.target)});if(r.ok){let f=new URLSearchParams(location.search).get("from")||"/";location.href=f.startsWith("/")&&!f.startsWith("//")?f:"/"}else document.querySelector("#error").textContent=await r.text()}</script>`;

export function loginPage(): Response {
  return shell("trellis 登录", `<h1>登录 trellis</h1><form action="/__gw/login"><label>用户名</label><input name="name" autocomplete="username" required><label>密码</label><input name="password" type="password" autocomplete="current-password" required><button>登录</button><p id="error"></p></form>${formScript}`);
}

export function invitePage(code: string): Response {
  return shell("认领 trellis", `<h1>设置你的密码</h1><p class="hint">密码至少 8 个字符。邀请使用后立即失效。</p><form action="/__gw/invite/${esc(code)}"><label>新密码</label><input name="password" type="password" minlength="8" autocomplete="new-password" required><button>认领并登录</button><p id="error"></p></form>${formScript}`);
}

export function registerPage(code = "", error = "", status = 200): Response {
  return shell(
    "注册 trellis",
    `<h1>注册 trellis</h1><p class="hint">用户名仅限小写字母、数字和连字符；密码至少 8 个字符。</p><form action="/__gw/register" method="post"><label>用户名</label><input name="username" pattern="[a-z0-9-]{1,32}" autocomplete="username" required><label>密码</label><input name="password" type="password" minlength="8" autocomplete="new-password" required><label>邀请码</label><input name="code" value="${esc(code)}" required><button>注册并创建工作空间</button><p id="error">${esc(error)}</p></form>`,
    false,
    status,
  );
}

export function registerPendingPage(): Response {
  return shell(
    "trellis · 准备中",
    `<h1>工作空间准备中</h1><p class="hint" id="state">正在创建隔离实例，完成后会自动进入。</p><script>let timer=setInterval(async()=>{try{let r=await fetch("/__gw/api/register/status");if(r.status===401){location.href="/__gw/login";return}let x=await r.json();if(x.state==="ready"){clearInterval(timer);location.href="/"}else if(x.state==="failed"){clearInterval(timer);document.querySelector("#state").textContent="创建失败："+(x.detail||"请联系管理员")}}catch{}},1000)</script>`,
  );
}

export function maintenancePage(): Response {
  return shell("trellis · 维护中", `<h1>你的实例正在启动或维护</h1><p class="hint">网关运行正常，实例恢复后本页会自动刷新。</p>`, true);
}
