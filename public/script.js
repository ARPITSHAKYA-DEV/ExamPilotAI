
/* ==========================================================
   EXAMPILOT AI
   Theme, authenticated API requests, uploads, analyzer,
   AI answers, and dashboard.
========================================================== */

"use strict";

/* ==========================================================
   1. THEME SWITCHER
========================================================== */

(function () {
  const THEME_KEY = "examPilotTheme";
  const root = document.documentElement;

  function applyTheme(theme) {
    const isDark = theme === "dark";

    root.setAttribute("data-theme", isDark ? "dark" : "light");

    const button = document.getElementById("themeToggle");

    if (button) {
      button.textContent = isDark ? "☀️ Light Mode" : "🌙 Dark Mode";

      button.setAttribute(
        "aria-label",
        isDark ? "Switch to light mode" : "Switch to dark mode"
      );
    }
  }

  let savedTheme = "light";

  try {
    savedTheme = localStorage.getItem(THEME_KEY) || "light";
  } catch (error) {
    console.warn("Theme preference could not be read.");
  }

  applyTheme(savedTheme);

  function setupThemeButton() {
    const button = document.getElementById("themeToggle");

    if (!button || button.dataset.themeHandlerAttached === "true") {
      return;
    }

    button.dataset.themeHandlerAttached = "true";

    button.addEventListener("click", function () {
      const nextTheme =
        root.getAttribute("data-theme") === "dark" ? "light" : "dark";

      applyTheme(nextTheme);

      try {
        localStorage.setItem(THEME_KEY, nextTheme);
      } catch (error) {
        console.warn("Theme preference could not be saved.");
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupThemeButton);
  } else {
    setupThemeButton();
  }
})();


/* ==========================================================
   2. GENERAL HELPERS
========================================================== */

const STORAGE_KEY = "exampilotData";

function getData() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveData(updates) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...getData(),
        ...updates
      })
    );
  } catch (error) {
    console.warn("Study data could not be saved locally.");
  }
}

async function readResponse(response) {
  let data = {};

  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Your session has expired. Please log in again.");
    }

    if (response.status === 403 || response.status === 404) {
      throw new Error(
        data.error || "This resource is unavailable or you do not have access."
      );
    }

    throw new Error(data.error || "Something went wrong.");
  }

  return data;
}

function textEl(tag, text, className = "") {
  const element = document.createElement(tag);

  element.textContent = text ?? "";

  if (className) {
    element.className = className;
  }

  return element;
}


/* ==========================================================
   3. FIREBASE AUTHENTICATED API REQUESTS

   This helper initializes Firebase if necessary, waits for
   the current authentication state, retrieves the ID token,
   and attaches it to protected backend requests.

   The backend must independently verify the token and check
   resource ownership. A browser token is not proof of
   ownership unless the backend validates it.
========================================================== */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyChT_OT_uSJCOCi961UJEdMvNT68BRl79s",
  authDomain: "exampilotai-8bb63.firebaseapp.com",
  projectId: "exampilotai-8bb63",
  storageBucket: "exampilotai-8bb63.firebasestorage.app",
  messagingSenderId: "648657969548",
  appId: "1:648657969548:web:f4ba5a62c30b2fd49636a9"
};

let firebaseAuthPromise = null;
let authStatePromise = null;

async function getFirebaseAuth() {
  if (!firebaseAuthPromise) {
    firebaseAuthPromise = (async () => {
      const appSdk = await import(
        "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js"
      );

      const authSdk = await import(
        "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js"
      );

      const app = appSdk.getApps().length
        ? appSdk.getApp()
        : appSdk.initializeApp(FIREBASE_CONFIG);

      const auth = authSdk.getAuth(app);

      return {
        auth,
        onAuthStateChanged: authSdk.onAuthStateChanged
      };
    })();
  }

  return firebaseAuthPromise;
}

