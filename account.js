/* =========================================================
   account.js — Account page (account.html)
   type="module" so it can read Firebase auth state directly, the
   same way auth.js does.
   ========================================================= */

import { auth } from "./firebase-config.js";
import { onAuthStateChanged, updateProfile } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";

const LIKED_KEY = "streamhub_liked_v1";
const HISTORY_KEY = "streamhub_history_v1";
const HISTORY_MAX = 40;

function readLocalList(key) {
  try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch (e) { return []; }
}
function writeLocalList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) { /* ignore */ }
}

// Exposed globally so watch.js (or any page) can call these without a
// module import — see the two lines you'd add near the like button and
// player init on v/watch.html/watch.js:
//   StreamHubLibrary.toggleLike(video)
//   StreamHubLibrary.addToHistory(video)
window.StreamHubLibrary = {
  isLiked(uniqueId) {
    return readLocalList(LIKED_KEY).some((v) => String(v.uniqueId) === String(uniqueId));
  },
  toggleLike(video) {
    const list = readLocalList(LIKED_KEY);
    const id = String(video.uniqueId ?? video.id);
    const idx = list.findIndex((v) => String(v.uniqueId) === id);
    if (idx >= 0) { list.splice(idx, 1); writeLocalList(LIKED_KEY, list); return false; }
    list.unshift({ uniqueId: id, title: video.title, thumbnail: video.thumbnail || video.thumb, author: video.author });
    writeLocalList(LIKED_KEY, list);
    return true;
  },
  addToHistory(video) {
    const list = readLocalList(HISTORY_KEY).filter((v) => String(v.uniqueId) !== String(video.uniqueId ?? video.id));
    list.unshift({ uniqueId: video.uniqueId ?? video.id, title: video.title, thumbnail: video.thumbnail || video.thumb, author: video.author, watchedAt: Date.now() });
    writeLocalList(HISTORY_KEY, list.slice(0, HISTORY_MAX));
  },
};

// Everything below this point only applies to account.html itself —
// guarded so this file can also load on v/watch.html or
// models/profile.html purely to expose window.StreamHubLibrary above.
const onAccountPage = !!document.getElementById("accountBody");

function renderLibrarySections() {
  if (!onAccountPage) return;
  const liked = readLocalList(LIKED_KEY);
  const likedGrid = document.getElementById("likedVideosGrid");
  likedGrid.innerHTML = liked.map(videoCardHtml).join("");
  wireVideoCardPreviews(likedGrid);
  document.getElementById("likedEmptyMsg").style.display = liked.length ? "none" : "";

  const history = readLocalList(HISTORY_KEY);
  const historyGrid = document.getElementById("historyGrid");
  historyGrid.innerHTML = history.map(videoCardHtml).join("");
  wireVideoCardPreviews(historyGrid);
  document.getElementById("historyEmptyMsg").style.display = history.length ? "none" : "";
}

if (onAccountPage) {
  document.getElementById("clearHistoryBtn").addEventListener("click", () => {
    writeLocalList(HISTORY_KEY, []);
    renderLibrarySections();
  });
}

/* ---------------- Theme toggle ---------------- */
function initThemeToggle() {
  const toggle = document.getElementById("themeToggle");
  const isLight = localStorage.getItem("streamhub_theme") === "light";
  toggle.checked = isLight;
  toggle.addEventListener("change", () => {
    const theme = toggle.checked ? "light" : "dark";
    try { localStorage.setItem("streamhub_theme", theme); } catch (e) { /* ignore */ }
    document.documentElement.setAttribute("data-theme", theme);
  });
}

/* ---------------- Profile load/save ---------------- */
let currentUser = null;

async function loadExtendedProfile(uid) {
  try {
    const res = await fetch(`${PROFILE_API_URL}/users/${encodeURIComponent(uid)}`);
    if (!res.ok) return null; // 404 -> no extended row yet, that's fine
    return await res.json();
  } catch (err) {
    console.warn("[account] couldn't load extended profile:", err);
    return null;
  }
}

