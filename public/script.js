/* ==============================
   EXAMPILOT AI THEME SWITCHER
================================ */
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

  // Apply the saved theme when the page loads.
  let savedTheme = "light";

  try {
    savedTheme = localStorage.getItem(THEME_KEY) || "light";
  } catch (error) {
    console.warn("Theme preference could not be read.");
  }

  applyTheme(savedTheme);

  // Register the button click handler.
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
const STORAGE_KEY = "exampilotData";

function getData() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { return {}; } }
function saveData(updates) { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...getData(), ...updates })); }
async function readResponse(response) { const data = await response.json(); if (!response.ok) throw new Error(data.error || "Something went wrong."); return data; }
function textEl(tag, text, className = "") { const el = document.createElement(tag); el.textContent = text ?? ""; if (className) el.className = className; return el; }

// Upload: retain an explicit selection across multiple file-picker operations.


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

  const fmt = (bytes) =>
    bytes < 1048576
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;

  // Display the selected PDF files.
  function render() {
    list.replaceChildren();

    if (fileCounter) {
      fileCounter.textContent =
        `${selected.size} file${selected.size === 1 ? "" : "s"}`;
    }

    if (selected.size === 0) {
      list.append(
        textEl("p", "No files selected.", "muted")
      );
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
        textEl("p", `${fmt(file.size)} · Ready to upload`, "muted")
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

  // Validate and add files from the picker or drag-and-drop.
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

  // File picker: supports selecting multiple files at once.
  input.addEventListener("change", () => {
    addFiles(Array.from(input.files));
    input.value = "";
  });

  // Drag-and-drop support.
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

  // Upload all selected files together.
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

    const existingData = getData();

    if (existingData.batchId) {
      formData.append("batchId", existingData.batchId);
    }

    submit.disabled = true;
    message.textContent = `Uploading ${selected.size} PDF file(s)...`;

    try {
      const response = await fetch("/api/papers/upload", {
        method: "POST",
        body: formData
      });

      const result = await readResponse(response);

      // Preserve the batch information returned by your backend.
      const documents = result.documents || [];
      const paperIds = result.paperIds ||
        documents.map((doc) => doc.paperId || doc._id).filter(Boolean);

      saveData({
        batchId: result.batchId || existingData.batchId || "",
        paperIds,
        paperId: paperIds[0] || "",
        subject: subjectInput.value.trim(),
        documents,
        warnings: result.warnings || []
      });

      const readyDocuments = documents.filter(
        (doc) => doc.status === "ready"
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
      message.textContent = error.message || "Upload failed. Please try again.";
    } finally {
      submit.disabled = false;
    }
  });

  render();
}
if (document.body.dataset.page === "analyzer") {
  const data = getData(), subjectEl = document.getElementById("analyzerSubject"), nameEl = document.getElementById("paperName");
  const topicGrid = document.getElementById("topicGrid"), questionList = document.getElementById("questionList"), status = document.getElementById("analysisStatus");
  const repeats = document.getElementById("repeatedQuestions");
  async function loadAnalysis() {
    if (!data.batchId && !data.paperId) { status.textContent = "No uploaded papers found. Please upload a PDF first."; return; }
    status.textContent = data.uploadWarnings?.length ? `Analyzing extracted papers. Upload issues: ${data.uploadWarnings.join("; ")}` : "Analyzing documents independently…";
    try {
      const endpoint = data.batchId ? `/api/batches/${encodeURIComponent(data.batchId)}/analyze` : `/api/papers/${encodeURIComponent(data.paperId)}/analyze`;
      const result = await readResponse(await fetch(endpoint)); subjectEl.textContent = result.subject || data.subject || "Unknown";
      nameEl.textContent = result.documents.map(doc => `${doc.fileName}: ${doc.status}${doc.error ? ` (${doc.error})` : ""}`).join(" · ");
      topicGrid.replaceChildren(); questionList.replaceChildren(); repeats.replaceChildren(); document.getElementById("priorityMethod").textContent = result.priorityMethod || "";
      result.topics.forEach(topic => {
        // Populate analyzer dashboard statistics.
const questionCountEl = document.getElementById("analyzerQuestionCount");
const topicCountEl = document.getElementById("analyzerTopicCount");
const repeatedCountEl = document.getElementById("analyzerRepeatedCount");
const documentCountEl = document.getElementById("analyzerDocumentCount");

if (questionCountEl) {
  questionCountEl.textContent = result.questionCount ?? result.questions.length;
}

if (topicCountEl) {
  topicCountEl.textContent = result.topics.length;
}

if (repeatedCountEl) {
  repeatedCountEl.textContent = result.repeatedQuestions.length;
}

if (documentCountEl) {
  documentCountEl.textContent =
    `${result.completedCount ?? 0}/${result.documentCount ?? result.documents.length}`;
}
        const card = document.createElement("article"); card.className = "card";
        card.append(textEl("h3", topic.topic), textEl("p", `${topic.priority} Priority · ${topic.paperCount} paper(s) · ${topic.questionCount} question(s)`), textEl("p", `Years: ${topic.years.join(", ") || "Unknown"} · Marks: ${topic.marks.join(", ") || "Unknown"}`, "muted"), textEl("p", `Evidence: ${topic.sources.join(", ")}`, "muted"));
        topic.representativeQuestions.forEach(q => card.append(textEl("p", `• ${q.text}${q.marks ? ` (${q.marks} marks)` : ""}`, "muted")));
        const choose = document.createElement("button"); choose.type = "button"; choose.className = "btn"; choose.textContent = "Study this topic";
        choose.addEventListener("click", () => { saveData({ topic: topic.topic, paperIds: result.documents.filter(d => d.status === "analyzed").map(d => d.paperId), paperId: result.documents.find(d => d.status === "analyzed")?.paperId || data.paperId, batchId: result.batchId }); window.location.href = "answer.html"; }); card.append(choose); topicGrid.append(card);
      });
      result.questions.forEach(q => {
        const card = document.createElement("article"); card.className = "card";
        card.append(textEl("h3", `${q.questionNumber || "Question"}${q.page ? ` · Page ${q.page}` : ""}`), textEl("p", q.text), textEl("p", `${q.marks ? `${q.marks} marks` : "Marks unknown"} · ${q.topic || "Topic unknown"} · ${q.sourceDocument}`, "muted"));
        const btn = document.createElement("button"); btn.type = "button"; btn.className = "btn question-btn"; btn.textContent = "Answer this question";
        btn.addEventListener("click", () => { saveData({ question: q.text, topic: q.topic || "", paperId: q.paperId, paperIds: result.documents.filter(d => d.status === "analyzed").map(d => d.paperId) }); window.location.href = "answer.html"; }); card.append(btn); questionList.append(card);
      });
      if (!result.repeatedQuestions.length) repeats.append(textEl("p", "No exact repeated questions were found in distinct uploaded papers."));
      result.repeatedQuestions.forEach(q => { const card = document.createElement("article"); card.className = "card"; card.append(textEl("h3", `${q.paperCount} distinct papers`), textEl("p", q.text), textEl("p", q.occurrences.map(o => `${o.sourceDocument}${o.questionNumber ? ` · ${o.questionNumber}` : ""}`).join("; "), "muted")); repeats.append(card); });
      if (!result.topics.length) topicGrid.append(textEl("p", "No topics were identified from the extracted questions."));
      if (!result.questions.length) questionList.append(textEl("p", "No valid questions were returned. Check extraction quality and try again."));
      const warnings = result.documents.filter(d => d.status !== "analyzed").map(d => `${d.fileName}: ${d.error || d.warning || "not analyzed"}`);
      status.textContent = `${result.partial ? "Partial analysis" : "Analysis complete"}: ${result.completedCount}/${result.documentCount} documents, ${result.questionCount} questions, ${result.topics.length} topics.${warnings.length ? ` Issues: ${warnings.join("; ")}` : ""}`;
    } catch (error) { status.textContent = `Analysis failed: ${error.message}`; }
  }
  loadAnalysis();
}

