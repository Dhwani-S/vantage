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
    chrome.action.setBadgeText({ text: active ? "ON" : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#51cf66" });
  }
});

chrome.storage.local.get("highlightingEnabled", ({ highlightingEnabled }) => {
  const active = highlightingEnabled !== false;
  chrome.action.setBadgeText({ text: active ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#51cf66" });
});

/* ════════════════════════════════════════════
   ANONYMOUS NAME GENERATOR (Excalidraw-style)
   ════════════════════════════════════════════ */
const NAME_COLORS = [
  "Amber", "Azure", "Coral", "Cyan", "Ember",
  "Jade", "Lime", "Mint", "Navy", "Onyx",
  "Pearl", "Rose", "Ruby", "Sage", "Slate",
  "Teal", "Violet", "Zinc",
];
const NAME_ANIMALS = [
  "Bear", "Crane", "Deer", "Eagle", "Falcon",
  "Fox", "Hawk", "Lynx", "Owl", "Panda",
  "Raven", "Seal", "Swan", "Tiger", "Wolf",
  "Wren", "Heron", "Otter",
];

function generateAnonName() {
  const color = NAME_COLORS[Math.floor(Math.random() * NAME_COLORS.length)];
  const animal = NAME_ANIMALS[Math.floor(Math.random() * NAME_ANIMALS.length)];
  return `${color} ${animal}`;
}

/* ════════════════════════════════════════════
   AVATAR COLOR MAP (adjective → hex)
   ════════════════════════════════════════════ */
const NAME_COLOR_HEX = {
  Amber: "#f59e0b", Azure: "#3b82f6", Coral: "#f97316", Cyan: "#06b6d4",
  Ember: "#ef4444", Jade: "#10b981", Lime: "#84cc16", Mint: "#34d399",
  Navy: "#1e40af", Onyx: "#71717a", Pearl: "#e2e8f0", Rose: "#f43f5e",
  Ruby: "#dc2626", Sage: "#94a3b8", Slate: "#64748b", Teal: "#14b8a6",
  Violet: "#8b5cf6", Zinc: "#a1a1aa",
};

/* ════════════════════════════════════════════
   DEFAULT ROOM LABELS
   ════════════════════════════════════════════ */
const DEFAULT_LABELS = {
  info:      { name: "Info",      color: "#3b82f6" },
  bug:       { name: "Bug",       color: "#ef4444" },
  question:  { name: "Question",  color: "#f59e0b" },
  important: { name: "Important", color: "#f97316" },
  todo:      { name: "Todo",      color: "#8b5cf6" },
  review:    { name: "Review",    color: "#10b981" },
};

const _nameCache = new Map();

function roleRank(r) { return r === "editor" ? 3 : r === "commentor" ? 2 : 1; }

/* ════════════════════════════════════════════
   PER-WINDOW SESSION IDS
   Uses chrome.storage.session (survives SW restarts,
   clears on browser close). Each Chrome window gets
   its own stable session ID.
   ════════════════════════════════════════════ */
async function getWindowSessionId(windowId) {
  const key = `winsession_${windowId}`;
  const data = await chrome.storage.session.get(key);
  if (data[key]) return data[key];
  const sid = "ws-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await chrome.storage.session.set({ [key]: sid });
  return sid;
}

function resolveWindowId(sender) {
  return new Promise(resolve => {
    if (sender?.tab?.windowId !== undefined) {
      resolve(sender.tab.windowId);
    } else {
      chrome.windows.getLastFocused(win => resolve(win.id));
    }
  });
}

async function assignRoomName(firebaseUrl, packKey, windowId, callback) {
  const sessionId = await getWindowSessionId(windowId);
  const cacheKey = `${packKey}__${sessionId}`;
  const memberUrl = `${firebaseUrl}/packs/${packKey}/members/${sessionId}.json`;
  try {
    const resp = await fetch(memberUrl);
    const existing = resp.ok ? await resp.json() : null;
    if (existing && existing.name) {
      _nameCache.set(cacheKey, Promise.resolve(existing.name));
      callback(existing.name, sessionId);
    } else {
      const name = generateAnonName();
      _nameCache.set(cacheKey, Promise.resolve(name));
      const entry = { name, joinedAt: new Date().toISOString() };
      await fetch(memberUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      }).catch(() => {});
      callback(name, sessionId);
    }
  } catch {
    const name = generateAnonName();
    _nameCache.set(cacheKey, Promise.resolve(name));
    callback(name, sessionId);
  }
}

async function writePresenceFromBg(firebaseUrl, packKey, role, userName, windowId) {
  const sessionId = await getWindowSessionId(windowId);
  const payload = {
    name: userName || "Anonymous",
    role: role || "viewer",
    url: "",
    lastSeen: Date.now(),
  };
  fetch(`${firebaseUrl}/packs/${packKey}/presence/${sessionId}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

/* ════════════════════════════════════════════
   ROOM HISTORY HELPERS
   ════════════════════════════════════════════ */
function addToRoomHistory(config, callback) {
  chrome.storage.local.get("roomHistory", (data) => {
    const history = data.roomHistory || [];
    const idx = history.findIndex(r => r.packKey === config.packKey && r.firebaseUrl === config.firebaseUrl);
    const entry = {
      firebaseUrl: config.firebaseUrl,
      packKey: config.packKey,
      packName: config.packName,
      role: config.role,
      userName: config.userName || "",
      joinedAt: idx >= 0 ? history[idx].joinedAt : new Date().toISOString(),
      lastActive: new Date().toISOString(),
    };
    if (idx >= 0) history.splice(idx, 1);
    history.unshift(entry);
    const trimmed = history.slice(0, 20);
    chrome.storage.local.set({ roomHistory: trimmed }, callback);
  });
}

// ── Message Router ────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "open-dashboard") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
  }

  if (msg.action === "get-all-highlights") {
    chrome.storage.local.get("highlights", (data) => {
      sendResponse(data.highlights || {});
    });
    return true;
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

  // ── Cloud Room CRUD ─────────────────────────
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
      name: name || "My Room",
      createdAt: new Date().toISOString(),
      defaultRole: "commentor",
      labels: DEFAULT_LABELS,
    };

    resolveWindowId(sender).then(windowId => {
      fetch(`${url}/packs/${packKey}/meta.json`, {
        method: "PUT",
        body: JSON.stringify(meta),
      })
        .then(resp => {
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          assignRoomName(url, packKey, windowId, (userName) => {
            const config = { firebaseUrl: url, packKey, packName: meta.name, role: "editor", userName };
            chrome.storage.local.set({ cloudPack: config }, () => {
              writePresenceFromBg(url, packKey, "editor", userName, windowId);
              addToRoomHistory(config, () => sendResponse({ ok: true, config }));
            });
          });
        })
        .catch(err => sendResponse({ error: err.message }));
    });
    return true;
  }

  if (msg.action === "join-cloud-pack") {
    const { firebaseUrl, packKey: inputKey } = msg;
    const url = (firebaseUrl || "").replace(/\/+$/, "");
    if (!url || !inputKey) { sendResponse({ error: "Missing URL or key" }); return true; }

    resolveWindowId(sender).then(async (windowId) => {
      try {
        // Step 1: check if inputKey is a master key (room identifier)
        let metaResp = await fetch(`${url}/packs/${inputKey}/meta.json`);
        let meta = metaResp.ok ? await metaResp.json() : null;
        let roomKey = inputKey;
        let role = "editor";

        if (meta) {
          // Master key — join as editor
          role = "editor";
        } else {
          // Step 2: check the global key index for an invite key
          const idxResp = await fetch(`${url}/keyIndex/${inputKey}.json`);
          const idx = idxResp.ok ? await idxResp.json() : null;
          if (!idx || !idx.packKey) throw new Error("Room not found");
          roomKey = idx.packKey;
          role = idx.role || "viewer";
          metaResp = await fetch(`${url}/packs/${roomKey}/meta.json`);
          meta = metaResp.ok ? await metaResp.json() : null;
          if (!meta) throw new Error("Room no longer exists");
        }

        assignRoomName(url, roomKey, windowId, (userName) => {
          const config = { firebaseUrl: url, packKey: roomKey, packName: meta.name || roomKey, role, userName };
          chrome.storage.local.set({ cloudPack: config }, () => {
            writePresenceFromBg(url, roomKey, role, userName, windowId);
            addToRoomHistory(config, () => sendResponse({ ok: true, config }));
          });
        });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    });
    return true;
  }

  if (msg.action === "rejoin-room") {
    const { firebaseUrl, packKey } = msg;
    const url = (firebaseUrl || "").replace(/\/+$/, "");
    if (!url || !packKey) { sendResponse({ error: "Missing URL or key" }); return true; }

    resolveWindowId(sender).then(windowId => {
      Promise.all([
        fetch(`${url}/packs/${packKey}/meta.json`).then(r => r.ok ? r.json() : null),
        new Promise(resolve => chrome.storage.local.get("roomHistory", d => resolve(d.roomHistory || []))),
      ]).then(([meta, history]) => {
          if (!meta) throw new Error("Room no longer exists");
          const defaultRole = meta.defaultRole || "viewer";
          const stored = history.find(r => r.packKey === packKey && r.firebaseUrl === url);
          const storedRole = stored?.role || defaultRole;
          const role = roleRank(storedRole) >= roleRank(defaultRole) ? storedRole : defaultRole;
          assignRoomName(url, packKey, windowId, (userName) => {
            const config = { firebaseUrl: url, packKey, packName: meta.name || packKey, role, userName };
            chrome.storage.local.set({ cloudPack: config }, () => {
              writePresenceFromBg(url, packKey, role, userName, windowId);
              addToRoomHistory(config, () => sendResponse({ ok: true, config }));
            });
          });
        })
        .catch(err => sendResponse({ error: err.message }));
    });
    return true;
  }

  if (msg.action === "leave-cloud-pack") {
    chrome.storage.local.remove("cloudPack", () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.action === "set-default-role") {
    const newRole = msg.role;
    if (!["viewer", "commentor", "editor"].includes(newRole)) {
      sendResponse({ error: "Invalid role" });
      return true;
    }
    const fbUrl = msg.firebaseUrl;
    const pk = msg.packKey;
    if (fbUrl && pk) {
      const url = fbUrl.replace(/\/+$/, "");
      fetch(`${url}/packs/${pk}/meta/defaultRole.json`, {
        method: "PUT",
        body: JSON.stringify(newRole),
      })
        .then(resp => {
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          sendResponse({ ok: true, role: newRole });
        })
        .catch(err => sendResponse({ error: err.message }));
    } else {
      chrome.storage.local.get("cloudPack", (data) => {
        const config = data.cloudPack;
        if (!config || config.role !== "editor") {
          sendResponse({ error: "Only the pack editor can change roles" });
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
    }
    return true;
  }

  if (msg.action === "get-cloud-status") {
    chrome.storage.local.get("cloudPack", (data) => {
      sendResponse(data.cloudPack || null);
    });
    return true;
  }

  if (msg.action === "get-room-history") {
    chrome.storage.local.get("roomHistory", (data) => {
      sendResponse(data.roomHistory || []);
    });
    return true;
  }

  if (msg.action === "remove-from-history") {
    chrome.storage.local.get("roomHistory", (data) => {
      const history = (data.roomHistory || []).filter(r => r.packKey !== msg.packKey);
      chrome.storage.local.set({ roomHistory: history }, () => sendResponse({ ok: true }));
    });
    return true;
  }

  if (msg.action === "get-session-id") {
    const windowId = sender?.tab?.windowId;
    if (windowId === undefined) { sendResponse({ sessionId: null }); return true; }
    getWindowSessionId(windowId).then(sessionId => sendResponse({ sessionId }));
    return true;
  }

  if (msg.action === "get-my-name") {
    const { firebaseUrl, packKey } = msg;
    const windowId = sender?.tab?.windowId;
    if (windowId === undefined) { sendResponse({ name: null }); return true; }
    const url = (firebaseUrl || "").replace(/\/+$/, "");
    if (!url || !packKey) { sendResponse({ name: null }); return true; }
    getWindowSessionId(windowId).then(sessionId => {
      const cacheKey = `${packKey}__${sessionId}`;
      if (_nameCache.has(cacheKey)) {
        _nameCache.get(cacheKey).then(name => sendResponse({ name }));
        return;
      }
      const lookup = fetch(`${url}/packs/${packKey}/members/${sessionId}.json`)
        .then(resp => resp.ok ? resp.json() : null)
        .then(data => {
          if (data && data.name) return data.name;
          const name = generateAnonName();
          const entry = { name, joinedAt: new Date().toISOString() };
          fetch(`${url}/packs/${packKey}/members/${sessionId}.json`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(entry),
          }).catch(() => {});
          return name;
        })
        .catch(() => null);
      _nameCache.set(cacheKey, lookup);
      lookup.then(name => sendResponse({ name }));
    });
    return true;
  }

  if (msg.action === "get-name-colors") {
    sendResponse(NAME_COLOR_HEX);
    return true;
  }

  if (msg.action === "get-room-labels") {
    const { firebaseUrl, packKey } = msg;
    const url = (firebaseUrl || "").replace(/\/+$/, "");
    if (!url || !packKey) { sendResponse({}); return true; }
    fetch(`${url}/packs/${packKey}/meta/labels.json`)
      .then(resp => resp.ok ? resp.json() : null)
      .then(data => sendResponse(data || {}))
      .catch(() => sendResponse({}));
    return true;
  }

  if (msg.action === "set-room-labels") {
    const { firebaseUrl, packKey, labels } = msg;
    const url = (firebaseUrl || "").replace(/\/+$/, "");
    if (!url || !packKey) { sendResponse({ ok: false }); return true; }
    fetch(`${url}/packs/${packKey}/meta/labels.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(labels || {}),
    })
      .then(resp => sendResponse({ ok: resp.ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.action === "get-room-members") {
    const { firebaseUrl, packKey } = msg;
    const url = (firebaseUrl || "").replace(/\/+$/, "");
    if (!url || !packKey) { sendResponse({}); return true; }
    fetch(`${url}/packs/${packKey}/members.json`)
      .then(resp => resp.ok ? resp.json() : null)
      .then(data => sendResponse(data || {}))
      .catch(() => sendResponse({}));
    return true;
  }

  if (msg.action === "get-room-presence") {
    const { firebaseUrl, packKey } = msg;
    const url = (firebaseUrl || "").replace(/\/+$/, "");
    if (!url || !packKey) { sendResponse({}); return true; }
    fetch(`${url}/packs/${packKey}/presence.json`)
      .then(resp => resp.ok ? resp.json() : null)
      .then(data => {
        if (!data) { sendResponse({}); return; }
        const cutoff = Date.now() - 60000;
        const active = {};
        for (const [id, info] of Object.entries(data)) {
          if (info && info.lastSeen > cutoff) active[id] = info;
        }
        sendResponse(active);
      })
      .catch(() => sendResponse({}));
    return true;
  }

  if (msg.action === "push-highlight-cloud") {
    const { firebaseUrl, packKey, urlHash, highlightId, payload } = msg;
    const url = (firebaseUrl || "").replace(/\/+$/, "");
    if (!url || !packKey || !urlHash || !highlightId) { sendResponse({ ok: false }); return true; }
    fetch(`${url}/packs/${packKey}/highlights/${urlHash}/${highlightId}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(resp => sendResponse({ ok: resp.ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.action === "delete-highlight-cloud") {
    const { firebaseUrl, packKey, urlHash, highlightId } = msg;
    const url = (firebaseUrl || "").replace(/\/+$/, "");
    if (!url || !packKey || !urlHash || !highlightId) { sendResponse({ ok: false }); return true; }
    fetch(`${url}/packs/${packKey}/highlights/${urlHash}/${highlightId}.json`, {
      method: "DELETE",
    })
      .then(resp => sendResponse({ ok: resp.ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.action === "write-presence") {
    const { firebaseUrl, packKey, payload } = msg;
    const windowId = sender?.tab?.windowId;
    if (windowId === undefined) { sendResponse({ ok: false }); return true; }
    const url = (firebaseUrl || "").replace(/\/+$/, "");
    if (!url || !packKey) { sendResponse({ ok: false }); return true; }
    getWindowSessionId(windowId).then(sessionId => {
      fetch(`${url}/packs/${packKey}/presence/${sessionId}.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then(resp => sendResponse({ ok: resp.ok }))
        .catch(() => sendResponse({ ok: false }));
    });
    return true;
  }

  if (msg.action === "remove-presence") {
    const { firebaseUrl, packKey } = msg;
    const windowId = sender?.tab?.windowId;
    if (windowId === undefined) { sendResponse({ ok: false }); return true; }
    const url = (firebaseUrl || "").replace(/\/+$/, "");
    if (!url || !packKey) { sendResponse({ ok: false }); return true; }
    getWindowSessionId(windowId).then(sessionId => {
      fetch(`${url}/packs/${packKey}/presence/${sessionId}.json`, { method: "DELETE" })
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
    });
    return true;
  }

  if (msg.action === "update-room-name") {
    const { firebaseUrl, packKey, newName } = msg;
    const url = (firebaseUrl || "").replace(/\/+$/, "");
    if (!url || !packKey || !newName) { sendResponse({ ok: false }); return true; }
    fetch(`${url}/packs/${packKey}/meta/name.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newName),
    })
      .then(resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        chrome.storage.local.get(["roomHistory", "cloudPack"], (data) => {
          const history = (data.roomHistory || []).map(r =>
            r.packKey === packKey ? { ...r, packName: newName } : r
          );
          const updates = { roomHistory: history };
          if (data.cloudPack && data.cloudPack.packKey === packKey) {
            updates.cloudPack = { ...data.cloudPack, packName: newName };
          }
          chrome.storage.local.set(updates, () => sendResponse({ ok: true }));
        });
      })
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.action === "delete-room") {
    const { firebaseUrl, packKey } = msg;
    const url = (firebaseUrl || "").replace(/\/+$/, "");
    if (!url || !packKey) { sendResponse({ ok: false }); return true; }
    fetch(`${url}/packs/${packKey}.json`, { method: "DELETE" })
      .then(resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        chrome.storage.local.get(["roomHistory", "cloudPack"], (data) => {
          const history = (data.roomHistory || []).filter(r => r.packKey !== packKey);
          const updates = { roomHistory: history };
          if (data.cloudPack && data.cloudPack.packKey === packKey) {
            updates.cloudPack = null;
          }
          chrome.storage.local.set(updates, () => sendResponse({ ok: true }));
        });
      })
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.action === "get-room-highlights") {
    const { firebaseUrl, packKey } = msg;
    const url = (firebaseUrl || "").replace(/\/+$/, "");
    if (!url || !packKey) { sendResponse({}); return true; }
    fetch(`${url}/packs/${packKey}/highlights.json`)
      .then(resp => resp.ok ? resp.json() : null)
      .then(data => sendResponse(data || {}))
      .catch(() => sendResponse({}));
    return true;
  }

  if (msg.action === "clear-all-data") {
    chrome.storage.local.remove(["highlights", "cloudPack", "roomHistory"], () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  // ── Room Key Management ─────────────────────
  if (msg.action === "add-room-key") {
    const { firebaseUrl, packKey, role, label } = msg;
    const url = (firebaseUrl || "").replace(/\/+$/, "");
    if (!url || !packKey || !role) { sendResponse({ error: "Missing params" }); return true; }
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const block = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    const newKey = `VK-${block()}-${block()}`;
    const entry = { role, label: label || "", createdAt: new Date().toISOString() };
    const indexEntry = { packKey, role };
    Promise.all([
      fetch(`${url}/packs/${packKey}/keys/${newKey}.json`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry) }),
      fetch(`${url}/keyIndex/${newKey}.json`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(indexEntry) }),
    ])
      .then(([r1, r2]) => {
        if (!r1.ok || !r2.ok) throw new Error("Failed to create key");
        sendResponse({ ok: true, key: newKey, entry });
      })
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.action === "get-room-keys") {
    const { firebaseUrl, packKey } = msg;
    const url = (firebaseUrl || "").replace(/\/+$/, "");
    if (!url || !packKey) { sendResponse({}); return true; }
    fetch(`${url}/packs/${packKey}/keys.json`)
      .then(resp => resp.ok ? resp.json() : null)
      .then(data => sendResponse(data || {}))
      .catch(() => sendResponse({}));
    return true;
  }

  if (msg.action === "delete-room-key") {
    const { firebaseUrl, packKey, key } = msg;
    const url = (firebaseUrl || "").replace(/\/+$/, "");
    if (!url || !packKey || !key) { sendResponse({ error: "Missing params" }); return true; }
    Promise.all([
      fetch(`${url}/packs/${packKey}/keys/${key}.json`, { method: "DELETE" }),
      fetch(`${url}/keyIndex/${key}.json`, { method: "DELETE" }),
    ])
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.action === "import-pack") {
    chrome.storage.local.get("highlights", (data) => {
      const all = data.highlights || {};
      const pack = msg.payload;
      for (const url of Object.keys(pack)) {
        if (!all[url]) {
          all[url] = pack[url];
        } else {
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
