
import { initializeApp, getApps, getApp } from
  "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";

import {
  getAuth,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";

// Firebase client configuration.
// This is the same public configuration used by your existing auth.js.
const firebaseConfig = {
  apiKey: "AIzaSyChT_OT_uSJCOCi961UJEdMvNT68BRl79s",
  authDomain: "exampilotai-8bb63.firebaseapp.com",
  projectId: "exampilotai-8bb63",
  storageBucket: "exampilotai-8bb63.firebasestorage.app",
  messagingSenderId: "648657969548",
  appId: "1:648657969548:web:f4ba5a62c30b2fd49636a9"
};

const ADMIN_EMAIL = "arpitshakya9807@gmail.com";

const app = getApps().length
  ? getApp()
  : initializeApp(firebaseConfig);

const auth = getAuth(app);

// HTML elements
const statusElement = document.getElementById("status");
const dashboard = document.getElementById("dashboard");
const totalUsersElement = document.getElementById("totalUsers");
const totalLoginsElement = document.getElementById("totalLogins");
const loginTableBody = document.getElementById("loginTableBody");
const refreshButton = document.getElementById("refreshButton");
const logoutButton = document.getElementById("logoutButton");

let currentUser = null;
let loading = false;

function showStatus(message, isError = false) {
  statusElement.textContent = message;
  statusElement.classList.toggle("error", isError);
}

function makeCell(value) {
  const cell = document.createElement("td");
  cell.textContent = value == null || value === ""
    ? "—"
    : String(value);
  return cell;
}

function formatDate(value) {
  if (!value) return "—";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  return date.toLocaleString();
}

function renderLogins(logins) {
  loginTableBody.replaceChildren();

  if (!Array.isArray(logins) || logins.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");

    cell.colSpan = 5;
    cell.className = "empty";
    cell.textContent = "No login events have been recorded yet.";

    row.appendChild(cell);
    loginTableBody.appendChild(row);
    return;
  }

  for (const login of logins) {
    const row = document.createElement("tr");

    row.appendChild(makeCell(login.name));
    row.appendChild(makeCell(login.email));
    row.appendChild(makeCell(login.firebaseUid));
    row.appendChild(makeCell(login.loginMethod));
    row.appendChild(makeCell(formatDate(login.loggedInAt)));

    loginTableBody.appendChild(row);
  }
}

async function loadDashboard() {
  if (!currentUser || loading) return;

  loading = true;
  refreshButton.disabled = true;

  showStatus("Loading administrator statistics...");

  try {
    const idToken = await currentUser.getIdToken();

    const response = await fetch("/api/admin/login-stats", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${idToken}`
      },
      cache: "no-store"
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          result.error || "Administrator access was denied."
        );
      }

      throw new Error(
        result.error || `Server returned HTTP ${response.status}.`
      );
    }

    if (!result.success || !result.statistics) {
      throw new Error("The server returned an invalid statistics response.");
    }

    totalUsersElement.textContent =
      result.statistics.totalUsers ?? 0;

    totalLoginsElement.textContent =
      result.statistics.totalLogins ?? 0;

    renderLogins(result.recentLogins);

    dashboard.hidden = false;

    showStatus("Administrator access verified. Statistics loaded.");
  } catch (error) {
    console.error("Admin dashboard error:", error);

    dashboard.hidden = true;

    showStatus(error.message || "Unable to load administrator data.", true);
  } finally {
    loading = false;
    refreshButton.disabled = false;
  }
}

// Verify the signed-in Firebase user.
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.replace("/login.html");
    return;
  }

  currentUser = user;

  if ((user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    showStatus("Access denied. This account is not the administrator.", true);
    dashboard.hidden = true;

    await signOut(auth);
    window.location.replace("/login.html");
    return;
  }

  logoutButton.hidden = false;

  await loadDashboard();
});

// Refresh statistics.
refreshButton.addEventListener("click", loadDashboard);

// Sign out.
logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;

  try {
    await signOut(auth);
    window.location.replace("/login.html");
  } catch (error) {
    console.error("Sign-out failed:", error);
    showStatus("Unable to sign out. Please try again.", true);
    logoutButton.disabled = false;
  }
});
