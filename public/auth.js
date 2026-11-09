function setupShowPassword() {
  document.getElementById("show").addEventListener("change", e => {
    document.getElementById("password").type = e.target.checked ? "text" : "password";
  });
}

function showError(message) {
  const box = document.getElementById("error");
  box.textContent = message;
  box.hidden = !message;
}

// helper function for html setup

function setupForm(endpoint, fields) {
  const form = document.querySelector("form");
  form.addEventListener("submit", async e => {
    e.preventDefault();
    showError("");
    const body = {};
    fields.forEach(f => body[f] = document.getElementById(f).value);
    const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) return showError(data.error);
    window.location.href = data.redirect;
  });
}

setupShowPassword();
if (new URLSearchParams(location.search).has("expired")) showError("Your session has expired. Log in again to continue.");
