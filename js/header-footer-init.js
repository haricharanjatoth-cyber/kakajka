/* =========================================================
   js/header-footer-init.js
   All the behavior that used to be scattered across inline
   <script> tags in index.html, now consolidated and re-run on
   every page after the shared header/footer partials load.

   Load this with `defer` AFTER include-partials.js:
     <script src="/js/include-partials.js"></script>
     ...
     <script src="/js/header-footer-init.js" defer></script>

   Everything below waits for "partials:loaded" before touching
   the DOM, since #headerTopbar / #backToTopBtn / etc. don't exist
   until include-partials.js finishes injecting them.

   FIX (this revision — removed the mobile search-toggle entirely):
   The old #searchToggleBtn button revealed a collapsed search row
   on mobile, and search-ai.js separately injected its own round
   .sa-submit-btn button right next to #searchInput inside that row.
   The two were meant to hand off to each other (tap toggle -> toggle
   hides itself -> search-ai.js's button takes over), but
   search-ai.js was wrapping .search-box in a new .sa-bar-wrap div
   that pulled it out from under style.css's `.header-topbar
   .search-box` mobile rules entirely — so .sa-bar-wrap (and the
   submit button inside it) was never actually hidden by default,
   and both buttons ended up visible on mobile at the same time.

   Rather than patch that hand-off again, the toggle button has been
   removed outright: search-ai.js's search box (with its own buttons
   built INSIDE .search-box, see search-ai.js's wireBarChrome()) is
   now the only search UI on the page, always visible, and style.css
   shows it as its own full-width row on mobile without needing a
   tap to reveal it. mobileSearchToggle() and everything wiring up
   #searchToggleBtn has been deleted from this file — there is
   nothing left for it to do.
   ========================================================= */
