/* ─────────────────────────────────────────────
   Vantage — Dashboard Script
   Full-screen management: view, group, search,
   harvest markdown, export/import packs
   ───────────────────────────────────────────── */

(() => {
  "use strict";

  let allData = {};          // { url: [highlights] }
  let currentView = "domain"; // domain | date | all | room
  let filterDomain = null;
  let searchQuery = "";
  let selectedIds = new Set();
  let cloudRole = null;      // null = no cloud, "viewer" | "commentor" | "editor"
  let activeCloudConfig = null;
  let selectedRoom = null;   // { firebaseUrl, packKey, packName, role }
  let roomHighlights = {};   // fetched from Firebase for the selected room

  const NAME_COLOR_HEX = {
    Amber: "#f59e0b", Azure: "#3b82f6", Coral: "#f97316", Cyan: "#06b6d4",
    Ember: "#ef4444", Jade: "#10b981", Lime: "#84cc16", Mint: "#34d399",
    Navy: "#1e40af", Onyx: "#71717a", Pearl: "#e2e8f0", Rose: "#f43f5e",
    Ruby: "#dc2626", Sage: "#94a3b8", Slate: "#64748b", Teal: "#14b8a6",
    Violet: "#8b5cf6", Zinc: "#a1a1aa",
  };

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
      list.innerHTML = history.map(r => {
        const isActive = r.packKey === activeKey;
        const isSelected = selectedRoom && selectedRoom.packKey === r.packKey;
        return `
          <div class="room-item${isActive ? " room-active" : ""}${isSelected ? " room-selected" : ""}"
               data-key="${escapeAttr(r.packKey)}" data-url="${escapeAttr(r.firebaseUrl)}"
               data-name="${escapeAttr(r.packName || r.packKey)}" data-role="${escapeAttr(r.role || "viewer")}">
            <div class="room-item-info">
              <span class="room-item-name">${escapeHTML(r.packName || r.packKey)}</span>
              <code class="room-item-key">${escapeHTML(r.packKey)}</code>
            </div>
            <div class="room-item-meta">
              <span class="room-item-role role-${r.role || "viewer"}">${r.role || "viewer"}</span>
              ${isActive ? '<span class="room-item-live"></span>' : ""}
            </div>
          </div>
        `;
      }).join("");

      list.querySelectorAll(".room-item").forEach(item => {
        item.addEventListener("click", () => {
          selectedRoom = {
            firebaseUrl: item.dataset.url,
            packKey: item.dataset.key,
            packName: item.dataset.name,
            role: item.dataset.role,
          };
          currentView = "room";
          document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
          render();
          loadRoomManager(activeCloudConfig);
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
        document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentView = btn.dataset.view;
        filterDomain = null;
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
  function render() {
    updateStats();
    renderDomainList();
    renderContent();
    updateDeleteBtn();
  }

  function updateStats() {
    let totalH = 0, totalN = 0;
    const pages = Object.keys(allData);
    for (const url of pages) {
      totalH += allData[url].length;
      totalN += allData[url].filter(h => h.note).length;
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

    // Filter by search
    if (searchQuery) {
      flat = flat.filter(h =>
        h.text.toLowerCase().includes(searchQuery) ||
        (h.note && h.note.toLowerCase().includes(searchQuery)) ||
        h.url.toLowerCase().includes(searchQuery) ||
        (h.title && h.title.toLowerCase().includes(searchQuery))
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

  function cardHTML(h) {
    const date = new Date(h.createdAt).toLocaleString();
    const colorClass = h.color && h.color !== "yellow" ? ` color-${h.color}` : "";
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

    return `
      <div class="highlight-card${selectedClass}${!deletable ? " readonly" : ""}" data-id="${escapeAttr(h.id)}" data-url="${safeUrl}" data-deletable="${deletable}">
        <input type="checkbox" class="card-checkbox"${checked} />
        <div class="card-body">
          <div class="card-text${colorClass}">${escapeHTML(h.text)}</div>
          ${h.note ? `<div class="card-note">${escapeHTML(h.note)}</div>` : ""}
          <div class="card-meta">
            <a href="${safeUrl}" target="_blank" title="${safeUrl}">${safeTitle}</a>
            <span>${date}</span>
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
    allData[url] = allData[url].filter(h => h.id !== id);
    if (allData[url].length === 0) delete allData[url];
    selectedIds.delete(id);
    saveAndRender();
  }

  function deleteSelected() {
    if (selectedIds.size === 0) return;
    const deletableIds = new Set();
    for (const url of Object.keys(allData)) {
      for (const h of allData[url]) {
        if (selectedIds.has(h.id) && canDeleteHighlight(h)) {
          deletableIds.add(h.id);
        }
      }
    }
    if (deletableIds.size === 0) {
      toast("No deletable items selected");
      return;
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
          if (h.note) {
            md += `**Note:** *${h.note}*\n\n`;
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
      { action: "get-room-highlights", firebaseUrl: selectedRoom.firebaseUrl, packKey: selectedRoom.packKey },
      (data) => {
        roomHighlights = data || {};
        const urlHashes = Object.keys(roomHighlights);
        if (urlHashes.length === 0) {
          content.innerHTML = renderRoomHeader() + `<div class="empty-state"><div class="empty-icon">${SVG_HIGHLIGHTER}</div><h3>No highlights in this room</h3><p>Highlights made in this room will appear here.</p></div>`;
          wireRoomSettings(content);
          return;
        }

        let html = renderRoomHeader();

        for (const urlHash of urlHashes) {
          const decodedUrl = decodeUrlKey(urlHash);
          const highlights = roomHighlights[urlHash];
          if (!highlights || typeof highlights !== "object") continue;
          const entries = Object.entries(highlights);
          if (entries.length === 0) continue;

          html += `<div class="group-header"><h3>${escapeHTML(decodedUrl)}</h3><span class="group-count">${entries.length}</span></div>`;
          for (const [id, hl] of entries) {
            const date = hl.createdAt ? new Date(hl.createdAt).toLocaleString() : "";
            const authorChip = hl._authorName
              ? `${avatarHTML(hl._authorName, 14)} <span class="card-author-name">${escapeHTML(hl._authorName)}</span>`
              : "";
            html += `
              <div class="highlight-card room-card" data-id="${escapeAttr(id)}">
                <div class="card-body">
                  <div class="card-text">${escapeHTML(hl.text || "")}</div>
                  ${hl.note ? `<div class="card-note">${escapeHTML(hl.note)}</div>` : ""}
                  <div class="card-meta">
                    ${authorChip}
                    <span>${date}</span>
                  </div>
                </div>
              </div>
            `;
          }
        }

        content.innerHTML = html;
        wireRoomSettings(content);
      }
    );
  }

  function renderRoomHeader() {
    const room = selectedRoom;
    const isEditor = room.role === "editor";
    const roleColors = { viewer: "#868e96", commentor: "#51cf66", editor: "#ffe066" };
    const roleColor = roleColors[room.role] || "#868e96";

    let presenceHTML = '<div class="room-header-viewers" id="roomViewPresence"></div>';

    let settingsHTML = "";
    if (isEditor) {
      settingsHTML = `
        <div class="room-settings" id="roomSettingsPanel">
          <div class="room-settings-header">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
            Room Settings
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
              <option value="viewer"${room.role === "viewer" ? " selected" : ""}>Viewer (read only)</option>
              <option value="commentor">Commentor (annotate)</option>
              <option value="editor">Editor (full access)</option>
            </select>
          </div>
          <div class="room-settings-row">
            <button class="room-settings-btn danger" id="btnDeleteRoom">Delete Room</button>
          </div>
        </div>
      `;
    }

    return `
      <div class="room-header">
        <div class="room-header-info">
          <span class="room-header-name">${escapeHTML(room.packName || room.packKey)}</span>
          <code class="room-header-key">${escapeHTML(room.packKey)}</code>
          <span class="room-header-role" style="color:${roleColor};border-color:${roleColor}">${room.role}</span>
        </div>
        ${presenceHTML}
        ${settingsHTML}
      </div>
    `;
  }

  function wireRoomSettings(container) {
    if (!selectedRoom) return;

    loadRoomViewPresence();

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
      chrome.runtime.sendMessage(
        { action: "get-room-presence", firebaseUrl: selectedRoom.firebaseUrl, packKey: selectedRoom.packKey },
        () => {
          const metaUrl = `${selectedRoom.firebaseUrl}/packs/${selectedRoom.packKey}/meta.json`;
          fetch(metaUrl).then(r => r.json()).then(meta => {
            if (meta && meta.defaultRole) roleSelect.value = meta.defaultRole;
          }).catch(() => {});
        }
      );
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

    const deleteBtn = container.querySelector("#btnDeleteRoom");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", () => {
        if (!confirm(`Delete room "${selectedRoom.packName || selectedRoom.packKey}"? This cannot be undone.`)) return;
        deleteBtn.textContent = "Deleting…";
        chrome.runtime.sendMessage({
          action: "delete-room",
          firebaseUrl: selectedRoom.firebaseUrl,
          packKey: selectedRoom.packKey,
        }, (resp) => {
          if (resp?.ok) {
            toast("Room deleted!");
            selectedRoom = null;
            currentView = "domain";
            loadCloudStatus();
            loadData();
          } else {
            deleteBtn.textContent = "Delete Room";
            toast(resp?.error || "Failed to delete room");
          }
        });
      });
    }
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
