// dechora-bookmark.js
// Dechora bookmarklet runtime injected into the current page.
//
// Features:
// - Adds "Add item" buttons on images larger than 100x100px.
// - Provides an "armed" overlay that hijacks the next click and picks the image under the cursor.
// - Detects product grid cards by checking for product name and price near the image.
// - If it looks like a grid card, it follows the product link, fetches the product page,
//   and extracts productName, productCategory and manufacturer.
// - Shows a right-side sliding panel with an iframe when launched.
// - Logs the final item object to the console (you can wire it to your app instead).

(function () {
  // Avoid double injection if user clicks the bookmark twice
  if (window.__dechoraBookmarkActive) {
    console.log("Dechora bookmark already active");
    return;
  }
  window.__dechoraBookmarkActive = true;

  console.log("Dechora bookmark: script started");

  // ================================================================
  // Configuration
  // ================================================================

  // Change to your real app URL (Lovable preview, etc)
  const PANEL_IFRAME_URL = "https://dechora.ai/demo";

  const MIN_IMAGE_WIDTH = 100;
  const MIN_IMAGE_HEIGHT = 100;
  const MAX_IMAGE_WIDTH = 1000;
  const MAX_IMAGE_HEIGHT = 1000;

  // Where the item ends up – customize this to talk to your app
  function outputItem(item) {
    console.log("Dechora item", item);

    // Example: open your web app with the item as a query parameter
    // const url =
    //   PANEL_IFRAME_URL +
    //   "?item=" +
    //   encodeURIComponent(JSON.stringify(item));
    // window.open(url, "_blank");
  }

  // ================================================================
  // Utilities
  // ================================================================

  function textFrom(el) {
    if (!el) return "";
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function pickBestText(nodes, maxLen, role) {
    let best = "";
    let bestScore = -Infinity;

    nodes.forEach((n) => {
      const t = textFrom(n);
      if (!t) return;
      if (maxLen && t.length > maxLen) return;

      const len = t.length;
      const ideal = role === "category" ? 30 : 50;
      let score = -Math.abs(len - ideal);

      const lower = t.toLowerCase();
      const hasCurrency = /(kr|sek|nok|dkk|eur|usd|\$|€|£)/i.test(lower);
      const digitCount = (t.match(/\d/g) || []).length;

      // Prices and CTAs should not be picked as names or brands
      if (role === "name" || role === "brand") {
        if (hasCurrency) score -= 12;
        if (digitCount >= 4) score -= 8;
      }

      if (/add to cart|buy now|köp nu|lägg i varukorg/i.test(lower)) {
        score -= 20;
      }

      if (digitCount >= 3 && hasCurrency && role === "category") {
        score -= 8;
      }

      const letters = t.replace(/[^a-zA-ZÅÄÖåäö]/g, "");
      if (letters.length >= 4) {
        const caps = (t.match(/[A-ZÅÄÖ]/g) || []).length;
        if (caps / letters.length > 0.9) score -= 4;
      }

      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    });

    return best || "";
  }

  function getOriginalUrl(img) {
    if (img.dataset.dechoraOriginalUrl) return img.dataset.dechoraOriginalUrl;

    const lazy1 = img.getAttribute("data-src") || "";
    const lazy2 = img.getAttribute("data-original") || "";
    const lazySet = img.getAttribute("data-srcset") || "";
    const lazySetFirst = lazySet ? lazySet.split(/\s+/)[0] : "";

    const url =
      img.currentSrc ||
      img.src ||
      lazy1 ||
      lazy2 ||
      lazySetFirst ||
      "";

    if (url) img.dataset.dechoraOriginalUrl = url;

    return url;
  }

  function isEligibleImage(img) {
    if (!img || img.nodeType !== Node.ELEMENT_NODE) return false;

    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    if (rect.width < MIN_IMAGE_WIDTH || rect.height < MIN_IMAGE_HEIGHT) return false;
    if (rect.width > MAX_IMAGE_WIDTH || rect.height > MAX_IMAGE_HEIGHT) return false;

    const style = window.getComputedStyle(img);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      parseFloat(style.opacity || "1") === 0
    ) {
      return false;
    }

    return true;
  }

  function elementsUnderPoint(x, y) {
    if (document.elementsFromPoint) return document.elementsFromPoint(x, y) || [];
    const el = document.elementFromPoint(x, y);
    return el ? [el] : [];
  }

  function findImageForPoint(x, y) {
    const candidates = elementsUnderPoint(x, y);

    for (const el of candidates) {
      if (!(el instanceof Element)) continue;

      if (el.tagName === "IMG" && isEligibleImage(el)) return el;

      const closestImg = el.closest && el.closest("img");
      if (closestImg && isEligibleImage(closestImg)) return closestImg;

      if (el.querySelector) {
        const innerImg = el.querySelector("img");
        if (innerImg && isEligibleImage(innerImg)) return innerImg;
      }
    }

    return null;
  }

  // ================================================================
  // Product card detection and local meta
  // ================================================================

  function findProductRoot(img) {
    let root =
      img.closest(
        '[data-product-id], [data-product-name], [data-product-brand], [data-product-category]'
      ) ||
      img.closest('[itemtype*="Product"]');

    if (root) return root;

    root =
      img.closest(
        ".product-card, .product, .product-item, .productTile, .product-tile, .product__card, .grid__item, .productBox, .ProductTile"
      );

    if (root) return root;

    const linkRoot = img.closest("a[href]");
    if (linkRoot) return linkRoot;

    let node = img.parentElement;
    for (let depth = 0; depth < 5 && node; depth++) {
      const className = (node.className || "").toString();
      if (
        /\bproduct\b/i.test(className) ||
        /\bcard\b/i.test(className) ||
        /\bitem\b/i.test(className) ||
        /\btile\b/i.test(className)
      ) {
        return node;
      }
      node = node.parentElement;
    }

    return img.parentElement || null;
  }

  function collectNameCandidates(scope) {
    const nodes = [];
    if (!scope || !scope.querySelectorAll) return nodes;

    nodes.push(...scope.querySelectorAll('[data-product-name], [itemprop="name"]'));
    nodes.push(
      ...scope.querySelectorAll(
        '.product-title, .product_name, .product-name, .ProductName, .product__title, .card-title, .title, .product-title__text, .productTitle'
      )
    );
    nodes.push(...scope.querySelectorAll("h1, h2, h3, h4"));

    return nodes;
  }

  function collectBrandCandidates(scope) {
    const nodes = [];
    if (!scope || !scope.querySelectorAll) return nodes;

    nodes.push(
      ...scope.querySelectorAll(
        '[data-product-brand], [data-brand], [itemprop="brand"], [itemprop="manufacturer"]'
      )
    );
    nodes.push(
      ...scope.querySelectorAll(
        '.brand, .product-brand, .ProductBrand, .manufacturer, .byline, .product__brand, .product-vendor, .vendor'
      )
    );

    return nodes;
  }

  function priceCandidates(scope) {
    if (!scope || !scope.querySelectorAll) return [];
    return Array.from(
      scope.querySelectorAll(
        '.price, .product-price, [data-price], [data-product-price], .Price, .current-price, .money'
      )
    );
  }

  function extractPriceText(scope) {
    const nodes = priceCandidates(scope);
    if (!nodes.length) return "";

    let best = "";
    let bestScore = -Infinity;

    nodes.forEach((n) => {
      const t = textFrom(n);
      if (!t) return;
      const lower = t.toLowerCase();
      const hasCurrency = /(kr|sek|nok|dkk|eur|usd|\$|€|£)/i.test(lower);
      const digits = (t.match(/\d/g) || []).length;
      if (!hasCurrency || digits < 2) return;

      const len = t.length;
      let score = -Math.abs(len - 10);
      if (hasCurrency) score += 5;
      if (digits >= 3) score += 3;

      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    });

    return best || "";
  }

  function looksLikeGridProductCard(root) {
    if (!root) return false;
    const price = extractPriceText(root);
    const nameNodes = collectNameCandidates(root);
    const name = pickBestText(nameNodes, 140, "name");
    return !!(price && name);
  }

  function findProductLinkFromCard(root, img) {
    if (!root && !img) return null;

    const candidate =
      (root && root.querySelector && root.querySelector("a[href]")) ||
      (img && img.closest && img.closest("a[href]"));

    if (!candidate) return null;

    try {
      const href = candidate.getAttribute("href");
      if (!href) return null;
      return new URL(href, window.location.href).toString();
    } catch {
      return null;
    }
  }

  function extractLocalMetaFromCard(root, img) {
    const meta = {
      productName: null,
      manufacturer: null
    };

    if (!root) return meta;

    const nameNodes = collectNameCandidates(root);
    const brandNodes = collectBrandCandidates(root);

    const name = pickBestText(nameNodes, 140, "name");
    const brand = pickBestText(brandNodes, 80, "brand");

    if (name) meta.productName = name;
    if (brand) meta.manufacturer = brand;

    if (!meta.productName && img) {
      const alt = (img.getAttribute("alt") || "").trim();
      if (alt && alt.length <= 200 && !/^image|picture|product$/i.test(alt)) {
        meta.productName = alt;
      }
    }

    const dName = root.getAttribute("data-product-name");
    const dBrand = root.getAttribute("data-product-brand") || root.getAttribute("data-brand");

    if (dName && !meta.productName) meta.productName = dName;
    if (dBrand && !meta.manufacturer) meta.manufacturer = dBrand;

    return meta;
  }

  // ================================================================
  // JSON-LD and product page parsing
  // ================================================================

  function parseJsonLdProductFromDoc(doc) {
    const result = { name: null, brand: null, category: null };
    try {
      const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
      for (const script of scripts) {
        let data;
        try {
          const text = script.innerText || script.textContent || "";
          if (!text.trim()) continue;
          data = JSON.parse(text);
        } catch {
          continue;
        }

        const candidates = Array.isArray(data) ? data : [data];
        for (const obj of candidates) {
          if (!obj || typeof obj !== "object") continue;
          const type = obj["@type"] || obj.type || "";
          const types = Array.isArray(type) ? type : [type];
          const isProduct = types.some(
            (t) => typeof t === "string" && t.toLowerCase().includes("product")
          );
          if (!isProduct) continue;

          if (!result.name && typeof obj.name === "string") result.name = obj.name;
          if (!result.category && typeof obj.category === "string") result.category = obj.category;

          const brandObj = obj.brand || obj.manufacturer;
          if (brandObj) {
            if (typeof brandObj === "string") {
              if (!result.brand) result.brand = brandObj;
            } else if (typeof brandObj === "object" && typeof brandObj.name === "string") {
              if (!result.brand) result.brand = brandObj.name;
            }
          }
        }
      }
    } catch {
      // ignore
    }
    return result;
  }

  function parseHeadMetaFromDoc(doc) {
    const result = { name: null, brand: null, category: null };
    try {
      const brandMeta =
        doc.querySelector('meta[property="product:brand"]') ||
        doc.querySelector('meta[name="product:brand"]') ||
        doc.querySelector('meta[name="brand"]') ||
        doc.querySelector('meta[property="og:site_name"]');

      const catMeta =
        doc.querySelector('meta[property="product:category"]') ||
        doc.querySelector('meta[name="product:category"]') ||
        doc.querySelector('meta[name="category"]');

      const ogTitle =
        doc.querySelector('meta[property="og:title"]') ||
        doc.querySelector('meta[name="og:title"]');

      if (brandMeta) result.brand = brandMeta.getAttribute("content") || null;
      if (catMeta) result.category = catMeta.getAttribute("content") || null;
      if (ogTitle) result.name = ogTitle.getAttribute("content") || null;
    } catch {
      // ignore
    }
    return result;
  }

  function parseTitleFromDoc(doc) {
    const title = doc.title || "";
    if (!title) return { name: null, brand: null };

    const parts = title.split(/[\|\-–»]/).map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return { name: null, brand: null };

    const name = parts[0];
    let brand = null;
    if (parts.length > 1 && parts[parts.length - 1].toLowerCase() !== name.toLowerCase()) {
      brand = parts[parts.length - 1];
    }
    return { name, brand };
  }

  function mergeMeta(base, extra) {
    return {
      productName: extra.productName || extra.name || base.productName || null,
      productCategory: extra.productCategory || extra.category || null,
      manufacturer: extra.manufacturer || extra.brand || base.manufacturer || null
    };
  }

  async function fetchProductPageMeta(productUrl) {
    const meta = { productName: null, productCategory: null, manufacturer: null };

    try {
      if (!productUrl) return meta;

      const res = await fetch(productUrl, { credentials: "include" });
      if (!res.ok) {
        console.warn("Dechora: product page fetch failed", res.status);
        return meta;
      }

      const html = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");

      const jsonld = parseJsonLdProductFromDoc(doc);
      const head = parseHeadMetaFromDoc(doc);
      const fromTitle = parseTitleFromDoc(doc);

      if (jsonld.name) meta.productName = jsonld.name;
      if (jsonld.category) meta.productCategory = jsonld.category;
      if (jsonld.brand) meta.manufacturer = jsonld.brand;

      if (!meta.productName && head.name) meta.productName = head.name;
      if (!meta.productCategory && head.category) meta.productCategory = head.category;
      if (!meta.manufacturer && head.brand) meta.manufacturer = head.brand;

      if (!meta.productName && fromTitle.name) meta.productName = fromTitle.name;
      if (!meta.manufacturer && fromTitle.brand) meta.manufacturer = fromTitle.brand;

      return meta;
    } catch (err) {
      console.warn("Dechora: error fetching product page", err);
      return meta;
    }
  }

  // ================================================================
  // Build item from image
  // ================================================================

  async function buildItemForImage(img) {
    const imageUrl = getOriginalUrl(img);
    if (!imageUrl) {
      console.warn("Dechora: no imageUrl found for image");
      return null;
    }

    const root = findProductRoot(img);
    const localMeta = extractLocalMetaFromCard(root, img);

    let finalMeta = { ...localMeta };
    let productPageUrl = null;

    if (root && looksLikeGridProductCard(root)) {
      productPageUrl = findProductLinkFromCard(root, img);
      if (productPageUrl) {
        console.log("Dechora: grid card detected, fetching product page", productPageUrl);
        const remoteMeta = await fetchProductPageMeta(productPageUrl);
        finalMeta = mergeMeta(localMeta, {
          productName: remoteMeta.productName,
          productCategory: remoteMeta.productCategory,
          manufacturer: remoteMeta.manufacturer
        });
      }
    }

    const item = {
      imageUrl,
      productName: finalMeta.productName,
      productCategory: finalMeta.productCategory,
      manufacturer: finalMeta.manufacturer,
      pageUrl: window.location.href,
      productPageUrl: productPageUrl || null
    };

    return item;
  }

  async function handleImageSelection(img) {
    try {
      ensureSidePanelOpen();
      const item = await buildItemForImage(img);
      if (!item) return;
      outputItem(item);
    } catch (err) {
      console.error("Dechora: error in handleImageSelection", err);
    }
  }

  // ================================================================
  // Armed overlay
  // ================================================================

  let isArmed = false;
  let armOverlayEl = null;
  let armStyleEl = null;

  function applyArmStyle() {
    if (armStyleEl) return;
    armStyleEl = document.createElement("style");
    armStyleEl.id = "dechora-arm-style";
    armStyleEl.textContent = `
      html.dechora-armed,
      html.dechora-armed body {
        cursor: copy !important;
      }

      html.dechora-armed .dechora-save-btn {
        display: none !important;
      }
    `;
    document.head.appendChild(armStyleEl);
  }

  function removeArmStyle() {
    if (armStyleEl && armStyleEl.parentNode) {
      armStyleEl.parentNode.removeChild(armStyleEl);
    }
    armStyleEl = null;
  }

  function createArmOverlay() {
    if (armOverlayEl || !document.body) return;

    armOverlayEl = document.createElement("div");
    armOverlayEl.id = "dechora-arm-overlay";
    Object.assign(armOverlayEl.style, {
      position: "fixed",
      inset: "0",
      left: "0",
      top: "0",
      width: "100vw",
      height: "100vh",
      // Put overlay below the side panel, above buttons
      zIndex: "2147483646",
      background: "transparent",
      cursor: "copy",
      pointerEvents: "auto"
    });

    armOverlayEl.addEventListener("click", handleArmOverlayClick, true);
    document.body.appendChild(armOverlayEl);
  }

  function destroyArmOverlay() {
    if (!armOverlayEl) return;
    armOverlayEl.removeEventListener("click", handleArmOverlayClick, true);
    if (armOverlayEl.parentNode) armOverlayEl.parentNode.removeChild(armOverlayEl);
    armOverlayEl = null;
  }

  function setArmed(armed) {
    if (armed === isArmed) return;
    isArmed = armed;

    const html = document.documentElement;

    if (isArmed) {
      applyArmStyle();
      if (!html.classList.contains("dechora-armed")) html.classList.add("dechora-armed");
      createArmOverlay();
    } else {
      if (html.classList.contains("dechora-armed")) html.classList.remove("dechora-armed");
      removeArmStyle();
      destroyArmOverlay();
    }
  }

  function suppressEvent(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function handleArmOverlayClick(e) {
    if (!isArmed) return;

    console.log("Dechora: arm overlay click");
    suppressEvent(e);

    const x = e.clientX;
    const y = e.clientY;

    armOverlayEl.style.pointerEvents = "none";
    const img = findImageForPoint(x, y);
    armOverlayEl.style.pointerEvents = "auto";

    setArmed(false);

    if (!img) {
      console.warn("Dechora: no eligible image under arm click");
      return;
    }

    handleImageSelection(img);
  }

  // ================================================================
  // Side panel with iframe
  // ================================================================

  let sidePanelEl = null;

  function createSidePanel() {
    if (sidePanelEl || !document.body) return;

    sidePanelEl = document.createElement("div");
    sidePanelEl.id = "dechora-sidepanel";
    sidePanelEl.className = "dechora-sidepanel";

    const iframe = document.createElement("iframe");
    iframe.className = "dechora-sidepanel-iframe";
    iframe.src = PANEL_IFRAME_URL;
    iframe.setAttribute("frameborder", "0");
    iframe.setAttribute("loading", "lazy");

    sidePanelEl.appendChild(iframe);
    document.body.appendChild(sidePanelEl);

    // Small delay so CSS transition can kick in
    setTimeout(() => {
      sidePanelEl.classList.add("dechora-open");
    }, 10);
  }

  function ensureSidePanelOpen() {
    if (!document.body) return;
    if (!sidePanelEl) {
      createSidePanel();
      return;
    }
    sidePanelEl.classList.add("dechora-open");
  }

  // ================================================================
  // Buttons on images
  // ================================================================

  function injectStyles() {
    if (document.getElementById("dechora-style")) return;

    const style = document.createElement("style");
    style.id = "dechora-style";
    style.textContent = `
      .dechora-img-parent {
        position: relative !important;
      }

      .dechora-save-btn {
        position: absolute;
        top: 8px;
        right: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        height: 32px;
        min-width: 32px;
        padding: 0 8px;
        font-size: 12px;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        border-radius: 9999px;
        background: rgba(0,0,0,0.85);
        color: #ffffff;
        cursor: pointer;
        border: none;
        z-index: 2147483645;
        opacity: 1;
        pointer-events: auto;
        transition:
          transform 0.15s ease,
          background-color 0.15s ease;
      }

      .dechora-save-btn:hover {
        background: rgba(0,0,0,1);
        transform: translateY(-1px);
      }

      .dechora-save-icon {
        width: 16px;
        height: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .dechora-save-icon svg {
        width: 16px;
        height: 16px;
        stroke: white;
      }

      .dechora-save-label {
        max-width: 0;
        opacity: 0;
        overflow: hidden;
        white-space: nowrap;
        margin-left: 0;
        font-size: 12px;
        line-height: 1;
        transition:
          max-width 0.15s ease,
          opacity 0.15s ease,
          margin-left 0.15s ease;
      }

      .dechora-save-btn:hover .dechora-save-label {
        max-width: 80px;
        opacity: 1;
        margin-left: 6px;
      }

      .dechora-toolbar {
        position: fixed;
        bottom: 16px;
        right: 16px;
        z-index: 2147483645;
        background: rgba(0, 0, 0, 0.9);
        color: #fff;
        padding: 8px 10px;
        border-radius: 9999px;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 12px;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .dechora-toolbar button {
        background: #ffffff;
        color: #000000;
        border: none;
        border-radius: 9999px;
        padding: 4px 10px;
        cursor: pointer;
        font-size: 12px;
      }

      .dechora-toolbar button:hover {
        background: #e5e5e5;
      }

      .dechora-sidepanel {
        position: fixed;
        top: 0;
        right: 0;
        width: 420px;
        max-width: 100vw;
        height: 100vh;
        background: #111111;
        color: #ffffff;
        z-index: 2147483647; /* highest: above overlay and buttons */
        display: flex;
        flex-direction: column;
        transform: translateX(100%);
        box-shadow: -4px 0 12px rgba(0, 0, 0, 0.4);
        transition: transform 0.25s ease;
      }

      .dechora-sidepanel.dechora-open {
        transform: translateX(0);
      }

      .dechora-sidepanel-iframe {
        flex: 1;
        width: 100%;
        border: none;
        background: #000000;
      }
    `;
    document.head.appendChild(style);
  }

  const PLUS_SVG = `
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" stroke="white" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="12" y1="8" x2="12" y2="16"></line>
      <line x1="8" y1="12" x2="16" y2="12"></line>
    </svg>
  `;

  function addButtonToImage(img) {
    try {
      if (!img || img.nodeType !== Node.ELEMENT_NODE) return;
      if (!isEligibleImage(img)) return;

      if (img.dataset.dechoraHasButton === "1") return;

      const parent = img.parentElement;
      if (!parent || parent.nodeType !== Node.ELEMENT_NODE) return;

      if (parent.dataset.dechoraHasDechoraButton === "1") {
        img.dataset.dechoraHasButton = "1";
        return;
      }

      img.dataset.dechoraHasButton = "1";
      parent.dataset.dechoraHasDechoraButton = "1";
      parent.classList.add("dechora-img-parent");

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dechora-save-btn";

      const icon = document.createElement("span");
      icon.className = "dechora-save-icon";
      icon.innerHTML = PLUS_SVG;

      const label = document.createElement("span");
      label.className = "dechora-save-label";
      label.textContent = "Add item";

      btn.appendChild(icon);
      btn.appendChild(label);
      parent.appendChild(btn);

      if (!img.complete || img.naturalWidth === 0) {
        img.addEventListener("load", () => getOriginalUrl(img), { once: true });
      } else {
        getOriginalUrl(img);
      }

      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleImageSelection(img);
      });
    } catch (err) {
      console.error("Dechora: error in addButtonToImage", err);
    }
  }

  function scanImages() {
    try {
      const imgs = document.querySelectorAll("img");
      console.log("Dechora: found", imgs.length, "images");
      imgs.forEach(addButtonToImage);
    } catch (err) {
      console.error("Dechora: error in scanImages", err);
    }
  }

  function observeNewImages() {
    try {
      const obs = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.tagName === "IMG") {
              addButtonToImage(node);
            } else if (node.querySelectorAll) {
              node.querySelectorAll("img").forEach(addButtonToImage);
            }
          }
        }
      });

      obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch (err) {
      console.error("Dechora: error in observeNewImages", err);
    }
  }

  // ================================================================
  // Small toolbar to control arm mode and exit
  // ================================================================

  function createToolbar() {
    if (document.getElementById("dechora-toolbar")) return;

    const bar = document.createElement("div");
    bar.id = "dechora-toolbar";
    bar.className = "dechora-toolbar";

    const label = document.createElement("span");
    label.textContent = "Dechora";

    const armBtn = document.createElement("button");
    armBtn.textContent = "Arm pick";
    armBtn.addEventListener("click", () => {
      setArmed(!isArmed);
    });

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => {
      setArmed(false);
      if (bar.parentNode) bar.parentNode.removeChild(bar);
      // leave panel and buttons; user can close panel via its own close button
    });

    bar.appendChild(label);
    bar.appendChild(armBtn);
    bar.appendChild(closeBtn);
    document.body.appendChild(bar);
  }

  // ================================================================
  // Init
  // ================================================================

  function init() {
    injectStyles();
    createSidePanel();
    scanImages();
    observeNewImages();
    createToolbar();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