async function getAuthenticatedUser() {
  const { auth, onAuthStateChanged } = await getFirebaseAuth();

  // Firebase may still be restoring a previously signed-in session.
  // Wait for the initial authentication state before deciding.
  if (auth.currentUser) {
    return auth.currentUser;
  }

  if (!authStatePromise) {
    authStatePromise = new Promise((resolve, reject) => {
      let unsubscribe = null;
      let settled = false;

      const cleanup = () => {
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
      };

      const timeout = setTimeout(() => {
        if (settled) return;

        settled = true;
        cleanup();

        reject(
          new Error("Authentication is taking too long. Please try again.")
        );
      }, 15000);

      unsubscribe = onAuthStateChanged(
        auth,
        (user) => {
          if (settled) return;

          settled = true;
          clearTimeout(timeout);
          cleanup();

          resolve(user);
        },
        (error) => {
          if (settled) return;

          settled = true;
          clearTimeout(timeout);
          cleanup();

          reject(error);
        }
      );
    }).finally(() => {
      authStatePromise = null;
    });
  }

  return authStatePromise;
}

async function authenticatedFetch(url, options = {}) {
  let user;

  try {
    user = await getAuthenticatedUser();
  } catch (error) {
    console.error("Firebase authentication could not be checked:", error);
    throw error;
  }

  if (!user) {
    // Protect the frontend experience. The backend remains responsible
    // for enforcing authentication and authorization.
    if (!window.location.pathname.endsWith("/login.html")) {
      window.location.replace("/login.html");
    }

    throw new Error("Please log in to access your study materials.");
  }

  // Refresh the token when needed and use the current Firebase identity.
  const idToken = await user.getIdToken();

  const headers = new Headers(options.headers || {});

  headers.set("Authorization", `Bearer ${idToken}`);

  return fetch(url, {
    ...options,
    headers
  });
}


/* ==========================================================
   4. MULTI-PDF UPLOAD
========================================================== */

if (document.getElementById("uploadForm")) {
  const form = document.getElementById("uploadForm");
  const input = document.getElementById("paper");
  const list = document.getElementById("fileList");
  const message = document.getElementById("uploadMessage");
  const submit = form.querySelector('button[type="submit"]');
  const dropzone = document.getElementById("uploadDropzone");
  const fileCounter = document.getElementById("selectedFileCount");
  const subjectInput = document.getElementById("subject");

  const selected = new Map();

  const MAX_FILES = 10;
  const MAX_BYTES = 50 * 1024 * 1024;

  const formatBytes = (bytes) =>
    bytes < 1048576
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;

  function render() {
    list.replaceChildren();

    if (fileCounter) {
      fileCounter.textContent =
        `${selected.size} file${selected.size === 1 ? "" : "s"}`;
    }

    if (selected.size === 0) {
      list.append(textEl("p", "No files selected.", "muted"));
      return;
    }

    selected.forEach((file, key) => {
      const card = document.createElement("article");
      card.className = "card";

      const details = document.createElement("div");
      details.className = "upload-file-details";

      const icon = textEl("span", "PDF", "upload-file-icon");
      const info = document.createElement("div");

      info.append(
        textEl("strong", file.name),
        textEl("p", `${formatBytes(file.size)} · Ready to upload`, "muted")
      );

      details.append(icon, info);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn secondary";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${file.name}`);

      remove.addEventListener("click", () => {
        selected.delete(key);
        message.textContent = "";
        render();
      });

      card.append(details, remove);
      list.append(card);
    });
  }

  function addFiles(files) {
    for (const file of files) {
      const key = `${file.name}:${file.size}:${file.lastModified}`;

      if (
        !/\.pdf$/i.test(file.name) &&
        file.type !== "application/pdf"
      ) {
        message.textContent = `${file.name}: choose a PDF file.`;
        continue;
      }

      if (!file.size || file.size > MAX_BYTES) {
        message.textContent =
          `${file.name}: file must be between 1 byte and 50 MB.`;
        continue;
      }

      if (selected.has(key)) {
        continue;
      }

      if (selected.size >= MAX_FILES) {
        message.textContent =
          `The limit is ${MAX_FILES} files. Remove a file before adding another.`;
        continue;
      }

      selected.set(key, file);
    }

    render();
  }

  input.addEventListener("change", () => {
    addFiles(Array.from(input.files));
    input.value = "";
  });

  if (dropzone) {
    dropzone.addEventListener("dragover", (event) => {
      event.preventDefault();
      dropzone.classList.add("is-dragging");
    });

    dropzone.addEventListener("dragleave", (event) => {
      if (!dropzone.contains(event.relatedTarget)) {
        dropzone.classList.remove("is-dragging");
      }
    });

    dropzone.addEventListener("drop", (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-dragging");

      addFiles(Array.from(event.dataTransfer.files));
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!subjectInput.value.trim()) {
      message.textContent = "Please enter a subject name.";
      subjectInput.focus();
      return;
    }

    if (selected.size === 0) {
      message.textContent = "Please select at least one PDF file.";
      return;
    }

    const formData = new FormData();

    formData.append("subject", subjectInput.value.trim());

    selected.forEach((file) => {
      formData.append("papers", file);
    });

    // This is browser-side navigation state only.
    // The backend must determine ownership from the verified Firebase UID.
    const existingData = getData();

    submit.disabled = true;
    message.textContent = `Uploading ${selected.size} PDF file(s)...`;

    try {
      const response = await authenticatedFetch("/api/papers/upload", {
        method: "POST",
        body: formData
      });

      const result = await readResponse(response);

      const documents = result.documents || [];

      const paperIds = result.paperIds ||
        documents.map((doc) => doc.paperId || doc._id).filter(Boolean);

      saveData({
        batchId: result.batchId || "",
        paperIds,
        paperId: paperIds[0] || "",
        subject: subjectInput.value.trim(),
        documents,
        warnings: result.warnings || []
      });

      const readyDocuments = documents.filter(
        (doc) =>
          doc.status === "ready" ||
          doc.status === "uploaded" ||
          doc.status === "analyzed" ||
          doc.status === "partial"
      );

      if (readyDocuments.length > 0) {
        message.textContent = "Upload complete! Opening analyzer...";
        window.location.href = "analyzer.html";
      } else {
        message.textContent =
          result.message ||
          "Upload completed, but no files are marked ready for analysis. Check the server response.";
      }
    } catch (error) {
      console.error("Upload error:", error);
      message.textContent =
        error.message || "Upload failed. Please try again.";
    } finally {
      submit.disabled = false;
    }
  });

  render();
}


