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
  let _actionBarGen = 0;       // generation counter to cancel stale async showActionBar calls
  let lastSavedRange = null;   // cloned Range preserved across focus loss
  let lastSavedText = "";     // plain text backup of selection
  let repaintAttempted = false;
  let currentTheme = "dark";  // synced from chrome.storage
  let isActive = false;        // global activation — persisted in chrome.storage
  let cloudSync = null;        // CloudSync instance (null = cloud disabled)
  const _recentlyDeletedIds = new Set(); // track deleted IDs to ignore cloud restore attempts
  const IC = {
    sun:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`,
    moon:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`,
    trash: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`,
    check: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
    close: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
    send:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9l20-7z"/></svg>`,
  };

  const _nameColors = {
    Amber:"#f59e0b",Azure:"#3b82f6",Coral:"#f97316",Cyan:"#06b6d4",
    Ember:"#ef4444",Jade:"#10b981",Lime:"#84cc16",Mint:"#34d399",
    Navy:"#1e40af",Onyx:"#71717a",Pearl:"#e2e8f0",Rose:"#f43f5e",
    Ruby:"#dc2626",Sage:"#94a3b8",Slate:"#64748b",Teal:"#14b8a6",
    Violet:"#8b5cf6",Zinc:"#a1a1aa",
  };

  function getComments(record) {
    if (Array.isArray(record.comments) && record.comments.length > 0) return record.comments;
    if (record.note) return [{ text: record.note, author: record._authorName || "You", createdAt: record.createdAt }];
    return [];
  }

  function relativeTime(dateStr) {
    const diff = Date.now() - new Date(dateStr).getTime();
    if (diff < 60000) return "just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
    return new Date(dateStr).toLocaleDateString();
  }

  function authorAvatar(name) {
    const parts = (name || "Anonymous").split(" ");
    const color = _nameColors[parts[0]] || "#71717a";
    const initial = (parts[1] || parts[0] || "?").charAt(0);
    return `<span class="cs-comment-avatar" style="background:${color}">${initial}</span>`;
  }

  function normalizeHex(h) {
    if (!h || typeof h !== "string") return "";
    let x = h.trim().toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(x)) {
      x = "#" + x[1] + x[1] + x[2] + x[2] + x[3] + x[3];
    }
    return x;
  }

  /** 8 colors: 4 warm | separator | 4 cool */
  const PICKER_BEFORE_SEP = [
    { name: "yellow", hex: "#facc15", title: "Yellow" },
    { name: "green", hex: "#34d399", title: "Green" },
    { name: "blue", hex: "#60a5fa", title: "Blue" },
    { name: "pink", hex: "#f472b6", title: "Pink" },
  ];
  const PICKER_AFTER_SEP = [
    { name: "red", hex: "#ef4444", title: "Red" },
    { name: "orange", hex: "#fb923c", title: "Orange" },
    { name: "violet", hex: "#8b5cf6", title: "Purple" },
    { name: "teal", hex: "#14b8a6", title: "Teal" },
  ];
  const HI_PICKER = [...PICKER_BEFORE_SEP, ...PICKER_AFTER_SEP];
  const HI_PICKER_MATCH = [...HI_PICKER];
  const DEFAULT_CREATE_RAW_COLOR = "orange";

  function labelToHighlightColor(hex) {
    const norm = normalizeHex(hex);
    if (!/^#[0-9a-f]{6}$/.test(norm)) return "yellow";
    const r = parseInt(norm.slice(1, 3), 16), g = parseInt(norm.slice(3, 5), 16), b = parseInt(norm.slice(5, 7), 16);
    let best = "yellow", bestD = Infinity;
    for (const e of HI_PICKER_MATCH) {
      const h = normalizeHex(e.hex);
      const dr = r - parseInt(h.slice(1, 3), 16), dg = g - parseInt(h.slice(3, 5), 16), db = b - parseInt(h.slice(5, 7), 16);
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = e.name; }
    }
    return best;
  }

  function useRoomLabelMode() {
    return !!(cloudSync && cloudSync.isConfigured && Object.keys(cloudSync.roomLabels || {}).length > 0);
  }

  function escapeAttr(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  function buildColorPickerHtml(record) {
    // If room has custom labels, show ONLY those (no default colors)
    if (useRoomLabelMode()) {
      const labels = cloudSync.roomLabels || {};
      const labelKeys = Object.keys(labels);
      const labelDot = (k) => {
        const lb = labels[k];
        const active = record ? record.label === k : false;
        let ring = normalizeHex(lb.color || "");
        if (!/^#[0-9a-f]{6}$/.test(ring)) ring = "#71717a";
        return `<button type="button" class="cs-lp-dot cs-lp-dot-label${active ? " active" : ""}" style="--lp-ring:${ring}" data-lbl="${escapeAttr(k)}" title="${escapeAttr(lb.name)}"><span style="background:${lb.color}"></span></button>`;
      };
      const dots = [...labelKeys].sort().map(labelDot).join("");
      return `<div class="cs-label-picker" role="group" aria-label="Room labels">${dots}</div>`;
    }
    
    // Otherwise show default colors
    const rawDot = (c) => {
      const active = record
        ? (record.color === c.name && !record.label)
        : c.name === DEFAULT_CREATE_RAW_COLOR;
      let ring = normalizeHex(c.hex);
      if (!/^#[0-9a-f]{6}$/.test(ring)) ring = "#71717a";
      return `<button type="button" class="cs-lp-dot cs-lp-dot-raw${active ? " active" : ""}" style="--lp-ring:${ring}" data-rawcolor="${c.name}" title="${escapeAttr(c.title)}"><span style="background:${c.hex}"></span></button>`;
    };
    const before = PICKER_BEFORE_SEP.map(rawDot).join("");
    const after = PICKER_AFTER_SEP.map(rawDot).join("");
    const sep = `<span class="cs-lp-sep-v" aria-hidden="true"></span>`;
    return `<div class="cs-label-picker" role="group" aria-label="Highlight colors">${before}${sep}${after}</div>`;
  }
  
  // Alias for backward compatibility
  function buildRawColorPickerHtml(record) {
    return buildColorPickerHtml(record);
  }

  /** Second row: room labels (only when cloud labels exist). Does not replace the color strip. */
  function buildRoomLabelPickerRow(record, labels, labelKeys) {
    if (!labelKeys.length) return "";
    const labelDot = (k) => {
      const lb = labels[k];
      const active = record ? record.label === k : false;
      let ring = normalizeHex(lb.color || "");
      if (!/^#[0-9a-f]{6}$/.test(ring)) ring = "#71717a";
      return `<button type="button" class="cs-lp-dot cs-lp-dot-label${active ? " active" : ""}" style="--lp-ring:${ring}" data-lbl="${escapeAttr(k)}" title="${escapeAttr(lb.name)}"><span style="background:${lb.color}"></span></button>`;
    };
    const noneActive = !record || !record.label;
    const none = `<button type="button" class="cs-lp-dot cs-lp-dot-label${noneActive ? " active" : ""}" style="--lp-ring:#71717a" data-lbl="" title="No label"><span style="background:#71717a"></span></button>`;
    const dots = [...labelKeys].sort().map(labelDot).join("");
    return `<div class="cs-label-picker cs-label-picker--room-labels" role="group" aria-label="Room labels">${none}${dots}</div>`;
  }

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
    const loadUrl = normalizeUrl(url || location.href);
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: "get-all-highlights" }, (all) => {
          if (chrome.runtime.lastError) {
            console.error("[Vantage] Load failed:", chrome.runtime.lastError.message);
            showConnectionError();
            resolve([]);
            return;
          }
          
          console.log("[Vantage] Loading highlights for URL:", loadUrl);
          console.log("[Vantage] All stored URLs:", all ? Object.keys(all) : "none");
          
          // Collect highlights from ALL URL keys that normalize to this URL
          let loaded = [];
          const seenIds = new Set();
          if (all) {
            for (const [storedUrl, items] of Object.entries(all)) {
              const normStoredUrl = normalizeUrl(storedUrl);
              console.log(`[Vantage] Comparing: stored="${normStoredUrl}" vs current="${loadUrl}" match=${normStoredUrl === loadUrl}`);
              if (normStoredUrl === loadUrl) {
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
            console.log(`[Vantage] Found ${loaded.length} highlights, texts:`, loaded.map(h => h.text?.slice(0,30)));
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

          // Only save highlights for the CURRENT page URL to avoid overwriting other pages
          const currentUrl = getCurrentUrl();
          const currentPageHighlights = highlights.filter(h => normalizeUrl(h.url || currentUrl) === currentUrl);
          
          // Normalize URLs on the highlights we're saving
          for (const h of currentPageHighlights) {
            h.url = normalizeUrl(h.url || currentUrl);
          }

          // Remove any old non-normalized URL keys that map to current page
          for (const storedUrl of Object.keys(data)) {
            if (normalizeUrl(storedUrl) === currentUrl && storedUrl !== currentUrl) {
              delete data[storedUrl];
            }
          }
          
          // Save current page highlights (or empty array if all deleted)
          data[currentUrl] = currentPageHighlights;

          try {
            chrome.runtime.sendMessage({ action: "save-highlights", payload: data }, () => {
              if (chrome.runtime.lastError) {
                console.error("[Vantage] Save failed (set):", chrome.runtime.lastError.message);
                showConnectionError();
                resolve();
                return;
              }
              console.log(`[Vantage] Saved ${currentPageHighlights.length} highlights for ${currentUrl}`);
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
     Uses prefix/suffix context to disambiguate when
     the same text appears multiple times on a page.
     ════════════════════════════════════════════ */
  function findTextInDOM(searchText, prefix, suffix) {
    if (!searchText || searchText.length < 2) return null;

    // Build a concatenated string from all text nodes with position tracking
    const textNodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.parentElement?.closest(".cs-tooltip, script, style, noscript")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    
    let fullText = "";
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.textContent;
      if (text) {
        textNodes.push({ node, start: fullText.length, end: fullText.length + text.length });
        fullText += text;
      }
    }

    if (!fullText) return null;

    // Find all occurrences of searchText
    const candidates = [];
    let idx = 0;
    while ((idx = fullText.indexOf(searchText, idx)) !== -1) {
      candidates.push({ pos: idx, len: searchText.length, score: 0 });
      idx += 1;
    }

    // Also try normalized whitespace search
    if (candidates.length === 0) {
      const normSearch = searchText.replace(/\s+/g, " ").trim();
      const normFull = fullText.replace(/\s+/g, " ");
      let nIdx = 0;
      while ((nIdx = normFull.indexOf(normSearch, nIdx)) !== -1) {
        // Map back to original position (approximate)
        const origPos = mapNormToOrig(fullText, nIdx);
        candidates.push({ pos: origPos, len: searchText.length, score: -1 });
        nIdx += 1;
      }
    }

    if (candidates.length === 0) {
      console.log("[Vantage] findTextInDOM: text not found in page:", searchText.slice(0, 50));
      return null;
    }

    console.log(`[Vantage] findTextInDOM: found ${candidates.length} candidates for "${searchText.slice(0,30)}", prefix="${prefix?.slice(0,30)}", suffix="${suffix?.slice(0,30)}"`);

    // Score candidates by prefix/suffix context match
    if ((prefix || suffix) && candidates.length > 1) {
      for (const c of candidates) {
        let prefixScore = 0, suffixScore = 0;
        
        if (prefix) {
          const before = fullText.slice(Math.max(0, c.pos - prefix.length - 30), c.pos);
          const normBefore = before.replace(/\s+/g, " ").toLowerCase();
          const normPrefix = prefix.replace(/\s+/g, " ").toLowerCase();
          if (before.toLowerCase().includes(prefix.toLowerCase())) prefixScore = 3;
          else if (normBefore.includes(normPrefix)) prefixScore = 2;
          else if (normPrefix.length > 10 && normBefore.includes(normPrefix.slice(-10))) prefixScore = 1;
        }
        
        if (suffix) {
          const after = fullText.slice(c.pos + c.len, c.pos + c.len + suffix.length + 30);
          const normAfter = after.replace(/\s+/g, " ").toLowerCase();
          const normSuffix = suffix.replace(/\s+/g, " ").toLowerCase();
          if (after.toLowerCase().includes(suffix.toLowerCase())) suffixScore = 3;
          else if (normAfter.includes(normSuffix)) suffixScore = 2;
          else if (normSuffix.length > 10 && normAfter.includes(normSuffix.slice(0, 10))) suffixScore = 1;
        }
        
        // Big bonus when BOTH match
        c.score = (prefixScore > 0 && suffixScore > 0) ? prefixScore + suffixScore + 10 : prefixScore + suffixScore;
        c.prefixScore = prefixScore;
        c.suffixScore = suffixScore;
        
        // Log context for debugging
        const beforeCtx = fullText.slice(Math.max(0, c.pos - 30), c.pos);
        const afterCtx = fullText.slice(c.pos + c.len, c.pos + c.len + 30);
        console.log(`[Vantage] Candidate at ${c.pos}: score=${c.score} (prefix=${prefixScore}, suffix=${suffixScore}), before="${beforeCtx.slice(-20)}", after="${afterCtx.slice(0,20)}"`);
      }
      candidates.sort((a, b) => b.score - a.score);
    }

    const best = candidates[0];
    console.log(`[Vantage] Selected candidate at pos ${best.pos} with score ${best.score}`);
    
    // Build range from text node positions
    const startPos = best.pos;
    const endPos = best.pos + best.len;
    
    let startNode = null, startOff = 0, endNode = null, endOff = 0;
    for (const tn of textNodes) {
      if (!startNode && tn.end > startPos) {
        startNode = tn.node;
        startOff = startPos - tn.start;
      }
      if (startNode && tn.end >= endPos) {
        endNode = tn.node;
        endOff = endPos - tn.start;
        break;
      }
    }

    if (startNode && endNode) {
      try {
        const range = document.createRange();
        range.setStart(startNode, startOff);
        range.setEnd(endNode, endOff);
        console.log("[Vantage] findTextInDOM: created range for:", range.toString().slice(0, 50));
        return range;
      } catch (e) {
        console.log("[Vantage] findTextInDOM: range creation failed:", e.message);
      }
    }

    console.log("[Vantage] findTextInDOM: could not build range");
    return null;
  }

  function mapNormToOrig(bodyText, normPos) {
    let orig = 0, ni = 0;
    for (; orig < bodyText.length && ni < normPos; orig++) {
      if (/\s/.test(bodyText[orig])) {
        if (orig === 0 || !/\s/.test(bodyText[orig - 1])) ni++;
      } else {
        ni++;
      }
    }
    return orig;
  }

  function findSingleTextNode(searchText) {
    const walker = document.createTreeWalker(
      document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node.parentElement && node.parentElement.closest(".cs-tooltip"))
            return NodeFilter.FILTER_REJECT;
          return node.textContent.includes(searchText)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP;
        }
      }
    );
    const textNode = walker.nextNode();
    if (textNode) {
      const off = textNode.textContent.indexOf(searchText);
      if (off !== -1) {
        const range = document.createRange();
        range.setStart(textNode, off);
        range.setEnd(textNode, off + searchText.length);
        return range;
      }
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
        if (node.parentElement && node.parentElement.closest(".cs-tooltip")) {
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
  function captureSelection(color = "yellow", label = null) {
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

    // Capture text context (prefix/suffix) for robust fallback anchoring
    let prefix = "", suffix = "";
    try {
      const bodyText = document.body.innerText;
      const selPos = bodyText.indexOf(text);
      if (selPos !== -1) {
        prefix = bodyText.slice(Math.max(0, selPos - 32), selPos).replace(/\s+/g, " ").trim();
        suffix = bodyText.slice(selPos + text.length, selPos + text.length + 32).replace(/\s+/g, " ").trim();
      }
    } catch {}

    const anchor = {
      startContainerXPath: getXPath(range.startContainer),
      startOffset: range.startOffset,
      endContainerXPath: getXPath(range.endContainer),
      endOffset: range.endOffset,
      prefix,
      suffix,
    };

    const record = {
      id,
      text,
      comments: [],
      color,
      anchor,
      createdAt: new Date().toISOString(),
      url: getCurrentUrl(),
      title: document.title,
    };
    if (label) record.label = label;

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
     Text-search based: finds each highlight's text
     in the live DOM using prefix/suffix context for
     disambiguation.
     ════════════════════════════════════════════ */
  function repaintAll() {
    const currentUrl = getCurrentUrl();
    const pageHighlights = highlights.filter(h => normalizeUrl(h.url) === currentUrl);

    console.log(`[Vantage] repaintAll: currentUrl=${currentUrl}, total highlights=${highlights.length}, for this page=${pageHighlights.length}`);

    if (pageHighlights.length === 0) {
      console.log("[Vantage] No highlights to repaint for this URL");
      return;
    }

    let painted = 0;
    let failed = 0;

    for (const h of pageHighlights) {
      if (document.querySelector(`[data-cs-id="${h.id}"]`)) { painted++; continue; }
      try {
        console.log(`[Vantage] Trying to repaint: "${h.text?.slice(0,40)}" prefix="${h.anchor?.prefix?.slice(0,20)}" suffix="${h.anchor?.suffix?.slice(0,20)}"`);
        const range = findTextInDOM(h.text, h.anchor?.prefix, h.anchor?.suffix);
        if (range) {
          console.log(`[Vantage] Found range for: "${h.text?.slice(0,40)}", range text: "${range.toString().slice(0,40)}"`);
          wrapRange(range, h.id, h.color || "yellow");
          painted++;
        } else {
          failed++;
          console.log(`[Vantage] Could not find text in DOM: "${h.text?.slice(0,60)}"`);
        }
      } catch (e) {
        failed++;
        console.log(`[Vantage] Repaint failed for "${h.text?.slice(0,40)}":`, e.message);
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

      for (const h of unpainted) {
        if (document.querySelector(`[data-cs-id="${h.id}"]`)) continue;
        try {
          const range = findTextInDOM(h.text, h.anchor?.prefix, h.anchor?.suffix);
          if (range) wrapRange(range, h.id, h.color || "yellow");
        } catch { /* skip */ }
      }
    }, retryInterval);
  }

  /* ════════════════════════════════════════════
     TOOLTIP (Note Editor)
     ════════════════════════════════════════════ */
  async function showTooltip(highlightEl) {
    closeTooltip();
    closeActionBar();

    const id = highlightEl.dataset.csId;
    const record = highlights.find(h => h.id === id);
    if (!record) return;

    if (cloudSync?.isConfigured) await cloudSync.fetchLabels();

    const isCloudHighlight = !!record._cloud;
    const isViewerRole = cloudSync && cloudSync.role === CloudSync.ROLES.VIEWER;
    const canComment = !isViewerRole;
    const canDeleteThis = !cloudSync || cloudSync.canDelete || (!isCloudHighlight);
    const hasCloud = cloudSync && cloudSync.isConfigured;
    const labels = hasCloud ? cloudSync.roomLabels : {};
    const labelKeys = Object.keys(labels);
    const labelMode = useRoomLabelMode();

    const rect = highlightEl.getBoundingClientRect();
    const tooltip = document.createElement("div");
    tooltip.className = `cs-tooltip${currentTheme === "light" ? " cs-light" : ""}`;
    tooltip.dataset.highlightId = id;

    let labelPickerHtml = "";
    if (canComment) {
      labelPickerHtml = buildRawColorPickerHtml(record);
    } else if (record.label) {
      const lb = labels[record.label];
      const lbName = lb ? lb.name : record.label;
      const lbColor = lb ? lb.color : "#71717a";
      labelPickerHtml = `<div class="cs-label-picker"><span class="cs-lp-badge" style="--lb-color:${escapeAttr(lbColor)}"><span class="cs-lp-badge-dot" style="background:${lbColor}"></span>${escapeHtml(lbName)}</span></div>`;
    }

    /* Show author name - use cloud name, or fallback to "You" for local highlights */
    const authorName = record._authorName || (cloudSync && cloudSync._userName) || "You";
    const authorHtml = `<span class="cs-tp-author">${authorAvatar(authorName)}${escapeHtml(authorName)}</span>`;

    const comments = getComments(record);
    const commentsHtml = comments.length > 0
      ? comments
          .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
          .map(c => `<div class="cs-comment-item"><span class="cs-comment-who">${authorAvatar(c.author)}<strong>${escapeHtml(c.author || "Anonymous")}</strong><span class="cs-comment-time">${relativeTime(c.createdAt)}</span></span><div class="cs-comment-text">${escapeHtml(c.text)}</div></div>`
          ).join("")
      : "";

    const inputHtml = canComment
      ? `<div class="cs-comment-input-row">
           <textarea class="cs-comment-input" placeholder="Comment… (Ctrl+Enter)" rows="2"></textarea>
           <button type="button" class="cs-icon-btn cs-send-comment" title="Send">${IC.send}</button>
         </div>`
      : "";

    tooltip.innerHTML = `
      <div class="cs-tooltip-header">
        ${authorHtml}
        <div class="cs-tooltip-actions">
          ${canDeleteThis ? `<button type="button" class="cs-icon-btn cs-delete" title="Delete">${IC.trash}</button>` : ""}
          <button type="button" class="cs-icon-btn cs-tooltip-close" title="Close">${IC.close}</button>
        </div>
      </div>
      ${labelPickerHtml}
      <div class="cs-comments-list">${commentsHtml}</div>
      ${inputHtml}
    `;

    tooltip.style.top = (window.scrollY + rect.bottom + 6) + "px";
    tooltip.style.left = Math.max(8, window.scrollX + rect.left - 12) + "px";
    document.body.appendChild(tooltip);
    activeTooltip = tooltip;

    const commentsList = tooltip.querySelector(".cs-comments-list");
    if (commentsList) commentsList.scrollTop = commentsList.scrollHeight;

    tooltip.querySelector(".cs-tooltip-close").addEventListener("click", closeTooltip);

    const deleteBtn = tooltip.querySelector(".cs-delete");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", () => { removeHighlight(id); closeTooltip(); });
    }

    function applyColorToSpans(highlightId, colorName) {
      const c = colorName || "yellow";
      document.querySelectorAll(`[data-cs-id="${highlightId}"]`).forEach(span => {
        span.className = `cs-highlight${c !== "yellow" ? ` cs-color-${c}` : ""}`;
      });
    }

    tooltip.querySelectorAll(".cs-lp-dot").forEach(dot => {
      dot.addEventListener("click", () => {
        const rawColor = dot.dataset.rawcolor;
        const lblKey = dot.dataset.lbl;
        if (rawColor) {
          record.color = rawColor;
          delete record.label;
          applyColorToSpans(id, rawColor);
        } else if (lblKey !== undefined) {
          if (lblKey === "") delete record.label;
          else if (labels[lblKey]) {
            record.label = lblKey;
            record.color = labelToHighlightColor(labels[lblKey].color);
          }
          applyColorToSpans(id, record.color || "yellow");
        } else {
          return;
        }
        saveHighlights();
        if (hasCloud) cloudSync.pushHighlight(record).catch(() => {});
        tooltip.querySelectorAll(".cs-lp-dot").forEach(d => d.classList.remove("active"));
        dot.classList.add("active");
      });
    });

    const inputArea = tooltip.querySelector(".cs-comment-input");
    const sendBtn = tooltip.querySelector(".cs-send-comment");
    if (inputArea && sendBtn) {
      const submitComment = () => {
        const text = inputArea.value.trim();
        if (!text) return;
        const myName = (cloudSync && cloudSync._userName) || "You";
        if (!Array.isArray(record.comments)) record.comments = [];
        record.comments.push({ text, author: myName, createdAt: new Date().toISOString() });
        delete record.note;
        saveHighlights();
        if (hasCloud) cloudSync.pushHighlight(record).catch(() => {});
        refreshOpenTooltip(id);
      };
      sendBtn.addEventListener("click", submitComment);
      inputArea.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeTooltip();
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitComment(); }
      });
      inputArea.focus();
    }
  }

  function refreshOpenTooltip(highlightId) {
    if (!activeTooltip || activeTooltip.dataset.highlightId !== highlightId) return;
    const record = highlights.find(h => h.id === highlightId);
    if (!record) return;

    /* Update comments list in-place without closing/reopening */
    const listEl = activeTooltip.querySelector(".cs-comments-list");
    const inputArea = activeTooltip.querySelector(".cs-comment-input");
    if (listEl) {
      const comments = getComments(record);
      listEl.innerHTML = comments.length > 0
        ? comments
            .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
            .map(c => `<div class="cs-comment-item"><span class="cs-comment-who">${authorAvatar(c.author)}<strong>${escapeHtml(c.author || "Anonymous")}</strong><span class="cs-comment-time">${relativeTime(c.createdAt)}</span></span><div class="cs-comment-text">${escapeHtml(c.text)}</div></div>`)
            .join("")
        : "";
      listEl.scrollTop = listEl.scrollHeight;
    }
    if (inputArea) {
      inputArea.value = "";
      inputArea.focus();
    }
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str || "";
    return d.innerHTML;
  }

  function closeTooltip() {
    if (activeTooltip) {
      activeTooltip.remove();
      activeTooltip = null;
    }
  }

  function getSelectionClientRect() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return r;
  }

  /* ════════════════════════════════════════════
     CREATE CARD (selection → compact popover, same shell as tooltip)
     ════════════════════════════════════════════ */
  async function showActionBar() {
    closeActionBar();
    closeTooltip();

    /* ── Eagerly capture everything BEFORE any async work ── */
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const selText = sel.toString().trim();
    if (!selText) return;
    const selRect = sel.getRangeAt(0).getBoundingClientRect();
    if (!selRect.width && !selRect.height) return;

    /* Capture the actual Range while selection is still live — this is the ground truth. */
    const selRange = sel.getRangeAt(0).cloneRange();

    /* Get prefix/suffix directly from the DOM around the ACTUAL selection Range */
    let selPrefix = "", selSuffix = "";
    try {
      // Get text BEFORE the selection by expanding range backwards
      const prefixRange = document.createRange();
      prefixRange.setStart(document.body, 0);
      prefixRange.setEnd(selRange.startContainer, selRange.startOffset);
      const prefixText = prefixRange.toString();
      selPrefix = prefixText.slice(-80).replace(/\s+/g, " ").trim();
      
      // Get text AFTER the selection by creating a range from end to a far point
      const suffixRange = document.createRange();
      suffixRange.setStart(selRange.endContainer, selRange.endOffset);
      suffixRange.setEndAfter(document.body.lastChild || document.body);
      const suffixText = suffixRange.toString();
      selSuffix = suffixText.slice(0, 80).replace(/\s+/g, " ").trim();
      
      console.log(`[Vantage] Captured context - prefix: "${selPrefix.slice(-30)}", suffix: "${selSuffix.slice(0,30)}"`);
    } catch (e) {
      console.log("[Vantage] Failed to capture prefix/suffix:", e.message);
    }

    const gen = ++_actionBarGen;
    /* Don't await fetchLabels — let it run in background to avoid flaky UX */
    if (cloudSync?.isConfigured) {
      cloudSync.fetchLabels().catch(() => {});
    }
    if (gen !== _actionBarGen) return;

    const myName = (cloudSync && cloudSync._userName) || "You";

    const pop = document.createElement("div");
    pop.className = "cs-tooltip cs-light cs-create-popover";
    const pickerHtml = buildRawColorPickerHtml(null);
    pop.innerHTML = pickerHtml;

    /* Position to left or right of selection based on available space */
    const popWidth = 210;
    const selCenterX = selRect.left + selRect.width / 2;
    const spaceOnRight = window.innerWidth - selRect.right;
    const spaceOnLeft = selRect.left;

    let leftPos;
    if (spaceOnRight >= popWidth + 20) {
      /* Enough space on right — align to right edge of selection */
      leftPos = window.scrollX + selRect.right - popWidth;
    } else if (spaceOnLeft >= popWidth + 20) {
      /* Enough space on left — align to left edge of selection */
      leftPos = window.scrollX + selRect.left;
    } else {
      /* Fallback: center it as best we can */
      leftPos = Math.max(10, Math.min(window.scrollX + selCenterX - popWidth / 2, window.innerWidth - popWidth - 10));
    }

    pop.style.top = (window.scrollY + selRect.bottom + 4) + "px";
    pop.style.left = leftPos + "px";
    document.body.appendChild(pop);
    activeActionBar = pop;

    function doCreate(color, label) {
      /* Try the original cloned Range first — it's the most accurate */
      let range = null;
      try {
        if (selRange && selRange.toString().trim() === selText) {
          range = selRange;
        }
      } catch {}

      /* Fallback: re-find the text using prefix/suffix context */
      if (!range) {
        range = findTextInDOM(selText, selPrefix, selSuffix);
      }

      if (!range) {
        console.warn("[Vantage] Could not find selected text in DOM for highlight");
        closeActionBar();
        return;
      }

      const id = uid();
      
      // Determine color: if label, use label's color; otherwise use raw color
      let finalColor = color || DEFAULT_CREATE_RAW_COLOR;
      if (label && cloudSync?.roomLabels?.[label]) {
        finalColor = labelToHighlightColor(cloudSync.roomLabels[label].color);
      }
      
      wrapRange(range, id, finalColor);
      try { window.getSelection()?.removeAllRanges(); } catch {}

      const record = {
        id,
        text: selText,
        comments: [],
        color: finalColor,
        anchor: {
          startContainerXPath: getXPath(range.startContainer),
          startOffset: range.startOffset,
          endContainerXPath: getXPath(range.endContainer),
          endOffset: range.endOffset,
          prefix: selPrefix,
          suffix: selSuffix,
        },
        createdAt: new Date().toISOString(),
        url: getCurrentUrl(),
        title: document.title,
      };
      
      // Add label if using room labels
      if (label) {
        record.label = label;
      }

      highlights.push(record);
      saveHighlights();
      if (cloudSync && cloudSync.isConfigured && cloudSync.canHighlight) {
        cloudSync.pushHighlight(record).catch(() => {});
      }

      closeActionBar();
      console.log("[Vantage] Highlighted:", selText.slice(0, 60), "with", label ? `label: ${label}` : `color: ${finalColor}`);

      /* Auto-open tooltip for the new highlight */
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-cs-id="${id}"]`);
        if (el) showTooltip(el);
      });
    }

    /* Use event delegation for clicks on color dots */
    pop.addEventListener("mousedown", (e) => {
      e.preventDefault();
    });
    
    pop.addEventListener("click", (e) => {
      const dot = e.target.closest(".cs-lp-dot");
      if (dot) {
        e.preventDefault();
        e.stopPropagation();
        
        // Check if it's a label dot or a raw color dot
        const label = dot.dataset.lbl;
        const color = dot.dataset.rawcolor;
        
        if (label !== undefined) {
          // Label mode
          console.log("[Vantage] Label dot clicked:", label);
          doCreate(null, label);
        } else if (color) {
          // Raw color mode
          console.log("[Vantage] Color dot clicked:", color);
          doCreate(color, null);
        }
      }
    });
  }

  function closeActionBar() {
    _actionBarGen++;
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
    
    // Track this ID to prevent cloud sync from restoring it
    _recentlyDeletedIds.add(id);
    setTimeout(() => _recentlyDeletedIds.delete(id), 10000); // clear after 10s
    
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
    if (e.target.closest(".cs-tooltip")) return;
    if (e.target.closest(".cs-highlight")) return; // don't open create popover when clicking highlights

    setTimeout(() => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) {
        showActionBar();
      } else {
        closeActionBar();
      }
    }, 10);
  });

  // Click on existing highlight → open tooltip
  document.addEventListener("click", (e) => {
    if (e.target.closest(".cs-create-popover")) return;
    const hlEl = e.target.closest(".cs-highlight");
    if (hlEl) {
      e.preventDefault();
      e.stopPropagation();
      closeActionBar(); // close create popover if open
      showTooltip(hlEl);
      return;
    }
    if (activeTooltip && !e.target.closest(".cs-tooltip")) {
      closeTooltip();
    }
    if (activeActionBar && !e.target.closest(".cs-tooltip")) {
      closeActionBar();
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

    for (const h of unpainted) {
      if (document.querySelector(`[data-cs-id="${h.id}"]`)) continue;
      try {
        const range = findTextInDOM(h.text, h.anchor?.prefix, h.anchor?.suffix);
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
    if (cloudSync) {
      cloudSync.disconnectAll();
      cloudSync = null;
    }

    if (!config || !config.firebaseUrl || !config.packKey) {
      removePresenceIndicator();
      console.log("[Vantage] Cloud sync disconnected");
      return;
    }

    cloudSync = new CloudSync();
    cloudSync.configure(config.firebaseUrl, config.packKey, config.role || "viewer", config.userName);
    cloudSync.fetchLabels();

    fetchAndMergeCloudHighlights();
    cloudSubscribeCurrentUrl();

    cloudSync._nameReady.then(() => {
      console.log("[Vantage] Cloud sync active — pack:", config.packKey, "role:", config.role, "as:", cloudSync._userName);
      cloudSync.startHeartbeat(getCurrentUrl);
    });
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

    indicator.classList.toggle("vp-light", currentTheme === "light");

    const names = others.map(([, v]) => v.name || "Anonymous");
    const overflow = names.length > 3 ? ` +${names.length - 3}` : "";
    const nameChips = names.slice(0, 3).map(n => {
      const parts = n.split(" ");
      const color = _nameColors[parts[0]] || "#71717a";
      const initial = (parts[1] || parts[0] || "?").charAt(0);
      return `<span class="vp-name"><span class="vp-avatar" style="background:${color}">${initial}</span>${n}</span>`;
    }).join("") + (overflow ? `<span class="vp-overflow">${overflow}</span>` : "");

    indicator.innerHTML = `
      <span class="vp-dot"></span>
      <span class="vp-count">${count}</span>
      <span class="vp-label">online</span>
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
        // Skip if recently deleted locally
        if (_recentlyDeletedIds.has(id)) {
          console.log("[Vantage] Skipping recently deleted highlight from cloud:", id);
          continue;
        }
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
        // Ignore if this was recently deleted locally
        if (_recentlyDeletedIds.has(remoteHighlight.id)) {
          console.log("[Vantage] Ignoring cloud highlight (recently deleted):", remoteHighlight.id);
          return;
        }
        
        console.log("[Vantage] Cloud highlight received:", remoteHighlight.text?.slice(0, 50));

        if (document.querySelector(`[data-cs-id="${remoteHighlight.id}"]`)) return;

        const existing = highlights.find(h => h.id === remoteHighlight.id);
        if (!existing) {
          const { _author, ...clean } = remoteHighlight;
          clean._cloud = true;
          if (!clean._authorName) delete clean._authorName;
          highlights.push(clean);
          saveHighlights();
        }

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
      },
      (updatedHighlight) => {
        // Ignore if this was recently deleted locally
        if (_recentlyDeletedIds.has(updatedHighlight.id)) {
          console.log("[Vantage] Ignoring cloud update (recently deleted):", updatedHighlight.id);
          return;
        }
        
        const local = highlights.find(h => h.id === updatedHighlight.id);
        if (!local) return;
        if (updatedHighlight.comments) local.comments = updatedHighlight.comments;
        if (updatedHighlight.note !== undefined) local.note = updatedHighlight.note;
        saveHighlights();
        refreshOpenTooltip(local.id);
      }
    );
  }

  function tryPaintCloudHighlight(hl) {
    if (document.querySelector(`[data-cs-id="${hl.id}"]`)) return true;
    if (!hl.text) return false;
    try {
      const range = findTextInDOM(hl.text, hl.anchor?.prefix, hl.anchor?.suffix);
      if (range) {
        wrapRange(range, hl.id, hl.color || "yellow");
        return true;
      }
    } catch {}
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
