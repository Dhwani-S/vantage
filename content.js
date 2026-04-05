/* ─────────────────────────────────────────────
   Vantage — Content Script
   Overlay layer for web annotations
   ───────────────────────────────────────────── */

(() => {
  "use strict";

  // Guard against double-injection — but allow re-injection after extension reload
  if (window.__vantageLoaded) {
    try {
      // If the runtime is still alive, the existing script is healthy — skip
      if (chrome.runtime?.id) return;
    } catch {}
    // Runtime is dead (extension was reloaded) → re-initialize
    console.log("[Vantage] Re-initializing after extension reload");
  }
  window.__vantageLoaded = true;

  let highlights = []; // local cache — may span multiple URLs on SPAs
  let activeTooltip = null;
  let activeActionBar = null;
  let lastSavedRange = null;  // cloned Range preserved across focus loss
  let lastSavedText = "";     // plain text backup of selection
  let repaintAttempted = false;
  let currentTheme = "dark";  // synced from chrome.storage
  let isActive = false;        // global activation — persisted in chrome.storage
  let cloudSync = null;        // CloudSync instance (null = cloud disabled)
  const IC = {
    sun:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`,
    moon:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`,
    trash: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`,
    check: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
    close: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
  };

  /** Strip tracking params, trailing slashes, and fragments for consistent URL matching */
  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      u.hash = "";
      // Known tracking / session params to strip
      const stripExact = [
        "lipi","licu","trk","utm_source","utm_medium","utm_campaign",
        "utm_content","utm_term","originalSubdomain","original_referer",
        "_l","ref","src","originTrackingId","fbclid","gclid","msclkid",
        "mc_cid","mc_eid","_ga","_gl","spm","yclid","_ke","dclid",
        "wbraid","gbraid","twclid","li_fat_id","igshid","s_kwcid",
        "si","feature","app","ref_src","ref_url"
      ];
      for (const p of stripExact) u.searchParams.delete(p);
      // Also strip any param whose name contains "tracking" (case-insensitive)
      for (const key of [...u.searchParams.keys()]) {
        if (/tracking|clickid|sessionid/i.test(key)) u.searchParams.delete(key);
      }
      if (u.searchParams.size === 0) u.search = "";
      u.pathname = u.pathname.replace(/\/+$/, "") || "/";
      return u.toString();
    } catch { return url.split("#")[0].replace(/\/+$/, ""); }
  }

  /** Always returns the CURRENT normalized page URL (handles SPA navigation) */
  function getCurrentUrl() {
    return normalizeUrl(location.href);
  }

  let lastKnownUrl = getCurrentUrl(); // for SPA URL-change detection

  console.log("[Vantage] Content script loaded on:", getCurrentUrl());

  /* ════════════════════════════════════════════
     STORAGE HELPERS
     ════════════════════════════════════════════ */
  function loadHighlights(url) {
    const loadUrl = url || getCurrentUrl();
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: "get-all-highlights" }, (all) => {
          if (chrome.runtime.lastError) {
            console.error("[Vantage] Load failed:", chrome.runtime.lastError.message);
            showConnectionError();
            resolve([]);
            return;
          }
          // Collect highlights from ALL URL keys that normalize to this URL
          let loaded = [];
          const seenIds = new Set();
          if (all) {
            for (const [storedUrl, items] of Object.entries(all)) {
              if (storedUrl === loadUrl || normalizeUrl(storedUrl) === loadUrl) {
                for (const item of items) {
                  if (!seenIds.has(item.id)) {
                    seenIds.add(item.id);
                    loaded.push(item);
                  }
                }
              }
            }
          }
          if (loaded.length > 0) {
            console.log(`[Vantage] Found ${loaded.length} highlights across matching URL keys`);
          }
          // Merge into local array (avoid duplicates by id)
          const existingIds = new Set(highlights.map(h => h.id));
          for (const h of loaded) {
            if (!existingIds.has(h.id)) {
              highlights.push(h);
            }
          }
          console.log(`[Vantage] Loaded ${loaded.length} highlights for ${loadUrl} (total local: ${highlights.length})`);
          resolve(loaded);
        });
      } catch (e) {
        console.error("[Vantage] Load failed:", e);
        showConnectionError();
        resolve([]);
      }
    });
  }

  function saveHighlights() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: "get-all-highlights" }, (all) => {
          if (chrome.runtime.lastError) {
            console.error("[Vantage] Save failed (get):", chrome.runtime.lastError.message);
            showConnectionError();
            resolve();
            return;
          }
          const data = all || {};

          // Group local highlights by NORMALIZED URL (prevents key fragmentation)
          const byUrl = {};
          for (const h of highlights) {
            const hUrl = normalizeUrl(h.url || getCurrentUrl());
            h.url = hUrl; // normalize stored URL for consistency
            if (!byUrl[hUrl]) byUrl[hUrl] = [];
            byUrl[hUrl].push(h);
          }

          // Remove any old non-normalized URL keys that map to the same page
          for (const storedUrl of Object.keys(data)) {
            const norm = normalizeUrl(storedUrl);
            if (norm !== storedUrl && byUrl[norm]) {
              delete data[storedUrl]; // remove old variant
            }
          }
          for (const [url, items] of Object.entries(byUrl)) {
            data[url] = items;
          }

          try {
            chrome.runtime.sendMessage({ action: "save-highlights", payload: data }, () => {
              if (chrome.runtime.lastError) {
                console.error("[Vantage] Save failed (set):", chrome.runtime.lastError.message);
                showConnectionError();
                resolve();
                return;
              }
              console.log(`[Vantage] Saved ${highlights.length} highlights across ${Object.keys(byUrl).length} URL(s)`);
              resolve();
            });
          } catch (e) {
            console.error("[Vantage] Save failed:", e);
            showConnectionError();
            resolve();
          }
        });
      } catch (e) {
        console.error("[Vantage] Save failed:", e);
        showConnectionError();
        resolve();
      }
    });
  }

  /** Show a toast when the extension context is broken (e.g. after extension reload) */
  function showConnectionError() {
    if (document.querySelector(".cs-connection-error")) return; // avoid spam
    const el = document.createElement("div");
    el.className = "cs-connection-error";
    el.style.cssText = `
      position: fixed; top: 16px; right: 16px; z-index: 2147483647;
      background: rgba(9,9,11,0.9); color: #f87171; padding: 12px 18px; border-radius: 10px;
      border: 1px solid rgba(248,113,113,0.2);
      font: 600 13px/1.4 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
      box-shadow: 0 8px 32px rgba(0,0,0,0.4); max-width: 340px;
      animation: cs-fadeIn 0.2s ease; cursor: pointer;
    `;
    el.innerHTML = `Vantage overlay lost connection.<br><span style="font-weight:400;font-size:12px;opacity:0.85">Reload this page to restore.</span>`;
    el.addEventListener("click", () => el.remove());
    document.body.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.remove(); }, 8000);
  }

  /* ════════════════════════════════════════════
     UNIQUE ID
     ════════════════════════════════════════════ */
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ════════════════════════════════════════════
     TEXT ANCHORING (XPath-based, text-node aware)
     ════════════════════════════════════════════ */
  function getXPath(node) {
    if (!node) return "";

    // Handle text nodes — use text() notation in XPath
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentNode;
      if (!parent) return "";
      const textSiblings = Array.from(parent.childNodes).filter(n => n.nodeType === Node.TEXT_NODE);
      const idx = textSiblings.indexOf(node) + 1;
      return getXPath(parent) + "/text()" + (textSiblings.length > 1 ? `[${idx}]` : "");
    }

    if (node.id) return `//*[@id="${node.id}"]`;
    if (node === document.body) return "/html/body";
    if (node === document.documentElement) return "/html";
    const parent = node.parentNode;
    if (!parent) return "";
    const siblings = Array.from(parent.childNodes).filter(n => n.nodeName === node.nodeName);
    const idx = siblings.indexOf(node) + 1;
    return getXPath(parent) + "/" + node.nodeName.toLowerCase() + (siblings.length > 1 ? `[${idx}]` : "");
  }

  function resolveXPath(xpath) {
    try {
      const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return result.singleNodeValue;
    } catch (e) {
      console.warn("[Vantage] XPath resolve failed:", xpath, e.message);
      return null;
    }
  }

  /* ════════════════════════════════════════════
     TEXT-BASED FALLBACK FINDER
     When XPath fails (SPA re-renders, DOM shifts),
     find the highlight text directly in the DOM.
     ════════════════════════════════════════════ */
  function findTextInDOM(searchText) {
    if (!searchText || searchText.length < 2) return null;

    // ── Strategy 1: exact match in a single text node ──
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.parentElement && node.parentElement.closest(".cs-tooltip, .cs-action-bar")) {
            return NodeFilter.FILTER_REJECT;
          }
          return node.textContent.includes(searchText)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP;
        }
      }
    );

    const textNode = walker.nextNode();
    if (textNode) {
      const startOffset = textNode.textContent.indexOf(searchText);
      if (startOffset !== -1) {
        const range = document.createRange();
        range.setStart(textNode, startOffset);
        range.setEnd(textNode, startOffset + searchText.length);
        return range;
      }
    }

    // ── Strategy 2: multi-node — use innerText for reliable cross-element search ──
    const bodyText = document.body.innerText;
    const pos = bodyText.indexOf(searchText);
    if (pos !== -1) {
      const rangeFromInnerText = resolveInnerTextRange(pos, searchText.length);
      if (rangeFromInnerText) return rangeFromInnerText;
    }

    // ── Strategy 3: whitespace-normalized innerText search ──
    const normalSearch = searchText.replace(/\s+/g, " ").trim();
    const normalBody = bodyText.replace(/\s+/g, " ");
    const normalPos = normalBody.indexOf(normalSearch);
    if (normalPos !== -1) {
      // Map normalized position back to original innerText position
      let origPos = 0, normIdx = 0;
      for (; origPos < bodyText.length && normIdx < normalPos; origPos++) {
        if (/\s/.test(bodyText[origPos])) {
          if (origPos === 0 || !/\s/.test(bodyText[origPos - 1])) normIdx++;
        } else {
          normIdx++;
        }
      }
      // Find the original length by mapping the end position too
      let origEnd = origPos, normEndIdx = normIdx;
      const normEndTarget = normalPos + normalSearch.length;
      for (; origEnd < bodyText.length && normEndIdx < normEndTarget; origEnd++) {
        if (/\s/.test(bodyText[origEnd])) {
          if (origEnd === 0 || !/\s/.test(bodyText[origEnd - 1])) normEndIdx++;
        } else {
          normEndIdx++;
        }
      }
      const rangeFromNorm = resolveInnerTextRange(origPos, origEnd - origPos);
      if (rangeFromNorm) return rangeFromNorm;
    }

    return null;
  }

  /**
   * Given a character position and length in document.body.innerText,
   * walk the DOM text nodes to build the corresponding Range.
   */
  function resolveInnerTextRange(pos, length) {
    const allWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.parentElement && node.parentElement.closest(".cs-tooltip, .cs-action-bar")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let charCount = 0;
    let startNode = null, startOff = 0, endNode = null, endOff = 0;
    const endPos = pos + length;

    while (allWalker.nextNode()) {
      const n = allWalker.currentNode;
      const nodeText = n.textContent;
      const nodeStart = charCount;
      const nodeEnd = charCount + nodeText.length;

      if (!startNode && nodeEnd > pos) {
        startNode = n;
        startOff = Math.max(0, pos - nodeStart);
      }
      if (startNode && nodeEnd >= endPos) {
        endNode = n;
        endOff = Math.min(nodeText.length, endPos - nodeStart);
        break;
      }
      charCount = nodeEnd;
    }

    if (startNode && endNode) {
      try {
        const range = document.createRange();
        range.setStart(startNode, startOff);
        range.setEnd(endNode, endOff);
        return range;
      } catch { return null; }
    }
    return null;
  }

  /* ════════════════════════════════════════════
     SAVE CURRENT SELECTION (call before it's lost)
     ════════════════════════════════════════════ */
  function snapshotSelection() {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      const text = sel.toString().trim();
      if (text) {
        lastSavedRange = sel.getRangeAt(0).cloneRange();
        lastSavedText = text;
        console.log("[Vantage] Selection saved:", text.slice(0, 60));
        return true;
      }
    }
    return false;
  }

  /* ════════════════════════════════════════════
     CREATE HIGHLIGHT FROM SELECTION
     ════════════════════════════════════════════ */
  function captureSelection(color = "yellow") {
    const sel = window.getSelection();
    let range = null;
    let text = "";

    // 1) Try current live selection first
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      range = sel.getRangeAt(0);
      text = sel.toString().trim();
      console.log("[Vantage] Using live selection:", text.slice(0, 60));
    }

    // 2) Fallback: use the last saved range (popup/click steals focus)
    if ((!range || !text) && lastSavedRange) {
      range = lastSavedRange;
      text = lastSavedText || range.toString().trim();
      console.log("[Vantage] Using saved range:", text.slice(0, 60));
    }

    if (!range || !text) {
      console.log("[Vantage] No selection or saved range found");
      return null;
    }

    const id = uid();
    const anchor = {
      startContainerXPath: getXPath(range.startContainer),
      startOffset: range.startOffset,
      endContainerXPath: getXPath(range.endContainer),
      endOffset: range.endOffset,
    };

    const record = {
      id,
      text,
      note: "",
      color,
      anchor,
      createdAt: new Date().toISOString(),
      url: getCurrentUrl(),
      title: document.title,
    };

    wrapRange(range, id, color);
    try { if (sel && sel.rangeCount) sel.removeAllRanges(); } catch {}
    lastSavedRange = null;
    lastSavedText = "";

    highlights.push(record);
    saveHighlights();

    if (cloudSync && cloudSync.isConfigured && cloudSync.canHighlight) {
      cloudSync.pushHighlight(record).catch(err =>
        console.warn("[Vantage] Cloud push failed:", err)
      );
    }

    console.log("[Vantage] Highlighted:", text.slice(0, 60));
    return record;
  }

  /* ════════════════════════════════════════════
     WRAP / PAINT RANGE
     ════════════════════════════════════════════ */
  function wrapRange(range, id, color) {
    const treeWalker = document.createTreeWalker(
      range.commonAncestorContainer,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const nodeRange = document.createRange();
          nodeRange.selectNodeContents(node);
          return range.compareBoundaryPoints(Range.END_TO_START, nodeRange) < 0 &&
                 range.compareBoundaryPoints(Range.START_TO_END, nodeRange) > 0
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }
      }
    );

    const textNodes = [];
    while (treeWalker.nextNode()) textNodes.push(treeWalker.currentNode);
    if (textNodes.length === 0 && range.startContainer.nodeType === Node.TEXT_NODE) {
      textNodes.push(range.startContainer);
    }

    for (const textNode of textNodes) {
      const span = document.createElement("span");
      span.className = `cs-highlight${color !== "yellow" ? ` cs-color-${color}` : ""}`;
      span.dataset.csId = id;

      let highlightRange = document.createRange();
      if (textNode === range.startContainer && textNode === range.endContainer) {
        highlightRange.setStart(textNode, range.startOffset);
        highlightRange.setEnd(textNode, range.endOffset);
      } else if (textNode === range.startContainer) {
        highlightRange.setStart(textNode, range.startOffset);
        highlightRange.setEndAfter(textNode);
      } else if (textNode === range.endContainer) {
        highlightRange.setStartBefore(textNode);
        highlightRange.setEnd(textNode, range.endOffset);
      } else {
        highlightRange.selectNodeContents(textNode);
      }

      try {
        highlightRange.surroundContents(span);
      } catch {
        const fragment = highlightRange.extractContents();
        span.appendChild(fragment);
        highlightRange.insertNode(span);
      }
    }
  }

  /* ════════════════════════════════════════════
     REPAINT STORED HIGHLIGHTS
     Two-phase approach:
       Phase 1 — resolve ALL XPaths while the DOM is still clean
       Phase 2 — paint resolved ranges, then text-search for the rest
     This prevents painting one highlight from breaking XPaths of others.
     ════════════════════════════════════════════ */
  function repaintAll() {
    const currentUrl = getCurrentUrl();
    const pageHighlights = highlights.filter(h => normalizeUrl(h.url) === currentUrl);

    if (pageHighlights.length === 0) {
      console.log("[Vantage] No highlights to repaint for this URL");
      return;
    }

    let painted = 0;
    let failed = 0;

    // ── Phase 1: resolve all XPaths BEFORE any DOM changes ──
    const resolved = [];   // { h, range }
    const unresolved = []; // highlights whose XPath failed

    for (const h of pageHighlights) {
      if (document.querySelector(`[data-cs-id="${h.id}"]`)) { painted++; continue; }

      let range = null;
      try {
        const startNode = resolveXPath(h.anchor.startContainerXPath);
        const endNode   = resolveXPath(h.anchor.endContainerXPath);
        if (startNode && endNode) {
          range = document.createRange();
          range.setStart(startNode, h.anchor.startOffset);
          range.setEnd(endNode, h.anchor.endOffset);
          const rangeText = range.toString().trim();
          if (!(rangeText && (rangeText === h.text || h.text.includes(rangeText) || rangeText.includes(h.text)))) {
            console.log(`[Vantage] XPath text mismatch: "${rangeText.slice(0,40)}" vs "${h.text.slice(0,40)}"`);
            range = null;
          }
        }
      } catch (e) {
        console.log(`[Vantage] XPath resolve failed for "${h.text.slice(0,40)}":`, e.message);
        range = null;
      }

      if (range) {
        resolved.push({ h, range });
      } else {
        unresolved.push(h);
      }
    }

    // ── Phase 2a: paint the XPath-resolved ranges ──
    for (const { h, range } of resolved) {
      try {
        wrapRange(range, h.id, h.color || "yellow");
        painted++;
      } catch (e) {
        console.log(`[Vantage] XPath paint failed for "${h.text.slice(0,40)}":`, e.message);
        unresolved.push(h);
      }
    }

    // ── Phase 2b: text-search fallback for unresolved highlights ──
    for (const h of unresolved) {
      if (document.querySelector(`[data-cs-id="${h.id}"]`)) { painted++; continue; }
      try {
        const range = findTextInDOM(h.text);
        if (range) {
          wrapRange(range, h.id, h.color || "yellow");
          painted++;
          console.log(`[Vantage] Text-search fallback succeeded for: "${h.text.slice(0,40)}"`);
        } else {
          failed++;
          console.log(`[Vantage] Could not repaint: "${h.text.slice(0,60)}"`);
        }
      } catch (e) {
        failed++;
        console.log(`[Vantage] Text-search fallback failed for "${h.text.slice(0,40)}":`, e.message);
      }
    }

    console.log(`[Vantage] Repaint complete: ${painted} painted, ${failed} failed out of ${pageHighlights.length}`);
    repaintAttempted = true;
  }

  /* ════════════════════════════════════════════
     DEFERRED REPAINT (for SPAs that render after load)
     ════════════════════════════════════════════ */
  function scheduleRepaintRetry() {
    // For SPA pages that render content asynchronously, retry repaint
    // when we detect new DOM nodes being added
    let retryCount = 0;
    const maxRetries = 10;
    const retryInterval = 1500; // ms

    const timer = setInterval(() => {
      retryCount++;
      if (retryCount > maxRetries) {
        clearInterval(timer);
        return;
      }

      // Check if any highlights for THIS page still need painting
      const currentUrl = getCurrentUrl();
      const unpainted = highlights.filter(h =>
        normalizeUrl(h.url) === currentUrl && !document.querySelector(`[data-cs-id="${h.id}"]`)
      );

      if (unpainted.length === 0) {
        clearInterval(timer);
        return;
      }

      console.log(`[Vantage] Retry repaint ${retryCount}/${maxRetries} — ${unpainted.length} unpainted`);

      // Phase 1: resolve XPaths while DOM is clean
      const resolved = [];
      const unresolved = [];
      for (const h of unpainted) {
        let range = null;
        try {
          const startNode = resolveXPath(h.anchor.startContainerXPath);
          const endNode = resolveXPath(h.anchor.endContainerXPath);
          if (startNode && endNode) {
            range = document.createRange();
            range.setStart(startNode, h.anchor.startOffset);
            range.setEnd(endNode, h.anchor.endOffset);
            const rangeText = range.toString().trim();
            if (!(rangeText && (rangeText === h.text || h.text.includes(rangeText) || rangeText.includes(h.text)))) {
              range = null;
            }
          }
        } catch { range = null; }
        if (range) resolved.push({ h, range }); else unresolved.push(h);
      }
      // Phase 2a: paint XPath-resolved
      for (const { h, range } of resolved) {
        try { wrapRange(range, h.id, h.color || "yellow"); }
        catch { unresolved.push(h); }
      }
      // Phase 2b: text-search fallback
      for (const h of unresolved) {
        if (document.querySelector(`[data-cs-id="${h.id}"]`)) continue;
        try {
          const range = findTextInDOM(h.text);
          if (range) wrapRange(range, h.id, h.color || "yellow");
        } catch { /* skip */ }
      }
    }, retryInterval);
  }

  /* ════════════════════════════════════════════
     TOOLTIP (Note Editor)
     ════════════════════════════════════════════ */
  function showTooltip(highlightEl) {
    closeTooltip();
    closeActionBar();

    const id = highlightEl.dataset.csId;
    const record = highlights.find(h => h.id === id);
    if (!record) return;

    const isCloudHighlight = !!record._cloud;
    const isViewerRole = cloudSync && cloudSync.role === CloudSync.ROLES.VIEWER;
    const canEditThis = !isViewerRole;
    const canDeleteThis = !cloudSync || cloudSync.canDelete || (!isCloudHighlight);

    const rect = highlightEl.getBoundingClientRect();
    const tooltip = document.createElement("div");
    tooltip.className = `cs-tooltip${currentTheme === "light" ? " cs-light" : ""}`;
    tooltip.innerHTML = `
      <div class="cs-tooltip-header">
        <span class="cs-tooltip-title">Note${isViewerRole ? " (read-only)" : ""}</span>
        <div class="cs-tooltip-header-right">
          <button class="cs-icon-btn cs-theme-toggle" title="Toggle theme">${currentTheme === "dark" ? IC.sun : IC.moon}</button>
          ${canDeleteThis ? `<button class="cs-icon-btn cs-delete" title="Remove highlight">${IC.trash}</button>` : ""}
          ${canEditThis ? `<button class="cs-icon-btn cs-save" title="Save note">${IC.check}</button>` : ""}
          <button class="cs-icon-btn cs-tooltip-close" title="Close">${IC.close}</button>
        </div>
      </div>
      <textarea placeholder="${isViewerRole ? "View only" : "Add a note…"}"${isViewerRole ? " readonly" : ""}>${record.note || ""}</textarea>
    `;

    tooltip.style.top = (window.scrollY + rect.bottom + 8) + "px";
    tooltip.style.left = Math.max(8, window.scrollX + rect.left - 20) + "px";
    document.body.appendChild(tooltip);
    activeTooltip = tooltip;

    const textarea = tooltip.querySelector("textarea");
    textarea.focus();

    tooltip.querySelector(".cs-tooltip-close").addEventListener("click", closeTooltip);

    // Theme toggle inside tooltip
    tooltip.querySelector(".cs-theme-toggle").addEventListener("click", () => {
      currentTheme = currentTheme === "dark" ? "light" : "dark";
      chrome.storage.local.set({ theme: currentTheme });
      // Re-apply theme to this tooltip live
      tooltip.classList.toggle("cs-light", currentTheme === "light");
      tooltip.querySelector(".cs-theme-toggle").innerHTML = currentTheme === "dark" ? IC.sun : IC.moon;
    });

    const saveBtn = tooltip.querySelector(".cs-save");
    if (saveBtn) {
      saveBtn.addEventListener("click", () => {
        record.note = textarea.value.trim();
        saveHighlights();
        if (cloudSync && cloudSync.isConfigured) {
          cloudSync.pushHighlight(record).catch(() => {});
        }
        closeTooltip();
      });
    }

    const deleteBtn = tooltip.querySelector(".cs-delete");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", () => {
        removeHighlight(id);
        closeTooltip();
      });
    }

    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeTooltip();
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canEditThis) {
        record.note = textarea.value.trim();
        saveHighlights();
        if (cloudSync && cloudSync.isConfigured) {
          cloudSync.pushHighlight(record).catch(() => {});
        }
        closeTooltip();
      }
    });
  }

  function closeTooltip() {
    if (activeTooltip) {
      activeTooltip.remove();
      activeTooltip = null;
    }
  }

  /* ════════════════════════════════════════════
     ACTION BAR (shows on text selection)
     ════════════════════════════════════════════ */
  function showActionBar(x, y) {
    closeActionBar();

    // ★ Snapshot the selection NOW before anything can steal it
    snapshotSelection();

    const bar = document.createElement("div");
    bar.className = `cs-action-bar${currentTheme === "light" ? " cs-light" : ""}`;
    const colors = [
      { name: "yellow", hex: "#facc15" },
      { name: "green",  hex: "#34d399" },
      { name: "blue",   hex: "#60a5fa" },
      { name: "pink",   hex: "#f472b6" },
      { name: "orange", hex: "#fb923c" },
    ];
    bar.innerHTML = colors.map(c =>
      `<button data-color="${c.name}" title="Highlight ${c.name}">
         <span class="cs-color-dot" style="background:${c.hex}"></span>
       </button>`
    ).join("");

    bar.style.top = (window.scrollY + y - 48) + "px";
    bar.style.left = (window.scrollX + x) + "px";
    document.body.appendChild(bar);
    activeActionBar = bar;

    // ★ Prevent mousedown on buttons from stealing focus / clearing selection
    bar.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    bar.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-color]");
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const record = captureSelection(btn.dataset.color);
      closeActionBar();
      // Auto-open the note tooltip so user can optionally add a comment
      if (record) {
        setTimeout(() => {
          const el = document.querySelector(`[data-cs-id="${record.id}"]`);
          if (el) showTooltip(el);
        }, 50);
      }
    });
  }

  function closeActionBar() {
    if (activeActionBar) {
      activeActionBar.remove();
      activeActionBar = null;
    }
  }

  /* ════════════════════════════════════════════
     REMOVE HIGHLIGHT
     ════════════════════════════════════════════ */
  function removeHighlight(id) {
    const record = highlights.find(h => h.id === id);
    document.querySelectorAll(`[data-cs-id="${id}"]`).forEach(el => {
      const parent = el.parentNode;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      el.remove();
      parent.normalize();
    });
    highlights = highlights.filter(h => h.id !== id);
    saveHighlights();

    if (cloudSync && cloudSync.isConfigured && cloudSync.canDelete && record) {
      cloudSync.deleteHighlight(record.url || getCurrentUrl(), id).catch(() => {});
    }
  }

  /* ════════════════════════════════════════════
     EVENT LISTENERS
     ════════════════════════════════════════════ */

  // Continuously save latest valid selection range (survives focus loss to popup)
  document.addEventListener("selectionchange", () => {
    snapshotSelection();
  });

  // Show action bar on text selection (mouseup) — only when activated for this page
  document.addEventListener("mouseup", (e) => {
    if (!isActive) return;
    if (cloudSync && !cloudSync.canHighlight) return; // viewers can't create highlights
    if (e.target.closest(".cs-tooltip, .cs-action-bar")) return;

    setTimeout(() => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) {
        showActionBar(e.clientX, e.clientY);
      } else {
        closeActionBar();
      }
    }, 10);
  });

  // Click on existing highlight → open tooltip
  document.addEventListener("click", (e) => {
    if (e.target.closest(".cs-action-bar")) return;
    const hlEl = e.target.closest(".cs-highlight");
    if (hlEl) {
      e.preventDefault();
      e.stopPropagation();
      showTooltip(hlEl);
      return;
    }
    if (activeTooltip && !e.target.closest(".cs-tooltip")) {
      closeTooltip();
    }
  });

  // Close action bar on scroll
  document.addEventListener("scroll", () => closeActionBar(), { passive: true });

  // Listen for messages from background / popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    console.log("[Vantage] Message:", msg.action);
    if (msg.action === "highlight-selection") {
      const result = captureSelection();
      if (result) {
        setTimeout(() => {
          const el = document.querySelector(`[data-cs-id="${result.id}"]`);
          if (el) showTooltip(el);
        }, 50);
      }
      sendResponse({ ok: !!result });
    }
    if (msg.action === "set-theme") {
      currentTheme = msg.theme || "dark";
      console.log("[Vantage] Theme set to:", currentTheme);
    }
    if (msg.action === "set-active") {
      isActive = !!msg.active;
      console.log("[Vantage] Highlighting", isActive ? "ENABLED" : "DISABLED");
      if (!isActive) closeActionBar();
      sendResponse({ active: isActive });
    }
    if (msg.action === "get-active-status") {
      sendResponse({ active: isActive });
    }
    if (msg.action === "ping") {
      sendResponse({ alive: true, url: getCurrentUrl() });
    }
  });

  // Listen for direct trigger from injected popup script (fallback path)
  document.addEventListener("cs-trigger-highlight", () => {
    console.log("[Vantage] Direct trigger received");
    const result = captureSelection();
    if (result) {
      setTimeout(() => {
        const el = document.querySelector(`[data-cs-id="${result.id}"]`);
        if (el) showTooltip(el);
      }, 50);
    }
  });

  /* ════════════════════════════════════════════
     SPA URL-CHANGE DETECTION
     LinkedIn, Twitter, etc. navigate without full
     page reloads — detect and load highlights
     for the new URL automatically.
     ════════════════════════════════════════════ */
  function onUrlChanged(newUrl) {
    console.log(`[Vantage] SPA navigation: → ${newUrl}`);
    lastKnownUrl = newUrl;
    closeActionBar();
    closeTooltip();

    // Re-subscribe SSE to the new URL and fetch existing cloud highlights
    if (cloudSync && cloudSync.isConfigured) {
      fetchAndMergeCloudHighlights();
      cloudSubscribeCurrentUrl();
    }

    // Load highlights for the new URL and paint them
    loadHighlights(newUrl).then((loaded) => {
      if (loaded.length > 0) {
        paintUnpainted();
        scheduleRepaintRetry();
      }
    });
  }

  /** Paint only highlights that don't have DOM elements yet */
  function paintUnpainted() {
    const currentUrl = getCurrentUrl();
    const unpainted = highlights.filter(h =>
      normalizeUrl(h.url) === currentUrl && !document.querySelector(`[data-cs-id="${h.id}"]`)
    );
    if (unpainted.length === 0) return;

    // Phase 1: resolve all XPaths while DOM is clean
    const resolved = [];
    const unresolved = [];
    for (const h of unpainted) {
      let range = null;
      try {
        const startNode = resolveXPath(h.anchor.startContainerXPath);
        const endNode   = resolveXPath(h.anchor.endContainerXPath);
        if (startNode && endNode) {
          range = document.createRange();
          range.setStart(startNode, h.anchor.startOffset);
          range.setEnd(endNode, h.anchor.endOffset);
          const rangeText = range.toString().trim();
          if (!(rangeText && (rangeText === h.text || h.text.includes(rangeText) || rangeText.includes(h.text)))) {
            range = null;
          }
        }
      } catch { range = null; }
      if (range) resolved.push({ h, range }); else unresolved.push(h);
    }
    // Phase 2a: paint resolved
    for (const { h, range } of resolved) {
      try { wrapRange(range, h.id, h.color || "yellow"); }
      catch { unresolved.push(h); }
    }
    // Phase 2b: text-search fallback
    for (const h of unresolved) {
      if (document.querySelector(`[data-cs-id="${h.id}"]`)) continue;
      try {
        const range = findTextInDOM(h.text);
        if (range) wrapRange(range, h.id, h.color || "yellow");
      } catch { /* skip */ }
    }
  }

  // Periodic URL check (catches pushState/replaceState which don't fire events)
  setInterval(() => {
    const cur = getCurrentUrl();
    if (cur !== lastKnownUrl) {
      onUrlChanged(cur);
    }
  }, 1000);

  // Also listen for popstate (back/forward browser buttons)
  window.addEventListener("popstate", () => {
    setTimeout(() => {
      const cur = getCurrentUrl();
      if (cur !== lastKnownUrl) {
        onUrlChanged(cur);
      }
    }, 200);
  });

  /* ════════════════════════════════════════════
     CLOUD SYNC — real-time highlights via Firebase
     ════════════════════════════════════════════ */

  function initCloudSync(config) {
    if (!config || !config.firebaseUrl || !config.packKey) {
      if (cloudSync) {
        cloudSync.disconnectAll();
        cloudSync = null;
        removePresenceIndicator();
        console.log("[Vantage] Cloud sync disconnected");
      }
      return;
    }

    cloudSync = new CloudSync();
    cloudSync.configure(config.firebaseUrl, config.packKey, config.role || "viewer", config.userName);
    console.log("[Vantage] Cloud sync active — pack:", config.packKey, "role:", config.role, "as:", config.userName);

    fetchAndMergeCloudHighlights();
    cloudSubscribeCurrentUrl();

    // Presence: announce, heartbeat, and subscribe to viewer changes
    cloudSync.startHeartbeat(getCurrentUrl);
    cloudSync.subscribePresence((viewers) => {
      updatePresenceIndicator(viewers);
    });
  }

  /* ════════════════════════════════════════════
     ON-PAGE PRESENCE INDICATOR
     ════════════════════════════════════════════ */
  function updatePresenceIndicator(viewers) {
    const selfId = cloudSync ? cloudSync.presenceId : null;
    const others = Object.entries(viewers).filter(([id]) => id !== selfId);
    const count = others.length;

    let indicator = document.querySelector(".vantage-presence");
    if (count === 0) {
      if (indicator) indicator.remove();
      return;
    }

    if (!indicator) {
      indicator = document.createElement("div");
      indicator.className = "vantage-presence";
      document.body.appendChild(indicator);
    }

    const names = others.map(([, v]) => v.name || "Anonymous");
    const overflow = names.length > 3 ? ` +${names.length - 3}` : "";
    const nameChips = names.slice(0, 3).map(n =>
      `<span class="vp-name">${n}</span>`
    ).join("") + (overflow ? `<span class="vp-overflow">${overflow}</span>` : "");

    indicator.innerHTML = `
      <span class="vp-dot"></span>
      <span class="vp-count">${count}</span>
      <span class="vp-label">${count === 1 ? "viewer" : "viewers"}</span>
      <span class="vp-names">${nameChips}</span>
    `;
    indicator.title = names.join(", ");
  }

  function removePresenceIndicator() {
    const el = document.querySelector(".vantage-presence");
    if (el) el.remove();
  }

  async function fetchAndMergeCloudHighlights() {
    if (!cloudSync || !cloudSync.isConfigured) return;
    const url = getCurrentUrl();
    try {
      const remote = await cloudSync.fetchAllHighlightsForUrl(url);
      if (!remote || typeof remote !== "object") return;
      let added = 0;
      for (const [id, hl] of Object.entries(remote)) {
        if (highlights.find(h => h.id === id)) continue;
        const { _author, ...clean } = hl;
        clean._cloud = true;
        highlights.push(clean);
        cloudSync._knownIds.add(id);
        added++;
        tryPaintCloudHighlight(hl);
      }
      if (added > 0) {
        saveHighlights();
        scheduleCloudRepaint();
        console.log(`[Vantage] Fetched ${added} existing cloud highlights`);
      }
    } catch (err) {
      console.warn("[Vantage] Cloud fetch failed:", err);
    }
  }

  function cloudSubscribeCurrentUrl() {
    if (!cloudSync || !cloudSync.isConfigured) return;
    const url = getCurrentUrl();

    // Mark all local highlight IDs as known so SSE won't re-deliver them
    for (const h of highlights) {
      if (normalizeUrl(h.url) === url) {
        cloudSync._knownIds.add(h.id);
      }
    }

    cloudSync.subscribeToUrl(url,
      (remoteHighlight) => {
        console.log("[Vantage] Cloud highlight received:", remoteHighlight.text?.slice(0, 50));

        // Skip if already painted locally
        if (document.querySelector(`[data-cs-id="${remoteHighlight.id}"]`)) return;

        // Always save to local cache first so the dashboard sees it
        const existing = highlights.find(h => h.id === remoteHighlight.id);
        if (!existing) {
          const { _author, ...clean } = remoteHighlight;
          clean._cloud = true;
          highlights.push(clean);
          saveHighlights();
        }

        // Then try to paint
        const painted = tryPaintCloudHighlight(remoteHighlight);
        if (painted) {
          console.log("[Vantage] Cloud highlight painted:", remoteHighlight.text?.slice(0, 40));
        } else {
          console.log("[Vantage] Cloud highlight saved, paint deferred:", remoteHighlight.text?.slice(0, 40));
          scheduleCloudRepaint();
        }
      },
      (deletedId) => {
        console.log("[Vantage] Cloud highlight deleted:", deletedId);
        removeHighlight(deletedId);
      }
    );
  }

  function tryPaintCloudHighlight(hl) {
    if (document.querySelector(`[data-cs-id="${hl.id}"]`)) return true;
    try {
      if (hl.anchor) {
        const startNode = resolveXPath(hl.anchor.startContainerXPath);
        const endNode = resolveXPath(hl.anchor.endContainerXPath);
        if (startNode && endNode) {
          const range = document.createRange();
          range.setStart(startNode, hl.anchor.startOffset);
          range.setEnd(endNode, hl.anchor.endOffset);
          const rangeText = range.toString().trim();
          if (rangeText && (rangeText === hl.text || hl.text.includes(rangeText) || rangeText.includes(hl.text))) {
            wrapRange(range, hl.id, hl.color || "yellow");
            return true;
          }
        }
      }
    } catch {}
    if (hl.text) {
      const range = findTextInDOM(hl.text);
      if (range) {
        wrapRange(range, hl.id, hl.color || "yellow");
        return true;
      }
    }
    return false;
  }

  let _cloudRepaintTimer = null;
  function scheduleCloudRepaint() {
    if (_cloudRepaintTimer) return;
    let attempts = 0;
    const maxAttempts = 15;
    _cloudRepaintTimer = setInterval(() => {
      attempts++;
      const url = getCurrentUrl();
      const unpainted = highlights.filter(h =>
        h._cloud && normalizeUrl(h.url) === url && !document.querySelector(`[data-cs-id="${h.id}"]`)
      );
      if (unpainted.length === 0 || attempts >= maxAttempts) {
        clearInterval(_cloudRepaintTimer);
        _cloudRepaintTimer = null;
        return;
      }
      for (const h of unpainted) tryPaintCloudHighlight(h);
    }, 1500);
  }

  /* ════════════════════════════════════════════
     INIT — load prefs + highlights & repaint
     ════════════════════════════════════════════ */
  // Load saved preferences (theme + global highlight toggle + cloud config)
  chrome.storage.local.get(["theme", "highlightingEnabled", "cloudPack"], (prefs) => {
    currentTheme = prefs.theme || "dark";
    isActive = prefs.highlightingEnabled !== false; // default ON
    console.log("[Vantage] Theme:", currentTheme, "| Highlighting:", isActive ? "ON" : "OFF");

    if (prefs.cloudPack && prefs.cloudPack.firebaseUrl && prefs.cloudPack.packKey) {
      initCloudSync(prefs.cloudPack);
    }
  });

  // React to changes from popup/other tabs in real-time
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.highlightingEnabled) {
      isActive = changes.highlightingEnabled.newValue !== false;
      console.log("[Vantage] Highlighting toggled globally:", isActive ? "ON" : "OFF");
      if (!isActive) closeActionBar();
    }
    if (changes.theme) {
      currentTheme = changes.theme.newValue || "dark";
    }
    if (changes.cloudPack) {
      initCloudSync(changes.cloudPack.newValue);
    }
  });

  loadHighlights().then(() => {
    repaintAll();
    // For SPA pages: retry unpainted highlights as content loads
    if (highlights.length > 0) {
      scheduleRepaintRetry();
      // MutationObserver — respond to async DOM changes (LinkedIn, Twitter, etc.)
      let repaintDebounce = null;
      const observer = new MutationObserver(() => {
        const cur = getCurrentUrl();
        const unpainted = highlights.filter(h =>
          normalizeUrl(h.url) === cur && !document.querySelector(`[data-cs-id="${h.id}"]`)
        );
        if (unpainted.length === 0) { observer.disconnect(); return; }
        clearTimeout(repaintDebounce);
        repaintDebounce = setTimeout(() => paintUnpainted(), 400);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      // Stop observer after 30s to avoid perf impact
      setTimeout(() => observer.disconnect(), 30000);
    }
  });

  // Clean up presence when leaving the page
  window.addEventListener("beforeunload", () => {
    if (cloudSync) cloudSync.removePresence();
  });
})();
