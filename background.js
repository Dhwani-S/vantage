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
   PRESENCE + IDENTITY HELPERS
   ════════════════════════════════════════════ */
function getOrCreateInstanceId(callback) {
  chrome.storage.local.get("vantageInstanceId", (data) => {
    if (data.vantageInstanceId) {
      callback(data.vantageInstanceId);
    } else {
      const id = "v-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      chrome.storage.local.set({ vantageInstanceId: id }, () => callback(id));
    }
  });
}

function assignRoomName(firebaseUrl, packKey, callback) {
  getOrCreateInstanceId((instanceId) => {
    const memberUrl = `${firebaseUrl}/packs/${packKey}/members/${instanceId}.json`;
    fetch(memberUrl, { headers: { "Content-Type": "application/json" } })
      .then(resp => resp.ok ? resp.json() : null)
      .then(existing => {
        if (existing && existing.name) {
          callback(existing.name, instanceId);
        } else {
          const name = generateAnonName();
          const entry = { name, joinedAt: new Date().toISOString() };
          fetch(memberUrl, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(entry),
          })
            .then(() => callback(name, instanceId))
            .catch(() => callback(name, instanceId));
        }
      })
      .catch(() => {
        callback(generateAnonName(), instanceId);
      });
  });
}

function writePresenceFromBg(firebaseUrl, packKey, role, userName) {
  getOrCreateInstanceId((instanceId) => {
    const payload = {
      name: userName || "Anonymous",
      role: role || "viewer",
      url: "",
      lastSeen: Date.now(),
    };
    fetch(`${firebaseUrl}/packs/${packKey}/presence/${instanceId}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  });
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
        assignRoomName(url, packKey, (userName) => {
          const config = { firebaseUrl: url, packKey, packName: meta.name, role: "editor", userName };
          chrome.storage.local.set({ cloudPack: config }, () => {
            writePresenceFromBg(url, packKey, "editor", userName);
            addToRoomHistory(config, () => sendResponse({ ok: true, config }));
          });
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
        assignRoomName(url, packKey, (userName) => {
          const config = { firebaseUrl: url, packKey, packName: meta.name || packKey, role, userName };
          chrome.storage.local.set({ cloudPack: config }, () => {
            writePresenceFromBg(url, packKey, role, userName);
            addToRoomHistory(config, () => sendResponse({ ok: true, config }));
          });
        });
      })
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.action === "rejoin-room") {
    const { firebaseUrl, packKey } = msg;
    const url = (firebaseUrl || "").replace(/\/+$/, "");
    if (!url || !packKey) { sendResponse({ error: "Missing URL or key" }); return true; }

    fetch(`${url}/packs/${packKey}/meta.json`)
      .then(resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
      })
      .then(meta => {
        if (!meta) throw new Error("Room no longer exists");
        const role = meta.defaultRole || "viewer";
        assignRoomName(url, packKey, (userName) => {
          const config = { firebaseUrl: url, packKey, packName: meta.name || packKey, role, userName };
          chrome.storage.local.set({ cloudPack: config }, () => {
            writePresenceFromBg(url, packKey, role, userName);
            addToRoomHistory(config, () => sendResponse({ ok: true, config }));
          });
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
    const { firebaseUrl, packKey, instanceId, payload } = msg;
    const url = (firebaseUrl || "").replace(/\/+$/, "");
    if (!url || !packKey || !instanceId) { sendResponse({ ok: false }); return true; }
    fetch(`${url}/packs/${packKey}/presence/${instanceId}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(resp => sendResponse({ ok: resp.ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.action === "remove-presence") {
    const { firebaseUrl, packKey, instanceId } = msg;
    const url = (firebaseUrl || "").replace(/\/+$/, "");
    if (!url || !packKey || !instanceId) { sendResponse({ ok: false }); return true; }
    fetch(`${url}/packs/${packKey}/presence/${instanceId}.json`, { method: "DELETE" })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.action === "clear-all-data") {
    chrome.storage.local.remove(["highlights", "cloudPack", "roomHistory"], () => {
      sendResponse({ ok: true });
    });
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