async function populateAccount(user) {
  document.getElementById("acctEmail").value = user.email || "";
  document.getElementById("acctUsername").value = user.displayName || "";
  const avatarEl = document.getElementById("acctAvatar");
  avatarEl.innerHTML = user.photoURL
    ? `<img src="${user.photoURL}" alt="">`
    : (user.displayName || user.email || "?").charAt(0).toUpperCase();

  const extended = await loadExtendedProfile(user.uid);
  if (extended) {
    document.getElementById("acctCity").value = extended.city || "";
    document.getElementById("acctCountry").value = extended.country || "";
    document.getElementById("acctPhone").value = extended.phone || "";
    document.getElementById("acctGender").value = extended.gender || "";
  }
}

function showStatus(msg, ok) {
  const el = document.getElementById("profileStatusMsg");
  el.textContent = msg;
  el.className = "status-msg " + (ok ? "ok" : "err");
}

async function saveProfile() {
  if (!currentUser) return;
  const btn = document.getElementById("saveProfileBtn");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Saving…";

  const username = document.getElementById("acctUsername").value.trim();
  const city = document.getElementById("acctCity").value.trim();
  const country = document.getElementById("acctCountry").value.trim();
  const phone = document.getElementById("acctPhone").value.trim();
  const gender = document.getElementById("acctGender").value;

  try {
    if (username && username !== currentUser.displayName) {
      await updateProfile(currentUser, { displayName: username });
    }
    const res = await fetch(`${PROFILE_API_URL}/users/${encodeURIComponent(currentUser.uid)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: currentUser.email, city, country, phone, gender }),
    });
    if (!res.ok) throw new Error(`Worker rejected update (HTTP ${res.status})`);
    showStatus("Saved.", true);
  } catch (err) {
    console.error("[account] saveProfile failed:", err);
    showStatus("Couldn't save — " + err.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

if (onAccountPage) document.getElementById("saveProfileBtn").addEventListener("click", saveProfile);

/* ---------------- Avatar upload ---------------- */
if (onAccountPage) {
document.getElementById("changeAvatarBtn").addEventListener("click", () => {
  document.getElementById("avatarFileInput").click();
});
document.getElementById("avatarFileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file || !currentUser) return;
  const btn = document.getElementById("changeAvatarBtn");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Uploading…";
  try {
    const url = await uploadProfilePhoto(currentUser.uid, file);
    await updateProfile(currentUser, { photoURL: url });
    document.getElementById("acctAvatar").innerHTML = `<img src="${url}" alt="">`;
    // Keep the D1 row's photoUrl in sync too, best-effort.
    fetch(`${PROFILE_API_URL}/users/${encodeURIComponent(currentUser.uid)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photoUrl: url }),
    }).catch(() => {});
    showStatus("Photo updated.", true);
  } catch (err) {
    console.error("[account] avatar upload failed:", err);
    showStatus(err.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});
} // end onAccountPage avatar upload block

/* ---------------- Sign out ---------------- */
if (onAccountPage) {
  document.getElementById("signOutBtn2").addEventListener("click", async () => {
    const { signOut } = await import("https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js");
    await signOut(auth);
    window.location.href = "index.html";
  });

  document.getElementById("signInPromptBtn").addEventListener("click", () => {
    window.location.href = "account.html?authRequired=1";
  });

  if (typeof initCountrySearch === "function") {
    initCountrySearch("acctCountry", "acctCountryDropdown");
  }
  initThemeToggle();
  renderLibrarySections();
}

/* ---------------- Boot: auth state (always runs, every page) ---------------- */
onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (!onAccountPage) return;
  if (user) {
    document.getElementById("signedOutPrompt").style.display = "none";
    document.getElementById("accountBody").style.display = "";
    populateAccount(user);
  } else {
    document.getElementById("signedOutPrompt").style.display = "";
    document.getElementById("accountBody").style.display = "none";
  }
});