/* ==========================================================
   5. PAPER ANALYZER
========================================================== */

if (document.body.dataset.page === "analyzer") {
  const data = getData();

  const subjectEl = document.getElementById("analyzerSubject");
  const nameEl = document.getElementById("paperName");
  const topicGrid = document.getElementById("topicGrid");
  const questionList = document.getElementById("questionList");
  const status = document.getElementById("analysisStatus");
  const repeats = document.getElementById("repeatedQuestions");
  const similarContainer =
    document.getElementById("similarQuestions");

  // The dashboard stores the explicit selection in localStorage.
  // Older upload flows may only have a batchId, which still works.
  const selectedPaperIds =
    Array.isArray(data.paperIds) && data.paperIds.length
      ? [
          ...new Set(
            data.paperIds
              .map((id) => String(id))
              .filter(Boolean)
          )
        ]
      : data.paperId
        ? [String(data.paperId)]
        : [];

  async function requestAnalysis() {
    if (selectedPaperIds.length) {
      const response = await authenticatedFetch("/api/papers/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          paperIds: selectedPaperIds
        })
      });

      return readResponse(response);
    }

    if (data.batchId) {
      const response = await authenticatedFetch(
        `/api/batches/${encodeURIComponent(data.batchId)}/analyze`
      );

      return readResponse(response);
    }

    throw new Error(
      "No uploaded papers found. Please upload a PDF first."
    );
  }

  async function loadAnalysis() {
    if (!selectedPaperIds.length && !data.batchId) {
      status.textContent =
        "No uploaded papers found. Please upload a PDF first.";
      return;
    }

    status.textContent = "Analyzing your study material...";

    try {
      const result = await requestAnalysis();

      subjectEl.textContent = result.subject || data.subject || "Unknown";

      const documents = result.documents || [];
      const topics = result.topics || [];
      const questions = result.questions || [];
      const repeatedQuestions = result.repeatedQuestions || [];
      const similarQuestions = result.similarQuestions || [];

      const frequencyByText = new Map(
        (result.questionFrequency || []).map((item) => [
          String(item.text || "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim(),
          item
        ])
      );

      const analyzedDocuments = documents.filter(
        (doc) => doc.status === "analyzed"
      );

      const sourcePaperIds =
        result.paperIds ||
        (analyzedDocuments.length
          ? analyzedDocuments.map((doc) => doc.paperId)
          : selectedPaperIds);

      nameEl.textContent = documents
        .map((doc) =>
          `${doc.fileName}: ${doc.status}` +
          `${doc.error ? ` (${doc.error})` : ""}`
        )
        .join(" · ");

      topicGrid.replaceChildren();
      questionList.replaceChildren();
      repeats.replaceChildren();

      if (similarContainer) {
        similarContainer.replaceChildren();
      }

      const priorityMethod = document.getElementById("priorityMethod");

      if (priorityMethod) {
        priorityMethod.textContent = result.priorityMethod || "";
      }

      const paperCountEl =
        document.getElementById("analyzerPaperCount");
      const questionCountEl =
        document.getElementById("analyzerQuestionCount");
      const uniqueCountEl =
        document.getElementById("analyzerUniqueCount");
      const topicCountEl =
        document.getElementById("analyzerTopicCount");
      const repeatedCountEl =
        document.getElementById("analyzerRepeatedCount");
      const documentCountEl =
        document.getElementById("analyzerDocumentCount");

      const totalQuestions =
        result.totalQuestionsFound ??
        result.questionCount ??
        questions.length;

      const uniqueQuestions =
        result.uniqueQuestionCount ??
        result.uniqueQuestions ??
        0;

      const repeatedCount =
        result.repeatedQuestionCount ??
        repeatedQuestions.length;

      if (paperCountEl) {
        paperCountEl.textContent =
          result.papersSelected ??
          result.documentCount ??
          documents.length;
      }

      if (questionCountEl) {
        questionCountEl.textContent = totalQuestions;
      }

      if (uniqueCountEl) {
        uniqueCountEl.textContent = uniqueQuestions;
      }

      if (topicCountEl) {
        topicCountEl.textContent = topics.length;
      }

      if (repeatedCountEl) {
        repeatedCountEl.textContent = repeatedCount;
      }

      if (documentCountEl) {
        documentCountEl.textContent =
          `${result.completedCount ?? 0}/` +
          `${result.documentCount ?? documents.length}`;
      }

      topics.forEach((topic) => {
        const card = document.createElement("article");
        card.className = "card";

        card.append(
          textEl("h3", topic.topic),
          textEl(
            "p",
            `${topic.priority} Priority · ${topic.paperCount} paper(s) · ` +
            `${topic.questionCount} question occurrence(s)`
          ),
          textEl(
            "p",
            `Years: ${(topic.years || []).join(", ") || "Unknown"} · ` +
            `Marks: ${(topic.marks || []).join(", ") || "Unknown"}`,
            "muted"
          ),
          textEl(
            "p",
            `Evidence: ${(topic.sources || []).join(", ")}`,
            "muted"
          )
        );

        (topic.representativeQuestions || []).forEach((question) => {
          card.append(
            textEl(
              "p",
              `• ${question.text}` +
              `${question.marks ? ` (${question.marks} marks)` : ""}`,
              "muted"
            )
          );
        });

        const choose = document.createElement("button");
        choose.type = "button";
        choose.className = "btn";
        choose.textContent = "Study this topic";

        choose.addEventListener("click", () => {
          saveData({
            topic: topic.topic,
            paperIds: sourcePaperIds,
            paperId:
              analyzedDocuments[0]?.paperId ||
              data.paperId ||
              sourcePaperIds[0] ||
              "",
            batchId: data.batchId || ""
          });

          window.location.href = "answer.html";
        });

        card.append(choose);
        topicGrid.append(card);
      });

      questions.forEach((question) => {
        const card = document.createElement("article");
        card.className = "card";

        const questionKey = String(question.text || "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim();

        const frequency = frequencyByText.get(questionKey);

        card.append(
          textEl(
            "h3",
            `${question.questionNumber || "Question"}` +
            `${question.page ? ` · Page ${question.page}` : ""}`
          ),
          textEl("p", question.text),
          textEl(
            "p",
            `${question.marks ? `${question.marks} marks` : "Marks unknown"} · ` +
            `${question.topic || "Topic unknown"} · ` +
            `${question.sourceDocument || "Source unavailable"}` +
            `${frequency
              ? ` · Appears in ${frequency.paperCount} paper(s) ` +
                `(${frequency.occurrenceCount} occurrence(s))`
              : ""}`,
            "muted"
          )
        );

        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn question-btn";
        button.textContent = "Answer this question";

        button.addEventListener("click", () => {
          saveData({
            question: question.text,
            topic: question.topic || "",
            paperId:
              question.paperId ||
              data.paperId ||
              sourcePaperIds[0] ||
              "",
            paperIds: sourcePaperIds,
            batchId: data.batchId || ""
          });

          window.location.href = "answer.html";
        });

        card.append(button);
        questionList.append(card);
      });

      if (repeatedQuestions.length === 0) {
        repeats.append(
          textEl(
            "p",
            "No exact repeated questions were found in at least two selected papers."
          )
        );
      }

      repeatedQuestions.forEach((question) => {
        const card = document.createElement("article");
        card.className = "card";

        const paperCount =
          question.paperCount ?? question.frequency ?? 0;

        const occurrenceCount =
          question.occurrenceCount ??
          (question.occurrences || []).length;

        card.append(
          textEl(
            "h3",
            `${paperCount} paper(s) · ` +
            `${occurrenceCount} occurrence(s)`
          ),
          textEl("p", question.text),
          textEl(
            "p",
            (question.occurrences || [])
              .map((occurrence) =>
                `${occurrence.sourceDocument}` +
                `${occurrence.questionNumber
                  ? ` · ${occurrence.questionNumber}`
                  : ""}`
              )
              .join("; "),
            "muted"
          )
        );

        repeats.append(card);
      });

      if (similarContainer) {
        if (similarQuestions.length === 0) {
          similarContainer.append(
            textEl(
              "p",
              "No closely matching questions were found in the selected papers."
            )
          );
        }

        similarQuestions.forEach((question) => {
          const card = document.createElement("article");
          card.className = "card";

          card.append(
            textEl(
              "h3",
              `${Math.round((question.similarity || 0) * 100)}% similar · ` +
              `${question.paperCount || 0} paper(s)`
            ),
            textEl("p", question.textA),
            textEl("p", `Similar to: ${question.textB}`, "muted")
          );

          similarContainer.append(card);
        });
      }

      if (topics.length === 0) {
        topicGrid.append(
          textEl("p", "No topics were identified from the extracted questions.")
        );
      }

      if (questions.length === 0) {
        questionList.append(
          textEl(
            "p",
            "No valid questions were returned. Check extraction quality and try again."
          )
        );
      }

      const warnings = documents
        .filter((doc) => doc.status !== "analyzed")
        .map(
          (doc) =>
            `${doc.fileName}: ${doc.error || doc.warning || "not analyzed"}`
        );

      status.textContent =
        `${result.partial ? "Partial analysis" : "Analysis complete"}` +
        `${result.cached ? " (reused saved analysis)" : ""}: ` +
        `${result.papersSelected ?? documents.length} paper(s) selected, ` +
        `${totalQuestions} total question occurrence(s), ` +
        `${uniqueQuestions} unique, ` +
        `${repeatedCount} repeated, ` +
        `${topics.length} topics.` +
        `${result.quotaMessage ? ` ${result.quotaMessage}` : ""}` +
        `${warnings.length ? ` Issues: ${warnings.join("; ")}` : ""}`;

    } catch (error) {
      console.error("Analyzer error:", error);
      status.textContent = `Analysis failed: ${error.message}`;
    }
  }

  loadAnalysis();
}


/* ==========================================================
   6. AI ANSWER GENERATION
========================================================== */

if (document.body.dataset.page === "answer") {
  const questionInput = document.getElementById("question");
  const marksSelect = document.getElementById("marks");
  const output = document.getElementById("answerOutput");
  const status = document.getElementById("answerStatus");
  const generate = document.getElementById("generateBtn");
  const data = getData();

  if (questionInput) {
    questionInput.value = data.question || "";
  }

  if (
    marksSelect &&
    data.marks &&
    [...marksSelect.options].some(
      (option) => option.value === String(data.marks)
    )
  ) {
    marksSelect.value = String(data.marks);
  }

  const contextBox = document.getElementById("answerContext");

  if (contextBox) {
    const contextText = contextBox.querySelector("p");

    if (contextText) {
      contextText.textContent = data.topic
        ? `Selected topic: ${data.topic}`
        : data.question
          ? "Question loaded from your analyzer. You can edit it below."
          : "No topic selected. Enter any question from your syllabus.";
    }
  }

  if (generate) {
    generate.addEventListener("click", async () => {
      const question = questionInput.value.trim();
      const marks = Number(marksSelect.value);

      if (!question) {
        status.textContent = "Enter a question first.";
        return;
      }

      generate.disabled = true;
      status.textContent = "Generating your answer...";
      output.textContent = "";

      try {
        const response = await authenticatedFetch("/api/answers", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            question,
            topic: data.topic || "",
            marks,
            paperId: data.paperId || "",
            paperIds: data.paperIds || []
          })
        });

        const result = await readResponse(response);

        output.textContent = result.answer || "No answer was returned.";

        const source = result.usedSourceMaterial
          ? `Sources: ${(result.sources || []).join(", ")}`
          : "No uploaded source material was available; answer uses general AI knowledge.";

        output.append(
          document.createElement("br"),
          textEl("small", source, "muted")
        );

        saveData({
          question,
          marks
        });

        status.textContent = "Answer generated successfully.";

      } catch (error) {
        console.error("Answer generation failed:", error);
        status.textContent = error.message;

      } finally {
        generate.disabled = false;
      }
    });
  }

  const copyButton = document.getElementById("copyBtn");

  if (copyButton) {
    copyButton.addEventListener("click", async () => {
      const answer = output.innerText.trim();

      if (!answer) {
        status.textContent = "Generate an answer first.";
        return;
      }

      try {
        await navigator.clipboard.writeText(answer);
        status.textContent = "Answer copied!";
      } catch {
        status.textContent =
          "Select the answer text and copy it manually.";
      }
    });
  }
}


