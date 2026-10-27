
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";

import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";

// ==========================================
// 1. FIREBASE CONFIGURATION
// ==========================================

const firebaseConfig = {
  apiKey: "AIzaSyChT_OT_uSJCOCi961UJEdMvNT68BRl79s",
  authDomain: "exampilotai-8bb63.firebaseapp.com",
  projectId: "exampilotai-8bb63",
  storageBucket: "exampilotai-8bb63.firebasestorage.app",
  messagingSenderId: "648657969548",
  appId: "1:648657969548:web:f4ba5a62c30b2fd49636a9"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

// ==========================================
// 2. LOGIN PAGE ELEMENTS
// ==========================================

const authForm = document.getElementById("authForm");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");

const submitButton = document.getElementById("submitButton");
const googleButton = document.getElementById("googleButton");

const switchModeButton = document.getElementById("switchMode");
const switchText = document.getElementById("switchText");
const authSubtitle = document.getElementById("authSubtitle");
const authMessage = document.getElementById("authMessage");

// ==========================================
// 3. DASHBOARD ELEMENTS
// ==========================================

const logoutButton = document.getElementById("logoutButton");
const profileTrigger = document.getElementById("profileTrigger");
const profileDropdown = document.getElementById("profileDropdown");

const profileName = document.getElementById("profileName");
const dropdownProfileName = document.getElementById("dropdownProfileName");
const profileEmail = document.getElementById("profileEmail");

let isRegisterMode = false;
let isSubmitting = false;

// ==========================================
// 4. DISPLAY AUTHENTICATION MESSAGES
// ==========================================

function showMessage(message, isError = false) {
  if (!authMessage) return;

  authMessage.textContent = message;
  authMessage.style.color = isError ? "#dc2626" : "#15803d";
}

// ==========================================
// 5. FRIENDLY FIREBASE ERROR MESSAGES
// ==========================================

function getFriendlyError(error) {
  const messages = {
    "auth/invalid-email":
      "Please enter a valid email address.",

    "auth/user-not-found":
      "No account found. Please register first.",

    "auth/wrong-password":
      "Incorrect email or password.",

    "auth/invalid-credential":
      "Incorrect email or password.",

    "auth/email-already-in-use":
      "This email already has an account.",

    "auth/weak-password":
      "Choose a stronger password of at least 6 characters.",

    "auth/popup-closed-by-user":
      "Google sign-in was cancelled.",

    "auth/popup-blocked":
      "Allow pop-ups for this website and try again.",

    "auth/network-request-failed":
      "Network error. Check your internet connection.",

    "auth/unauthorized-domain":
      "This website domain is not authorized in Firebase.",

    "auth/too-many-requests":
      "Too many attempts. Please wait and try again."
  };

  return messages[error.code] || error.message || "Authentication failed.";
}

// ==========================================
// 6. SWITCH BETWEEN LOGIN AND REGISTRATION
// ==========================================

function updateMode() {
  if (
    !submitButton ||
    !switchText ||
    !switchModeButton ||
    !authSubtitle ||
    !passwordInput
  ) {
    return;
  }

  submitButton.textContent = isRegisterMode
    ? "Create Account"
    : "Sign In";

  switchText.textContent = isRegisterMode
    ? "Already have an account?"
    : "Don't have an account?";

  switchModeButton.textContent = isRegisterMode
    ? "Sign In"
    : "Create account";

  authSubtitle.textContent = isRegisterMode
    ? "Create your account to start preparing."
    : "Sign in to continue your exam preparation.";

  passwordInput.autocomplete = isRegisterMode
    ? "new-password"
    : "current-password";

  showMessage("");
}

if (switchModeButton) {
  switchModeButton.addEventListener("click", (event) => {
    event.preventDefault();

    isRegisterMode = !isRegisterMode;

    updateMode();
  });
}

// ==========================================
// 7. RECORD SUCCESSFUL LOGINS IN MONGODB
// ==========================================

async function recordLogin(user, loginMethod) {
  try {
    const idToken = await user.getIdToken();

    const response = await fetch("/api/auth/login", {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`
      },

      body: JSON.stringify({
        name: user.displayName || "Student",
        loginMethod
      })
    });

    if (!response.ok) {
      const result = await response.json().catch(() => ({}));

      console.error(
        "Login tracking failed:",
        response.status,
        result.error || response.statusText
      );

      return false;
    }

    console.log("Login history recorded successfully.");

    return true;
  } catch (error) {
    console.error("Unable to record login:", error);

    // A tracking failure must not prevent the user from signing in.
    return false;
  }
}

// ==========================================
// 8. EMAIL/PASSWORD LOGIN AND REGISTRATION
// ==========================================

if (authForm) {
  authForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (isSubmitting) return;

    if (!emailInput || !passwordInput) {
      showMessage("Email or password input is missing.", true);
      return;
    }

    isSubmitting = true;

    if (submitButton) submitButton.disabled = true;
    if (googleButton) googleButton.disabled = true;

    showMessage(
      isRegisterMode
        ? "Creating your account..."
        : "Signing in..."
    );

    try {
      const email = emailInput.value.trim();
      const password = passwordInput.value;

      if (isRegisterMode) {
        const userCredential = await createUserWithEmailAndPassword(
          auth,
          email,
          password
        );

        await recordLogin(
          userCredential.user,
          "password"
        );

        showMessage("Account created successfully!");

        window.location.replace("/index.html");
      } else {
        const userCredential = await signInWithEmailAndPassword(
          auth,
          email,
          password
        );

        // Record only successful email/password logins.
        await recordLogin(
          userCredential.user,
          "password"
        );

        window.location.replace("/index.html");
      }
    } catch (error) {
      console.error("Authentication error:", error);

      showMessage(getFriendlyError(error), true);
    } finally {
      isSubmitting = false;

      if (submitButton) submitButton.disabled = false;
      if (googleButton) googleButton.disabled = false;
    }
  });
}

// ==========================================
// 9. GOOGLE SIGN-IN
// ==========================================

if (googleButton) {
  googleButton.addEventListener("click", async (event) => {
    event.preventDefault();

    if (isSubmitting) return;

    isSubmitting = true;

    googleButton.disabled = true;

    if (submitButton) submitButton.disabled = true;

    showMessage("Opening Google sign-in...");

    try {
      const userCredential = await signInWithPopup(
        auth,
        googleProvider
      );

      // Record only successful Google logins.
      await recordLogin(
        userCredential.user,
        "google.com"
      );

      window.location.replace("/index.html");
    } catch (error) {
      console.error("Google sign-in error:", error);

      showMessage(getFriendlyError(error), true);
    } finally {
      isSubmitting = false;

      if (googleButton) googleButton.disabled = false;
      if (submitButton) submitButton.disabled = false;
    }
  });
}

// ==========================================
// 10. AUTHENTICATION STATE AND USER PROFILE
// ==========================================

onAuthStateChanged(auth, (user) => {
  // Redirect an already authenticated user away from the login page.
  if (authForm && user) {
    if (!isSubmitting) {
      window.location.replace("/index.html");
    }

    return;
  }

  // Redirect unauthenticated users away from protected dashboard pages.
  if (profileTrigger && !user) {
    window.location.replace("/login.html");
    return;
  }

  // No profile to update on this page.
  if (!profileTrigger || !user) {
    return;
  }

  const name = user.displayName || "Student";
  const email = user.email || "";

  // Display the user's name without a Google avatar.
  if (profileName) {
    profileName.textContent = name;
  }

  if (dropdownProfileName) {
    dropdownProfileName.textContent = name;
  }

  // Display the user's email.
  if (profileEmail) {
    profileEmail.textContent = email;
  }
});

// ==========================================
// 11. LOGOUT
// ==========================================

if (logoutButton) {
  logoutButton.addEventListener("click", async (event) => {
    event.preventDefault();

    try {
      logoutButton.disabled = true;

      await signOut(auth);

      window.location.replace("/login.html");
    } catch (error) {
      console.error("Logout failed:", error);

      alert("Unable to log out. Please try again.");

      logoutButton.disabled = false;
    }
  });
}

// ==========================================
// 12. PROFILE DROPDOWN
// ==========================================

if (profileTrigger && profileDropdown) {
  profileTrigger.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    const isOpen = !profileDropdown.hidden;

    profileDropdown.hidden = isOpen;

    profileTrigger.setAttribute(
      "aria-expanded",
      String(!isOpen)
    );
  });

  document.addEventListener("click", (event) => {
    const userProfile = document.getElementById("userProfile");

    if (userProfile && !userProfile.contains(event.target)) {
      profileDropdown.hidden = true;

      profileTrigger.setAttribute(
        "aria-expanded",
        "false"
      );
    }
  });
}

console.log("ExamPilot AI authentication script loaded.");


