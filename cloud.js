/* ─────────────────────────────────────────────
   Vantage — Cloud Sync (Firebase REST + SSE)
   Zero-SDK real-time sync via Firebase Realtime Database
   ───────────────────────────────────────────── */

/** One row per display name (latest heartbeat wins). Fixes duplicate tabs/sessions with the same anon name. */
function dedupePresenceByDisplayName(viewers) {
  if (!viewers || typeof viewers !== "object") return {};
  const cutoff = Date.now() - 60000;
  const entries = Object.entries(viewers)
    .filter(([, info]) => info && typeof info.lastSeen === "number" && info.lastSeen > cutoff)
    .sort((a, b) => b[1].lastSeen - a[1].lastSeen);
  const seen = new Set();
  const out = {};
  for (const [id, info] of entries) {
    const nameKey = String(info.name || "Anonymous").trim().toLowerCase();
    if (seen.has(nameKey)) continue;
    seen.add(nameKey);
    out[id] = info;
  }
  return out;
}

// Exposed globally for content.js to consume
// eslint-disable-next-line no-unused-vars
class CloudSync {

  static ROLES = Object.freeze({
    VIEWER:    "viewer",
    COMMENTOR: "commentor",
    EDITOR:    "editor",
  });

  constructor() {
    this._firebaseUrl = "";
    this._packKey = "";
    this._role = CloudSync.ROLES.VIEWER;
    this._instanceId = this._generateInstanceId();
    this._sessionId = null;
    this._userName = "Anonymous";
    this._eventSource = null;
    this._presenceSource = null;
    this._heartbeatTimer = null;
    this._onHighlight = null;
    this._onDelete = null;
    this._onPresenceChange = null;
    this._subscribedUrlHash = null;
    this._knownIds = new Set();
    this._activeViewers = {};
    this._roomLabels = {};
    this._sessionReady = this._loadSessionId();
    this._nameReady = Promise.resolve();
  }

