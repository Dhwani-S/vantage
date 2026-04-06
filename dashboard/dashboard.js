/* ─────────────────────────────────────────────
   Vantage — Dashboard Script
   Full-screen management: view, group, search,
   harvest markdown, export/import packs
   ───────────────────────────────────────────── */

(() => {
  "use strict";

  let allData = {};          // { url: [highlights] }
  let currentView = "domain"; // domain | date | all | room | none
  let filterDomain = null;
  let searchQuery = "";
  let selectedIds = new Set();
  let cloudRole = null;      // null = no cloud, "viewer" | "commentor" | "editor"
  let activeCloudConfig = null;
  let selectedRoom = null;   // { firebaseUrl, packKey, packName, role }
  let roomHighlights = {};   // fetched from Firebase for the selected room
  let cachedLabels = {};     // room labels cache: { id: { name, color } }
  let filterLabel = null;    // active label filter
  let filterAuthor = null;   // active author name filter
  let filterRoomDomain = null; // active domain filter (room view only)

  const NAME_COLOR_HEX = {
    Amber: "#f59e0b", Azure: "#3b82f6", Coral: "#f97316", Cyan: "#06b6d4",
    Ember: "#ef4444", Jade: "#10b981", Lime: "#84cc16", Mint: "#34d399",
    Navy: "#1e40af", Onyx: "#71717a", Pearl: "#e2e8f0", Rose: "#f43f5e",
    Ruby: "#dc2626", Sage: "#94a3b8", Slate: "#64748b", Teal: "#14b8a6",
    Violet: "#8b5cf6", Zinc: "#a1a1aa",
  };

  function getComments(h) {
    if (Array.isArray(h.comments) && h.comments.length > 0) return h.comments;
    if (h.note) return [{ text: h.note, author: h._authorName || "Anonymous", createdAt: h.createdAt }];
    return [];
  }

  /* ════════════════════════════════════════════
     INIT
     ════════════════════════════════════════════ */
  document.addEventListener("DOMContentLoaded", () => {
    initTheme();
    loadData();
    wireEvents();
  });

  /* ════════════════════════════════════════════
     THEME
     ════════════════════════════════════════════ */
  function initTheme() {
    chrome.storage.local.get("theme", ({ theme }) => {
      applyTheme(theme || "dark");
    });
  }

  const SVG_SUN  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;
  const SVG_MOON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;
  const SVG_TRASH = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`;
  const SVG_COPY = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
  const SVG_LINK = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`;
  const SVG_HIGHLIGHTER = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>`;
  const SVG_CLOUD_SM = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/></svg>`;

  function applyTheme(theme) {
    document.body.setAttribute("data-theme", theme);
    const btn = document.getElementById("themeToggle");
    if (btn) {
      btn.innerHTML = (theme === "dark" ? SVG_SUN : SVG_MOON) + `<span>${theme === "dark" ? "Light" : "Dark"}</span>`;
      btn.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
    }
  }

  function canDeleteHighlight(h) {
    if (!cloudRole) return true;
    if (cloudRole === "editor") return true;
    if (cloudRole === "commentor") return !h._cloud;
    return false; // viewer
  }

  function loadData() {
    chrome.runtime.sendMessage({ action: "get-cloud-status" }, (status) => {
      cloudRole = (status && status.role) ? status.role : null;
      chrome.runtime.sendMessage({ action: "get-all-highlights" }, (data) => {
        allData = data || {};
        render();
      });
    });
    loadCloudStatus();
  }

  function loadCloudStatus() {
    chrome.runtime.sendMessage({ action: "get-cloud-status" }, (status) => {
      activeCloudConfig = status;
      const container = document.getElementById("cloudStatusContent");
      if (!container) return;
      if (status && status.packKey) {
        cloudRole = status.role || null;
        const role = status.role || "viewer";
        const roleColors = { viewer: "#868e96", commentor: "#51cf66", editor: "#ffe066" };
        const roleColor = roleColors[role] || "#868e96";
        container.innerHTML = `
          <div class="cloud-connected-info">
            <span class="cloud-live-dot"></span>
            <span class="cloud-pack-label">${escapeHTML(status.packName || "Shared POV")}</span>
          </div>
          <code class="cloud-room-key">${escapeHTML(status.packKey)}</code>
          <span class="cloud-role-tag" style="color:${roleColor};border-color:${roleColor}">${role}</span>
          <div class="cloud-identity-row" id="dashIdentity"></div>
          <div class="cloud-viewers-row" id="dashViewers">
            <span class="cloud-viewer-dot"></span>
            <span id="dashViewerCount">…</span> online
          </div>
          <div class="cloud-viewer-names" id="dashViewerNames"></div>
        `;
        if (status.userName) {
          const idEl = document.getElementById("dashIdentity");
          if (idEl) idEl.innerHTML = `<span class="dash-identity-label">You are</span> ${avatarHTML(status.userName, 18)} <span class="dash-identity-name">${escapeHTML(status.userName)}</span>`;
        }
        loadPresenceCount(status);
        chrome.runtime.sendMessage(
          { action: "get-room-labels", firebaseUrl: status.firebaseUrl, packKey: status.packKey },
          (labels) => { cachedLabels = labels || {}; }
        );
      } else {
        container.innerHTML = `<span class="cloud-offline">Not connected</span>`;
      }
      loadRoomManager(status);
    });
  }

  function avatarHTML(name, size) {
    const s = size || 16;
    const fs = Math.round(s * 0.55);
    const parts = (name || "Anonymous").split(" ");
    const color = NAME_COLOR_HEX[parts[0]] || "#71717a";
    const initial = (parts[1] || parts[0] || "?").charAt(0).toUpperCase();
    return `<span class="dash-avatar" style="background:${color};width:${s}px;height:${s}px;font-size:${fs}px">${initial}</span>`;
  }

  function loadPresenceCount(config) {
    chrome.runtime.sendMessage(
      { action: "get-room-presence", firebaseUrl: config.firebaseUrl, packKey: config.packKey },
      (viewers) => {
        const entries = viewers ? Object.values(viewers) : [];
        const el = document.getElementById("dashViewerCount");
        if (el) el.textContent = entries.length;

        const namesEl = document.getElementById("dashViewerNames");
        if (namesEl && entries.length > 0) {
          namesEl.innerHTML = entries
            .map(v => `<span class="dash-viewer-chip">${avatarHTML(v.name, 14)}${escapeHTML(v.name || "Anonymous")}</span>`)
            .join("");
        } else if (namesEl) {
          namesEl.innerHTML = "";
        }
      }
    );
  }

  function roomOwnerRegistryKey(firebaseUrl, packKey) {
    const url = (firebaseUrl || "").replace(/\/+$/, "");
    return `${url}::${packKey}`;
  }

  function afterRoomDeleted(deletedPackKey) {
    if (selectedRoom && selectedRoom.packKey === deletedPackKey) {
      selectedRoom = null;
      currentView = "domain";
      filterRoomDomain = null;
    }
    loadCloudStatus();
    loadData();
  }

  function loadRoomManager(activeConfig) {
    chrome.runtime.sendMessage({ action: "get-room-history" }, (history) => {
      const section = document.getElementById("roomManagerSection");
      const list = document.getElementById("roomManagerList");
      if (!section || !list) return;
      if (!history || history.length === 0) {
        section.style.display = "none";
        return;
      }
      section.style.display = "";
      const activeKey = activeConfig?.packKey;
      chrome.storage.local.get("roomCreatorRegistry", (regData) => {
        const reg = regData.roomCreatorRegistry || {};
        list.innerHTML = history.map(r => {
          const isActive = r.packKey === activeKey;
          const isSelected = selectedRoom && selectedRoom.packKey === r.packKey;
          const canDelete = !!reg[roomOwnerRegistryKey(r.firebaseUrl, r.packKey)];
          return `
          <div class="room-item${isActive ? " room-active" : ""}${isSelected ? " room-selected" : ""}"
               data-key="${escapeAttr(r.packKey)}" data-url="${escapeAttr(r.firebaseUrl)}"
               data-name="${escapeAttr(r.packName || r.packKey)}" data-role="${escapeAttr(r.role || "viewer")}">
            <span class="room-item-name">${escapeHTML(r.packName || r.packKey)}</span>
            <div class="room-item-meta">
              ${canDelete ? `<span class="room-item-owner" title="You can delete this room from this browser (created here or joined with the master room key)">Owner</span>` : ""}
              <span class="room-item-role role-${r.role || "viewer"}">${r.role || "viewer"}</span>
              ${isActive ? '<span class="room-item-live"></span>' : ""}
              ${canDelete ? `<button type="button" class="room-item-delete" title="Delete room" aria-label="Delete room">${SVG_TRASH}</button>` : ""}
            </div>
          </div>
        `;
        }).join("");

        list.querySelectorAll(".room-item").forEach(item => {
          item.addEventListener("click", (e) => {
            if (e.target.closest(".room-item-delete")) return;
            const key = item.dataset.key;
            if (selectedRoom && selectedRoom.packKey === key && currentView === "room") {
              selectedRoom = null;
              currentView = "none";
              filterRoomDomain = null;
              render();
              loadRoomManager(activeCloudConfig);
              return;
            }
            selectedRoom = {
              firebaseUrl: item.dataset.url,
              packKey: item.dataset.key,
              packName: item.dataset.name,
              role: item.dataset.role,
            };
            currentView = "room";
            render();
            loadRoomManager(activeCloudConfig);
          });
        });

        list.querySelectorAll(".room-item-delete").forEach(btn => {
          btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const row = btn.closest(".room-item");
            if (!row) return;
            const packKey = row.dataset.key;
            const firebaseUrl = row.dataset.url;
            const packName = row.dataset.name;
            if (!confirm(`Delete room "${packName}"? This removes it for everyone and cannot be undone.`)) return;
            btn.disabled = true;
            chrome.runtime.sendMessage(
              { action: "delete-room", firebaseUrl, packKey },
              (resp) => {
                btn.disabled = false;
                if (resp?.ok) {
                  toast("Room deleted!");
                  afterRoomDeleted(packKey);
                } else {
                  toast(resp?.error || "Failed to delete room");
                }
              }
            );
          });
        });
      });
    });
  }

  function timeAgo(dateStr) {
    if (!dateStr) return "";
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `${days}d`;
  }

  /* ════════════════════════════════════════════
     EVENT WIRING
     ════════════════════════════════════════════ */
  function wireEvents() {
    // Nav buttons
    document.querySelectorAll(".nav-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const view = btn.dataset.view;
        if (currentView === view && !selectedRoom) {
          currentView = "none";
          filterDomain = null;
          filterLabel = null;
          filterAuthor = null;
          filterRoomDomain = null;
          render();
          loadRoomManager(activeCloudConfig);
          return;
        }
        currentView = view;
        filterDomain = null;
        filterLabel = null;
        filterAuthor = null;
        filterRoomDomain = null;
        selectedRoom = null;
        render();
        loadRoomManager(activeCloudConfig);
      });
    });

    // Theme toggle
    document.getElementById("themeToggle").addEventListener("click", () => {
      const current = document.body.getAttribute("data-theme") || "dark";
      const next = current === "dark" ? "light" : "dark";
      applyTheme(next);
      chrome.storage.local.set({ theme: next });
      // Notify content scripts on all tabs
      chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
          try { chrome.tabs.sendMessage(tab.id, { action: "set-theme", theme: next }); } catch {}
        }
      });
    });

    // Search
    document.getElementById("searchInput").addEventListener("input", (e) => {
      searchQuery = e.target.value.toLowerCase().trim();
      render();
    });

    // Select All
    document.getElementById("btnSelectAll").addEventListener("click", toggleSelectAll);

    // Delete Selected
    document.getElementById("btnDeleteSelected").addEventListener("click", deleteSelected);

    // Clear All
    document.getElementById("btnClearAll").addEventListener("click", () => {
      if (!confirm("This will delete ALL local annotations and disconnect from the cloud room. Continue?")) return;
      chrome.runtime.sendMessage({ action: "clear-all-data" }, () => {
        allData = {};
        cloudRole = null;
        selectedIds.clear();
        render();
        loadCloudStatus();
        toast("All data cleared!");
      });
    });

    // Harvest Markdown
    document.getElementById("btnHarvest").addEventListener("click", harvestMarkdown);

    // Export Pack
    document.getElementById("btnExportPack").addEventListener("click", exportPack);

    // Import Pack
    document.getElementById("btnImportPack").addEventListener("click", () => {
      document.getElementById("fileImport").click();
    });
    document.getElementById("fileImport").addEventListener("change", importPack);

    // Modal close
    document.getElementById("mdClose").addEventListener("click", () => {
      document.getElementById("mdModal").classList.remove("visible");
    });
    document.getElementById("mdModal").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) e.currentTarget.classList.remove("visible");
    });

    // Copy markdown
    document.getElementById("mdCopy").addEventListener("click", () => {
      navigator.clipboard.writeText(document.getElementById("mdOutput").value);
      toast("Copied to clipboard!");
    });

    // Download markdown
    document.getElementById("mdDownload").addEventListener("click", () => {
      const blob = new Blob([document.getElementById("mdOutput").value], { type: "text/markdown" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `vantage-${new Date().toISOString().slice(0,10)}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast("Downloaded!");
    });
  }

  /* ════════════════════════════════════════════
     RENDER
     ════════════════════════════════════════════ */
  function syncNavActiveState() {
    document.querySelectorAll(".nav-btn").forEach(b => {
      const v = b.dataset.view;
      b.classList.toggle("active", currentView === v && currentView !== "none" && currentView !== "room");
    });
  }

  function render() {
    updateStats();
    renderDomainList();
    renderFilterBar();
    renderContent();
    syncNavActiveState();
    updateDeleteBtn();
  }

  function updateStats() {
    let totalH = 0, totalN = 0;
    const pages = Object.keys(allData);
    for (const url of pages) {
      totalH += allData[url].length;
      totalN += allData[url].filter(h => getComments(h).length > 0).length;
    }
    document.getElementById("statHighlights").textContent = totalH;
    document.getElementById("statPages").textContent = pages.length;
    document.getElementById("statNotes").textContent = totalN;
  }

  /* ── Domain sidebar list ─────────────────── */
  function renderDomainList() {
    const list = document.getElementById("domainList");
    const domains = {};
    for (const url of Object.keys(allData)) {
      try {
        const d = new URL(url).hostname;
        if (!domains[d]) domains[d] = 0;
        domains[d] += allData[url].length;
      } catch { /* skip invalid */ }
    }

    list.innerHTML = Object.entries(domains)
      .sort((a, b) => b[1] - a[1])
      .map(([d, count]) => `
        <div class="domain-item${filterDomain === d ? " active" : ""}" data-domain="${d}">
          <span>${d}</span>
          <span class="badge">${count}</span>
        </div>
      `).join("");

    list.querySelectorAll(".domain-item").forEach(el => {
      el.addEventListener("click", () => {
        filterDomain = filterDomain === el.dataset.domain ? null : el.dataset.domain;
        if (currentView === "none") currentView = "domain";
        render();
      });
    });
  }

  /* ── Filter bar (domains + labels + authors) ─ */
  function renderFilterBar() {
    const domainContainer = document.getElementById("domainFilters");
    const labelContainer = document.getElementById("labelFilters");
    const authorContainer = document.getElementById("authorFilters");
    const bar = document.getElementById("filterBar");
    if (!labelContainer || !authorContainer || !bar) return;

    if (currentView === "none") {
      bar.style.display = "none";
      if (domainContainer) domainContainer.innerHTML = "";
      labelContainer.innerHTML = "";
      authorContainer.innerHTML = "";
      return;
    }

    const allFlat = [];
    const domainCounts = {};
    const isRoomView = currentView === "room" && selectedRoom && roomHighlights;

    if (isRoomView) {
      for (const urlHash of Object.keys(roomHighlights)) {
        const decodedUrl = decodeUrlKey(urlHash);
        const hls = roomHighlights[urlHash];
        if (!hls || typeof hls !== "object") continue;
        const values = Object.values(hls);
        for (const hl of values) allFlat.push(hl);
        try {
          const hostname = new URL(decodedUrl).hostname;
          domainCounts[hostname] = (domainCounts[hostname] || 0) + values.length;
        } catch {}
      }
    } else {
      for (const url of Object.keys(allData)) {
        for (const h of allData[url]) allFlat.push(h);
      }
    }

    const labelCounts = {};
    const authorCounts = {};
    for (const h of allFlat) {
      if (h.label) {
        labelCounts[h.label] = (labelCounts[h.label] || 0) + 1;
      }
      if (h._authorName) {
        authorCounts[h._authorName] = (authorCounts[h._authorName] || 0) + 1;
      }
    }

    const hasDomains = Object.keys(domainCounts).length > 1;
    const hasLabels = Object.keys(labelCounts).length > 0;
    const hasAuthors = Object.keys(authorCounts).length > 0;
    const hasFilters = hasDomains || hasLabels || hasAuthors;
    bar.style.display = hasFilters ? "" : "none";
    if (!hasFilters) {
      if (domainContainer) domainContainer.innerHTML = "";
      labelContainer.innerHTML = "";
      authorContainer.innerHTML = "";
      return;
    }

    if (domainContainer) {
      if (hasDomains) {
        domainContainer.innerHTML = `<span class="filter-group-title">Domains</span>` +
          Object.entries(domainCounts).sort((a, b) => b[1] - a[1]).map(([domain, count]) => {
            const active = filterRoomDomain === domain ? " active" : "";
            return `<button class="filter-chip domain-chip${active}" data-domain="${escapeAttr(domain)}">${escapeHTML(domain)}<span class="filter-count">${count}</span></button>`;
          }).join("");
        domainContainer.querySelectorAll(".domain-chip").forEach(btn => {
          btn.addEventListener("click", () => {
            filterRoomDomain = filterRoomDomain === btn.dataset.domain ? null : btn.dataset.domain;
            render();
          });
        });
      } else {
        domainContainer.innerHTML = "";
      }
    }

    if (hasLabels) {
      labelContainer.innerHTML = `<span class="filter-group-title">Labels</span>` +
        Object.entries(labelCounts).map(([id, count]) => {
          const lb = cachedLabels[id];
          const name = lb ? escapeHTML(lb.name) : escapeHTML(id);
          const color = lb ? lb.color : "#71717a";
          const active = filterLabel === id ? " active" : "";
          return `<button class="filter-chip label-chip${active}" data-label="${escapeAttr(id)}"><span class="filter-dot" style="background:${color}"></span>${name}<span class="filter-count">${count}</span></button>`;
        }).join("");
    } else {
      labelContainer.innerHTML = "";
    }

    if (hasAuthors) {
      authorContainer.innerHTML = `<span class="filter-group-title">Authors</span>` +
        Object.entries(authorCounts).map(([name, count]) => {
          const active = filterAuthor === name ? " active" : "";
          return `<button class="filter-chip author-chip${active}" data-author="${escapeAttr(name)}">${avatarHTML(name, 14)}${escapeHTML(name)}<span class="filter-count">${count}</span></button>`;
        }).join("");
    } else {
      authorContainer.innerHTML = "";
    }

    labelContainer.querySelectorAll(".label-chip").forEach(btn => {
      btn.addEventListener("click", () => {
        filterLabel = filterLabel === btn.dataset.label ? null : btn.dataset.label;
        render();
      });
    });
    authorContainer.querySelectorAll(".author-chip").forEach(btn => {
      btn.addEventListener("click", () => {
        filterAuthor = filterAuthor === btn.dataset.author ? null : btn.dataset.author;
        render();
      });
    });
  }

  /* ── Main content ────────────────────────── */
  function renderContent() {
    const content = document.getElementById("content");

    if (currentView === "room" && selectedRoom) {
      renderRoomView(content);
      return;
    }

    if (currentView === "none") {
      content.innerHTML = `<div class="dash-idle-hint">Choose <strong>By Domain</strong>, <strong>By Date</strong>, or <strong>All Annotations</strong>, or pick a room below.</div>`;
      document.getElementById("viewTitle").textContent = "Overview";
      return;
    }

    const flat = getFlatHighlights();

    if (flat.length === 0) {
      content.innerHTML = "";
      content.appendChild(createEmptyState());
      document.getElementById("viewTitle").textContent = "All Annotations";
      return;
    }

    let html = "";

    if (currentView === "domain") {
      html = renderGrouped(flat, groupByDomain(flat));
      document.getElementById("viewTitle").textContent = filterDomain || "By Domain";
    } else if (currentView === "date") {
      html = renderGrouped(flat, groupByDate(flat));
      document.getElementById("viewTitle").textContent = "By Date";
    } else {
      html = flat.map(h => cardHTML(h)).join("");
      document.getElementById("viewTitle").textContent = "All Annotations";
    }

    content.innerHTML = html;
    wireCardEvents(content);
  }

  function getFlatHighlights() {
    let flat = [];
    for (const url of Object.keys(allData)) {
      for (const h of allData[url]) {
        flat.push({ ...h, url });
      }
    }

    // Filter by domain
    if (filterDomain) {
      flat = flat.filter(h => {
        try { return new URL(h.url).hostname === filterDomain; } catch { return false; }
      });
    }

    // Filter by label
    if (filterLabel) {
      flat = flat.filter(h => h.label === filterLabel);
    }

    // Filter by author
    if (filterAuthor) {
      flat = flat.filter(h => h._authorName === filterAuthor);
    }

    // Filter by search
    if (searchQuery) {
      flat = flat.filter(h =>
        (h.text || "").toLowerCase().includes(searchQuery) ||
        (h.type === "page-note" && "page note".includes(searchQuery)) ||
        (getComments(h).some(c => c.text.toLowerCase().includes(searchQuery))) ||
        h.url.toLowerCase().includes(searchQuery) ||
        (h.title && h.title.toLowerCase().includes(searchQuery)) ||
        (h.label && h.label.toLowerCase().includes(searchQuery))
      );
    }

    // Sort newest first
    flat.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return flat;
  }

  function groupByDomain(flat) {
    const groups = {};
    for (const h of flat) {
      let domain;
      try { domain = new URL(h.url).hostname; } catch { domain = "unknown"; }
      if (!groups[domain]) groups[domain] = [];
      groups[domain].push(h);
    }
    return groups;
  }

  function groupByDate(flat) {
    const groups = {};
    for (const h of flat) {
      const date = new Date(h.createdAt).toLocaleDateString("en-US", {
        year: "numeric", month: "long", day: "numeric"
      });
      if (!groups[date]) groups[date] = [];
      groups[date].push(h);
    }
    return groups;
  }

  function renderGrouped(flat, groups) {
    return Object.entries(groups).map(([label, items]) => `
      <div class="group-header">
        <h3>${label}</h3>
        <span class="group-count">${items.length} highlight${items.length !== 1 ? "s" : ""}</span>
      </div>
      ${items.map(h => cardHTML(h)).join("")}
    `).join("");
  }

  const SVG_LOCK_SM = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;

  const SVG_PAGE_NOTE = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/></svg>`;

  function cardHTML(h) {
    const isPageNote = h.type === "page-note";
    const date = new Date(h.createdAt).toLocaleString();
    const colorClass = (!isPageNote && h.color && h.color !== "yellow") ? ` color-${h.color}` : "";
    const checked = selectedIds.has(h.id) ? " checked" : "";
    const selectedClass = selectedIds.has(h.id) ? " selected" : "";
    const safeUrl = escapeAttr(h.url);
    const safeTitle = escapeHTML(h.title || h.url);
    const deletable = canDeleteHighlight(h);

    const cloudBadge = h._cloud
      ? `<span class="card-cloud-badge" title="Synced from cloud">${SVG_CLOUD_SM} shared</span>`
      : "";

    const accessBadge = !deletable
      ? `<span class="card-readonly-badge" title="Read-only — your role cannot delete this">${SVG_LOCK_SM} read-only</span>`
      : "";

    const authorChip = h._authorName
      ? `<span class="card-author">${avatarHTML(h._authorName, 14)} ${escapeHTML(h._authorName)}</span>`
      : "";

    const labelChip = h.label
      ? (() => {
          const lb = cachedLabels[h.label];
          const lbName = lb ? escapeHTML(lb.name) : escapeHTML(h.label);
          const lbColor = lb ? lb.color : "#71717a";
          return `<span class="card-label" style="--lb-color:${lbColor}"><span class="card-label-dot" style="background:${lbColor}"></span>${lbName}</span>`;
        })()
      : "";

    const textContent = isPageNote
      ? `<span class="card-page-note-badge">${SVG_PAGE_NOTE} Page Note</span>`
      : escapeHTML(h.text);

    return `
      <div class="highlight-card${selectedClass}${!deletable ? " readonly" : ""}${isPageNote ? " page-note-card" : ""}" data-id="${escapeAttr(h.id)}" data-url="${safeUrl}" data-deletable="${deletable}">
        <input type="checkbox" class="card-checkbox"${checked} />
        <div class="card-body">
          <div class="card-text${colorClass}">${textContent}</div>
          ${renderCommentsPreview(h)}
          <div class="card-meta">
            <a href="${safeUrl}" target="_blank" title="${safeUrl}">${safeTitle}</a>
            <span>${date}</span>
            ${labelChip}
            ${authorChip}
            ${cloudBadge}
            ${accessBadge}
          </div>
        </div>
        <div class="card-actions">
          <button class="card-action-btn" data-action="copy-link" title="Copy link">${SVG_COPY}</button>
          ${deletable ? `<button class="card-action-btn" data-action="delete" title="Delete">${SVG_TRASH}</button>` : ""}
          <button class="card-action-btn" data-action="visit" title="Visit page">${SVG_LINK}</button>
        </div>
      </div>
    `;
  }

  function renderCommentsPreview(h) {
    const comments = getComments(h);
    if (comments.length === 0) return "";
    const sorted = [...comments].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const latest = sorted[0];
    const authorName = escapeHTML(latest.author || "Anonymous");
    const preview = escapeHTML(latest.text.length > 80 ? latest.text.slice(0, 80) + "…" : latest.text);
    const countBadge = comments.length > 1 ? `<span class="card-comment-count">${comments.length} comments</span>` : "";
    return `<div class="card-comments-preview">
      <span class="card-comment-latest">${avatarHTML(latest.author || "Anonymous", 12)} <strong>${authorName}</strong>: ${preview}</span>
      ${countBadge}
    </div>`;
  }

  function wireCardEvents(container) {
    container.querySelectorAll(".highlight-card").forEach(card => {
      const id = card.dataset.id;
      const url = card.dataset.url;

      // Checkbox
      card.querySelector(".card-checkbox").addEventListener("change", (e) => {
        if (e.target.checked) selectedIds.add(id);
        else selectedIds.delete(id);
        card.classList.toggle("selected", e.target.checked);
        updateDeleteBtn();
      });

      // Actions
      card.querySelectorAll(".card-action-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          if (btn.dataset.action === "delete") {
            deleteHighlight(url, id);
          } else if (btn.dataset.action === "visit") {
            window.open(url, "_blank");
          } else if (btn.dataset.action === "copy-link") {
            navigator.clipboard.writeText(url).then(() => toast("Link copied!"));
          }
        });
      });
    });
  }

  /* ════════════════════════════════════════════
     SELECTION & DELETION
     ════════════════════════════════════════════ */
  function toggleSelectAll() {
    const cards = document.querySelectorAll(".highlight-card");
    const allSelected = [...cards].every(c => selectedIds.has(c.dataset.id));
    cards.forEach(c => {
      const id = c.dataset.id;
      if (allSelected) {
        selectedIds.delete(id);
        c.classList.remove("selected");
        c.querySelector(".card-checkbox").checked = false;
      } else {
        selectedIds.add(id);
        c.classList.add("selected");
        c.querySelector(".card-checkbox").checked = true;
      }
    });
    updateDeleteBtn();
  }

  function updateDeleteBtn() {
    const btn = document.getElementById("btnDeleteSelected");
    if (selectedIds.size === 0) {
      btn.disabled = true;
      btn.textContent = "Delete Selected";
      return;
    }
    const selectedCards = document.querySelectorAll(".highlight-card.selected");
    const deletableCount = [...selectedCards].filter(c => c.dataset.deletable === "true").length;
    const readonlyCount = selectedIds.size - deletableCount;

    if (deletableCount === 0) {
      btn.disabled = true;
      btn.textContent = `Read-only (${readonlyCount})`;
    } else {
      btn.disabled = false;
      btn.textContent = readonlyCount > 0
        ? `Delete ${deletableCount} (${readonlyCount} read-only)`
        : `Delete Selected (${deletableCount})`;
    }
  }

  function deleteHighlight(url, id) {
    if (!allData[url]) return;
    const h = allData[url].find(h => h.id === id);
    if (h && !canDeleteHighlight(h)) {
      toast("Cannot delete — read-only");
      return;
    }
    
    // Also delete from cloud if connected and has permission
    if (h && h._cloud && cloudRole === "editor") {
      chrome.runtime.sendMessage({ action: "delete-cloud-highlight", url, id });
    }
    
    allData[url] = allData[url].filter(h => h.id !== id);
    if (allData[url].length === 0) delete allData[url];
    selectedIds.delete(id);
    saveAndRender();
  }

  function deleteSelected() {
    if (selectedIds.size === 0) return;
    const deletableIds = new Set();
    const cloudDeletes = []; // track cloud highlights to delete
    
    for (const url of Object.keys(allData)) {
      for (const h of allData[url]) {
        if (selectedIds.has(h.id) && canDeleteHighlight(h)) {
          deletableIds.add(h.id);
          if (h._cloud && cloudRole === "editor") {
            cloudDeletes.push({ url, id: h.id });
          }
        }
      }
    }
    if (deletableIds.size === 0) {
      toast("No deletable items selected");
      return;
    }
    
    // Delete from cloud
    for (const { url, id } of cloudDeletes) {
      chrome.runtime.sendMessage({ action: "delete-cloud-highlight", url, id });
    }
    
    for (const url of Object.keys(allData)) {
      allData[url] = allData[url].filter(h => !deletableIds.has(h.id));
      if (allData[url].length === 0) delete allData[url];
    }
    selectedIds.clear();
    saveAndRender();
    toast(`Deleted ${deletableIds.size} annotation${deletableIds.size !== 1 ? "s" : ""}!`);
  }

  function saveAndRender() {
    try {
      chrome.runtime.sendMessage({ action: "save-highlights", payload: allData }, () => {
        if (chrome.runtime.lastError) {
          console.warn("Save error:", chrome.runtime.lastError.message);
        }
        render();
      });
    } catch (e) {
      console.error("saveAndRender failed:", e);
      // Still render even if save fails, so the UI reflects the local state
      render();
    }
  }

  /* ════════════════════════════════════════════
     MARKDOWN HARVESTER
     ════════════════════════════════════════════ */
  function harvestMarkdown() {
    const flat = getFlatHighlights();
    if (flat.length === 0) { toast("No highlights to harvest!"); return; }

    const grouped = groupByDomain(flat);
    let md = `# Vantage — Harvested Notes\n`;
    md += `> Exported on ${new Date().toLocaleString()}\n\n`;
    md += `---\n\n`;

    for (const [domain, items] of Object.entries(grouped)) {
      md += `## ${domain}\n\n`;

      // Sub-group by page
      const byPage = {};
      for (const h of items) {
        const key = h.title || h.url;
        if (!byPage[key]) byPage[key] = { url: h.url, items: [] };
        byPage[key].items.push(h);
      }

      for (const [pageTitle, { url, items: pageItems }] of Object.entries(byPage)) {
        md += `### [${pageTitle}](${url})\n\n`;
        for (const h of pageItems) {
          md += `> ${h.text}\n\n`;
          const hComments = getComments(h);
          if (hComments.length > 0) {
            for (const c of hComments) {
              md += `**${c.author || "Anonymous"}** (${new Date(c.createdAt).toLocaleString()}): *${c.text}*\n\n`;
            }
          }
          md += `<sub>${new Date(h.createdAt).toLocaleString()}</sub>\n\n`;
        }
        md += `---\n\n`;
      }
    }

    document.getElementById("mdOutput").value = md;
    document.getElementById("mdModal").classList.add("visible");
  }

  /* ════════════════════════════════════════════
     P2P KNOWLEDGE PACKS
     ════════════════════════════════════════════ */
  function exportPack() {
    let dataToExport = {};

    if (selectedIds.size > 0) {
      // Export only selected
      for (const url of Object.keys(allData)) {
        const filtered = allData[url].filter(h => selectedIds.has(h.id));
        if (filtered.length > 0) dataToExport[url] = filtered;
      }
    } else if (filterDomain) {
      // Export current domain filter
      for (const url of Object.keys(allData)) {
        try {
          if (new URL(url).hostname === filterDomain) {
            dataToExport[url] = allData[url];
          }
        } catch { /* skip */ }
      }
    } else {
      dataToExport = allData;
    }

    if (Object.keys(dataToExport).length === 0) {
      toast("Nothing to export!");
      return;
    }

    const pack = {
      _format: "vantage-pack",
      _version: "1.0",
      _exportedAt: new Date().toISOString(),
      _author: "anonymous",
      highlights: dataToExport
    };

    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const label = selectedIds.size > 0
      ? `pack-selected-${selectedIds.size}`
      : filterDomain
        ? `pack-${filterDomain}`
        : "pack-all";
    a.download = `vantage-${label}-${Date.now()}.cscribe`;
    a.click();
    URL.revokeObjectURL(a.href);

    const count = Object.values(dataToExport).reduce((s, arr) => s + arr.length, 0);
    toast(`Exported ${count} highlights!`);
  }

  function importPack(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const raw = JSON.parse(ev.target.result);
        let packData;

        if ((raw._format === "vantage-pack" || raw._format === "context-scribe-pack") && raw.highlights) {
          packData = raw.highlights;
        } else if (typeof raw === "object" && !Array.isArray(raw)) {
          // Plain { url: [highlights] } format
          packData = raw;
        } else {
          toast("Invalid pack file!");
          return;
        }

        chrome.runtime.sendMessage({ action: "import-pack", payload: packData }, () => {
          loadData();
          toast("Pack imported successfully!");
        });
      } catch {
        toast("Failed to parse pack file!");
      }
    };
    reader.readAsText(file);
    e.target.value = ""; // reset
  }

  /* ════════════════════════════════════════════
     ROOM VIEW
     ════════════════════════════════════════════ */
  function renderRoomView(content) {
    if (!selectedRoom) return;
    const title = document.getElementById("viewTitle");
    title.textContent = selectedRoom.packName || selectedRoom.packKey;

    content.innerHTML = `<div class="room-view-loading">Loading room highlights…</div>`;

    chrome.runtime.sendMessage(
      { action: "get-room-labels", firebaseUrl: selectedRoom.firebaseUrl, packKey: selectedRoom.packKey },
      (labels) => { cachedLabels = labels || {}; }
    );

    chrome.runtime.sendMessage(
      { action: "get-room-highlights", firebaseUrl: selectedRoom.firebaseUrl, packKey: selectedRoom.packKey },
      (data) => {
        roomHighlights = data || {};
        renderFilterBar();

        // Flatten into filterable array
        let flat = [];
        for (const urlHash of Object.keys(roomHighlights)) {
          const decodedUrl = decodeUrlKey(urlHash);
          const hls = roomHighlights[urlHash];
          if (!hls || typeof hls !== "object") continue;
          for (const [id, hl] of Object.entries(hls)) {
            flat.push({ ...hl, _id: id, _url: decodedUrl });
          }
        }

        // Apply active filters
        if (filterLabel) flat = flat.filter(h => h.label === filterLabel);
        if (filterAuthor) flat = flat.filter(h => h._authorName === filterAuthor);
        if (filterRoomDomain) {
          flat = flat.filter(h => {
            try { return new URL(h._url).hostname === filterRoomDomain; } catch { return false; }
          });
        }
        if (searchQuery) {
          flat = flat.filter(h =>
            (h.text || "").toLowerCase().includes(searchQuery) ||
            (h.type === "page-note" && "page note".includes(searchQuery)) ||
            getComments(h).some(c => c.text.toLowerCase().includes(searchQuery)) ||
            h._url.toLowerCase().includes(searchQuery)
          );
        }

        const hasActiveFilters = filterLabel || filterAuthor || filterRoomDomain || searchQuery;

        if (flat.length === 0) {
          content.innerHTML = renderRoomHeader() + `<div class="empty-state"><div class="empty-icon">${SVG_HIGHLIGHTER}</div><h3>${hasActiveFilters ? "No matching highlights" : "No highlights in this room"}</h3><p>${hasActiveFilters ? "Try adjusting your filters." : "Highlights made in this room will appear here."}</p></div>`;
          wireRoomSettings(content);
          return;
        }

        // Sort newest first, then group by URL
        flat.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const grouped = {};
        for (const h of flat) {
          if (!grouped[h._url]) grouped[h._url] = [];
          grouped[h._url].push(h);
        }

        let html = renderRoomHeader();

        for (const [pageUrl, items] of Object.entries(grouped)) {
          const safeUrl = escapeAttr(pageUrl);
          html += `<div class="group-header"><h3><a href="${safeUrl}" target="_blank" class="room-group-link">${escapeHTML(pageUrl)}</a></h3><span class="group-count">${items.length}</span></div>`;
          for (const hl of items) {
            const date = hl.createdAt ? new Date(hl.createdAt).toLocaleString() : "";
            const authorChip = hl._authorName
              ? `<span class="card-author">${avatarHTML(hl._authorName, 14)} ${escapeHTML(hl._authorName)}</span>`
              : "";
            const roomLabelChip = hl.label
              ? (() => {
                  const lb = cachedLabels[hl.label];
                  const lbName = lb ? escapeHTML(lb.name) : escapeHTML(hl.label);
                  const lbColor = lb ? lb.color : "#71717a";
                  return `<span class="card-label" style="--lb-color:${lbColor}"><span class="card-label-dot" style="background:${lbColor}"></span>${lbName}</span>`;
                })()
              : "";
            const isPN = hl.type === "page-note";
            const textContent = isPN
              ? `<span class="card-page-note-badge">${SVG_PAGE_NOTE} Page Note</span>`
              : escapeHTML(hl.text || "");
            html += `
              <div class="highlight-card room-card${isPN ? " page-note-card" : ""}" data-id="${escapeAttr(hl._id)}" data-url="${safeUrl}">
                <div class="card-body">
                  <div class="card-text">${textContent}</div>
                  ${renderCommentsPreview(hl)}
                  <div class="card-meta">
                    <a href="${safeUrl}" target="_blank" title="${safeUrl}">${escapeHTML(pageUrl)}</a>
                    ${roomLabelChip}
                    ${authorChip}
                    <span>${date}</span>
                  </div>
                </div>
                <div class="card-actions">
                  <button class="card-action-btn" data-action="copy-link" title="Copy link">${SVG_COPY}</button>
                  <button class="card-action-btn" data-action="visit" title="Visit page">${SVG_LINK}</button>
                </div>
              </div>
            `;
          }
        }

        content.innerHTML = html;
        wireRoomSettings(content);
        wireRoomCardActions(content);
      }
    );
  }

  function wireRoomCardActions(container) {
    container.querySelectorAll(".room-card .card-action-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const card = btn.closest(".highlight-card");
        const url = card.dataset.url;
        if (btn.dataset.action === "visit") {
          window.open(url, "_blank");
        } else if (btn.dataset.action === "copy-link") {
          navigator.clipboard.writeText(url).then(() => toast("Link copied!"));
        }
      });
    });
  }

  const SVG_SETTINGS = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`;
  const SVG_CHEVRON = `<svg class="room-accordion-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
  const SVG_KEY = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`;

  function renderRoomHeader() {
    const room = selectedRoom;
    const isEditor = room.role === "editor";
    const roleColors = { viewer: "#868e96", commentor: "#51cf66", editor: "#ffe066" };
    const roleColor = roleColors[room.role] || "#868e96";

    let settingsHTML = "";
    if (isEditor) {
      settingsHTML = `
        <div class="room-accordion">
          <button class="room-accordion-toggle" id="toggleSettings">
            <span class="room-accordion-left">${SVG_SETTINGS} Settings</span>
            ${SVG_CHEVRON}
          </button>
          <div class="room-accordion-body" id="roomSettingsBody" style="display:none">
            <div class="room-settings-row room-settings-danger-zone">
              <label>Delete room</label>
              <p class="room-delete-lead">Remove this room from Firebase for everyone. Only available on this browser if you <strong>created</strong> the room here or <strong>joined with the master room key</strong> (the CS-… code).</p>
              <p class="room-delete-hint" id="deleteRoomHint">You don’t have owner rights on this profile for this room. Use the browser where you created it or re-join using the master key once to enable delete.</p>
              <button type="button" class="room-settings-btn danger" id="btnDeleteRoom">Delete room</button>
            </div>
            <div class="room-settings-row">
              <label>Room Name</label>
              <div class="room-settings-inline">
                <input type="text" id="roomNameInput" class="room-settings-input" value="${escapeAttr(room.packName || "")}" />
                <button class="room-settings-btn" id="btnSaveRoomName">Save</button>
              </div>
            </div>
            <div class="room-settings-row">
              <label>Default Role</label>
              <select id="roomDefaultRole" class="room-settings-select">
                <option value="viewer">Viewer (read only)</option>
                <option value="commentor">Commentor (annotate)</option>
                <option value="editor">Editor (full access)</option>
              </select>
            </div>
            <div class="room-settings-row">
              <label>Labels</label>
              <p class="label-help" id="labelHelp"></p>
              <button type="button" class="room-settings-btn secondary" id="btnStarterLabels">Add starter labels</button>
              <div class="label-manager" id="labelManager">
                <div class="label-list" id="labelList"></div>
                <div class="label-add-row">
                  <input type="text" id="newLabelName" class="room-settings-input" placeholder="Label name" />
                  <input type="color" id="newLabelColor" class="label-color-picker" value="#3b82f6" />
                  <button class="room-settings-btn" id="btnAddLabel">Add</button>
                </div>
              </div>
            </div>
            <div class="room-settings-row">
              <label>Access Keys</label>
              <div class="key-manager" id="keyManager">
                <div class="key-list" id="keyList"></div>
                <div class="key-add-row">
                  <select id="newKeyRole" class="room-settings-select key-role-select">
                    <option value="viewer">Viewer</option>
                    <option value="commentor">Commentor</option>
                    <option value="editor">Editor</option>
                  </select>
                  <button class="room-settings-btn" id="btnAddKey">${SVG_KEY} Add Key</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    return `
      <div class="room-header">
        <div class="room-header-top">
          <div class="room-header-info">
            <span class="room-header-name">${escapeHTML(room.packName || room.packKey)}</span>
            <code class="room-header-key">${escapeHTML(room.packKey)}</code>
            <span class="room-header-role" style="color:${roleColor};border-color:${roleColor}">${room.role}</span>
          </div>
          <div class="room-header-viewers" id="roomViewPresence"></div>
        </div>
        ${settingsHTML}
      </div>
    `;
  }

  function wireRoomSettings(container) {
    if (!selectedRoom) return;

    loadRoomViewPresence();

    // Accordion toggle
    const toggleBtn = container.querySelector("#toggleSettings");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        const body = container.querySelector("#roomSettingsBody");
        const open = body.style.display !== "none";
        body.style.display = open ? "none" : "";
        toggleBtn.classList.toggle("open", !open);
      });
    }

    const saveBtn = container.querySelector("#btnSaveRoomName");
    if (saveBtn) {
      saveBtn.addEventListener("click", () => {
        const input = container.querySelector("#roomNameInput");
        const newName = input.value.trim();
        if (!newName) return;
        saveBtn.textContent = "…";
        chrome.runtime.sendMessage({
          action: "update-room-name",
          firebaseUrl: selectedRoom.firebaseUrl,
          packKey: selectedRoom.packKey,
          newName,
        }, (resp) => {
          saveBtn.textContent = "Save";
          if (resp?.ok) {
            selectedRoom.packName = newName;
            toast("Room name updated!");
            loadCloudStatus();
          } else {
            toast(resp?.error || "Failed to update name");
          }
        });
      });
    }

    const roleSelect = container.querySelector("#roomDefaultRole");
    if (roleSelect) {
      const metaUrl = `${selectedRoom.firebaseUrl}/packs/${selectedRoom.packKey}/meta.json`;
      fetch(metaUrl).then(r => r.json()).then(meta => {
        if (meta && meta.defaultRole) roleSelect.value = meta.defaultRole;
      }).catch(() => {});
      roleSelect.addEventListener("change", () => {
        const newRole = roleSelect.value;
        chrome.runtime.sendMessage({
          action: "set-default-role",
          role: newRole,
          firebaseUrl: selectedRoom.firebaseUrl,
          packKey: selectedRoom.packKey,
        }, (resp) => {
          if (resp?.ok) toast("Default role updated to " + newRole);
          else toast(resp?.error || "Failed to update role");
        });
      });
    }

    if (container.querySelector("#labelList")) {
      loadAndRenderLabels(container);
    }

    if (container.querySelector("#keyList")) {
      loadAndRenderKeys(container);
    }

    const deleteBtn = container.querySelector("#btnDeleteRoom");
    const deleteHint = container.querySelector("#deleteRoomHint");
    if (deleteBtn && selectedRoom) {
      chrome.storage.local.get("roomCreatorRegistry", (data) => {
        const reg = data.roomCreatorRegistry || {};
        const creator = !!reg[roomOwnerRegistryKey(selectedRoom.firebaseUrl, selectedRoom.packKey)];
        deleteBtn.disabled = !creator;
        deleteBtn.title = creator
          ? "Permanently delete this room for everyone"
          : "Owner only: create the room on this browser or join once with the master CS-… key";
        if (deleteHint) deleteHint.style.display = creator ? "none" : "block";
      });
      deleteBtn.onclick = () => {
        if (deleteBtn.disabled) return;
        if (!confirm(`Delete room "${selectedRoom.packName || selectedRoom.packKey}"? This cannot be undone for everyone.`)) return;
        deleteBtn.textContent = "Deleting…";
        deleteBtn.disabled = true;
        chrome.runtime.sendMessage(
          {
            action: "delete-room",
            firebaseUrl: selectedRoom.firebaseUrl,
            packKey: selectedRoom.packKey,
          },
          (resp) => {
            if (resp?.ok) {
              toast("Room deleted!");
              afterRoomDeleted(selectedRoom.packKey);
            } else {
              deleteBtn.textContent = "Delete room";
              deleteBtn.disabled = false;
              chrome.storage.local.get("roomCreatorRegistry", (d) => {
                const reg = d.roomCreatorRegistry || {};
                deleteBtn.disabled = !reg[roomOwnerRegistryKey(selectedRoom.firebaseUrl, selectedRoom.packKey)];
              });
              toast(resp?.error || "Failed to delete room");
            }
          }
        );
      };
    }
  }

  function loadAndRenderKeys(container) {
    if (!selectedRoom) return;
    chrome.runtime.sendMessage(
      { action: "get-room-keys", firebaseUrl: selectedRoom.firebaseUrl, packKey: selectedRoom.packKey },
      (keys) => {
        const roomKeys = keys || {};
        const listEl = container.querySelector("#keyList");
        if (!listEl) return;

        const roleColors = { viewer: "#868e96", commentor: "#51cf66", editor: "#ffe066" };

        // Always show master key first
        let html = `<div class="key-item key-item-master">
          <div class="key-item-info">
            <code class="key-item-code">${escapeHTML(selectedRoom.packKey)}</code>
            <span class="key-item-role" style="color:${roleColors.editor}">editor</span>
            <span class="key-item-tag">master</span>
          </div>
          <div class="key-item-actions">
            <button class="key-copy-btn" data-key="${escapeAttr(selectedRoom.packKey)}" title="Copy key">${SVG_COPY}</button>
          </div>
        </div>`;

        for (const [k, v] of Object.entries(roomKeys)) {
          const rc = roleColors[v.role] || "#868e96";
          html += `<div class="key-item" data-key-id="${escapeAttr(k)}">
            <div class="key-item-info">
              <code class="key-item-code">${escapeHTML(k)}</code>
              <span class="key-item-role" style="color:${rc}">${escapeHTML(v.role)}</span>
              ${v.label ? `<span class="key-item-label">${escapeHTML(v.label)}</span>` : ""}
            </div>
            <div class="key-item-actions">
              <button class="key-copy-btn" data-key="${escapeAttr(k)}" title="Copy key">${SVG_COPY}</button>
              <button class="key-delete-btn" data-key="${escapeAttr(k)}" title="Delete key">${SVG_TRASH}</button>
            </div>
          </div>`;
        }

        listEl.innerHTML = html;

        listEl.querySelectorAll(".key-copy-btn").forEach(btn => {
          btn.addEventListener("click", () => {
            navigator.clipboard.writeText(btn.dataset.key).then(() => toast("Key copied!"));
          });
        });

        listEl.querySelectorAll(".key-delete-btn").forEach(btn => {
          btn.addEventListener("click", () => {
            const key = btn.dataset.key;
            if (!confirm(`Delete invite key ${key}?`)) return;
            chrome.runtime.sendMessage({
              action: "delete-room-key",
              firebaseUrl: selectedRoom.firebaseUrl,
              packKey: selectedRoom.packKey,
              key,
            }, (resp) => {
              if (resp?.ok) {
                toast("Key deleted");
                loadAndRenderKeys(container);
              } else {
                toast(resp?.error || "Failed to delete key");
              }
            });
          });
        });

        const addBtn = container.querySelector("#btnAddKey");
        const roleSelect = container.querySelector("#newKeyRole");
        if (addBtn && !addBtn._wired) {
          addBtn._wired = true;
          addBtn.addEventListener("click", () => {
            const role = roleSelect.value;
            addBtn.disabled = true;
            addBtn.textContent = "Creating…";
            chrome.runtime.sendMessage({
              action: "add-room-key",
              firebaseUrl: selectedRoom.firebaseUrl,
              packKey: selectedRoom.packKey,
              role,
            }, (resp) => {
              addBtn.disabled = false;
              addBtn.innerHTML = `${SVG_KEY} Add Key`;
              if (resp?.ok) {
                toast(`Key created: ${resp.key}`);
                loadAndRenderKeys(container);
              } else {
                toast(resp?.error || "Failed to create key");
              }
            });
          });
        }
      }
    );
  }

  function loadAndRenderLabels(container) {
    if (!selectedRoom) return;
    chrome.runtime.sendMessage(
      { action: "get-room-labels", firebaseUrl: selectedRoom.firebaseUrl, packKey: selectedRoom.packKey },
      (labels) => {
        const roomLabels = labels || {};
        cachedLabels = roomLabels;
        const listEl = container.querySelector("#labelList");
        if (!listEl) return;

        const helpEl = container.querySelector("#labelHelp");
        if (helpEl) {
          helpEl.textContent = Object.keys(roomLabels).length === 0
            ? "No labels: highlights use free colors only. Add custom labels or use “Add starter labels” (Info, Bug, Question, …)."
            : "Highlighting uses only these labels; each maps to a color. Remove all labels to switch back to free colors.";
        }

        const starterBtn = container.querySelector("#btnStarterLabels");
        if (starterBtn && !starterBtn._wired) {
          starterBtn._wired = true;
          starterBtn.addEventListener("click", () => {
            chrome.runtime.sendMessage({ action: "get-starter-labels" }, (starter) => {
              if (chrome.runtime.lastError || !starter) {
                toast("Could not load starter labels");
                return;
              }
              chrome.runtime.sendMessage(
                {
                  action: "get-room-labels",
                  firebaseUrl: selectedRoom.firebaseUrl,
                  packKey: selectedRoom.packKey,
                },
                (current) => {
                  const cur = current && typeof current === "object" ? current : {};
                  const merged = { ...starter, ...cur };
                  saveRoomLabels(merged, () => loadAndRenderLabels(container));
                }
              );
            });
          });
        }

        listEl.innerHTML = Object.entries(roomLabels).map(([id, lb]) =>
          `<div class="label-item" data-label-id="${escapeAttr(id)}">
            <span class="label-item-dot" style="background:${lb.color}"></span>
            <span class="label-item-name">${escapeHTML(lb.name)}</span>
            <button class="label-item-delete" title="Remove label">&times;</button>
          </div>`
        ).join("") || '<span class="label-empty">No labels defined</span>';

        listEl.querySelectorAll(".label-item-delete").forEach(btn => {
          btn.addEventListener("click", () => {
            const item = btn.closest(".label-item");
            const id = item.dataset.labelId;
            delete roomLabels[id];
            saveRoomLabels(roomLabels, () => {
              loadAndRenderLabels(container);
            });
          });
        });

        const addBtn = container.querySelector("#btnAddLabel");
        const nameInput = container.querySelector("#newLabelName");
        const colorInput = container.querySelector("#newLabelColor");
        if (addBtn && !addBtn._wired) {
          addBtn._wired = true;
          addBtn.addEventListener("click", () => {
            const name = nameInput.value.trim();
            if (!name) { nameInput.focus(); return; }
            const color = colorInput.value;
            const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
            if (!id) return;
            roomLabels[id] = { name, color };
            nameInput.value = "";
            saveRoomLabels(roomLabels, () => {
              loadAndRenderLabels(container);
            });
          });
        }
      }
    );
  }

  function saveRoomLabels(labels, callback) {
    if (!selectedRoom) return;
    chrome.runtime.sendMessage({
      action: "set-room-labels",
      firebaseUrl: selectedRoom.firebaseUrl,
      packKey: selectedRoom.packKey,
      labels,
    }, (resp) => {
      if (resp?.ok) {
        cachedLabels = labels;
        toast("Labels updated!");
      } else {
        toast("Failed to save labels");
      }
      if (callback) callback();
    });
  }

  function loadRoomViewPresence() {
    if (!selectedRoom) return;
    chrome.runtime.sendMessage(
      { action: "get-room-presence", firebaseUrl: selectedRoom.firebaseUrl, packKey: selectedRoom.packKey },
      (viewers) => {
        const el = document.getElementById("roomViewPresence");
        if (!el) return;
        const entries = viewers ? Object.values(viewers) : [];
        if (entries.length === 0) {
          el.innerHTML = '<span class="room-presence-empty">No one online</span>';
          return;
        }
        el.innerHTML = entries.map(v =>
          `<span class="dash-viewer-chip">${avatarHTML(v.name, 14)}${escapeHTML(v.name || "Anonymous")}</span>`
        ).join("");
      }
    );
  }

  function decodeUrlKey(hash) {
    try {
      let b64 = hash.replace(/-/g, "+").replace(/_/g, "/");
      const pad = b64.length % 4;
      if (pad) b64 += "=".repeat(4 - pad);
      return decodeURIComponent(escape(atob(b64)));
    } catch {
      return hash;
    }
  }

  /* ════════════════════════════════════════════
     UTILITIES
     ════════════════════════════════════════════ */
  function escapeHTML(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function createEmptyState() {
    const el = document.createElement("div");
    el.className = "empty-state";
    el.id = "emptyState";
    el.innerHTML = `
      <div class="empty-icon">${SVG_HIGHLIGHTER}</div>
      <h3>No annotations yet</h3>
      <p>Start annotating text on any webpage to build your shared POV.<br/>Use <kbd>Alt+H</kbd> or right-click to annotate.</p>
    `;
    return el;
  }

  function toast(message) {
    const existing = document.querySelector(".toast");
    if (existing) existing.remove();
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }

})();
