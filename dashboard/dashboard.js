/* ─────────────────────────────────────────────
   Context Scribe — Dashboard Script
   Full-screen management: view, group, search,
   harvest markdown, export/import packs
   ───────────────────────────────────────────── */

(() => {
  "use strict";

  let allData = {};          // { url: [highlights] }
  let currentView = "domain"; // domain | date | all
  let filterDomain = null;
  let searchQuery = "";
  let selectedIds = new Set();

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

  const SVG_SUN  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
  const SVG_MOON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
  const SVG_TRASH = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
  const SVG_COPY = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  const SVG_LINK = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
  const SVG_SCROLL = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14"/><path d="M4 19h16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`;
  const SVG_CLOUD_SM = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>`;

  function applyTheme(theme) {
    document.body.setAttribute("data-theme", theme);
    const btn = document.getElementById("themeToggle");
    if (btn) {
      btn.innerHTML = (theme === "dark" ? SVG_SUN : SVG_MOON) + `<span>${theme === "dark" ? "Light" : "Dark"}</span>`;
      btn.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
    }
  }

  function loadData() {
    chrome.runtime.sendMessage({ action: "get-all-highlights" }, (data) => {
      allData = data || {};
      render();
    });
    loadCloudStatus();
  }

  function loadCloudStatus() {
    chrome.runtime.sendMessage({ action: "get-cloud-status" }, (status) => {
      const container = document.getElementById("cloudStatusContent");
      if (!container) return;
      if (status && status.packKey) {
        container.innerHTML = `
          <div class="cloud-connected-info">
            <span class="cloud-live-dot"></span>
            <span class="cloud-pack-label">${escapeHTML(status.packName || "Cloud Pack")}</span>
          </div>
          <code class="cloud-room-key">${escapeHTML(status.packKey)}</code>
        `;
      } else {
        container.innerHTML = `<span class="cloud-offline">Not connected</span>`;
      }
    });
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
        render();
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
      a.download = `context-scribe-${new Date().toISOString().slice(0,10)}.md`;
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
    const flat = getFlatHighlights();

    if (flat.length === 0) {
      content.innerHTML = "";
      content.appendChild(createEmptyState());
      document.getElementById("viewTitle").textContent = "All Highlights";
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
      document.getElementById("viewTitle").textContent = "All Highlights";
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

  function cardHTML(h) {
    const date = new Date(h.createdAt).toLocaleString();
    const colorClass = h.color && h.color !== "yellow" ? ` color-${h.color}` : "";
    const checked = selectedIds.has(h.id) ? " checked" : "";
    const selectedClass = selectedIds.has(h.id) ? " selected" : "";
    const safeUrl = escapeAttr(h.url);
    const safeTitle = escapeHTML(h.title || h.url);

    const cloudBadge = h._cloud
      ? `<span class="card-cloud-badge" title="Synced from cloud">${SVG_CLOUD_SM} shared</span>`
      : "";

    return `
      <div class="highlight-card${selectedClass}" data-id="${escapeAttr(h.id)}" data-url="${safeUrl}">
        <input type="checkbox" class="card-checkbox"${checked} />
        <div class="card-body">
          <div class="card-text${colorClass}">${escapeHTML(h.text)}</div>
          ${h.note ? `<div class="card-note">${escapeHTML(h.note)}</div>` : ""}
          <div class="card-meta">
            <a href="${safeUrl}" target="_blank" title="${safeUrl}">${safeTitle}</a>
            <span>${date}</span>
            ${cloudBadge}
          </div>
        </div>
        <div class="card-actions">
          <button class="card-action-btn" data-action="copy-link" title="Copy link">${SVG_COPY}</button>
          <button class="card-action-btn" data-action="delete" title="Delete">${SVG_TRASH}</button>
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
    btn.disabled = selectedIds.size === 0;
    btn.textContent = selectedIds.size > 0
      ? `Delete Selected (${selectedIds.size})`
      : "Delete Selected";
  }

  function deleteHighlight(url, id) {
    if (!allData[url]) return;
    allData[url] = allData[url].filter(h => h.id !== id);
    if (allData[url].length === 0) delete allData[url];
    selectedIds.delete(id);
    saveAndRender();
  }

  function deleteSelected() {
    if (selectedIds.size === 0) return;
    const count = selectedIds.size;
    for (const url of Object.keys(allData)) {
      allData[url] = allData[url].filter(h => !selectedIds.has(h.id));
      if (allData[url].length === 0) delete allData[url];
    }
    selectedIds.clear();
    saveAndRender();
    toast(`Deleted ${count} highlight${count !== 1 ? "s" : ""}!`);
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
    let md = `# Context Scribe — Harvested Notes\n`;
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
      _format: "context-scribe-pack",
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
    a.download = `context-scribe-${label}-${Date.now()}.cscribe`;
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

        if (raw._format === "context-scribe-pack" && raw.highlights) {
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
      <div class="empty-icon">${SVG_SCROLL}</div>
      <h3>No highlights yet</h3>
      <p>Start highlighting text on any webpage to see it here.<br/>Use <kbd>Alt+H</kbd> or right-click → Highlight.</p>
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
