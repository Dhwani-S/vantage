/* ─────────────────────────────────────────────
   Vantage — Background Service Worker
   ───────────────────────────────────────────── */

// ── Context Menu ──────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "vantage-annotate",
    title: "Annotate with Vantage",
    contexts: ["selection"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "vantage-annotate" && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { action: "highlight-selection" });
  }
});

// ── Keyboard Shortcut ─────────────────────────
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "highlight-selection" && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { action: "highlight-selection" });
  }
});

// ── Sync badge across all tabs when highlighting toggle changes ──
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.highlightingEnabled) {
    const active = changes.highlightingEnabled.newValue !== false;
    // Update badge globally (no tabId = all tabs)
    chrome.action.setBadgeText({ text: active ? "ON" : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#51cf66" });
  }
});

// Set initial badge on startup
chrome.storage.local.get("highlightingEnabled", ({ highlightingEnabled }) => {
  const active = highlightingEnabled !== false;
  chrome.action.setBadgeText({ text: active ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#51cf66" });
});

// ── Message Router ────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "open-dashboard") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
  }

  if (msg.action === "get-all-highlights") {
    chrome.storage.local.get("highlights", (data) => {
      sendResponse(data.highlights || {});
    });
    return true; // async
  }

  if (msg.action === "save-highlights") {
    chrome.storage.local.set({ highlights: msg.payload }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.action === "delete-highlight") {
    chrome.storage.local.get("highlights", (data) => {
      const all = data.highlights || {};
      const url = msg.url;
      const id = msg.id;
      if (all[url]) {
        all[url] = all[url].filter(h => h.id !== id);
        if (all[url].length === 0) delete all[url];
        chrome.storage.local.set({ highlights: all }, () => sendResponse({ ok: true }));
      } else {
        sendResponse({ ok: false });
      }
    });
    return true;
  }

  // ── Cloud Pack CRUD ─────────────────────────
  if (msg.action === "create-cloud-pack") {
    const { firebaseUrl, name } = msg;
    const url = (firebaseUrl || "").replace(/\/+$/, "");
    if (!url) { sendResponse({ error: "No Firebase URL" }); return true; }

    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const block = () => Array.from({ length: 4 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
    const packKey = `CS-${block()}-${block()}`;

    const meta = {
      name: name || "Untitled Pack",
      createdAt: new Date().toISOString(),
      defaultRole: "commentor",
    };

    fetch(`${url}/packs/${packKey}/meta.json`, {
      method: "PUT",
      body: JSON.stringify(meta),
    })
      .then(resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const config = { firebaseUrl: url, packKey, packName: meta.name, role: "editor" };
        chrome.storage.local.set({ cloudPack: config }, () => {
          sendResponse({ ok: true, config });
        });
      })
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.action === "join-cloud-pack") {
    const { firebaseUrl, packKey } = msg;
    const url = (firebaseUrl || "").replace(/\/+$/, "");
    if (!url || !packKey) { sendResponse({ error: "Missing URL or key" }); return true; }

    fetch(`${url}/packs/${packKey}/meta.json`)
      .then(resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
      })
      .then(meta => {
        if (!meta) throw new Error("Pack not found");
        const role = meta.defaultRole || "viewer";
        const config = { firebaseUrl: url, packKey, packName: meta.name || packKey, role };
        chrome.storage.local.set({ cloudPack: config }, () => {
          sendResponse({ ok: true, config });
        });
      })
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.action === "leave-cloud-pack") {
    chrome.storage.local.remove("cloudPack", () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.action === "set-default-role") {
    chrome.storage.local.get("cloudPack", (data) => {
      const config = data.cloudPack;
      if (!config || config.role !== "editor") {
        sendResponse({ error: "Only the pack editor can change roles" });
        return;
      }
      const newRole = msg.role;
      if (!["viewer", "commentor", "editor"].includes(newRole)) {
        sendResponse({ error: "Invalid role" });
        return;
      }
      const url = config.firebaseUrl;
      fetch(`${url}/packs/${config.packKey}/meta/defaultRole.json`, {
        method: "PUT",
        body: JSON.stringify(newRole),
      })
        .then(resp => {
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          sendResponse({ ok: true, role: newRole });
        })
        .catch(err => sendResponse({ error: err.message }));
    });
    return true;
  }

  if (msg.action === "get-cloud-status") {
    chrome.storage.local.get("cloudPack", (data) => {
      sendResponse(data.cloudPack || null);
    });
    return true;
  }

  if (msg.action === "clear-all-data") {
    chrome.storage.local.remove(["highlights", "cloudPack"], () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.action === "import-pack") {
    chrome.storage.local.get("highlights", (data) => {
      const all = data.highlights || {};
      const pack = msg.payload; // { url: [highlights] }
      for (const url of Object.keys(pack)) {
        if (!all[url]) {
          all[url] = pack[url];
        } else {
          // merge — avoid duplicates by id
          const existingIds = new Set(all[url].map(h => h.id));
          for (const h of pack[url]) {
            if (!existingIds.has(h.id)) {
              all[url].push(h);
            }
          }
        }
      }
      chrome.storage.local.set({ highlights: all }, () => sendResponse({ ok: true }));
    });
    return true;
  }
});
