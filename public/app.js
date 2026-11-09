function esc(value) {
  const div = document.createElement("div");
  div.textContent = value ?? "";
  return div.innerHTML;
}

async function api(url, options = {}) {
  const opts = { ...options, headers: { "Content-Type": "application/json" } };
  if (opts.body !== undefined) opts.body = JSON.stringify(opts.body);
  const res = await fetch(url, opts);
  if (res.status === 401) {
    location.href = "/login?expired=1";
    throw new Error("Session expired");
  }
  const data = res.status === 204 ? null : await res.json();
  return { ok: res.ok, status: res.status, data };
}

function formatDate(sqlDate) {
  return new Date(sqlDate.replace(" ", "T") + "Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function showError(message) {
  const box = document.getElementById("error");
  box.textContent = message;
  box.hidden = !message;
}

async function loadUser() {
  const { data } = await api("/api/me");
  document.getElementById("username").textContent = data.username;
}

loadUser();
