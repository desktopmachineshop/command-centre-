// Settings page for the desktop shell. Talks to the Rust side through Tauri's global API.
const { invoke } = window.__TAURI__.core;
const form = document.getElementById("form");
const error = document.getElementById("error");

invoke("get_settings").then((settings) => {
  for (const [key, value] of Object.entries(settings)) {
    const input = form.elements.namedItem(key);
    if (!input) continue;
    if (input.type === "checkbox") input.checked = value;
    else input.value = value;
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  const f = form.elements;
  const settings = {
    serverUrl: f.serverUrl.value.trim().replace(/\/+$/, ""),
    token: f.token.value.trim(),
    nodeName: f.nodeName.value.trim(),
    workerEnabled: f.workerEnabled.checked,
    launchAtLogin: f.launchAtLogin.checked,
  };
  try {
    await invoke("save_settings", { settings });
  } catch (err) {
    error.textContent = String(err);
    error.hidden = false;
  }
});