document.addEventListener("partials:loaded", function () {

  /* ---------- Active nav link (was hardcoded .active in index.html;
     now header.html is identical on every page, so this figures out
     which link matches the current page from data-nav). Map each
     page's <body data-page="..."> to the matching nav item. Runs for
     BOTH the desktop nav strip and the mobile drawer's copy of the
     same links, since header.html now includes both. ---------- */
  (function highlightActiveNav() {
    var page = document.body.getAttribute("data-page"); // set this per-page, e.g. data-page="videos"
    if (!page) return;
    document.querySelectorAll('[data-nav="' + page + '"]').forEach(function (link) {
      link.classList.add("active");
    });
  })();

  /* ---------- Header auto-hide on scroll ---------- */
  (function headerAutoHide() {
    var header = document.querySelector(".site-header");
    if (!header) return;
    var lastY = window.scrollY;
    var ticking = false;

    function onScroll() {
      var y = window.scrollY;
      var scrollingDown = y > lastY && y > header.offsetHeight;
      // header-lock (search open, modal open, input focused) keeps it pinned
      if (!document.body.classList.contains("header-lock")) {
        header.classList.toggle("is-hidden", scrollingDown);
      }
      lastY = y;
      ticking = false;
    }
    window.addEventListener("scroll", function () {
      if (!ticking) {
        window.requestAnimationFrame(onScroll);
        ticking = true;
      }
    }, { passive: true });
  })();

  /* ---------- Keep body padding-top in sync with real header height ---------- */
  (function syncHeaderHeight() {
    var header = document.querySelector(".site-header");
    if (!header || !("ResizeObserver" in window)) return;
    var ro = new ResizeObserver(function (entries) {
      var h = entries[0].contentRect.height;
      document.documentElement.style.setProperty("--header-total-h", h + "px");
    });
    ro.observe(header);
  })();

  /* ---------- Hamburger: filter sidebar OR mobile nav drawer ----------
     header.html ships both possible targets (#sidebar comes from the
     PAGE, not the partial; .mobile-menu-panel comes from the header
     partial itself). Whichever exists wins:
       - #sidebar present (index.html, category listings) -> filters
       - otherwise -> the shared nav drawer (watch.html, profile pages) */
  (function hamburgerMenu() {
    var btn = document.getElementById("hamburgerBtn");
    if (!btn) return;

    var sidebar = document.getElementById("sidebar");
    var sidebarOverlay = document.getElementById("sidebarOverlay");

    if (sidebar && sidebarOverlay) {
      var sidebarCloseBtn = document.getElementById("sidebarClose");
      function openSidebar() {
        sidebar.classList.add("open");
        sidebarOverlay.classList.add("show");
        btn.setAttribute("aria-expanded", "true");
        document.body.classList.add("mobile-menu-open");
      }
      function closeSidebar() {
        sidebar.classList.remove("open");
        sidebarOverlay.classList.remove("show");
        btn.setAttribute("aria-expanded", "false");
        document.body.classList.remove("mobile-menu-open");
      }
      btn.addEventListener("click", openSidebar);
      sidebarOverlay.addEventListener("click", closeSidebar);
      if (sidebarCloseBtn) sidebarCloseBtn.addEventListener("click", closeSidebar);
      return;
    }

    var navOverlay = document.getElementById("mobileMenuOverlay");
    var navPanel = document.getElementById("mobileMenuPanel");
    if (!navOverlay || !navPanel) return; // shouldn't happen — header.html always ships these

    var navCloseBtn = document.getElementById("mobileMenuCloseBtn");
    var navSignInBtn = document.getElementById("mobileMenuSignInBtn");

    function openDrawer() {
      navOverlay.classList.add("show");
      navPanel.classList.add("show");
      navPanel.setAttribute("aria-hidden", "false");
      btn.setAttribute("aria-expanded", "true");
      document.body.classList.add("mobile-menu-open");
    }
    function closeDrawer() {
      navOverlay.classList.remove("show");
      navPanel.classList.remove("show");
      navPanel.setAttribute("aria-hidden", "true");
      btn.setAttribute("aria-expanded", "false");
      document.body.classList.remove("mobile-menu-open");
    }

    btn.addEventListener("click", openDrawer);
    navOverlay.addEventListener("click", closeDrawer);
    if (navCloseBtn) navCloseBtn.addEventListener("click", closeDrawer);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && navPanel.classList.contains("show")) closeDrawer();
    });
    navPanel.querySelectorAll(".mobile-menu-links a").forEach(function (a) {
      a.addEventListener("click", closeDrawer);
    });
    if (navSignInBtn) {
      navSignInBtn.addEventListener("click", function () {
        closeDrawer();
        if (window.StreamHubAuth && typeof window.StreamHubAuth.openModal === "function") {
          window.StreamHubAuth.openModal("signin");
        } else {
          var fallback = document.getElementById("fallbackSignInBtn");
          if (fallback) fallback.click();
        }
      });
    }
  })();

  /* ---------- Sign-in fallback button ---------- */
  (function signInFallback() {
    var btn = document.getElementById("fallbackSignInBtn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      if (window.StreamHubAuth && typeof window.StreamHubAuth.openModal === "function") {
        window.StreamHubAuth.openModal("signin");
      } else {
        alert("Sign-in isn't ready yet. Open DevTools (F12) > Console for the error — likely a 404 or blocked request for firebase-config.js or auth.js.");
        console.error("[auth] window.StreamHubAuth is not available — firebase-config.js/auth.js did not finish loading.");
      }
    });
  })();

  /* ---------- Back to top ---------- */
  (function backToTop() {
    var btn = document.getElementById("backToTopBtn");
    if (!btn) return;
    window.addEventListener("scroll", function () {
      btn.classList.toggle("show", window.scrollY > 600);
    }, { passive: true });
    btn.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  })();

  /* ---------- Footer year ---------- */
  (function footerYear() {
    var el = document.getElementById("footerYear");
    if (el) el.textContent = new Date().getFullYear();
  })();

  /* ---------- Ad slots in header/footer (banner strip + mobile ad bar) ---------- */
  (function fillHeaderFooterAds() {
    if (typeof window.fillAdSlotSafe !== "function") return; // ad helper not loaded on this page
    var runWhenIdle = window.requestIdleCallback || function (cb) { setTimeout(cb, 1); };
    runWhenIdle(function () {
      window.fillAdSlotSafe("bannerStripSlot", "bannerStrip970x90");
      if (typeof renderMobileAdBar === "function") renderMobileAdBar();
    });
  })();

  document.dispatchEvent(new CustomEvent("header-footer:ready"));
});