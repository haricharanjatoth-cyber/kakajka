/* =========================================================
   auth.js — Sign-in modal + header auth widget (StreamHub)
   Loaded as a <script type="module"> on EVERY page, AFTER
   firebase-config.js and AFTER partials.js (so the #authWidget
   mount already exists — see the ordering note below).

   Handles: Google sign-in, Email/Password sign-in + sign-up,
   sign-out, and rendering the header's sign-in button / avatar
   dropdown. There is no anonymous/guest sign-in — every account
   requires a real, verified email + password (or Google).

   Ordering note: module scripts always run after the HTML has
   finished parsing, but plain (non-module) scripts like
   partials.js run immediately as the parser reaches them. So as
   long as partials.js is a plain <script> tag anywhere in the
   page, it will have already built #authWidget by the time this
   file runs, regardless of the tags' relative order.
   ========================================================= */

import { auth, googleProvider, initError } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  sendPasswordResetEmail,
  getAdditionalUserInfo,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";

console.log("[auth.js] module loaded");

(() => {
  "use strict";

  function renderFatalError(message) {
    const mount = document.getElementById("authWidget");
    if (!mount) {
      console.error("[auth.js] no #authWidget element on this page to render into");
      return;
    }
    mount.innerHTML = `<button class="auth-signin-btn" style="background:#ff6b6b;" title="${message.replace(/"/g, "'")}" onclick="location.reload()">⚠ Auth error</button>`;
  }

  if (initError) {
    renderFatalError("firebase-config.js failed to initialize: " + initError.message);
    return;
  }
  if (!auth) {
    renderFatalError("Firebase auth object is unavailable — check the console.");
    return;
  }

  try {
    runAuth();
  } catch (err) {
    console.error("[auth.js] fatal error while setting up auth UI:", err);
    renderFatalError(err.message);
  }

  function runAuth() {

  // Video pages live one folder down — reuse the same VIDEO_FOLDER
  // convention as partials.js so "Account" links work from anywhere.
  const inVideoFolder = typeof VIDEO_FOLDER !== "undefined" &&
    new RegExp(`/${VIDEO_FOLDER}/[^/]*$`).test(window.location.pathname);
  const root = inVideoFolder ? "../" : "";

  let currentUser = null;
  let pendingMode = "signin"; // "signin" | "signup"

  /* ---------------- Forgot-password rate limit (2/day/account) ----------------
     Client-side only (localStorage) — there's no server tracking these
     attempts, so it only stops accidental repeat clicks / the same
     browser, not someone determined to bypass it in another browser or
     incognito. For real enforcement this needs to move server-side
     (e.g. a table in the same D1 database the Worker already talks to). */
  const PW_RESET_LIMIT_PER_DAY = 2;
  function pwResetKey(email) { return `streamhub_pwreset_${email.trim().toLowerCase()}`; }
  function canSendPasswordReset(email) {
    try {
      const raw = localStorage.getItem(pwResetKey(email));
      if (!raw) return true;
      const data = JSON.parse(raw);
      const today = new Date().toISOString().slice(0, 10);
      if (data.date !== today) return true;
      return data.count < PW_RESET_LIMIT_PER_DAY;
    } catch (e) { return true; }
  }
  function recordPasswordReset(email) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const raw = localStorage.getItem(pwResetKey(email));
      let data = raw ? JSON.parse(raw) : { date: today, count: 0 };
      if (data.date !== today) data = { date: today, count: 0 };
      data.count += 1;
      localStorage.setItem(pwResetKey(email), JSON.stringify(data));
    } catch (e) { /* ignore */ }
  }

  /* ---------------- Extended-profile sync (Cloudflare Worker + D1) ----------------
     Fire-and-forget: a failure here should never block sign-up/sign-in.
     Only called for brand-new accounts so it never clobbers city/country/
     phone/gender the person already saved on account.html. */
  async function syncNewUserProfile(user, provider, extra = {}) {
    if (!user || !user.email) {
      console.warn("[profile-sync] skipped — no signed-in user with an email yet.");
      return;
    }
    if (typeof PROFILE_API_URL === "undefined") {
      console.error("[profile-sync] PROFILE_API_URL is undefined — check config.js loaded before auth.js.");
      return;
    }
    try {
      const res = await fetch(`${PROFILE_API_URL}/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: user.uid, email: user.email, provider, ...extra }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[profile-sync] Worker rejected the new profile — HTTP ${res.status} ${res.statusText}. Response body: ${body}`);
      } else {
        console.log("[profile-sync] profile row created in D1 for uid", user.uid);
      }
    } catch (err) {
      // A TypeError here almost always means the request never reached
      // the Worker at all — either PROFILE_API_URL is wrong/unreachable,
      // or the Worker's CORS headers (Access-Control-Allow-Origin) don't
      // include this site's origin, so the browser blocked it before any
      // response came back. Check DevTools > Network for the request.
      console.error("[profile-sync] fetch to the Worker failed (network/CORS):", err);
    }
  }

  /* ---------------- Small helpers ---------------- */
  function initialsOf(user) {
    const src = (user.displayName || user.email || "?").trim();
    return src.charAt(0).toUpperCase();
  }

  function displayNameOf(user) {
    if (user.displayName) return user.displayName;
    if (user.email) return user.email.split("@")[0];
    if (user.isAnonymous) return "Guest";
    return "Account";
  }

  function friendlyError(err) {
    const map = {
      "auth/invalid-email": "That email address doesn't look right.",
      "auth/user-disabled": "This account has been disabled.",
      "auth/user-not-found": "No account found with that email.",
      "auth/wrong-password": "Incorrect password.",
      "auth/invalid-credential": "Incorrect email or password.",
      "auth/email-already-in-use": "An account already exists with that email.",
      "auth/weak-password": "Password should be at least 6 characters.",
      "auth/popup-closed-by-user": "Sign-in popup was closed before finishing.",
      "auth/network-request-failed": "Network error — check your connection.",
      "auth/too-many-requests": "Too many attempts. Try again in a bit.",
      "auth/unauthorized-domain": "This domain isn't authorized for sign-in yet. In the Firebase console, go to Authentication → Settings → Authorized domains and add this site's domain.",
    };
    return map[err.code] || err.message || "Something went wrong. Please try again.";
  }

  /* ---------------- Modal markup ---------------- */
  const ICON_MAIL = `<svg class="auth-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6Z"/><path d="m22 6-10 7L2 6"/></svg>`;
  const ICON_LOCK = `<svg class="auth-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
  const ICON_USER = `<svg class="auth-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>`;
  const ICON_PIN = `<svg class="auth-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>`;
  const ICON_GLOBE = `<svg class="auth-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z"/></svg>`;

  function buildModal() {
    if (document.getElementById("authModal")) return;
    const wrap = document.createElement("div");
    wrap.className = "auth-modal";
    wrap.id = "authModal";
    wrap.innerHTML = `
      <div class="auth-modal-card">
        <button class="auth-modal-close" id="authModalClose" aria-label="Close">✕</button>

        <div class="auth-modal-brand"><div class="brand-logo">S</div></div>

        <div class="auth-tabs" id="authTabs">
          <button type="button" class="auth-tab active" id="authTabSignin" data-mode="signin">Sign In</button>
          <button type="button" class="auth-tab" id="authTabSignup" data-mode="signup">Sign Up</button>
        </div>

        <h2 class="auth-modal-title" id="authModalTitle">Welcome back</h2>
        <div class="auth-modal-error" id="authModalError" style="display:none;"></div>

        <form class="auth-form" id="authForm">
          <div class="auth-input-wrap auth-signup-only" style="display:none;">
            ${ICON_USER}
            <input type="text" id="authUserId" placeholder="Username (letters &amp; numbers)" autocomplete="username" maxlength="30">
          </div>
          <div class="auth-input-wrap">
            ${ICON_MAIL}
            <input type="email" id="authEmail" placeholder="Email address" autocomplete="email" required>
          </div>
          <div class="auth-input-wrap">
            ${ICON_LOCK}
            <input type="password" id="authPassword" placeholder="Password" autocomplete="current-password" required minlength="6">
          </div>
          <div class="auth-input-wrap auth-signup-only" style="display:none;">
            ${ICON_LOCK}
            <input type="password" id="authConfirmPassword" placeholder="Confirm password" autocomplete="new-password" minlength="6">
          </div>
          <div class="auth-input-wrap auth-signup-only" style="display:none;">
            ${ICON_PIN}
            <input type="text" id="authCity" placeholder="City" autocomplete="address-level2">
          </div>
          <div class="country-search-wrap auth-signup-only" style="display:none;">
            <div class="auth-input-wrap">
              ${ICON_GLOBE}
              <input type="text" id="authCountry" placeholder="Country (type to search)" autocomplete="off">
            </div>
            <div class="country-search-dropdown" id="authCountryDropdown"></div>
          </div>
          <select id="authGender" class="auth-signup-only select-field" style="display:none;">
            <option value="" disabled selected>Gender</option>
            <option value="Female">Female</option>
            <option value="Male">Male</option>
            <option value="Other">Other</option>
            <option value="Prefer not to say">Prefer not to say</option>
          </select>
          <button type="button" class="auth-forgot-link" id="authForgotBtn">Forgot password?</button>
          <button type="submit" class="load-more-btn" id="authSubmitBtn">Sign In</button>
        </form>

        <div class="auth-divider"><span>or</span></div>

        <button class="auth-google-btn" id="authGoogleBtn" type="button">
          <span style="display:inline-flex;align-items:center;gap:8px;justify-content:center;width:100%;">
            <svg width="16" height="16" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.9 32.5 29.4 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.4 6.2 29.5 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.4 6.2 29.5 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.3 0 10.1-2 13.7-5.3l-6.3-5.2C29.3 35.4 26.8 36 24 36c-5.3 0-9.8-3.4-11.4-8.1l-6.5 5C9.6 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-1 2.9-3 5.3-5.6 6.8l6.3 5.2C39.4 37.4 44 31.4 44 24c0-1.2-.1-2.3-.4-3.5z"/></svg>
            Continue with Google
          </span>
        </button>
      </div>`;
    document.body.appendChild(wrap);

    document.getElementById("authModalClose").addEventListener("click", closeModal);
    wrap.addEventListener("click", (e) => { if (e.target === wrap) closeModal(); });
    document.getElementById("authTabSignin").addEventListener("click", () => setMode("signin"));
    document.getElementById("authTabSignup").addEventListener("click", () => setMode("signup"));
    document.getElementById("authGoogleBtn").addEventListener("click", handleGoogleSignIn);
    document.getElementById("authForm").addEventListener("submit", handleEmailSubmit);
    document.getElementById("authForgotBtn").addEventListener("click", handleForgotPassword);

    if (typeof initCountrySearch === "function") {
      initCountrySearch("authCountry", "authCountryDropdown");
    }
  }

  function showModalError(msg) {
    const el = document.getElementById("authModalError");
    el.textContent = msg;
    el.style.display = "block";
  }
  function clearModalError() {
    const el = document.getElementById("authModalError");
    el.style.display = "none";
    el.textContent = "";
  }

  function openModal(mode = "signin") {
    buildModal();
    pendingMode = mode;
    applyMode();
    clearModalError();
    document.getElementById("authForm").reset();
    document.getElementById("authModal").classList.add("show");
  }
  function closeModal() {
    const m = document.getElementById("authModal");
    if (m) m.classList.remove("show");
  }

  function applyMode() {
    const isSignup = pendingMode === "signup";
    document.getElementById("authTabSignin")?.classList.toggle("active", !isSignup);
    document.getElementById("authTabSignup")?.classList.toggle("active", isSignup);
    document.getElementById("authModalTitle").textContent =
      isSignup ? "Create your account" : "Welcome back";
    document.getElementById("authSubmitBtn").textContent = isSignup ? "Sign Up" : "Sign In";
    document.getElementById("authPassword").autocomplete = isSignup ? "new-password" : "current-password";
    document.getElementById("authForgotBtn").style.display = isSignup ? "none" : "inline-block";
    document.querySelectorAll(".auth-signup-only").forEach((el) => {
      const isFlexEl = el.classList.contains("country-search-wrap");
      el.style.display = isSignup ? (isFlexEl ? "block" : "block") : "none";
      const field = el.tagName === "SELECT" ? el : el.querySelector("input, select");
      if (field) {
        if (isSignup) field.setAttribute("required", "required");
        else field.removeAttribute("required");
      }
    });
  }
  function setMode(mode) {
    pendingMode = mode;
    clearModalError();
    document.getElementById("authForm").reset();
    applyMode();
  }

  async function withBusy(btn, fn) {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Please wait…";
    try {
      await fn();
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  async function handleEmailSubmit(e) {
    e.preventDefault();
    clearModalError();
    const email = document.getElementById("authEmail").value.trim();
    const password = document.getElementById("authPassword").value;
    const btn = document.getElementById("authSubmitBtn");

    if (pendingMode === "signup") {
      const userid = document.getElementById("authUserId").value.trim();
      const confirmPassword = document.getElementById("authConfirmPassword").value;
      const city = document.getElementById("authCity").value.trim();
      const country = document.getElementById("authCountry").value.trim();
      const gender = document.getElementById("authGender").value;

      if (!/^[A-Za-z0-9]{3,30}$/.test(userid)) {
        showModalError("Username should be 3–30 characters, letters and numbers only (no spaces or symbols).");
        return;
      }
      if (password !== confirmPassword) {
        showModalError("Passwords don't match.");
        return;
      }
      if (!city || !country) {
        showModalError("Please enter your city and country.");
        return;
      }
      if (!gender) {
        showModalError("Please select your gender.");
        return;
      }

      await withBusy(btn, async () => {
        try {
          // Firebase Auth owns: email, password, and the username (stored
          // as displayName). Cloudflare/D1 owns: city + country + gender
          // (see syncNewUserProfile), keyed by the uid Firebase just
          // created. Phone number is collected later, on the account page.
          const cred = await createUserWithEmailAndPassword(auth, email, password);
          try {
            await updateProfile(cred.user, { displayName: userid });
          } catch (err) {
            console.warn("[auth] couldn't set username on the new account:", err);
          }
          await syncNewUserProfile(cred.user, "password", { city, country, gender });
          closeModal();
        } catch (err) {
          showModalError(friendlyError(err));
        }
      });
      return;
    }

    await withBusy(btn, async () => {
      try {
        await signInWithEmailAndPassword(auth, email, password);
        closeModal();
      } catch (err) {
        showModalError(friendlyError(err));
      }
    });
  }

  async function handleForgotPassword() {
    clearModalError();
    const email = document.getElementById("authEmail").value.trim();
    if (!email) {
      showModalError('Enter your email address above first, then click "Forgot password?".');
      return;
    }
    if (!canSendPasswordReset(email)) {
      showModalError(`You've hit today's limit of ${PW_RESET_LIMIT_PER_DAY} password-reset emails for this account. Please try again tomorrow.`);
      return;
    }
    const btn = document.getElementById("authForgotBtn");
    await withBusy(btn, async () => {
      try {
        await sendPasswordResetEmail(auth, email);
        recordPasswordReset(email);
        showModalError("Password reset email sent — check your inbox (and spam folder).");
      } catch (err) {
        showModalError(friendlyError(err));
      }
    });
  }

  async function handleGoogleSignIn() {
    const btn = document.getElementById("authGoogleBtn");
    await withBusy(btn, async () => {
      try {
        const result = await signInWithPopup(auth, googleProvider);
        const info = getAdditionalUserInfo(result);
        if (info && info.isNewUser) syncNewUserProfile(result.user, "google.com");
        closeModal();
      } catch (err) {
        if (err.code !== "auth/popup-closed-by-user") showModalError(friendlyError(err));
      }
    });
  }

  async function handleSignOut() {
    try {
      await signOut(auth);
    } catch (err) {
      console.error("[auth] sign-out failed:", err);
    }
  }

  /* ---------------- Header widget rendering ---------------- */
  function renderSignedOut(mount) {
    mount.innerHTML = `<button class="auth-signin-btn" id="authOpenBtn">Sign In</button>`;
    document.getElementById("authOpenBtn").addEventListener("click", () => openModal("signin"));
  }

  function renderSignedIn(mount, user) {
    const avatarInner = user.photoURL
      ? `<img src="${user.photoURL}" alt="">`
      : initialsOf(user);
    const guestBadge = user.isAnonymous ? `<span class="auth-guest-badge">Guest</span>` : "";

    mount.innerHTML = `
      <div class="auth-account-wrap" id="authAccountWrap">
        <button class="auth-account-btn" id="authAccountBtn" aria-haspopup="true" aria-expanded="false">
          <span class="auth-avatar">${avatarInner}</span>
          <span class="auth-account-name">${displayNameOf(user)}</span>${guestBadge}
        </button>
        <div class="auth-dropdown" id="authDropdown">
          <div class="auth-dropdown-header">
            <div class="auth-dropdown-name">${displayNameOf(user)}</div>
            <div class="auth-dropdown-email">${user.email || (user.isAnonymous ? "Browsing as guest" : "")}</div>
          </div>
          <button class="auth-dropdown-item" id="authAccountLink">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>
            Account
          </button>
          <button class="auth-dropdown-item danger" id="authSignOutBtn">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            Sign Out
          </button>
        </div>
      </div>`;

    const wrapEl = document.getElementById("authAccountWrap");
    const btn = document.getElementById("authAccountBtn");
    const dropdown = document.getElementById("authDropdown");

    function closeDropdown() {
      dropdown.classList.remove("show");
      btn.setAttribute("aria-expanded", "false");
    }
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willShow = !dropdown.classList.contains("show");
      dropdown.classList.toggle("show", willShow);
      btn.setAttribute("aria-expanded", String(willShow));
    });
    document.addEventListener("click", (e) => {
      if (!wrapEl.contains(e.target)) closeDropdown();
    });
    document.getElementById("authAccountLink").addEventListener("click", () => {
      window.location.href = `${root}account.html`;
    });
    document.getElementById("authSignOutBtn").addEventListener("click", () => {
      closeDropdown();
      handleSignOut();
    });
  }

  function render(user) {
    const mount = document.getElementById("authWidget");
    if (!mount) return; // page has no auth mount point
    if (user) renderSignedIn(mount, user);
    else renderSignedOut(mount);
  }

  // Re-render whenever #authWidget shows up (covers partials.js
  // rebuilding the header after this listener has already been set up,
  // and pages that mount it before firebase has resolved auth state).
  let authRequiredHandled = false;
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    render(user);

    // account.html redirects signed-out visitors here with
    // ?authRequired=1 — open the modal for them once we've confirmed
    // they're actually signed out (not just mid-rehydration).
    if (!user && !authRequiredHandled && /[?&]authRequired=1\b/.test(window.location.search)) {
      authRequiredHandled = true;
      openModal("signin");
      const el = document.getElementById("authModalTitle");
      if (el) el.textContent = "Sign in to view your account";
    }
  });

  // In case #authWidget wasn't in the DOM yet on the very first paint
  // (e.g. this script happened to run before partials.js on some
  // custom page), retry a render shortly after DOMContentLoaded.
  document.addEventListener("DOMContentLoaded", () => render(currentUser));

  // Exposed so account.html's inline "sign in" prompt (for signed-out
  // visitors who land there directly) can reuse the same modal.
  window.StreamHubAuth = { openModal, get currentUser() { return currentUser; } };

  console.log("[auth.js] auth UI ready");
  } // end runAuth()
})();