  _loadSessionId() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: "get-session-id" }, (resp) => {
          if (chrome.runtime.lastError) {
            this._sessionId = this._instanceId;
          } else if (resp && resp.sessionId) {
            this._sessionId = resp.sessionId;
          } else {
            this._sessionId = this._instanceId;
          }
          resolve();
        });
      } catch {
        this._sessionId = this._instanceId;
        resolve();
      }
    });
  }

  get presenceId() {
    return this._sessionId || this._instanceId;
  }

  /* ════════════════════════════════════════════
     CONFIGURATION
     ════════════════════════════════════════════ */

  configure(firebaseUrl, packKey, role, userName) {
    this._firebaseUrl = (firebaseUrl || "").replace(/\/+$/, "");
    this._packKey = packKey || "";
    this._role = role || CloudSync.ROLES.VIEWER;
    this._userName = userName || "Anonymous";
    this._nameReady = this._resolveMyName();
  }

  async _resolveMyName() {
    await this._sessionReady;
    if (!this._firebaseUrl || !this._packKey) return;
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { action: "get-my-name", firebaseUrl: this._firebaseUrl, packKey: this._packKey, preferredName: this._userName },
          (resp) => {
            if (chrome.runtime.lastError) { resolve(); return; }
            if (resp && resp.name) {
              this._userName = resp.name;
              try {
                chrome.storage.local.get("cloudPack", (data) => {
                  if (data.cloudPack && data.cloudPack.packKey === this._packKey) {
                    data.cloudPack.userName = resp.name;
                    chrome.storage.local.set({ cloudPack: data.cloudPack });
                  }
                });
              } catch {}
            }
            resolve();
          }
        );
      } catch { resolve(); }
    });
  }

  get instanceId() {
    return this._instanceId;
  }

  get activeViewers() {
    return { ...this._activeViewers };
  }

  get activeViewerCount() {
    return Object.keys(this._activeViewers).length;
  }

  get isConfigured() {
    return !!(this._firebaseUrl && this._packKey);
  }

  get packKey() {
    return this._packKey;
  }

  get role() {
    return this._role;
  }

  get roomLabels() {
    return { ...this._roomLabels };
  }

  async fetchLabels() {
    if (!this.isConfigured) return {};
    try {
      const resp = await new Promise(resolve => {
        chrome.runtime.sendMessage(
          { action: "get-room-labels", firebaseUrl: this._firebaseUrl, packKey: this._packKey },
          resolve
        );
      });
      this._roomLabels = resp && typeof resp === "object" ? resp : {};
    } catch {
      this._roomLabels = {};
    }
    return this._roomLabels;
  }

  /* ════════════════════════════════════════════
     ROLE-BASED PERMISSIONS
     ════════════════════════════════════════════ */

  get canHighlight() {
    return this._role === CloudSync.ROLES.COMMENTOR || this._role === CloudSync.ROLES.EDITOR;
  }

  get canDelete() {
    return this._role === CloudSync.ROLES.EDITOR;
  }

  get canEditOthers() {
    return this._role === CloudSync.ROLES.EDITOR;
  }

  get isOwner() {
    return this._role === CloudSync.ROLES.EDITOR;
  }

  /* ════════════════════════════════════════════
     ROOM KEY GENERATION
     ════════════════════════════════════════════ */

  static generateRoomKey() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const block = () => Array.from({ length: 4 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
    return `CS-${block()}-${block()}`;
  }

  /* ════════════════════════════════════════════
     PACK CRUD (Firebase REST)
     ════════════════════════════════════════════ */

  async createPack(name) {
    const key = CloudSync.generateRoomKey();
    const meta = {
      name: name || "Untitled Pack",
      createdAt: new Date().toISOString(),
    };
    const resp = await fetch(
      `${this._firebaseUrl}/packs/${key}/meta.json`,
      { method: "PUT", body: JSON.stringify(meta) }
    );
    if (!resp.ok) throw new Error(`Firebase PUT failed: ${resp.status}`);
    return key;
  }

  async joinPack(key) {
    const resp = await fetch(
      `${this._firebaseUrl}/packs/${key}/meta.json`
    );
    if (!resp.ok) throw new Error(`Firebase GET failed: ${resp.status}`);
    const meta = await resp.json();
    if (!meta) throw new Error("Pack not found");
    return meta;
  }

  async updateDefaultRole(newRole) {
    if (!this.isConfigured) return;
    const resp = await fetch(
      `${this._firebaseUrl}/packs/${this._packKey}/meta/defaultRole.json`,
      { method: "PUT", body: JSON.stringify(newRole) }
    );
    if (!resp.ok) throw new Error(`Firebase PUT failed: ${resp.status}`);
  }

  async fetchAllHighlightsForUrl(url) {
    if (!this.isConfigured) return {};
    const urlHash = CloudSync.encodeUrlKey(url);
    const resp = await fetch(
      `${this._firebaseUrl}/packs/${this._packKey}/highlights/${urlHash}.json`
    );
    if (!resp.ok) return {};
    const data = await resp.json();
    return data || {};
  }

  /* ════════════════════════════════════════════
     PUSH HIGHLIGHT TO CLOUD
     ════════════════════════════════════════════ */

  async pushHighlight(highlight) {
    if (!this.isConfigured) return;
    await this._nameReady;
    const urlHash = CloudSync.encodeUrlKey(highlight.url);
    const payload = {
      ...highlight,
      _author: this.presenceId,
      _authorName: this._userName,
    };
    this._knownIds.add(highlight.id);
    try {
      chrome.runtime.sendMessage({
        action: "push-highlight-cloud",
        firebaseUrl: this._firebaseUrl,
        packKey: this._packKey,
        urlHash,
        highlightId: highlight.id,
        payload,
      });
    } catch (err) {
      console.error("[CloudSync] Push relay failed:", err);
    }
  }

  async deleteHighlight(url, highlightId) {
    if (!this.isConfigured) return;
    const urlHash = CloudSync.encodeUrlKey(url);
    this._knownIds.delete(highlightId);
    try {
      chrome.runtime.sendMessage({
        action: "delete-highlight-cloud",
        firebaseUrl: this._firebaseUrl,
        packKey: this._packKey,
        urlHash,
        highlightId,
      });
    } catch (err) {
      console.error("[CloudSync] Delete relay failed:", err);
    }
  }

  /* ════════════════════════════════════════════
     SSE SUBSCRIPTION (real-time streaming)
     ════════════════════════════════════════════ */

  subscribeToUrl(url, onHighlight, onDelete, onUpdate) {
    this.unsubscribe();
    if (!this.isConfigured) return;

    this._onHighlight = onHighlight;
    this._onDelete = onDelete;
    this._onUpdate = onUpdate || null;
    const urlHash = CloudSync.encodeUrlKey(url);
    this._subscribedUrlHash = urlHash;

    const sseUrl = `${this._firebaseUrl}/packs/${this._packKey}/highlights/${urlHash}.json`;
    console.log("[CloudSync] SSE subscribing:", sseUrl);

    this._eventSource = new EventSource(sseUrl);

    this._eventSource.addEventListener("put", (e) => {
      this._handleSSE(e, "put");
    });

    this._eventSource.addEventListener("patch", (e) => {
      this._handleSSE(e, "patch");
    });

    this._eventSource.onerror = (err) => {
      console.warn("[CloudSync] SSE error, will auto-reconnect:", err);
    };
  }

  unsubscribe() {
    if (this._eventSource) {
      this._eventSource.close();
      this._eventSource = null;
    }
    this._subscribedUrlHash = null;
  }

  /* ════════════════════════════════════════════
     PRESENCE — who's online in this room
     ════════════════════════════════════════════ */

  async announcePresence(pageUrl) {
    if (!this.isConfigured) return;
    await this._nameReady;
    const payload = {
      name: this._userName,
      role: this._role,
      url: pageUrl || "",
      lastSeen: Date.now(),
    };
    try {
      chrome.runtime.sendMessage({
        action: "write-presence",
        firebaseUrl: this._firebaseUrl,
        packKey: this._packKey,
        payload,
      });
    } catch (err) {
      console.warn("[CloudSync] Presence announce failed:", err);
    }
  }

  async removePresence() {
    if (!this.isConfigured) return;
    await this._nameReady;
    try {
      chrome.runtime.sendMessage({
        action: "remove-presence",
        firebaseUrl: this._firebaseUrl,
        packKey: this._packKey,
      });
    } catch {}
  }

  startHeartbeat(pageUrlFn) {
    this.stopHeartbeat();
    this.announcePresence(pageUrlFn ? pageUrlFn() : "");
    this._heartbeatTimer = setInterval(() => {
      this.announcePresence(pageUrlFn ? pageUrlFn() : "");
    }, 30000);
  }

  stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  subscribePresence(onChange) {
    this.unsubscribePresence();
    if (!this.isConfigured) return;
    this._onPresenceChange = onChange;

    const url = `${this._firebaseUrl}/packs/${this._packKey}/presence.json`;
    this._presenceSource = new EventSource(url);

    this._presenceSource.addEventListener("put", (e) => {
      this._handlePresenceSSE(e);
    });
    this._presenceSource.addEventListener("patch", (e) => {
      this._handlePresenceSSE(e);
    });
    this._presenceSource.onerror = () => {};
  }

  unsubscribePresence() {
    if (this._presenceSource) {
      this._presenceSource.close();
      this._presenceSource = null;
    }
  }

  _handlePresenceSSE(event) {
    let parsed;
    try { parsed = JSON.parse(event.data); } catch { return; }
    const { path, data } = parsed;

    if (path === "/") {
      this._activeViewers = {};
      if (data && typeof data === "object") {
        const cutoff = Date.now() - 60000;
        for (const [id, info] of Object.entries(data)) {
          if (info && info.lastSeen > cutoff) {
            this._activeViewers[id] = info;
          }
        }
      }
    } else {
      const id = path.split("/").filter(Boolean).pop();
      if (!data) {
        delete this._activeViewers[id];
      } else if (data.lastSeen > Date.now() - 60000) {
        this._activeViewers[id] = data;
      }
    }

    if (this._onPresenceChange) {
      this._onPresenceChange(dedupePresenceByDisplayName(this._activeViewers));
    }
  }

  disconnectAll() {
    this.removePresence();
    this.stopHeartbeat();
    this.unsubscribePresence();
    this.unsubscribe();
    this._activeViewers = {};
  }

  _handleSSE(event, type) {
    let parsed;
    try {
      parsed = JSON.parse(event.data);
    } catch { return; }

    const { path, data } = parsed;
    if (!data) {
      if (type === "put" && path !== "/") {
        const id = path.split("/").filter(Boolean).pop();
        if (id && this._onDelete) {
          this._onDelete(id);
        }
      }
      return;
    }

    if (path === "/") {
      if (typeof data === "object") {
        for (const [id, hl] of Object.entries(data)) {
          if (hl._author === this.presenceId) continue;
          if (this._knownIds.has(id)) {
            if (this._onUpdate) this._onUpdate(hl);
          } else {
            this._knownIds.add(id);
            if (this._onHighlight) this._onHighlight(hl);
          }
        }
      }
    } else {
      const id = path.split("/").filter(Boolean).pop();
      if (!id || data._author === this.presenceId) return;
      if (this._knownIds.has(id)) {
        if (this._onUpdate) this._onUpdate(data);
      } else {
        this._knownIds.add(id);
        if (this._onHighlight) this._onHighlight(data);
      }
    }
  }

  /* ════════════════════════════════════════════
     UTILITIES
     ════════════════════════════════════════════ */

  static decodeUrlKey(hash) {
    try {
      let b64 = hash.replace(/-/g, "+").replace(/_/g, "/");
      const pad = b64.length % 4;
      if (pad) b64 += "=".repeat(4 - pad);
      return decodeURIComponent(escape(atob(b64)));
    } catch {
      return hash;
    }
  }

  static encodeUrlKey(url) {
    try {
      return btoa(unescape(encodeURIComponent(url)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    } catch {
      return btoa(url)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    }
  }

  _generateInstanceId() {
    return "inst-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
}
