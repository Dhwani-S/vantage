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

  // ── Page Note Button ────────────────────────
  document.getElementById("btnPageNote").addEventListener("click", async () => {
    if (!currentTab?.id) return;
    try {
      await chrome.tabs.sendMessage(currentTab.id, { action: "add-page-note" });
    } catch {}
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
      loadPresenceCount(status);
    }
    loadRoomHistory(status);
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
      { action: "create-cloud-pack", firebaseUrl: fbUrl },
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

    const nameEl = document.getElementById("cloudPackName");
    nameEl.textContent = config.packName || "My Room";
    document.getElementById("cloudPackKey").textContent = config.packKey;

    const role = config.role || "viewer";
    const badge = document.getElementById("cloudRoleBadge");
    badge.textContent = role;
    badge.className = "cloud-role-badge role-" + role;

    const identity = document.getElementById("cloudIdentity");
    if (config.userName) {
      identity.innerHTML = `<span class="identity-label">You are</span> <span class="identity-name">${esc(config.userName)}</span>`;
    } else {
      identity.textContent = "";
    }

    const roleSelector = document.getElementById("roleSelector");
    if (role === "editor") {
      roleSelector.classList.remove("hidden");
      nameEl.classList.add("editable");
      nameEl.title = "Click to rename";
      nameEl.onclick = () => startRoomNameEdit(config);
    } else {
      roleSelector.classList.add("hidden");
      nameEl.classList.remove("editable");
      nameEl.title = "";
      nameEl.onclick = null;
    }
  }

  function startRoomNameEdit(config) {
    const nameEl = document.getElementById("cloudPackName");
    const currentName = nameEl.textContent;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "cloud-name-input";
    input.value = currentName;
    input.maxLength = 40;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    const commit = () => {
      const newName = input.value.trim() || currentName;
      const span = document.createElement("span");
      span.className = "cloud-pack-name editable";
      span.id = "cloudPackName";
      span.textContent = newName;
      span.title = "Click to rename";
      span.onclick = () => startRoomNameEdit({ ...config, packName: newName });
      input.replaceWith(span);
      if (newName !== currentName) {
        chrome.runtime.sendMessage({
          action: "update-room-name",
          firebaseUrl: config.firebaseUrl,
          packKey: config.packKey,
          newName,
        });
      }
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { input.value = currentName; input.blur(); }
    });
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

  // ── Presence Count ──────────────────────────
  const _nameColorHex = {
    Amber: "#f59e0b", Azure: "#3b82f6", Coral: "#f97316", Cyan: "#06b6d4",
    Ember: "#ef4444", Jade: "#10b981", Lime: "#84cc16", Mint: "#34d399",
    Navy: "#1e40af", Onyx: "#71717a", Pearl: "#e2e8f0", Rose: "#f43f5e",
    Ruby: "#dc2626", Sage: "#94a3b8", Slate: "#64748b", Teal: "#14b8a6",
    Violet: "#8b5cf6", Zinc: "#a1a1aa",
  };

  function avatarChip(name) {
    const parts = (name || "Anonymous").split(" ");
    const adjective = parts[0] || "";
    const animal = parts[1] || parts[0] || "?";
    const color = _nameColorHex[adjective] || "#71717a";
    const initial = animal.charAt(0).toUpperCase();
    return `<span class="viewer-chip"><span class="viewer-avatar" style="background:${color}">${esc(initial)}</span>${esc(name)}</span>`;
  }

  let _presencePoller = null;
  function loadPresenceCount(config) {
    if (!config || !config.firebaseUrl || !config.packKey) return;
    const fetchPresence = () => {
      chrome.runtime.sendMessage(
        { action: "get-room-presence", firebaseUrl: config.firebaseUrl, packKey: config.packKey },
        (viewers) => {
          const entries = viewers ? Object.values(viewers) : [];
          const el = document.getElementById("viewerCount");
          if (el) el.textContent = entries.length;

          const namesEl = document.getElementById("viewerNames");
          if (namesEl && entries.length > 0) {
            namesEl.innerHTML = entries.map(v => avatarChip(v.name)).join("");
          } else if (namesEl) {
            namesEl.innerHTML = "";
          }
        }
      );
    };
    setTimeout(fetchPresence, 1500);
    if (_presencePoller) clearInterval(_presencePoller);
    _presencePoller = setInterval(fetchPresence, 5000);
  }

  // ── Room History ────────────────────────────
  function loadRoomHistory(activeConfig) {
    chrome.runtime.sendMessage({ action: "get-room-history" }, (history) => {
      const container = document.getElementById("roomHistory");
      const list = document.getElementById("roomHistoryList");
      if (!history || history.length === 0) {
        container.classList.add("hidden");
        return;
      }

      const activeKey = activeConfig?.packKey;
      const filtered = history.filter(r => r.packKey !== activeKey);
      if (filtered.length === 0) {
        container.classList.add("hidden");
        return;
      }

      container.classList.remove("hidden");
      list.innerHTML = filtered.map(r => {
        const ago = timeAgo(r.lastActive);
        return `
          <div class="history-item" data-key="${esc(r.packKey)}" data-url="${esc(r.firebaseUrl)}">
            <div class="history-info">
              <span class="history-name">${esc(r.packName || r.packKey)}</span>
              <code class="history-key">${esc(r.packKey)}</code>
              <span class="history-ago">${ago}</span>
            </div>
            <div class="history-actions">
              <button class="history-btn rejoin" title="Rejoin">↗</button>
              <button class="history-btn remove" title="Remove">×</button>
            </div>
          </div>
        `;
      }).join("");

      list.querySelectorAll(".history-item").forEach(item => {
        item.querySelector(".rejoin").addEventListener("click", () => {
          const key = item.dataset.key;
          const url = item.dataset.url;
          item.querySelector(".rejoin").textContent = "…";
          chrome.runtime.sendMessage({ action: "rejoin-room", firebaseUrl: url, packKey: key }, (resp) => {
            if (resp?.error) {
              showCloudError(resp.error);
              item.querySelector(".rejoin").textContent = "↗";
            } else if (resp?.config) {
              showConnectedUI(resp.config);
              loadPresenceCount(resp.config);
              loadRoomHistory(resp.config);
            }
          });
        });
        item.querySelector(".remove").addEventListener("click", () => {
          chrome.runtime.sendMessage({ action: "remove-from-history", packKey: item.dataset.key }, () => {
            item.remove();
            if (list.children.length === 0) container.classList.add("hidden");
          });
        });
      });
    });
  }

  function esc(str) {
    const d = document.createElement("div");
    d.textContent = str || "";
    return d.innerHTML;
  }

  function timeAgo(dateStr) {
    if (!dateStr) return "";
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }
});
