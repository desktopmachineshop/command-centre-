// Settings page for the desktop shell. Talks to the Rust side through Tauri's global API.
// There is no token to type: saving (or "Link this computer") opens your command centre,
// where you sign in and approve this computer.
const { invoke } = window.__TAURI__.core;
const form = document.getElementById("form");
const error = document.getElementById("error");
const linkStatus = document.getElementById("link-status");
const linkNow = document.getElementById("link-now");

function showError(err) {
  error.textContent = String(err);
  error.hidden = false;
}

async function refresh(fillForm) {
  const settings = await invoke("get_settings");
  if (fillForm) {
    for (const [key, value] of Object.entries(settings)) {
      const input = form.elements.namedItem(key);
      if (!input) continue;
      if (input.type === "checkbox") input.checked = value;
      else input.value = value ?? "";
    }
  }
  if (settings.version) document.getElementById("version").textContent = `Version ${settings.version}`;
  if (settings.linked) {
    linkStatus.textContent = "This computer is linked to your command centre.";
    linkNow.textContent = "Link again";
  } else if (settings.linkCode) {
    linkStatus.textContent = `Waiting for you to approve code ${settings.linkCode} in the Command Centre window.`;
    linkNow.textContent = "Start again";
  } else {
    linkStatus.textContent = "This computer isn't linked yet.";
    linkNow.textContent = "Link this computer";
  }
}

refresh(true).catch(showError);
setInterval(() => refresh(false).catch(() => {}), 2000);

linkNow.addEventListener("click", async () => {
  error.hidden = true;
  try {
    await invoke("link_now");
    await refresh(false);
  } catch (err) {
    showError(err);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  const f = form.elements;
  const settings = {
    serverUrl: f.serverUrl.value.trim().replace(/\/+$/, ""),
    nodeName: f.nodeName.value.trim(),
    workerEnabled: f.workerEnabled.checked,
    launchAtLogin: f.launchAtLogin.checked,
  };
  try {
    await invoke("save_settings", { settings });
    await refresh(false);
  } catch (err) {
    showError(err);
  }
});
