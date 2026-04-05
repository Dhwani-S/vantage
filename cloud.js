/* ─────────────────────────────────────────────
   Vantage — Cloud Sync (Firebase REST + SSE)
   Zero-SDK real-time sync via Firebase Realtime Database
   ───────────────────────────────────────────── */

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
    this._sharedInstanceId = null; // loaded from storage, shared across tabs
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
    this._loadSharedId();
  }

  _loadSharedId() {
    try {
      chrome.storage.local.get("vantageInstanceId", (data) => {
        if (data.vantageInstanceId) {
          this._sharedInstanceId = data.vantageInstanceId;
        } else {
          const id = "v-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          this._sharedInstanceId = id;
          chrome.storage.local.set({ vantageInstanceId: id });
        }
      });
    } catch {
      this._sharedInstanceId = this._instanceId;
    }
  }

  get presenceId() {
    return this._sharedInstanceId || this._instanceId;
  }

  /* ════════════════════════════════════════════
     CONFIGURATION
     ════════════════════════════════════════════ */

  configure(firebaseUrl, packKey, role, userName) {
    this._firebaseUrl = (firebaseUrl || "").replace(/\/+$/, "");
    this._packKey = packKey || "";
    this._role = role || CloudSync.ROLES.VIEWER;
    this._userName = userName || "Anonymous";
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
    const urlHash = CloudSync.encodeUrlKey(highlight.url);
    const payload = {
      ...highlight,
      _author: this._instanceId,
    };
    this._knownIds.add(highlight.id);
    const resp = await fetch(
      `${this._firebaseUrl}/packs/${this._packKey}/highlights/${urlHash}/${highlight.id}.json`,
      { method: "PUT", body: JSON.stringify(payload) }
    );
    if (!resp.ok) {
      console.error("[CloudSync] Push failed:", resp.status);
    }
  }

  async deleteHighlight(url, highlightId) {
    if (!this.isConfigured) return;
    const urlHash = CloudSync.encodeUrlKey(url);
    this._knownIds.delete(highlightId);
    const resp = await fetch(
      `${this._firebaseUrl}/packs/${this._packKey}/highlights/${urlHash}/${highlightId}.json`,
      { method: "DELETE" }
    );
    if (!resp.ok) {
      console.error("[CloudSync] Delete failed:", resp.status);
    }
  }

  /* ════════════════════════════════════════════
     SSE SUBSCRIPTION (real-time streaming)
     ════════════════════════════════════════════ */

  subscribeToUrl(url, onHighlight, onDelete) {
    this.unsubscribe();
    if (!this.isConfigured) return;

    this._onHighlight = onHighlight;
    this._onDelete = onDelete;
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
        instanceId: this.presenceId,
        payload,
      });
    } catch (err) {
      console.warn("[CloudSync] Presence announce failed:", err);
    }
  }

  async removePresence() {
    if (!this.isConfigured) return;
    try {
      chrome.runtime.sendMessage({
        action: "remove-presence",
        firebaseUrl: this._firebaseUrl,
        packKey: this._packKey,
        instanceId: this.presenceId,
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
      this._onPresenceChange(this._activeViewers);
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
      // Initial load or full replacement — data is { id: highlight, ... }
      if (typeof data === "object") {
        for (const [id, hl] of Object.entries(data)) {
          if (this._shouldAccept(id, hl)) {
            this._knownIds.add(id);
            if (this._onHighlight) this._onHighlight(hl);
          }
        }
      }
    } else {
      // Single highlight added/updated — path is "/{highlightId}"
      const id = path.split("/").filter(Boolean).pop();
      if (id && this._shouldAccept(id, data)) {
        this._knownIds.add(id);
        if (this._onHighlight) this._onHighlight(data);
      }
    }
  }

  _shouldAccept(id, highlight) {
    if (this._knownIds.has(id)) return false;
    if (highlight._author === this._instanceId) return false;
    return true;
  }

  /* ════════════════════════════════════════════
     UTILITIES
     ════════════════════════════════════════════ */

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