/* ==========================================================
   7. DASHBOARD
========================================================== */

if (document.body.dataset.page === "home") {
  const dashboardStatus = document.getElementById("dashboardStatus");
  const papersStat = document.getElementById("statPapers");
  const questionsStat = document.getElementById("statQuestions");
  const repeatedStat = document.getElementById("statRepeated");
  const topicsStat = document.getElementById("statTopics");
  const uploadsContainer = document.getElementById("recentUploads");
  const topicsContainer = document.getElementById("dashboardTopics");
  const selectionToolbar =
    document.getElementById("paperSelectionToolbar");
  const selectAllCheckbox =
    document.getElementById("selectAllPapers");
  const selectionCount = document.getElementById("selectionCount");
  const clearSelectionButton =
    document.getElementById("clearSelection");
  const analyzeSelectedButton =
    document.getElementById("analyzeSelected");
  const selectionMessage =
    document.getElementById("paperSelectionMessage");

  let libraryPapers = [];

  const selectedPaperIds = new Set();

  function dashboardElement(tag, text, className = "") {
    const element = document.createElement(tag);

    element.textContent = text ?? "";

    if (className) {
      element.className = className;
    }

    return element;
  }

  function formatUploadDate(date) {
    if (!date) return "Date unavailable";

    const parsed = new Date(date);

    if (Number.isNaN(parsed.getTime())) {
      return "Date unavailable";
    }

    return parsed.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric"
    });
  }

  function statusLabel(status) {
    const labels = {
      analyzed: "Analyzed",
      uploaded: "Uploaded",
      partial: "Partially analyzed",
      error: "Error"
    };

    return labels[status] || "Pending analysis";
  }

  function syncCheckboxes() {
    uploadsContainer
      .querySelectorAll('input[data-paper-id]')
      .forEach((checkbox) => {
        const isSelected = selectedPaperIds.has(
          checkbox.dataset.paperId
        );

        checkbox.checked = isSelected;

        checkbox
          .closest(".paper-library-row")
          ?.classList.toggle("is-selected", isSelected);
      });
  }

  function updateSelectionUi() {
    const total = libraryPapers.length;
    const selectedCount = selectedPaperIds.size;

    if (selectionCount) {
      selectionCount.textContent =
        `${selectedCount} PDF${selectedCount === 1 ? "" : "s"} selected`;
    }

    if (selectAllCheckbox) {
      selectAllCheckbox.checked =
        total > 0 && selectedCount === total;
      selectAllCheckbox.indeterminate =
        selectedCount > 0 && selectedCount < total;
      selectAllCheckbox.disabled = total === 0;
    }

    if (clearSelectionButton) {
      clearSelectionButton.disabled = selectedCount === 0;
    }

    if (analyzeSelectedButton) {
      analyzeSelectedButton.disabled = selectedCount === 0;
      analyzeSelectedButton.textContent = selectedCount
        ? `Analyze Selected Papers (${selectedCount})`
        : "Analyze Selected Papers";
    }

    if (selectionToolbar) {
      selectionToolbar.hidden = total === 0;
    }

    syncCheckboxes();
  }

  function selectedPapers() {
    return libraryPapers.filter((paper) =>
      selectedPaperIds.has(String(paper.paperId))
    );
  }

  function openAnalyzer(papers) {
    const usablePapers = papers.filter(
      (paper) => paper && paper.paperId
    );

    if (!usablePapers.length) {
      if (selectionMessage) {
        selectionMessage.textContent =
          "Select at least one PDF to analyze.";
      }

      return;
    }

    if (selectionMessage) {
      selectionMessage.textContent = "";
    }

    const paperIds = usablePapers.map((paper) =>
      String(paper.paperId)
    );

    const subjects = [
      ...new Set(
        usablePapers
          .map((paper) => paper.subject)
          .filter(Boolean)
      )
    ];

    saveData({
      // An empty batchId means this is an explicit selection,
      // not the old "analyze this upload batch" shortcut.
      batchId: "",
      paperId: paperIds[0],
      paperIds,
      subject:
        subjects.length === 1
          ? subjects[0]
          : "Multiple subjects",
      documents: usablePapers.map((paper) => ({
        paperId: paper.paperId,
        fileName: paper.fileName,
        status: paper.status
      }))
    });

    window.location.href = "analyzer.html";
  }

  function renderRecentUploads(uploads) {
    libraryPapers = Array.isArray(uploads) ? uploads : [];

    const validIds = new Set(
      libraryPapers.map((paper) => String(paper.paperId))
    );

    [...selectedPaperIds].forEach((id) => {
      if (!validIds.has(id)) {
        selectedPaperIds.delete(id);
      }
    });

    uploadsContainer.replaceChildren();

    if (!libraryPapers.length) {
      const empty = dashboardElement(
        "div",
        "Your study library is empty. Upload your first question paper to get started.",
        "dashboard-empty"
      );

      const link = document.createElement("a");
      link.href = "upload.html";
      link.className = "btn";
      link.textContent = "Upload Your First Paper →";

      empty.append(document.createElement("br"), link);
      uploadsContainer.append(empty);

      updateSelectionUi();

      return;
    }

    libraryPapers.forEach((paper) => {
      const paperId = String(paper.paperId);

      const row = document.createElement("article");
      row.className = "upload-row paper-library-row";

      const checkLabel = document.createElement("label");
      checkLabel.className = "paper-check";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.paperId = paperId;
      checkbox.checked = selectedPaperIds.has(paperId);
      checkbox.setAttribute(
        "aria-label",
        `Select ${paper.fileName || "PDF"}`
      );

      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          selectedPaperIds.add(paperId);
        } else {
          selectedPaperIds.delete(paperId);
        }

        if (selectionMessage) {
          selectionMessage.textContent = "";
        }

        row.classList.toggle(
          "is-selected",
          checkbox.checked
        );

        updateSelectionUi();
      });

      checkLabel.append(checkbox);

      const icon = dashboardElement("div", "📄", "upload-file-icon");

      const details = document.createElement("div");
      details.className = "upload-details";

      details.append(
        dashboardElement(
          "h3",
          paper.fileName || "Untitled PDF",
          "upload-file-name"
        ),
        dashboardElement(
          "p",
          paper.subject || "Subject not specified",
          "upload-subject"
        ),
        dashboardElement(
          "p",
          `${formatUploadDate(paper.uploadedAt)} · ` +
          `${paper.questionCount || 0} questions`,
          "upload-meta"
        )
      );

      const actions = document.createElement("div");
      actions.className = "upload-actions";

      const badge = dashboardElement(
        "span",
        statusLabel(paper.status),
        `status-badge status-${paper.status || "uploaded"}`
      );

      const analyzeButton = document.createElement("button");
      analyzeButton.type = "button";
      analyzeButton.className = "btn secondary upload-analyze-btn";
      analyzeButton.textContent = "Analyze alone →";

      analyzeButton.addEventListener("click", () => {
        openAnalyzer([paper]);
      });

      actions.append(badge, analyzeButton);
      row.append(checkLabel, icon, details, actions);

      uploadsContainer.append(row);
    });

    updateSelectionUi();
  }

  if (selectAllCheckbox) {
    selectAllCheckbox.addEventListener("change", () => {
      if (selectAllCheckbox.checked) {
        libraryPapers.forEach((paper) => {
          selectedPaperIds.add(String(paper.paperId));
        });
      } else {
        selectedPaperIds.clear();
      }

      if (selectionMessage) {
        selectionMessage.textContent = "";
      }

      updateSelectionUi();
    });
  }

  if (clearSelectionButton) {
    clearSelectionButton.addEventListener("click", () => {
      selectedPaperIds.clear();

      if (selectionMessage) {
        selectionMessage.textContent = "";
      }

      updateSelectionUi();
    });
  }

  if (analyzeSelectedButton) {
    analyzeSelectedButton.addEventListener("click", () => {
      openAnalyzer(selectedPapers());
    });
  }

  function renderImportantTopics(topics) {
    topicsContainer.replaceChildren();

    if (!topics.length) {
      topicsContainer.append(
        dashboardElement(
          "p",
          "Your important topics will appear here after you analyze your uploaded papers.",
          "dashboard-empty"
        )
      );

      return;
    }

    topics.forEach((topic, index) => {
      const row = document.createElement("article");
      row.className = "topic-row";

      const number = dashboardElement(
        "span",
        String(index + 1).padStart(2, "0"),
        "topic-number"
      );

      const details = document.createElement("div");
      details.className = "topic-details";

      details.append(
        dashboardElement("h3", topic.topic),
        dashboardElement(
          "p",
          `${topic.questionCount} questions · ${topic.paperCount} papers`
        )
      );

      const badge = dashboardElement(
        "span",
        topic.priority,
        `priority-badge priority-${String(topic.priority).toLowerCase()}`
      );

      row.append(number, details, badge);
      topicsContainer.append(row);
    });
  }

  async function loadDashboard() {
    dashboardStatus.textContent = "Loading your study statistics...";

    try {
      const response = await authenticatedFetch("/api/dashboard");
      const result = await readResponse(response);

      papersStat.textContent = result.stats.totalPapers;
      questionsStat.textContent = result.stats.questionsExtracted;
      repeatedStat.textContent = result.stats.repeatedQuestions;
      topicsStat.textContent = result.stats.importantTopics;

      const papers =
        result.papers ||
        result.uploads ||
        result.recentUploads ||
        [];

      renderRecentUploads(papers);
      renderImportantTopics(result.topics || []);

      dashboardStatus.textContent =
        result.stats.totalPapers === 0
          ? "Welcome! Upload your first PDF to start building your study library."
          : `${result.stats.totalPapers} PDF(s) available. ` +
            "Select one or more papers to analyze them together.";

    } catch (error) {
      console.error("Dashboard loading failed:", error);

      dashboardStatus.textContent =
        `Unable to load dashboard: ${error.message}`;

      [papersStat, questionsStat, repeatedStat, topicsStat].forEach(
        (element) => {
          if (element) {
            element.textContent = "—";
          }
        }
      );

      uploadsContainer.replaceChildren(
        dashboardElement(
          "p",
          "Could not load recent uploads. Check your login and server connection.",
          "dashboard-empty"
        )
      );

      topicsContainer.replaceChildren(
        dashboardElement(
          "p",
          "Topic insights are temporarily unavailable.",
          "dashboard-empty"
        )
      );
    }
  }

  loadDashboard();
}

console.log("ExamPilot AI script loaded.");
