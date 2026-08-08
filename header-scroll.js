/* =========================================================
   header-scroll.js — StreamHub
   xHamster-style auto-hide header, hardened for all devices:
   - iOS Safari (overscroll/rubber-band clamp, bfcache, notch)
   - Android Chrome/WebView (passive-listener feature detect)
   - Desktop (mouse wheel, trackpad, keyboard scroll)
   - Foldables / landscape phones (ResizeObserver-driven height)
   - Reduced-motion users (never auto-hide; stays static)
   - Accessibility (never hides while dropdown/sidebar/search open)
   ========================================================= */
(function () {
  "use strict";

  if (window.__streamhubHeaderScrollInit) return; // guard against double-inclusion
  window.__streamhubHeaderScrollInit = true;

  var header = document.querySelector(".site-header");
  if (!header) return;

  var HIDE_THRESHOLD = 8;    // px of intentional movement before acting — filters jitter
  var TOP_REVEAL_ZONE = 80;  // always show header near the very top of the page

  var reduceMotion = false;
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduceMotion = mq.matches;
    if (mq.addEventListener) {
      mq.addEventListener("change", function (e) { reduceMotion = e.matches; });
    } else if (mq.addListener) {
      mq.addListener(function (e) { reduceMotion = e.matches; });
    }
  }

  var lastY = getScrollY();
  var ticking = false;
  var locked = false;

  function getScrollY() {
    // Clamp iOS Safari's negative rubber-band overscroll, which
    // otherwise produces a false "scroll up" flicker at page top.
    var y = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
    return Math.max(y, 0);
  }

  function setLocked(v) {
    locked = v;
    document.body.classList.toggle("header-lock", locked);
  }

  function onScroll() {
    ticking = false;
    if (reduceMotion) return;
    if (locked) { lastY = getScrollY(); return; }

    var currentY = getScrollY();
    var delta = currentY - lastY;

    if (currentY <= TOP_REVEAL_ZONE) {
      header.classList.remove("is-hidden");
    } else if (delta > HIDE_THRESHOLD) {
      header.classList.add("is-hidden");     // scrolling down -> hide
    } else if (delta < -HIDE_THRESHOLD) {
      header.classList.remove("is-hidden");  // scrolling up -> show
    }
    lastY = currentY;
  }

  function requestTick() {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(onScroll);
    }
  }

  var supportsPassive = false;
  try {
    var opts = Object.defineProperty({}, "passive", {
      get: function () { supportsPassive = true; return true; }
    });
    window.addEventListener("__test", null, opts);
    window.removeEventListener("__test", null, opts);
  } catch (e) {}

  window.addEventListener("scroll", requestTick, supportsPassive ? { passive: true } : false);
  window.addEventListener("touchmove", requestTick, supportsPassive ? { passive: true } : false);

  function setHeaderHeightVar() {
    var h = header.getBoundingClientRect().height;
    if (h > 0) {
      document.documentElement.style.setProperty("--header-total-h", Math.ceil(h) + "px");
    }
  }

  if ("ResizeObserver" in window) {
    new ResizeObserver(setHeaderHeightVar).observe(header);
  } else {
    window.addEventListener("resize", debounce(setHeaderHeightVar, 150));
  }

  window.addEventListener("orientationchange", function () {
    setTimeout(setHeaderHeightVar, 300); // let iOS/Android chrome resize settle first
  });
  window.addEventListener("load", setHeaderHeightVar);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") setHeaderHeightVar();
  });
  window.addEventListener("pageshow", function () {
    header.classList.remove("is-hidden"); // reset after bfcache restore
    lastY = getScrollY();
    setHeaderHeightVar();
  });

  function debounce(fn, wait) {
    var t;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, wait);
    };
  }

  // Add any other header-anchored overlay class here (e.g. your
  // search-ai.js results dropdown) so it isn't stranded mid-scroll.
  var lockSelectors = [
    "#sidebar.open",
    ".auth-dropdown.show",
    ".auth-modal.show"
  ];

  function anyLockTargetOpen() {
    for (var i = 0; i < lockSelectors.length; i++) {
      if (document.querySelector(lockSelectors[i])) return true;
    }
    return false;
  }

  if ("MutationObserver" in window) {
    new MutationObserver(function () {
      setLocked(anyLockTargetOpen());
    }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ["class"] });
  }

  var searchInput = document.getElementById("searchInput");
  if (searchInput) {
    searchInput.addEventListener("focus", function () { setLocked(true); });
    searchInput.addEventListener("blur", function () {
      setTimeout(function () { setLocked(anyLockTargetOpen()); }, 200);
    });
  }

  setHeaderHeightVar();

  function openMenu() {
  overlay.classList.add("show");
  panel.classList.add("show");
  panel.setAttribute("aria-hidden", "false");
  hamburgerBtn.setAttribute("aria-expanded", "true");
  document.body.classList.add("mobile-menu-open", "header-lock");
}
  function closeMenu() {
  overlay.classList.remove("show");
  panel.classList.remove("show");
  panel.setAttribute("aria-hidden", "true");
  hamburgerBtn.setAttribute("aria-expanded", "false");
  document.body.classList.remove("mobile-menu-open", "header-lock");
}
})();