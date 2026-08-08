/* =========================================================
   firebase-config.js — Firebase initialization (Auth ONLY)
   Loaded as a <script type="module"> on EVERY page, before
   auth.js (and before account.js on account.html).

   This project does not use Firestore, Realtime Database, or
   Storage. All profile preferences that aren't part of the
   Firebase Auth user object (theme, autoplay previews, etc.)
   live in localStorage — see account.js.
   ========================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { getAnalytics, isSupported as analyticsIsSupported }
  from "https://www.gstatic.com/firebasejs/12.16.0/firebase-analytics.js";
import { getAuth, GoogleAuthProvider }
  from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";

// TODO: fill these in from Firebase Console -> Project settings ->
// your web app -> "SDK setup and configuration". authDomain and
// projectId are REQUIRED for auth.js to work at all — with them
// empty, initializeApp()/getAuth() will throw and every page will
// show the "⚠ Auth error" button instead of Sign In.
const firebaseConfig = {
  apiKey: "AIzaSyBwuOtMF9Awp09tBSAcGCk2sdfQivSrjUk",
  authDomain: "sexvid-18.firebaseapp.com",
  projectId: "sexvid-18",
  storageBucket: "sexvid-18.firebasestorage.app",
  messagingSenderId: "924642876133",
  appId: "1:924642876133:web:90535522f006059541120c",
  measurementId: "G-29196TD69B",
};

// initializeApp/getAuth are synchronous and can throw (bad config,
// duplicate init, etc.) — catch that here so one bad call can't take
// down every page silently. auth.js checks `initError` and shows a
// visible message in the header instead of just rendering nothing.
export let app = null;
export let auth = null;
export let googleProvider = null;
export let initError = null;

try {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  googleProvider = new GoogleAuthProvider();
  console.log("[firebase-config] initialized OK");
} catch (err) {
  initError = err;
  console.error("[firebase-config] initialization FAILED:", err);
}

// Analytics can fail to initialize (ad/tracker blockers, unsupported
// environments) — isolated in its own chain so it never affects auth.
if (app) {
  analyticsIsSupported()
    .then((supported) => { if (supported) getAnalytics(app); })
    .catch((err) => console.warn("[firebase-config] analytics skipped:", err.message));
}