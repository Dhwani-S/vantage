/* ─────────────────────────────────────────────
   Context Scribe — Popup Script
   ───────────────────────────────────────────── */

document.addEventListener("DOMContentLoaded", async () => {
  // ── Theme ───────────────────────────────────
  const themeBtn = document.getElementById("themeToggle");

  chrome.storage.local.get("theme", ({ theme }) => {
    applyTheme(theme || "dark");
  });

  themeBtn.addEventListener("click", () => {
    const current = document.body.getAttribute("data-theme") || "dark";
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    chrome.storage.local.set({ theme: next });
    // Notify content scripts on all tabs about theme change
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        try { chrome.tabs.sendMessage(tab.id, { action: "set-theme", theme: next }); } catch {}
      }
    });
  });

  const SVG_SUN  = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
  const SVG_MOON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
  const SVG_LOCK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
  const SVG_EDIT = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
  function applyTheme(theme) {
    document.body.setAttribute("data-theme", theme);
    themeBtn.innerHTML = theme === "dark" ? SVG_SUN : SVG_MOON;
    themeBtn.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  }

  // ── Global Highlighting Toggle ──
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Load global toggle state from storage
  chrome.storage.local.get("highlightingEnabled", ({ highlightingEnabled }) => {
    const active = highlightingEnabled !== false; // default ON
    updateToggleUI(active);
  });

  const pageToggle = document.getElementById("pageToggle");
  pageToggle.addEventListener("change", () => {
    const active = pageToggle.checked;
    chrome.storage.local.set({ highlightingEnabled: active });
    updateToggleUI(active);
  });

  function updateToggleUI(active) {
    const container = document.getElementById("pageToggleContainer");
    const icon = document.getElementById("toggleIcon");
    const label = document.getElementById("toggleLabel");
    const checkbox = document.getElementById("pageToggle");

    checkbox.checked = active;
    container.classList.toggle("active", active);
    icon.innerHTML = active ? SVG_EDIT : SVG_LOCK;
    label.textContent = active ? "Highlighting enabled" : "Highlighting disabled";
  }

  // ── Load Stats ──────────────────────────────
  chrome.runtime.sendMessage({ action: "get-all-highlights" }, (all) => {
    const data = all || {};
    const pages = Object.keys(data);
    const totalHighlights = pages.reduce((sum, url) => sum + data[url].length, 0);

    document.getElementById("totalHighlights").textContent = totalHighlights;
    document.getElementById("totalPages").textContent = pages.length;

    if (currentTab) {
      const currentUrl = (currentTab.url || "").split("#")[0];
      const count = data[currentUrl] ? data[currentUrl].length : 0;
      document.getElementById("thisPage").textContent = count;
    }
  });

  // ── Highlight Button ────────────────────────
  document.getElementById("btnHighlight").addEventListener("click", async () => {
    if (!currentTab?.id) return;

    try {
      const response = await chrome.tabs.sendMessage(currentTab.id, { action: "highlight-selection" });
      if (response?.ok) {
        window.close();
        return;
      }
    } catch {}

    try {
      await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: () => {
          if (window.__contextScribeLoaded) {
            document.dispatchEvent(new CustomEvent("cs-trigger-highlight"));
          }
        }
      });
    } catch (err) {
      console.error("[Context Scribe] Could not inject script:", err);
    }

    window.close();
  });

  // ── Dashboard Button ────────────────────────
  document.getElementById("btnDashboard").addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "open-dashboard" });
    window.close();
  });

  // ── Cloud Pack ─────────────────────────────
  const cloudDisconnected = document.getElementById("cloudDisconnected");
  const cloudConnected = document.getElementById("cloudConnected");
  const firebaseUrlInput = document.getElementById("firebaseUrl");
  const joinFields = document.getElementById("joinFields");

  // Load persisted Firebase URL
  chrome.storage.local.get("firebaseUrl", ({ firebaseUrl }) => {
    if (firebaseUrl) firebaseUrlInput.value = firebaseUrl;
  });

  // Persist Firebase URL on change
  firebaseUrlInput.addEventListener("change", () => {
    chrome.storage.local.set({ firebaseUrl: firebaseUrlInput.value.trim() });
  });

  // Load current cloud status
  chrome.runtime.sendMessage({ action: "get-cloud-status" }, (status) => {
    if (status && status.packKey) {
      showConnectedUI(status);
    }
  });

  // Create Pack
  document.getElementById("btnCreatePack").addEventListener("click", () => {
    const fbUrl = firebaseUrlInput.value.trim();
    if (!fbUrl) { firebaseUrlInput.focus(); firebaseUrlInput.classList.add("error"); return; }
    firebaseUrlInput.classList.remove("error");

    const btn = document.getElementById("btnCreatePack");
    btn.disabled = true;
    btn.textContent = "Creating…";

    chrome.storage.local.set({ firebaseUrl: fbUrl });
    chrome.runtime.sendMessage(
      { action: "create-cloud-pack", firebaseUrl: fbUrl, name: "My Pack" },
      (resp) => {
        btn.disabled = false;
        btn.textContent = "Create Pack";
        if (resp?.error) {
          showCloudError(resp.error);
        } else if (resp?.config) {
          showConnectedUI(resp.config);
        }
      }
    );
  });

  // Show/hide join fields
  document.getElementById("btnShowJoin").addEventListener("click", () => {
    joinFields.classList.toggle("hidden");
    if (!joinFields.classList.contains("hidden")) {
      document.getElementById("joinKey").focus();
    }
  });

  // Join Pack
  document.getElementById("btnJoinPack").addEventListener("click", () => {
    const fbUrl = firebaseUrlInput.value.trim();
    const key = document.getElementById("joinKey").value.trim().toUpperCase();
    if (!fbUrl) { firebaseUrlInput.focus(); firebaseUrlInput.classList.add("error"); return; }
    if (!key) { document.getElementById("joinKey").focus(); return; }
    firebaseUrlInput.classList.remove("error");

    const btn = document.getElementById("btnJoinPack");
    btn.disabled = true;
    btn.textContent = "Connecting…";

    chrome.storage.local.set({ firebaseUrl: fbUrl });
    chrome.runtime.sendMessage(
      { action: "join-cloud-pack", firebaseUrl: fbUrl, packKey: key },
      (resp) => {
        btn.disabled = false;
        btn.textContent = "Connect";
        if (resp?.error) {
          showCloudError(resp.error);
        } else if (resp?.config) {
          showConnectedUI(resp.config);
        }
      }
    );
  });

  // Leave Pack
  document.getElementById("btnLeavePack").addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "leave-cloud-pack" }, () => {
      showDisconnectedUI();
    });
  });

  // Copy pack key on click
  document.getElementById("cloudPackKey").addEventListener("click", () => {
    const key = document.getElementById("cloudPackKey").textContent;
    navigator.clipboard.writeText(key).then(() => {
      const el = document.getElementById("cloudPackKey");
      const orig = el.textContent;
      el.textContent = "Copied!";
      setTimeout(() => { el.textContent = orig; }, 1200);
    });
  });

  function showConnectedUI(config) {
    cloudDisconnected.classList.add("hidden");
    cloudConnected.classList.remove("hidden");
    document.getElementById("cloudPackName").textContent = config.packName || "Cloud Pack";
    document.getElementById("cloudPackKey").textContent = config.packKey;
  }

  function showDisconnectedUI() {
    cloudConnected.classList.add("hidden");
    cloudDisconnected.classList.remove("hidden");
    joinFields.classList.add("hidden");
  }

  function showCloudError(message) {
    const existing = document.querySelector(".cloud-error");
    if (existing) existing.remove();
    const el = document.createElement("div");
    el.className = "cloud-error";
    el.textContent = message;
    cloudDisconnected.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }
});
