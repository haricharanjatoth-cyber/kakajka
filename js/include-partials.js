/* =========================================================
   js/include-partials.js
   Drop this <script> as the FIRST thing in <body>, right after
   the two include divs:

     <body>
       <div id="site-header-include"></div>
       <script src="/js/include-partials.js"></script>
       ...page content...
       <div id="site-footer-include"></div>

   It fetches /partials/header.html and /partials/footer.html and
   swaps them in for the placeholder divs. Once BOTH are in the DOM
   it fires a "partials:loaded" event on document — everything that
   touches header/footer elements (scroll-hide, hamburger, sign-in
   button, back-to-top, ad fill) should hang its init off that
   event instead of DOMContentLoaded, since those elements don't
   exist until this runs.

   FIX (this revision — <script> tags inside partials never ran):
   loadPartial() previously did:
     wrapper.innerHTML = html.trim();
     while (wrapper.firstChild) frag.appendChild(wrapper.firstChild);
     el.replaceWith(frag);
   Per the HTML spec, any <script> parsed via .innerHTML is inert —
   it's a real node in the DOM, but the browser will never execute
   it. header.html ships `<script type="module" src="/search-ai.js">`
   at the bottom, relying on this file to bring search-ai.js in on
   EVERY page that includes the header partial. Because of the
   innerHTML issue, that tag was silently doing nothing on every
   page — search only ever worked because index.html ALSO loads
   search-ai.js directly in its own <script> list, which has nothing
   to do with this partial system. Any other page relying solely on
   the header partial for search-ai.js (no matching direct
   <script> tag of its own) would silently ship with a dead search
   box, which is the exact failure mode the "search-ai.js is loaded
   from HERE now" comment in header.html was trying to prevent.

   Fix: reviveScripts() walks the parsed fragment, finds every
   <script> node (inert, since it came from innerHTML), and replaces
   each one with a freshly created <script> element — cloning its
   attributes (src, type, async, defer, etc.) or inline text content
   as appropriate. Creating a <script> via document.createElement and
   appending it to the live DOM DOES execute it, per spec — this is
   the standard workaround for the innerHTML limitation. Module
   scripts (type="module") are deferred by the browser automatically,
   so relative execution order against other module scripts on the
   page is preserved; classic scripts run synchronously the moment
   they're appended, matching normal parser behavior.
   ========================================================= */
(function () {
  var PARTIALS_BASE = "/partials/"; // change if you host partials elsewhere

  // Replaces every inert <script> in `root` (a DocumentFragment or
  // Element that came from an innerHTML assignment) with a live,
  // executing equivalent. Must be called AFTER the fragment/element
  // is attached to the document — appending a freshly created
  // <script> node is what triggers execution, so this walks scripts
  // that are already part of the live DOM tree.
  function reviveScripts(root) {
    var oldScripts = root.querySelectorAll("script");
    oldScripts.forEach(function (oldScript) {
      var newScript = document.createElement("script");
      // Copy every attribute (src, type, async, defer, crossorigin, etc.)
      for (var i = 0; i < oldScript.attributes.length; i++) {
        var attr = oldScript.attributes[i];
        newScript.setAttribute(attr.name, attr.value);
      }
      if (oldScript.src) {
        // External script — browser fetches + executes once appended.
        newScript.textContent = "";
      } else {
        // Inline script — copy the source text over.
        newScript.textContent = oldScript.textContent;
      }
      oldScript.replaceWith(newScript);
    });
  }

  function loadPartial(placeholderId, file) {
    var el = document.getElementById(placeholderId);
    if (!el) return Promise.resolve(); // page doesn't use this partial — fine

    return fetch(PARTIALS_BASE + file)
      .then(function (res) {
        if (!res.ok) throw new Error(file + " responded " + res.status);
        return res.text();
      })
      .then(function (html) {
        // Use a wrapper + replaceWith instead of outerHTML so we
        // don't lose the reference before the DOM is updated.
        var wrapper = document.createElement("div");
        wrapper.innerHTML = html.trim();
        var frag = document.createDocumentFragment();
        while (wrapper.firstChild) frag.appendChild(wrapper.firstChild);

        // Keep a reference to what we're about to insert so we can
        // find its <script> tags AFTER they're live in the document
        // (reviveScripts() needs them attached to actually execute).
        var insertedNodes = Array.prototype.slice.call(frag.childNodes);
        el.replaceWith(frag);

        insertedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return; // element nodes only
          if (node.tagName === "SCRIPT") {
            reviveScripts({ querySelectorAll: function () { return [node]; } });
          } else if (typeof node.querySelectorAll === "function") {
            reviveScripts(node);
          }
        });
      })
      .catch(function (err) {
        console.error("[partials] failed to load " + file + ":", err);
        el.innerHTML = ""; // fail quiet rather than leaving a broken placeholder
      });
  }

  function start() {
    var ready = Promise.all([
      loadPartial("site-header-include", "header.html"),
      loadPartial("site-footer-include", "footer.html")
    ]).then(function () {
      document.dispatchEvent(new CustomEvent("partials:loaded"));
    });

    // Exposed in case another script wants to await it directly
    // instead of listening for the event, e.g.:
    //   window.StreamHubPartials.ready.then(() => { ... });
    window.StreamHubPartials = { ready: ready };
  }

  // CRITICAL: if this <script> tag sits between the header and
  // footer include divs (as recommended), it executes the instant
  // the parser reaches it — BEFORE the footer div further down the
  // page even exists in the DOM yet. getElementById("site-footer-
  // include") would return null and silently skip it. So always
  // wait for parsing to finish first, regardless of where the
  // <script> tag is placed.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();