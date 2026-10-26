/*
 * Social Wall — tiny loader (~1 KB). Loaded by the app block on every page that
 * has the block. It only pulls in the heavy 3D bundle (ugme-canvas.js) once the
 * block is about to scroll into view, so it doesn't hurt page speed.
 * Also re-mounts in the theme editor when the block is added/changed/removed.
 */
(function () {
  if (window.__ugmeCanvasLoader) return;
  window.__ugmeCanvasLoader = true;

  var bundlePromise = null;
  function loadBundle(url) {
    if (window.UgmeCanvas) return Promise.resolve();
    if (!bundlePromise) {
      bundlePromise = new Promise(function (resolve, reject) {
        var s = document.createElement("script");
        s.src = url;
        s.charset = "utf-8";
        s.async = true;
        s.onload = function () { resolve(); };
        s.onerror = function () { bundlePromise = null; reject(new Error("ugme-canvas bundle failed")); };
        document.head.appendChild(s);
      });
    }
    return bundlePromise;
  }

  // Fetch the media list and warm the thumbnails *while* the 3D bundle downloads,
  // instead of one after the other. The bundle picks up root.__ugmeData.
  function prefetchData(root) {
    if (root.__ugmeData || !window.fetch) return;
    var endpoint = root.getAttribute("data-endpoint") || "/apps/social-wall/canvas";
    var params = [];
    var wall = root.getAttribute("data-wall") || "";
    var campaigns = (root.getAttribute("data-campaigns") || "").replace(/,+$/, "");
    var product = root.getAttribute("data-product") || "";
    if (wall) params.push("wall=" + encodeURIComponent(wall));
    else if (campaigns) params.push("campaigns=" + encodeURIComponent(campaigns));
    if (product) params.push("product=" + encodeURIComponent(product));
    var url = endpoint + (params.length ? (endpoint.indexOf("?") < 0 ? "?" : "&") + params.join("&") : "");
    root.__ugmeData = fetch(url, { headers: { Accept: "application/json" }, credentials: "same-origin" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (data) {
        var items = (data && data.items) || [];
        for (var i = 0; i < items.length; i++) {
          var src = items[i].thumb || (items[i].type === "image" ? items[i].src : null);
          if (!src) continue;
          var img = new Image();
          img.crossOrigin = "anonymous"; // must match the bundle's CORS mode to share the cache
          img.src = src;
        }
        return data;
      });
    root.__ugmeData.catch(function () { root.__ugmeData = null; });
  }

  function start(root) {
    if (root.__ugmeStarted) return;
    root.__ugmeStarted = true;
    var go = function () {
      prefetchData(root);
      loadBundle(root.getAttribute("data-bundle")).then(function () {
        root.__ugmeUnmount = window.UgmeCanvas.mount(root);
      }).catch(function (e) { console.error("[ugme-canvas]", e); });
    };
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) { io.disconnect(); go(); return; }
        }
      }, { rootMargin: "600px 0px" });
      io.observe(root);
    } else {
      go();
    }
  }

  function scan(scope) {
    var nodes = (scope || document).querySelectorAll("[data-ugme-canvas]");
    for (var i = 0; i < nodes.length; i++) start(nodes[i]);
  }

  function teardown(scope) {
    var nodes = scope.querySelectorAll("[data-ugme-canvas]");
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].__ugmeUnmount) nodes[i].__ugmeUnmount();
      nodes[i].__ugmeStarted = false;
      nodes[i].__ugmeData = null;
    }
  }

  // Theme editor events
  document.addEventListener("shopify:section:load", function (e) { scan(e.target); });
  document.addEventListener("shopify:block:select", function (e) { scan(e.target); });
  document.addEventListener("shopify:section:unload", function (e) { teardown(e.target); });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { scan(); });
  } else {
    scan();
  }
})();
