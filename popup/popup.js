/* ─────────────────────────────────────────────
   Vantage — Popup Script
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

  const SVG_SUN  = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;
  const SVG_MOON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;
  const SVG_EYE  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;
  const SVG_EYE_OFF = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>`;
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
    icon.innerHTML = active ? SVG_EYE : SVG_EYE_OFF;
    label.textContent = active ? "Overlay active" : "Overlay disabled";
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
          if (window.__vantageLoaded) {
            document.dispatchEvent(new CustomEvent("cs-trigger-highlight"));
          }
        }
      });
    } catch (err) {
      console.error("[Vantage] Could not inject script:", err);
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

  // Default role change (editors only)
  document.getElementById("defaultRoleSelect").addEventListener("change", (e) => {
    const newRole = e.target.value;
    chrome.runtime.sendMessage({ action: "set-default-role", role: newRole }, (resp) => {
      if (resp?.error) {
        showCloudError(resp.error);
      }
    });
  });

  function showConnectedUI(config) {
    cloudDisconnected.classList.add("hidden");
    cloudConnected.classList.remove("hidden");
    document.getElementById("cloudPackName").textContent = config.packName || "Cloud Pack";
    document.getElementById("cloudPackKey").textContent = config.packKey;

    const role = config.role || "viewer";
    const badge = document.getElementById("cloudRoleBadge");
    badge.textContent = role;
    badge.className = "cloud-role-badge role-" + role;

    const roleSelector = document.getElementById("roleSelector");
    if (role === "editor") {
      roleSelector.classList.remove("hidden");
    } else {
      roleSelector.classList.add("hidden");
    }
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
