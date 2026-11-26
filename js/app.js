/* Slemani Map kiosk viewer */
(function () {
  "use strict";

  var IDLE_DEFAULT = 90;
  var SWIPE_PX = 70;
  var HOME_SLACK = 1.2;
  var TURN_MS = 560;

  var pages = [];
  var index = 0;
  var front, back;
  var frontEl, backEl;
  var turning = false;
  var idleTimer = null;
  var idleSeconds = IDLE_DEFAULT;
  var pointerStart = null;

  function $(id) { return document.getElementById(id); }

  function loadManifest() {
    return fetch("pages.json", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("pages.json " + r.status);
        return r.json();
      })
      .catch(function () {
        if (window.SLEMANI_MAP) return window.SLEMANI_MAP;
        throw new Error("No pages manifest found");
      });
  }

  function osdOptions(element) {
    return {
      id: element.id,
      element: element,
      prefixUrl: "vendor/openseadragon/images/",
      showNavigationControl: false,
      showNavigator: false,
      visibilityRatio: 1,
      constrainDuringPan: true,
      homeFillsViewer: false,
      minZoomImageRatio: 0.85,
      maxZoomPixelRatio: 1.5,
      immediateRender: true,
      // Canvas is more reliable on kiosk displays and in headless captures
      // than WebGL (which can fail without a usable software fallback).
      drawer: "canvas",
      animationTime: 0.7,
      springStiffness: 6.5,
      gestureSettingsMouse: {
        clickToZoom: false,
        dblClickToZoom: true,
        scrollToZoom: true,
        dragToPan: true
      },
      gestureSettingsTouch: {
        pinchToZoom: true,
        dblClickToZoom: true,
        flickEnabled: false,
        dragToPan: true,
        pinchRotate: false
      },
      gestureSettingsPen: {
        pinchToZoom: true,
        dblClickToZoom: true,
        clickToZoom: false,
        dragToPan: true
      }
    };
  }

  function tileSource(page) {
    return page.tileSource || page.dzi;
  }

  function atHome(viewer) {
    if (!viewer || !viewer.viewport) return true;
    try {
      var z = viewer.viewport.getZoom(true);
      var h = viewer.viewport.getHomeZoom();
      return z <= h * HOME_SLACK;
    } catch (e) {
      return true;
    }
  }

  function _thumbFadeWhenReady(thumbImg, viewer) {
    if (!thumbImg) return;
    var tiledImage = viewer.world && viewer.world.getItemAt(0);
    if (!tiledImage) {
      setTimeout(function () { thumbImg.classList.add("is-loaded"); }, 1500);
      return;
    }
    if (tiledImage.getFullyLoaded()) {
      thumbImg.classList.add("is-loaded");
      return;
    }
    var fired = false;
    var fallback = setTimeout(function () {
      fired = true;
      thumbImg.classList.add("is-loaded");
    }, 2000);
    tiledImage.addOnceHandler("fully-loaded-change", function () {
      if (fired) return;
      clearTimeout(fallback);
      thumbImg.classList.add("is-loaded");
    });
  }

  function openIn(viewer, page) {
    // Show thumbnail immediately so tile-squares are hidden during load
    var paneEl = viewer.element;
    var thumbImg = paneEl ? paneEl.querySelector(".pane-thumb") : null;
    if (thumbImg && page.thumb) {
      thumbImg.src = page.thumb;
      thumbImg.classList.remove("is-loaded");
    }

    return new Promise(function (resolve, reject) {
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        viewer.removeHandler("open", onOpen);
        viewer.removeHandler("open-failed", onFail);
        resolve();
      }
      function onOpen() {
        try {
          viewer.viewport.goHome(true);
          addHotspots(viewer, page);
        } catch (e) { /* ignore */ }
        // Fade thumbnail once tiles are ready at home zoom
        _thumbFadeWhenReady(thumbImg, viewer);
        finish();
      }
      function onFail(ev) {
        if (done) return;
        done = true;
        viewer.removeHandler("open", onOpen);
        viewer.removeHandler("open-failed", onFail);
        // Thumbnail stays visible as fallback if OSD fails
        reject(ev && ev.message ? ev.message : new Error("open failed"));
      }
      viewer.addOnceHandler("open", onOpen);
      viewer.addOnceHandler("open-failed", onFail);
      try {
        viewer.world.removeAll();
      } catch (e) { /* first open */ }
      viewer.open(tileSource(page));
    });
  }

  function clearOverlays(viewer) {
    if (!viewer) return;
    try { viewer.clearOverlays(); } catch (e) { /* ignore */ }
  }

  function addHotspots(viewer, page) {
    clearOverlays(viewer);
    var list = page.hotspots || [];
    if (!list.length || !viewer.viewport) return;
    list.forEach(function (h) {
      var el = document.createElement("button");
      el.type = "button";
      el.className = "hotspot";
      el.setAttribute("aria-label", h.title || "Place");
      // OSD owns pointer events on the viewer; MouseTracker is the reliable hook.
      new OpenSeadragon.MouseTracker({
        element: el,
        clickHandler: function (event) {
          if (event.originalEvent) {
            event.originalEvent.preventDefault();
            event.originalEvent.stopPropagation();
          }
          openCard(h);
        }
      });
      var x = Number(h.x);
      var y = Number(h.y);
      if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return;
      var pt = viewer.viewport.imageToViewportCoordinates(
        x * page.width,
        y * page.height
      );
      viewer.addOverlay({
        element: el,
        location: pt,
        placement: OpenSeadragon.Placement.CENTER,
        checkResize: false
      });
    });
  }

  function openCard(h) {
    var card = $("hotspot-card");
    var backdrop = $("card-backdrop");
    card.querySelector(".card-title").textContent = h.title || "";
    card.querySelector(".card-text").textContent = h.text || "";
    var img = card.querySelector(".card-image");
    if (h.image) {
      img.src = h.image;
      img.alt = h.title || "";
      img.classList.add("is-on");
    } else {
      img.removeAttribute("src");
      img.alt = "";
      img.classList.remove("is-on");
    }
    card.hidden = false;
    backdrop.hidden = false;
  }

  function closeCard() {
    var card = $("hotspot-card");
    var backdrop = $("card-backdrop");
    if (card) card.hidden = true;
    if (backdrop) backdrop.hidden = true;
  }

  function updateChrome() {
    var n = pages.length;
    $("btn-prev").disabled = index <= 0;
    $("btn-next").disabled = index >= n - 1;
    $("page-indicator").textContent = n ? (index + 1) + "  /  " + n : "";
    var thumbs = $("thumbs").querySelectorAll(".thumb");
    thumbs.forEach(function (btn, i) {
      var on = i === index;
      btn.classList.toggle("is-current", on);
      btn.setAttribute("aria-current", on ? "true" : "false");
      if (on) {
        try { btn.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" }); }
        catch (e) { btn.scrollIntoView(); }
      }
    });
    var title = (pages[index] && pages[index].title) || "Slemani Map";
    document.title = title;
  }

  function buildThumbs() {
    var rail = $("thumbs");
    rail.innerHTML = "";
    pages.forEach(function (page, i) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "thumb";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-label", "Page " + (i + 1));
      var img = document.createElement("img");
      img.src = page.thumb || page.dzi;
      img.alt = "";
      btn.appendChild(img);
      btn.addEventListener("click", function () { goTo(i); });
      rail.appendChild(btn);
    });
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function goTo(next, opts) {
    opts = opts || {};
    if (turning) return Promise.resolve();
    if (next < 0 || next >= pages.length || next === index) {
      if (next === index && front) front.viewport.goHome(!!opts.immediate);
      return Promise.resolve();
    }
    var delta = next > index ? 1 : -1;
    turning = true;
    document.body.classList.add("is-busy");
    closeCard();

    var leaveClass = delta > 0 ? "is-leave-next" : "is-leave-prev";
    var enterClass = delta > 0 ? "is-enter-next" : "is-enter-prev";

    return openIn(back, pages[next]).then(function () {
      backEl.classList.add("no-anim", enterClass);
      void backEl.offsetWidth;
      backEl.classList.remove("no-anim");
      frontEl.classList.add(leaveClass);
      backEl.classList.remove(enterClass);
      backEl.classList.add("is-front");
      frontEl.classList.remove("is-front");
      return wait(TURN_MS);
    }).then(function () {
      frontEl.classList.remove(leaveClass, "is-enter-next", "is-enter-prev");
      clearOverlays(front);
      var tmpV = front, tmpE = frontEl;
      front = back;
      frontEl = backEl;
      back = tmpV;
      backEl = tmpE;
      index = next;
      updateChrome();
    }).catch(function (err) {
      console.error("page turn failed", err);
    }).then(function () {
      turning = false;
      document.body.classList.remove("is-busy");
    });
  }

  function step(delta) {
    return goTo(index + delta);
  }

  function resetIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(onIdle, idleSeconds * 1000);
  }

  function onIdle() {
    closeCard();
    if (index !== 0) {
      goTo(0).then(function () {
        if (front && front.viewport) front.viewport.goHome(true);
      });
    } else if (front && front.viewport) {
      front.viewport.goHome(true);
    }
  }

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function toggleFullscreen() {
    var root = document.documentElement;
    if (isFullscreen()) {
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document);
    } else {
      var req = root.requestFullscreen || root.webkitRequestFullscreen;
      if (req) req.call(root);
    }
  }

  function syncFullscreenClass() {
    document.body.classList.toggle("is-fullscreen", isFullscreen());
  }

  function onPointerDown(ev) {
    if (ev.target.closest("button, .card, #rail, #toolbar, .hotspot")) return;
    if (!atHome(front)) {
      pointerStart = null;
      return;
    }
    var t = ev.touches ? ev.touches[0] : ev;
    pointerStart = { x: t.clientX, y: t.clientY, id: ev.pointerId };
  }

  function onPointerUp(ev) {
    if (!pointerStart) return;
    var t = ev.changedTouches ? ev.changedTouches[0] : ev;
    var dx = t.clientX - pointerStart.x;
    var dy = t.clientY - pointerStart.y;
    pointerStart = null;
    if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    if (!atHome(front) || turning) return;
    if (dx < 0) step(1);
    else step(-1);
  }

  function onKey(ev) {
    var tag = (ev.target && ev.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    switch (ev.key) {
      case "ArrowRight":
      case "PageDown":
        ev.preventDefault();
        step(1);
        break;
      case "ArrowLeft":
      case "PageUp":
        ev.preventDefault();
        step(-1);
        break;
      case "Home":
        ev.preventDefault();
        if (front) front.viewport.goHome();
        break;
      case "Escape":
        if (!$("hotspot-card").hidden) {
          ev.preventDefault();
          closeCard();
        }
        break;
      case "f":
      case "F":
        ev.preventDefault();
        toggleFullscreen();
        break;
    }
  }

  function bindIdleAndKiosk() {
    ["pointerdown", "pointermove", "touchstart", "keydown", "wheel"].forEach(function (type) {
      document.addEventListener(type, resetIdle, { passive: true });
    });
    document.addEventListener("contextmenu", function (ev) { ev.preventDefault(); });
    document.addEventListener("dragstart", function (ev) { ev.preventDefault(); });
    resetIdle();
  }

  function init(manifest) {
    pages = manifest.pages || [];
    idleSeconds = Number(manifest.idleSeconds) > 0 ? Number(manifest.idleSeconds) : IDLE_DEFAULT;
    if (manifest.title) document.title = manifest.title;
    if (!pages.length) {
      $("page-indicator").textContent = "No pages";
      return;
    }

    frontEl = $("viewer-a");
    backEl = $("viewer-b");
    front = OpenSeadragon(osdOptions(frontEl));
    back = OpenSeadragon(osdOptions(backEl));

    buildThumbs();
    updateChrome();

    $("btn-prev").addEventListener("click", function () { step(-1); });
    $("btn-next").addEventListener("click", function () { step(1); });
    $("btn-home").addEventListener("click", function () {
      if (front && front.viewport) front.viewport.goHome();
    });
    $("btn-fullscreen").addEventListener("click", toggleFullscreen);
    document.addEventListener("fullscreenchange", syncFullscreenClass);
    document.addEventListener("webkitfullscreenchange", syncFullscreenClass);
    $("card-backdrop").addEventListener("click", closeCard);
    $("hotspot-card").querySelector(".card-close").addEventListener("click", closeCard);

    var stage = $("stage");
    stage.addEventListener("pointerdown", onPointerDown);
    stage.addEventListener("pointerup", onPointerUp);
    stage.addEventListener("pointercancel", function () { pointerStart = null; });
    // Touch fallback for older webviews
    stage.addEventListener("touchstart", onPointerDown, { passive: true });
    stage.addEventListener("touchend", onPointerUp, { passive: true });

    document.addEventListener("keydown", onKey);
    bindIdleAndKiosk();

    openIn(front, pages[0]).then(function () {
      if (pages.length > 1) {
        // Pre-warm next page so first forward flip has no tile squares
        openIn(back, pages[1]).catch(function () {});
      }
    }).catch(function (err) {
      console.error(err);
      $("page-indicator").textContent = "Could not open page";
    });
  }

  loadManifest().then(init).catch(function (err) {
    console.error(err);
    var el = $("page-indicator");
    if (el) el.textContent = "Could not load map";
  });
})();
