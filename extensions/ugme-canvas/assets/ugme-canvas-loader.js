/*
 * UGME Canvas — tiny loader (~1 KB). Loaded by the app block on every page that
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

  function start(root) {
    if (root.__ugmeStarted) return;
    root.__ugmeStarted = true;
    var go = function () {
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