if (document.body.dataset.page === "answer") {
  const questionInput = document.getElementById("question"), marksSelect = document.getElementById("marks"), output = document.getElementById("answerOutput"), status = document.getElementById("answerStatus"), generate = document.getElementById("generateBtn"), data = getData();
  questionInput.value = data.question || "";
  if (data.marks && [...marksSelect.options].some(o => o.value === String(data.marks))) marksSelect.value = String(data.marks);
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
  generate.addEventListener("click", async () => {
    const question = questionInput.value.trim(), marks = Number(marksSelect.value); if (!question) { status.textContent = "Enter a question first."; return; }
    generate.disabled = true; status.textContent = "Generating your answer…"; output.textContent = "";
    try { const result = await readResponse(await fetch("/api/answers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question, topic: data.topic || "", marks, paperId: data.paperId || "", paperIds: data.paperIds || [] }) })); output.textContent = result.answer; const source = result.usedSourceMaterial ? `Sources: ${result.sources.join(", ")}` : "No uploaded source material was available; answer uses general AI knowledge."; output.append(document.createElement("br"), textEl("small", source, "muted")); saveData({ question, marks }); status.textContent = "Answer generated successfully."; }
    catch (error) { status.textContent = error.message; } finally { generate.disabled = false; }
  });
  document.getElementById("copyBtn").addEventListener("click", async () => { const answer = output.innerText.trim(); if (!answer) { status.textContent = "Generate an answer first."; return; } try { await navigator.clipboard.writeText(answer); status.textContent = "Answer copied!"; } catch { status.textContent = "Select the answer text and copy it manually."; } });
}
// ==========================================
// EXAMPILOT AI: PROFESSIONAL DASHBOARD
// ==========================================

if (document.body.dataset.page === "home") {
  const dashboardStatus = document.getElementById("dashboardStatus");
  const papersStat = document.getElementById("statPapers");
  const questionsStat = document.getElementById("statQuestions");
  const repeatedStat = document.getElementById("statRepeated");
  const topicsStat = document.getElementById("statTopics");
  const uploadsContainer = document.getElementById("recentUploads");
  const topicsContainer = document.getElementById("dashboardTopics");

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

  function renderRecentUploads(uploads) {
    uploadsContainer.replaceChildren();

    if (!uploads.length) {
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
      return;
    }

    uploads.forEach(paper => {
      const row = document.createElement("article");
      row.className = "upload-row";

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
          `${formatUploadDate(paper.uploadedAt)} · ${paper.questionCount || 0} questions`,
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
      analyzeButton.textContent = "Analyze →";

      analyzeButton.addEventListener("click", () => {
        const currentData = getData();

        const relatedPapers = uploads.filter(item =>
          paper.batchId
            ? item.batchId === paper.batchId
            : item.paperId === paper.paperId
        );

        const paperIds = relatedPapers.map(item => item.paperId);

        saveData({
          batchId: paper.batchId || "",
          paperId: paper.paperId,
          paperIds,
          subject: paper.subject || "",
          documents: relatedPapers.map(item => ({
            paperId: item.paperId,
            fileName: item.fileName,
            status: item.status
          }))
        });

        window.location.href = "analyzer.html";
      });

      actions.append(badge, analyzeButton);
      row.append(icon, details, actions);
      uploadsContainer.append(row);
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
      const response = await fetch("/api/dashboard");
      const result = await readResponse(response);

      papersStat.textContent = result.stats.totalPapers;
      questionsStat.textContent = result.stats.questionsExtracted;
      repeatedStat.textContent = result.stats.repeatedQuestions;
      topicsStat.textContent = result.stats.importantTopics;

      renderRecentUploads(result.recentUploads || []);
      renderImportantTopics(result.topics || []);

      dashboardStatus.textContent =
        result.stats.totalPapers === 0
          ? "Welcome! Upload your first PDF to start building your study library."
          : "Your dashboard is up to date.";

    } catch (error) {
      console.error("Dashboard loading failed:", error);

      dashboardStatus.textContent =
        "Unable to load live statistics. Check your server connection.";

      [papersStat, questionsStat, repeatedStat, topicsStat].forEach(
        element => {
          element.textContent = "—";
        }
      );

      uploadsContainer.replaceChildren(
        dashboardElement(
          "p",
          "Could not load recent uploads. Please check that your backend server is running.",
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