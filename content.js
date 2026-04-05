/* ─────────────────────────────────────────────
   Context Scribe — Content Script
   Runs on every page to paint & manage highlights
   ───────────────────────────────────────────── */

(() => {
  "use strict";

  // Guard against double-injection — but allow re-injection after extension reload
  if (window.__contextScribeLoaded) {
    try {
      // If the runtime is still alive, the existing script is healthy — skip
      if (chrome.runtime?.id) return;
    } catch {}
    // Runtime is dead (extension was reloaded) → re-initialize
    console.log("[Context Scribe] Re-initializing after extension reload");
  }
  window.__contextScribeLoaded = true;

  let highlights = []; // local cache — may span multiple URLs on SPAs
  let activeTooltip = null;
  let activeActionBar = null;
  let lastSavedRange = null;  // cloned Range preserved across focus loss
  let lastSavedText = "";     // plain text backup of selection
  let repaintAttempted = false;
  let currentTheme = "dark";  // synced from chrome.storage
  let isActive = false;        // global activation — persisted in chrome.storage
  let cloudSync = null;        // CloudSync instance (null = cloud disabled)
  /** SVG icon constants (professional, no emojis) */
  const IC = {
    sun:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`,
    moon:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
    trash: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
    check: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    close: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
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

  console.log("[Context Scribe] Content script loaded on:", getCurrentUrl());

  /* ════════════════════════════════════════════
     STORAGE HELPERS
     ════════════════════════════════════════════ */
  function loadHighlights(url) {
    const loadUrl = url || getCurrentUrl();
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: "get-all-highlights" }, (all) => {
          if (chrome.runtime.lastError) {
            console.error("[Context Scribe] Load failed:", chrome.runtime.lastError.message);
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
            console.log(`[Context Scribe] Found ${loaded.length} highlights across matching URL keys`);
          }
          // Merge into local array (avoid duplicates by id)
          const existingIds = new Set(highlights.map(h => h.id));
          for (const h of loaded) {
            if (!existingIds.has(h.id)) {
              highlights.push(h);
            }
          }
          console.log(`[Context Scribe] Loaded ${loaded.length} highlights for ${loadUrl} (total local: ${highlights.length})`);
          resolve(loaded);
        });
      } catch (e) {
        console.error("[Context Scribe] Load failed:", e);
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
            console.error("[Context Scribe] Save failed (get):", chrome.runtime.lastError.message);
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
                console.error("[Context Scribe] Save failed (set):", chrome.runtime.lastError.message);
                showConnectionError();
                resolve();
                return;
              }
              console.log(`[Context Scribe] Saved ${highlights.length} highlights across ${Object.keys(byUrl).length} URL(s)`);
              resolve();
            });
          } catch (e) {
            console.error("[Context Scribe] Save failed:", e);
            showConnectionError();
            resolve();
          }
        });
      } catch (e) {
        console.error("[Context Scribe] Save failed:", e);
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
      background: #c92a2a; color: #fff; padding: 12px 18px; border-radius: 10px;
      font: 600 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3); max-width: 340px;
      animation: cs-fadeIn 0.2s ease; cursor: pointer;
    `;
    el.innerHTML = `Context Scribe lost connection.<br><span style="font-weight:400;font-size:12px;opacity:0.9">Reload this page to restore saving.</span>`;
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
      console.warn("[Context Scribe] XPath resolve failed:", xpath, e.message);
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
        console.log("[Context Scribe] Selection saved:", text.slice(0, 60));
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
      console.log("[Context Scribe] Using live selection:", text.slice(0, 60));
    }

    // 2) Fallback: use the last saved range (popup/click steals focus)
    if ((!range || !text) && lastSavedRange) {
      range = lastSavedRange;
      text = lastSavedText || range.toString().trim();
      console.log("[Context Scribe] Using saved range:", text.slice(0, 60));
    }

    if (!range || !text) {
      console.log("[Context Scribe] No selection or saved range found");
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

    if (cloudSync && cloudSync.isConfigured) {
      cloudSync.pushHighlight(record).catch(err =>
        console.warn("[Context Scribe] Cloud push failed:", err)
      );
    }

    console.log("[Context Scribe] Highlighted:", text.slice(0, 60));
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
      console.log("[Context Scribe] No highlights to repaint for this URL");
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
            console.log(`[Context Scribe] XPath text mismatch: "${rangeText.slice(0,40)}" vs "${h.text.slice(0,40)}"`);
            range = null;
          }
        }
      } catch (e) {
        console.log(`[Context Scribe] XPath resolve failed for "${h.text.slice(0,40)}":`, e.message);
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
        console.log(`[Context Scribe] XPath paint failed for "${h.text.slice(0,40)}":`, e.message);
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
          console.log(`[Context Scribe] Text-search fallback succeeded for: "${h.text.slice(0,40)}"`);
        } else {
          failed++;
          console.log(`[Context Scribe] Could not repaint: "${h.text.slice(0,60)}"`);
        }
      } catch (e) {
        failed++;
        console.log(`[Context Scribe] Text-search fallback failed for "${h.text.slice(0,40)}":`, e.message);
      }
    }

    console.log(`[Context Scribe] Repaint complete: ${painted} painted, ${failed} failed out of ${pageHighlights.length}`);
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

      console.log(`[Context Scribe] Retry repaint ${retryCount}/${maxRetries} — ${unpainted.length} unpainted`);

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

    const rect = highlightEl.getBoundingClientRect();
    const tooltip = document.createElement("div");
    tooltip.className = `cs-tooltip${currentTheme === "light" ? " cs-light" : ""}`;
    tooltip.innerHTML = `
      <div class="cs-tooltip-header">
        <span class="cs-tooltip-title">Note</span>
        <div class="cs-tooltip-header-right">
          <button class="cs-icon-btn cs-theme-toggle" title="Toggle theme">${currentTheme === "dark" ? IC.sun : IC.moon}</button>
          <button class="cs-icon-btn cs-delete" title="Remove highlight">${IC.trash}</button>
          <button class="cs-icon-btn cs-save" title="Save note">${IC.check}</button>
          <button class="cs-icon-btn cs-tooltip-close" title="Close">${IC.close}</button>
        </div>
      </div>
      <textarea placeholder="Add a note…">${record.note || ""}</textarea>
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

    tooltip.querySelector(".cs-save").addEventListener("click", () => {
      record.note = textarea.value.trim();
      saveHighlights();
      if (cloudSync && cloudSync.isConfigured) {
        cloudSync.pushHighlight(record).catch(() => {});
      }
      closeTooltip();
    });

    tooltip.querySelector(".cs-delete").addEventListener("click", () => {
      removeHighlight(id);
      closeTooltip();
    });

    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeTooltip();
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
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
      { name: "yellow", hex: "#ffe066" },
      { name: "green",  hex: "#b2f2bb" },
      { name: "blue",   hex: "#a5d8ff" },
      { name: "pink",   hex: "#fcc2d7" },
      { name: "orange", hex: "#ffd8a8" },
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

    if (cloudSync && cloudSync.isConfigured && record) {
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
    if (!isActive) return; // highlighting not enabled for this page
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
    console.log("[Context Scribe] Message:", msg.action);
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
      console.log("[Context Scribe] Theme set to:", currentTheme);
    }
    if (msg.action === "set-active") {
      isActive = !!msg.active;
      console.log("[Context Scribe] Highlighting", isActive ? "ENABLED" : "DISABLED");
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
    console.log("[Context Scribe] Direct trigger received");
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
    console.log(`[Context Scribe] SPA navigation: → ${newUrl}`);
    lastKnownUrl = newUrl;
    closeActionBar();
    closeTooltip();

    // Re-subscribe SSE to the new URL
    if (cloudSync && cloudSync.isConfigured) {
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
        cloudSync.unsubscribe();
        cloudSync = null;
        console.log("[Context Scribe] Cloud sync disconnected");
      }
      return;
    }

    cloudSync = new CloudSync();
    cloudSync.configure(config.firebaseUrl, config.packKey);
    console.log("[Context Scribe] Cloud sync active — pack:", config.packKey);

    cloudSubscribeCurrentUrl();
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
        console.log("[Context Scribe] Cloud highlight received:", remoteHighlight.text?.slice(0, 50));

        // Skip if already painted locally
        if (document.querySelector(`[data-cs-id="${remoteHighlight.id}"]`)) return;

        // Paint it on the page
        let painted = false;
        try {
          if (remoteHighlight.anchor) {
            const startNode = resolveXPath(remoteHighlight.anchor.startContainerXPath);
            const endNode = resolveXPath(remoteHighlight.anchor.endContainerXPath);
            if (startNode && endNode) {
              const range = document.createRange();
              range.setStart(startNode, remoteHighlight.anchor.startOffset);
              range.setEnd(endNode, remoteHighlight.anchor.endOffset);
              const rangeText = range.toString().trim();
              if (rangeText && (rangeText === remoteHighlight.text || remoteHighlight.text.includes(rangeText) || rangeText.includes(remoteHighlight.text))) {
                wrapRange(range, remoteHighlight.id, remoteHighlight.color || "yellow");
                painted = true;
              }
            }
          }
        } catch {}

        if (!painted && remoteHighlight.text) {
          const range = findTextInDOM(remoteHighlight.text);
          if (range) {
            wrapRange(range, remoteHighlight.id, remoteHighlight.color || "yellow");
            painted = true;
          }
        }

        if (painted) {
          // Add to local cache so it persists
          const existing = highlights.find(h => h.id === remoteHighlight.id);
          if (!existing) {
            const { _author, ...clean } = remoteHighlight;
            clean._cloud = true;
            highlights.push(clean);
            saveHighlights();
          }
          console.log("[Context Scribe] Cloud highlight painted:", remoteHighlight.text?.slice(0, 40));
        } else {
          console.log("[Context Scribe] Cloud highlight could not be painted:", remoteHighlight.text?.slice(0, 40));
        }
      },
      (deletedId) => {
        console.log("[Context Scribe] Cloud highlight deleted:", deletedId);
        removeHighlight(deletedId);
      }
    );
  }

  /* ════════════════════════════════════════════
     INIT — load prefs + highlights & repaint
     ════════════════════════════════════════════ */
  // Load saved preferences (theme + global highlight toggle + cloud config)
  chrome.storage.local.get(["theme", "highlightingEnabled", "cloudPack"], (prefs) => {
    currentTheme = prefs.theme || "dark";
    isActive = prefs.highlightingEnabled !== false; // default ON
    console.log("[Context Scribe] Theme:", currentTheme, "| Highlighting:", isActive ? "ON" : "OFF");

    if (prefs.cloudPack && prefs.cloudPack.firebaseUrl && prefs.cloudPack.packKey) {
      initCloudSync(prefs.cloudPack);
    }
  });

  // React to changes from popup/other tabs in real-time
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.highlightingEnabled) {
      isActive = changes.highlightingEnabled.newValue !== false;
      console.log("[Context Scribe] Highlighting toggled globally:", isActive ? "ON" : "OFF");
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
})();
