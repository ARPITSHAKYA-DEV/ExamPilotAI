
require("dotenv").config();

const mongoose = require("mongoose");

const {
  initializeApp,
  cert,
  getApps
} = require("firebase-admin/app");

const { getAuth } = require("firebase-admin/auth");

const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const path = require("path");
const { randomUUID } = require("crypto");
const { GoogleGenAI } = require("@google/genai");

// ============================================
// MODELS
// ============================================

const Paper = require("./models/Paper");
const Answer = require("./models/Answer");
const LoginHistory = require("./models/LoginHistory");

// ============================================
// APP CONFIGURATION
// ============================================

const app = express();

const PORT = process.env.PORT || 3000;

const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

const MAX_FILES = Number(process.env.MAX_UPLOAD_FILES || 10);

const MAX_MB = Number(process.env.MAX_UPLOAD_FILE_MB || 50);

const MAX_ANALYSIS_PAPERS = Number(
  process.env.MAX_ANALYSIS_PAPERS || 50
);

const ANALYSIS_VERSION = "2";

const ANALYSIS_CACHE_TTL_MS = 30 * 60 * 1000;

app.use(express.json({ limit: "1mb" }));

app.use(express.static(path.join(__dirname, "public")));

// ============================================
// FIREBASE ADMIN INITIALIZATION
// ============================================

const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  : require("./serviceAccountKey.json");

if (!getApps().length) {
  initializeApp({
    credential: cert(serviceAccount)
  });
}

const firebaseAuth = getAuth();

console.log("Firebase Admin initialized successfully.");

// ============================================
// FIREBASE AUTHENTICATION
// ============================================

async function verifyFirebaseToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Authentication required."
      });
    }

    const idToken = authHeader.slice(7);

    req.user = await firebaseAuth.verifyIdToken(idToken);

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: "Invalid or expired authentication token."
    });
  }
}

// ============================================
// ADMIN AUTHORIZATION
// ============================================

function requireAdmin(req, res, next) {
  const adminEmail = (process.env.ADMIN_EMAIL || "")
    .trim()
    .toLowerCase();

  const userEmail = (req.user?.email || "")
    .trim()
    .toLowerCase();

  if (
    !adminEmail ||
    !req.user?.email_verified ||
    userEmail !== adminEmail
  ) {
    return res.status(403).json({
      success: false,
      error: "Administrator access required."
    });
  }

  next();
}

// ============================================
// DATABASE CONNECTION
// ============================================

if (process.env.MONGODB_URI) {
  mongoose
    .connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000
    })
    .then(() => {
      console.log("MongoDB connected");
    })
    .catch(error => {
      console.error(
        "MongoDB connection failed:",
        error.message
      );
    });
} else {
  console.warn(
    "MONGODB_URI is not configured. " +
    "Uploads will only persist until the server restarts."
  );
}

// ============================================
// GEMINI CONFIGURATION
// ============================================

const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    })
  : null;

console.log(
  ai
    ? `Gemini configured. Model: ${MODEL}`
    : "WARNING: GEMINI_API_KEY is not configured."
);

// ============================================
// GEMINI RETRY HELPER
// ============================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getGeminiStatusCode(error) {
  const value =
    error?.status ??
    error?.statusCode ??
    error?.code;

  const numeric = Number(value);

  if ([429, 500, 502, 503, 504].includes(numeric)) {
    return numeric;
  }

  const message = String(error?.message || error);

  const match = message.match(
    /\b(429|500|502|503|504)\b/
  );

  return match ? Number(match[1]) : null;
}


function isRetryableGeminiError(error) {
  const message = String(error?.message || error);

  // A daily quota exhaustion cannot be fixed by
  // retrying after a few seconds.
  if (
    /per day limit exceeded|GenerateRequestsPerDayPerModel|quota exceeded for metric:.*requests/i
      .test(message)
  ) {
    return false;
  }

  const statusCode = getGeminiStatusCode(error);

  if ([500, 502, 503, 504].includes(statusCode)) {
    return true;
  }

  // Retry 429 only when it appears to be a temporary
  // rate limit, not an exhausted daily quota.
  if (statusCode === 429) {
    return /rate limit|too many requests|requests per minute|tokens per minute/i
      .test(message);
  }

  return /UNAVAILABLE|high demand|overloaded|temporarily unavailable/i
    .test(message);
}

async function generateContentWithRetry(
  request,
  maxAttempts = 3
) {
  if (!ai) {
    throw new Error(
      "Gemini is not configured. Check GEMINI_API_KEY."
    );
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await ai.models.generateContent(request);
    } catch (error) {
      const statusCode = getGeminiStatusCode(error);

      if (
        !isRetryableGeminiError(error) ||
        attempt === maxAttempts
      ) {
        throw error;
      }

      // Wait 2 seconds, then 4 seconds.
      // Avoid retrying immediately during temporary overload.

      const delay = 2000 * Math.pow(2, attempt - 1);

      console.warn(
        `Gemini request failed. Status: ${statusCode || "unknown"}. ` +
        `Attempt ${attempt}/${maxAttempts}. ` +
        `Retrying in ${delay / 1000} seconds.`
      );

      await sleep(delay);
    }
  }

  throw new Error("Gemini request failed after retries.");
}

// ============================================
// TEMPORARY CACHE
// ============================================

// Used only when MongoDB is unavailable.
// Every cached paper is associated with a Firebase UID.

const cache = new Map();

// Successful combined-analysis results are cached by the exact set
// of papers and the analysis version. This avoids repeated Gemini
// requests for the same selection during the cache lifetime.
const analysisCache = new Map();

// ============================================
// PDF UPLOAD CONFIGURATION
// ============================================

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: MAX_MB * 1024 * 1024,
    files: MAX_FILES
  }
});

// ============================================
// HELPER FUNCTIONS
// ============================================

function parseJSON(result) {
  const text = (result.text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  return JSON.parse(text);
}

// ============================================
// OWNERSHIP CHECK
// ============================================

async function getOwnedPaper(id, userId) {
  if (!mongoose.isValidObjectId(id)) {
    return null;
  }

  if (mongoose.connection.readyState === 1) {
    const paper = await Paper.findOne({
      _id: id,
      userId
    });

    if (paper) {
      return paper;
    }
  }

  const cachedPaper = cache.get(String(id));

  if (
    cachedPaper &&
    cachedPaper.userId === userId
  ) {
    return cachedPaper;
  }

  return null;
}

async function getOwnedPapers(ids, userId) {
  const uniqueIds = [...new Set(ids.map(id => String(id)))];

  if (mongoose.connection.readyState === 1) {
    const papers = await Paper.find({
      _id: { $in: uniqueIds },
      userId
    });

    const byId = new Map(
      papers.map(paper => [String(paper._id), paper])
    );

    return uniqueIds
      .map(id => {
        const stored = byId.get(id);

        if (stored) {
          return stored;
        }

        const cached = cache.get(id);

        return cached && cached.userId === userId
          ? cached
          : null;
      })
      .filter(Boolean);
  }

  return uniqueIds
    .map(id => cache.get(id))
    .filter(paper => paper && paper.userId === userId);
}

// ============================================
// QUESTION NORMALIZATION AND METRICS
// ============================================

function normalizeQuestionText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function questionTokens(value) {
  return new Set(
    normalizeQuestionText(value)
      .split(" ")
      .filter(token => token.length > 2)
  );
}

function jaccardSimilarity(first, second) {
  if (!first.size || !second.size) {
    return 0;
  }

  let intersection = 0;

  for (const token of first) {
    if (second.has(token)) {
      intersection++;
    }
  }

  return intersection / (first.size + second.size - intersection);
}

function isQuotaExceededError(error) {
  const message = String(error?.message || error);

  if (
    /per day limit exceeded|GenerateRequestsPerDayPerModel|quota exceeded for metric:.*requests|exceeded your current quota/i
      .test(message)
  ) {
    return true;
  }

  return (
    getGeminiStatusCode(error) === 429 &&
    !/rate limit|too many requests|requests per minute|tokens per minute/i
      .test(message)
  );
}

function paperSignature(docs) {
  return docs
    .map(paper => {
      const updatedAt = paper.updatedAt
        ? new Date(paper.updatedAt).getTime()
        : 0;

      return [
        String(paper._id),
        paper.status || "",
        paper.questions?.length || 0,
        updatedAt
      ].join(":");
    })
    .sort()
    .join("|");
}

function getAnalysisCacheKey(docs, userId) {
  return [
    ANALYSIS_VERSION,
    userId,
    paperSignature(docs)
  ].join(":");
}

async function analyzeWithCache(docs, userId, options = {}) {
  const cacheKey = getAnalysisCacheKey(docs, userId);
  const cached = analysisCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return {
      ...cached.result,
      cached: true
    };
  }

  const result = await analyzePapers(docs, options);

  // Cache only complete, successful analyses. Partial/failed results
  // should be retried instead of being served from cache.
  if (
    result.completedCount === docs.length &&
    !result.quotaExceeded
  ) {
    // The papers may have been marked as analyzed while this request
    // was running, so store the result under the updated signature.
    analysisCache.set(getAnalysisCacheKey(docs, userId), {
      expiresAt: Date.now() + ANALYSIS_CACHE_TTL_MS,
      result
    });
  }

  return {
    ...result,
    cached: false
  };
}

function analysisHttpStatus(result) {
  return result.quotaExceeded && result.completedCount === 0
    ? 429
    : 200;
}

// ============================================
// HEALTH CHECK
// ============================================

app.get("/api/health", (req, res) => {
  res.json({
    success: true,

    database:
      mongoose.connection.readyState === 1
        ? "connected"
        : "unavailable",

    gemini: Boolean(ai),

    model: MODEL
  });
});

// ============================================
// LOGIN HISTORY
// ============================================

app.post(
  "/api/auth/login",
  verifyFirebaseToken,
  async (req, res) => {
    try {
      const { name, loginMethod } = req.body;

      const verifiedEmail = (
        req.user.email || ""
      )
        .trim()
        .toLowerCase();

      if (!verifiedEmail) {
        return res.status(400).json({
          success: false,
          error: "The authenticated account has no email address."
        });
      }

      const allowedMethods = [
        "google.com",
        "password"
      ];

      const safeLoginMethod = allowedMethods.includes(
        loginMethod
      )
        ? loginMethod
        : "unknown";

      const loginRecord = await LoginHistory.create({
        firebaseUid: req.user.uid,

        name: (
          name ||
          req.user.name ||
          "Student"
        )
          .toString()
          .trim(),

        email: verifiedEmail,

        loginMethod: safeLoginMethod,

        loggedInAt: new Date()
      });

      return res.status(201).json({
        success: true,
        message: "Login recorded successfully.",
        loginId: loginRecord._id
      });
    } catch (error) {
      console.error(
        "Login tracking error:",
        error.message
      );

      return res.status(500).json({
        success: false,
        error: "Unable to record login."
      });
    }
  }
);

// ============================================
// USER DASHBOARD
// ============================================

app.get(
  "/api/dashboard",
  verifyFirebaseToken,
  async (req, res) => {
    try {
      const userId = req.user.uid;

      let papers = [];

      if (mongoose.connection.readyState === 1) {
        papers = await Paper.find({
          userId
        })
          .sort({ createdAt: -1 })
          .lean();
      } else {
        papers = [...cache.values()]
          .filter(paper => paper.userId === userId)
          .sort(
            (a, b) =>
              new Date(b.createdAt || 0) -
              new Date(a.createdAt || 0)
          );
      }

      const totalPapers = papers.length;

      const questionsExtracted = papers.reduce(
        (total, paper) =>
          total + (paper.questions?.length || 0),
        0
      );

      const questionGroups = new Map();

      for (const paper of papers) {
        const seenInPaper = new Set();

        for (const question of paper.questions || []) {
          if (!question.text) {
            continue;
          }

          const key = question.text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim();

          if (!key || seenInPaper.has(key)) {
            continue;
          }

          seenInPaper.add(key);

          if (!questionGroups.has(key)) {
            questionGroups.set(key, new Set());
          }

          questionGroups.get(key).add(String(paper._id));
        }
      }

      const repeatedQuestions = [
        ...questionGroups.values()
      ].filter(
        paperIds => paperIds.size > 1
      ).length;

      const topicGroups = new Map();

      for (const paper of papers) {
        for (const question of paper.questions || []) {
          const topic = String(
            question.topic || ""
          ).trim();

          if (!topic) {
            continue;
          }

          const key = topic.toLowerCase();

          if (!topicGroups.has(key)) {
            topicGroups.set(key, {
              topic,
              questionCount: 0,
              papers: new Set()
            });
          }

          const item = topicGroups.get(key);

          item.questionCount++;
          item.papers.add(String(paper._id));
        }
      }

      const importantTopics = [
        ...topicGroups.values()
      ]
        .map(item => ({
          topic: item.topic,

          questionCount: item.questionCount,

          paperCount: item.papers.size,

          priority:
            item.papers.size >= 3 ||
            item.questionCount >= 4
              ? "High"
              : item.papers.size >= 2 ||
                item.questionCount >= 2
                ? "Medium"
                : "Low"
        }))
        .sort(
          (a, b) =>
            b.paperCount - a.paperCount ||
            b.questionCount - a.questionCount
        )
        .slice(0, 5);

      const allPapers = papers.map(paper => ({
        paperId: String(paper._id),

        fileName: paper.originalName,

        subject: paper.subject,

        status: paper.status,

        extractionMethod: paper.extractionMethod,

        uploadedAt: paper.createdAt || null,

        questionCount: paper.questions?.length || 0,

        batchId: paper.batchId || null,

        analysisAvailable:
          paper.status === "analyzed" &&
          Array.isArray(paper.questions) &&
          paper.questions.length > 0
      }));

      return res.json({
        success: true,

        stats: {
          totalPapers,

          questionsExtracted,

          repeatedQuestions,

          importantTopics: topicGroups.size
        },

        // Every paper owned by the authenticated student.
        papers: allPapers,

        // Kept for backwards compatibility with older clients.
        recentUploads: allPapers.slice(0, 5),

        // Kept for backwards compatibility. Dashboard now uses `papers`.
        uploads: allPapers,

        topics: importantTopics
      });
    } catch (error) {
      console.error(
        "Dashboard error:",
        error.message
      );

      return res.status(500).json({
        success: false,
        error: "Unable to load dashboard statistics."
      });
    }
  }
);

// ============================================
// UPLOAD PAPERS
// ============================================

app.post(
  "/api/papers/upload",
  verifyFirebaseToken,

  upload.fields([
    {
      name: "papers",
      maxCount: MAX_FILES
    },
    {
      name: "paper",
      maxCount: 1
    }
  ]),

  async (req, res) => {
    try {
      const userId = req.user.uid;

      const files = [
        ...(req.files?.papers || []),
        ...(req.files?.paper || [])
      ];

      if (!files.length) {
        return res.status(400).json({
          success: false,
          error: "Select at least one PDF."
        });
      }

      if (files.length > MAX_FILES) {
        return res.status(400).json({
          success: false,
          error: `Select no more than ${MAX_FILES} PDFs.`
        });
      }

      const subject = String(
        req.body.subject || ""
      ).trim();

      if (!subject || subject.length > 100) {
        return res.status(400).json({
          success: false,
          error: "Enter a valid subject."
        });
      }

      const requestedBatchId = String(
        req.body.batchId || ""
      );

      if (
        requestedBatchId &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          requestedBatchId
        )
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid upload batch ID."
        });
      }

      const batchId =
        requestedBatchId || randomUUID();

      const documents = [];

      // Process PDFs sequentially to avoid unnecessary
      // simultaneous PDF parsing and resource pressure.

      for (const file of files) {
        const originalName = path.basename(
          file.originalname
        );

        try {
          if (
            (
              !/\.pdf$/i.test(originalName) &&
              file.mimetype !== "application/pdf"
            ) ||
            file.buffer.subarray(0, 5).toString() !== "%PDF-"
          ) {
            throw new Error("This file is not a valid PDF.");
          }

          const parsed = await pdfParse(file.buffer);

          let text = (parsed.text || "").trim();

          let extractionMethod = "pdf-parse";

          let warning = "";

          // Gemini fallback for scanned PDFs.

          if (!text && ai) {
            try {
              const ocr = await generateContentWithRetry({
                model: MODEL,

                contents: [
                  {
                    inlineData: {
                      mimeType: "application/pdf",

                      data: file.buffer.toString("base64")
                    }
                  },

                  {
                    text:
                      "Transcribe this exam paper. " +
                      "Preserve question numbers, subquestions, " +
                      "marks and headings. Use [unclear] " +
                      "for unreadable content. Do not guess. " +
                      "Return transcription only."
                  }
                ]
              });

              text = (ocr.text || "").trim();

              if (text) {
                extractionMethod = "gemini-pdf-vision";
              }
            } catch (error) {
              console.error(
                `Gemini transcription failed for ${originalName}:`,
                error.message
              );

              warning =
                `Gemini PDF transcription failed: ${error.message}`;
            }
          }

          if (!text) {
            throw new Error(
              warning ||
              "No selectable text was found. " +
              "This may be a scanned PDF; " +
              "configure Gemini vision/OCR fallback."
            );
          }

          if (text.length > 200000) {
            warning =
              "Extracted text truncated at the 200,000-character limit.";
          }

          const record = {
            userId,

            batchId,

            subject,

            originalName,

            extractedText: text.slice(0, 200000),

            extractionMethod,

            extractionWarning: warning,

            status: "uploaded"
          };

          let saved;

          if (mongoose.connection.readyState === 1) {
            saved = await Paper.create(record);
          } else {
            saved = {
              ...record,

              _id: new mongoose.Types.ObjectId(),

              createdAt: new Date(),

              updatedAt: new Date(),

              questions: [],

              topics: []
            };

            cache.set(String(saved._id), saved);
          }

          documents.push({
            paperId: String(saved._id),

            fileName: originalName,

            status: "ready",

            extractedCharacters: text.length,

            extractionMethod,

            warning
          });
        } catch (error) {
          console.error(
            `Upload processing failed for ${originalName}:`,
            error.message
          );

          documents.push({
            fileName: originalName,

            status: "error",

            error: error.message
          });
        }
      }

      const successfulDocuments = documents.filter(
        document => document.status === "ready"
      );

      if (!successfulDocuments.length) {
        return res.status(422).json({
          success: false,

          batchId,

          documents,

          error: "No selected PDF could be extracted."
        });
      }

      return res.status(201).json({
        success: true,

        batchId,

        subject,

        documents
      });
    } catch (error) {
      console.error(
        "Upload failed:",
        error.message
      );

      return res.status(500).json({
        success: false,
        error: "Upload processing failed. Check server configuration."
      });
    }
  }
);

// ============================================
// LOAD A USER'S UPLOAD BATCH
// ============================================

async function loadBatch(batchId, userId) {
  let stored = [];

  if (mongoose.connection.readyState === 1) {
    stored = await Paper.find({
      batchId,
      userId
    });
  }

  const known = new Set(
    stored.map(paper => String(paper._id))
  );

  const cached = [...cache.values()].filter(
    paper =>
      paper.batchId === batchId &&
      paper.userId === userId &&
      !known.has(String(paper._id))
  );

  return [...stored, ...cached];
}

// ============================================
// ANALYZE PAPERS
// ============================================

async function analyzePapers(docs, options = {}) {
  const batchId = options.batchId || null;

  const analysisSessionId =
    options.analysisSessionId || null;

  const needsGemini = docs.some(
    paper =>
      !(
        paper.status === "analyzed" &&
        Array.isArray(paper.questions) &&
        paper.questions.length
      )
  );

  // Saved analyses can still be combined when Gemini is not
  // configured. Only fail when new extraction is actually needed.
  if (!ai && needsGemini) {
    throw new Error(
      "Gemini is not configured. Set GEMINI_API_KEY in .env."
    );
  }

  const outcomes = [];

  let dailyQuotaExceeded = false;

  // IMPORTANT:
  // Process one PDF at a time instead of sending a large
  // number of simultaneous Gemini requests.

  for (const paper of docs) {
    try {
      if (
        paper.status === "analyzed" &&
        Array.isArray(paper.questions) &&
        paper.questions.length
      ) {
        // Reuse previously extracted questions. Normalize the
        // paper/source fields in case older records omitted them.
        const savedQuestions = paper.questions.map(
          question => ({
            ...question,
            paperId: String(paper._id),
            sourceDocument:
              question.sourceDocument || paper.originalName
          })
        );

        outcomes.push({
          paper,
          questions: savedQuestions,
          error: null,
          quotaExceeded: false
        });

        continue;
      }

      // Do not keep calling Gemini after the daily quota has
      // already been exhausted in this request.
      if (dailyQuotaExceeded) {
        outcomes.push({
          paper,
          questions: [],
          error:
            "Gemini's daily request quota has been reached. " +
            "Try again after the quota resets.",
          quotaExceeded: true
        });

        continue;
      }

      const result = await generateContentWithRetry({
        model: MODEL,

        config: {
          responseMimeType: "application/json"
        },

        contents: `
You are an exam-question extraction engine for ExamPilot AI.

TASK:
Extract every actual exam question from the supplied question paper.

SUBJECT: ${paper.subject}
SOURCE FILE: ${paper.originalName}

DOCUMENT TEXT:
${paper.extractedText.slice(0, 24000)}

RULES:
1. Extract every identifiable exam question.
2. Include internal choices, subquestions and numerical problems.
3. Preserve original wording as closely as possible.
4. Preserve question numbers and section names.
5. Extract marks only when supported by the document.
6. Never invent questions, marks, units or page numbers.
7. Ignore unrelated text.
8. Assign a concise topic to each question.
9. Use null when information cannot be determined.
10. Do not combine separate questions.
11. Return up to 150 questions.
12. Extract only identifiable questions if text is incomplete.

Return valid JSON in this structure:
{
  "questions": [
    {
      "text": "Full question text",
      "questionNumber": "Q1(a)",
      "marks": 5,
      "page": null,
      "unit": null,
      "topic": "Supported topic"
    }
  ],
  "topics": [
    {
      "topic": "Supported topic"
    }
  ]
}
`
      });

      const parsed = parseJSON(result);

      if (!Array.isArray(parsed.questions)) {
        throw new Error(
          "Gemini response did not contain a valid questions array."
        );
      }

      const questions = parsed.questions
        .filter(
          question =>
            question &&
            typeof question.text === "string" &&
            question.text.trim()
        )
        .slice(0, 150)
        .map((question, index) => ({
          id: String(index + 1),

          text: question.text.trim().slice(0, 2000),

          questionNumber: question.questionNumber || null,

          marks:
            question.marks == null ||
            !Number.isFinite(Number(question.marks))
              ? null
              : Number(question.marks),

          page:
            question.page == null ||
            !Number.isFinite(Number(question.page))
              ? null
              : Number(question.page),

          unit: question.unit || null,

          topic: question.topic || null,

          paperId: String(paper._id),

          sourceDocument: paper.originalName
        }));

      if (!questions.length) {
        throw new Error(
          "No questions were identified in the extracted text."
        );
      }

      paper.questions = questions;

      paper.topics = (
        Array.isArray(parsed.topics)
          ? parsed.topics
          : []
      )
        .filter(topic => topic?.topic)
        .map(topic => ({
          topic: String(topic.topic),
          mentions: 1
        }));

      paper.status = "analyzed";

      if (
        paper.save &&
        mongoose.connection.readyState === 1
      ) {
        await paper.save();
      } else {
        paper.updatedAt = new Date();
        cache.set(String(paper._id), paper);
      }

      outcomes.push({
        paper,
        questions,
        error: null,
        quotaExceeded: false
      });
    } catch (error) {
      console.error(
        `Analysis failed for ${paper.originalName}:`,
        error.message
      );

      const quotaExceeded = isQuotaExceededError(error);

      if (quotaExceeded) {
        dailyQuotaExceeded = true;
      }

      outcomes.push({
        paper,
        questions: [],
        error: error.message,
        quotaExceeded
      });
    }
  }

  const successful = outcomes.filter(
    outcome => !outcome.error
  );

  const questions = successful.flatMap(
    outcome => outcome.questions
  );

  // Group question occurrences by topic.

  const grouped = new Map();

  for (const question of questions) {
    const name = String(
      question.topic || "Uncategorized"
    ).trim();

    const key = name.toLowerCase();

    const row = grouped.get(key) || {
      topic: name,

      papers: new Set(),

      questions: [],

      years: new Set(),

      sources: new Set(),

      marks: []
    };

    row.papers.add(question.paperId);

    row.questions.push(question);

    row.sources.add(question.sourceDocument);

    if (question.marks) {
      row.marks.push(question.marks);
    }

    const year = String(
      question.sourceDocument || ""
    ).match(/(?:19|20)\d{2}/)?.[0];

    if (year) {
      row.years.add(year);
    }

    grouped.set(key, row);
  }

  const topics = [...grouped.values()]
    .map(
      topic => ({
        topic: topic.topic,

        // Number of distinct selected papers containing the topic.
        paperCount: topic.papers.size,

        // Total topic occurrences across all selected papers.
        questionCount: topic.questions.length,

        frequency: topic.papers.size,

        years: [...topic.years],

        sources: [...topic.sources],

        marks: topic.marks,

        representativeQuestions:
          topic.questions.slice(0, 3),

        priority:
          topic.papers.size >= 3 ||
          topic.questions.length >= 4
            ? "High"
            : topic.papers.size >= 2 ||
              topic.questions.length >= 2
              ? "Medium"
              : "Low"
      })
    )
    .sort(
      (a, b) =>
        b.paperCount - a.paperCount ||
        b.questionCount - a.questionCount ||
        a.topic.localeCompare(b.topic)
    );

  // Group every question occurrence by normalized text.
  // A paper is added to paperIds only once per group, while every
  // occurrence is preserved in occurrences.

  const exact = new Map();

  for (const question of questions) {
    const key = normalizeQuestionText(question.text);

    if (!key) {
      continue;
    }

    const group = exact.get(key) || {
      key,
      text: question.text,
      occurrences: [],
      paperIds: new Set(),
      sources: new Set()
    };

    group.occurrences.push(question);
    group.paperIds.add(String(question.paperId));
    group.sources.add(question.sourceDocument);

    exact.set(key, group);
  }

  const questionFrequency = [...exact.values()]
    .map(group => ({
      text: group.text,

      // Frequency = number of distinct selected papers.
      paperCount: group.paperIds.size,

      frequency: group.paperIds.size,

      // Total appearances, including multiple times in one paper.
      occurrenceCount: group.occurrences.length,

      sources: [...group.sources],

      paperIds: [...group.paperIds],

      occurrences: group.occurrences.map(question => ({
        paperId: question.paperId,

        sourceDocument: question.sourceDocument,

        questionNumber: question.questionNumber,

        page: question.page
      }))
    }))
    .sort(
      (a, b) =>
        b.paperCount - a.paperCount ||
        b.occurrenceCount - a.occurrenceCount ||
        a.text.localeCompare(b.text)
    );

  const repeatedQuestions = questionFrequency.filter(
    question => question.paperCount > 1
  );

  // Lightweight near-duplicate detection for questions whose
  // wording differs but whose content substantially overlaps.
  // This is separate from the exact repeated-question metric.

  const similarQuestions = [];
  const similarityEntries = [...exact.values()]
    .map(group => ({
      text: group.text,
      tokens: questionTokens(group.text),
      paperIds: group.paperIds
    }))
    .filter(entry => entry.tokens.size >= 4);

  if (similarityEntries.length <= 400) {
    for (
      let firstIndex = 0;
      firstIndex < similarityEntries.length;
      firstIndex++
    ) {
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < similarityEntries.length;
        secondIndex++
      ) {
        const first = similarityEntries[firstIndex];
        const second = similarityEntries[secondIndex];

        const similarity = jaccardSimilarity(
          first.tokens,
          second.tokens
        );

        if (similarity >= 0.8 && similarity < 1) {
          similarQuestions.push({
            textA: first.text,
            textB: second.text,
            similarity: Number(similarity.toFixed(2)),
            paperCount: new Set([
              ...first.paperIds,
              ...second.paperIds
            ]).size
          });
        }

        if (similarQuestions.length >= 20) {
          break;
        }
      }

      if (similarQuestions.length >= 20) {
        break;
      }
    }
  }

  const quotaExceeded = outcomes.some(
    outcome => outcome.quotaExceeded
  );

  const quotaMessage = quotaExceeded
    ? "Gemini's daily request quota has been reached. " +
      "Saved analyses were reused where possible. " +
      "Please try again after the quota resets."
    : null;

  return {
    batchId,

    analysisSessionId,

    paperIds: docs.map(paper => String(paper._id)),

    subject:
      docs.length === 1
        ? docs[0]?.subject
        : [...new Set(
            docs.map(paper => paper.subject).filter(Boolean)
          )].length === 1
          ? docs[0]?.subject
          : "Multiple subjects",

    documents: outcomes.map(outcome => ({
      paperId: String(outcome.paper._id),

      fileName: outcome.paper.originalName,

      status: outcome.error
        ? "error"
        : "analyzed",

      error: outcome.error,

      extractionMethod:
        outcome.paper.extractionMethod,

      warning: outcome.paper.extractionWarning
    })),

    // Number of distinct PDFs selected for this analysis.
    papersSelected: docs.length,

    documentCount: docs.length,

    completedCount: successful.length,

    // Total question occurrences across the selected papers.
    totalQuestionsFound: questions.length,

    // Backwards-compatible alias for the total occurrence count.
    questionCount: questions.length,

    // Number of distinct normalized questions.
    uniqueQuestions: questionFrequency.length,

    uniqueQuestionCount: questionFrequency.length,

    // Number of distinct questions appearing in at least two papers.
    repeatedQuestionCount: repeatedQuestions.length,

    repeatedQuestions,

    questionFrequency,

    similarQuestions,

    questions,

    topics,

    partial: successful.length < docs.length,

    quotaExceeded,

    quotaMessage,

    priorityMethod:
      "High: at least 3 distinct papers or 4 questions; " +
      "Medium: at least 2 papers or 2 questions; Low: otherwise. " +
      "Historical evidence only, not a prediction."
  };
}

// ============================================
// SELECTED PAPERS ANALYSIS ENDPOINT
// ============================================

app.post(
  "/api/papers/analyze",
  verifyFirebaseToken,
  async (req, res) => {
    try {
      const rawIds = Array.isArray(req.body.paperIds)
        ? req.body.paperIds
        : req.body.paperId
          ? [req.body.paperId]
          : [];

      const ids = [
        ...new Set(
          rawIds
            .map(id => String(id || "").trim())
            .filter(Boolean)
        )
      ];

      if (!ids.length) {
        return res.status(400).json({
          success: false,
          error: "Select at least one PDF to analyze."
        });
      }

      if (ids.length > MAX_ANALYSIS_PAPERS) {
        return res.status(400).json({
          success: false,
          error:
            `Select no more than ${MAX_ANALYSIS_PAPERS} PDFs at once.`
        });
      }

      const invalidIds = ids.filter(
        id => !mongoose.isValidObjectId(id)
      );

      if (invalidIds.length) {
        return res.status(400).json({
          success: false,
          error:
            "One or more selected paper IDs are invalid."
        });
      }

      const docs = await getOwnedPapers(
        ids,
        req.user.uid
      );

      if (docs.length !== ids.length) {
        return res.status(404).json({
          success: false,
          error:
            "One or more selected papers were not found in your account. " +
            "They may have been deleted or belong to another user."
        });
      }

      const result = await analyzeWithCache(
        docs,
        req.user.uid,
        {
          analysisSessionId: randomUUID()
        }
      );

      const status = analysisHttpStatus(result);

      return res.status(status).json({
        success: status === 200,
        ...result,
        ...(status === 429
          ? {
              error:
                result.quotaMessage ||
                "Gemini's daily request quota has been reached."
            }
          : {})
      });
    } catch (error) {
      console.error(
        "Selected paper analysis error:",
        error.message
      );

      if (isQuotaExceededError(error)) {
        return res.status(429).json({
          success: false,
          error:
            "Gemini's daily request quota has been reached. " +
            "Please try again after the quota resets."
        });
      }

      return res.status(500).json({
        success: false,
        error:
          error.message ||
          "Question analysis failed."
      });
    }
  }
);

// ============================================
// BATCH ANALYSIS ENDPOINT (BACKWARDS COMPATIBLE)
// ============================================

app.get(
  "/api/batches/:batchId/analyze",
  verifyFirebaseToken,
  async (req, res) => {
    try {
      const docs = await loadBatch(
        req.params.batchId,
        req.user.uid
      );

      if (!docs.length) {
        return res.status(404).json({
          success: false,
          error: "No documents found for this upload batch."
        });
      }

      const result = await analyzeWithCache(
        docs,
        req.user.uid,
        {
          batchId: req.params.batchId,
          analysisSessionId: randomUUID()
        }
      );

      const status = analysisHttpStatus(result);

      return res.status(status).json({
        success: status === 200,
        ...result,
        ...(status === 429
          ? {
              error:
                result.quotaMessage ||
                "Gemini's daily request quota has been reached."
            }
          : {})
      });
    } catch (error) {
      console.error(
        "Batch analysis error:",
        error.message
      );

      if (isQuotaExceededError(error)) {
        return res.status(429).json({
          success: false,
          error:
            "Gemini's daily request quota has been reached. " +
            "Please try again after the quota resets."
        });
      }

      return res.status(500).json({
        success: false,
        error:
          error.message ||
          "Question analysis failed."
      });
    }
  }
);

// ============================================
// INDIVIDUAL PAPER ANALYSIS ENDPOINT
// ============================================

app.get(
  "/api/papers/:paperId/analyze",
  verifyFirebaseToken,
  async (req, res) => {
    try {
      const paper = await getOwnedPaper(
        req.params.paperId,
        req.user.uid
      );

      if (!paper) {
        return res.status(404).json({
          success: false,
          error: "Paper not found. Upload it again."
        });
      }

      // Individual analysis must not pull in other papers from the
      // same upload batch. Combined analysis uses the selected-paper
      // POST endpoint above.
      const result = await analyzeWithCache(
        [paper],
        req.user.uid,
        {
          batchId: paper.batchId || null,
          analysisSessionId: randomUUID()
        }
      );

      const status = analysisHttpStatus(result);

      return res.status(status).json({
        success: status === 200,
        ...result,
        ...(status === 429
          ? {
              error:
                result.quotaMessage ||
                "Gemini's daily request quota has been reached."
            }
          : {})
      });
    } catch (error) {
      console.error(
        "Paper analysis error:",
        error.message
      );

      if (isQuotaExceededError(error)) {
        return res.status(429).json({
          success: false,
          error:
            "Gemini's daily request quota has been reached. " +
            "Please try again after the quota resets."
        });
      }

      return res.status(500).json({
        success: false,
        error:
          error.message ||
          "Question analysis failed."
      });
    }
  }
);

// ============================================
// GENERATE AI ANSWER
// ============================================

app.post(
  "/api/answers",
  verifyFirebaseToken,
  async (req, res) => {
    try {
      if (!ai) {
        return res.status(503).json({
          success: false,
          error:
            "Gemini is not configured. Set GEMINI_API_KEY in the server environment."
        });
      }

      const question = String(
        req.body.question || ""
      ).trim();

      const topic = String(
        req.body.topic || ""
      );

      const marks = Number(req.body.marks);

      if (
        !question ||
        question.length > 3000
      ) {
        return res.status(400).json({
          success: false,
          error: "Enter a question of up to 3000 characters."
        });
      }

      if (
        ![2, 5, 7, 10, 15].includes(marks)
      ) {
        return res.status(400).json({
          success: false,
          error: "Choose 2, 5, 7, 10 or 15 marks."
        });
      }

      const ids = Array.isArray(req.body.paperIds)
        ? req.body.paperIds
        : req.body.paperId
          ? [req.body.paperId]
          : [];

      if (
        ids.some(
          id => !mongoose.isValidObjectId(id)
        )
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid paper ID."
        });
      }

      // Enforce ownership for every requested paper.

      const docs = [];

      for (const id of ids) {
        const paper = await getOwnedPaper(
          id,
          req.user.uid
        );

        if (!paper) {
          return res.status(404).json({
            success: false,
            error:
              "One or more selected papers were not found in your account."
          });
        }

        docs.push(paper);
      }

      const context = docs
        .map(
          paper =>
            `Source: ${paper.originalName}\n` +
            paper.extractedText.slice(
              0,
              Math.floor(
                15000 / Math.max(1, docs.length)
              )
            )
        )
        .join("\n\n");

      const generated = await generateContentWithRetry({
        model: MODEL,

        contents: `
Answer accurately in an exam-oriented format suitable for ${marks} marks.

Use supplied source material as primary evidence.
Do not invent citations.
If sources lack enough information, say so.

Subject: ${docs[0]?.subject || "General"}

Selected topic: ${topic}

Question:
${question}

Source material:
${context || "No uploaded source material."}
`
      });

      const answer = (
        generated.text || ""
      ).trim();

      if (!answer) {
        throw new Error(
          "Gemini returned an empty answer."
        );
      }

      let saved = null;

      if (
        docs[0] &&
        mongoose.connection.readyState === 1
      ) {
        saved = await Answer.create({
          userId: req.user.uid,

          paperId: docs[0]._id,

          question,

          marks,

          answer
        });
      }

      return res.json({
        success: true,

        answerId: saved?.id || null,

        answer,

        question,

        topic,

        marks,

        usedSourceMaterial: Boolean(context),

        sources: docs.map(
          paper => paper.originalName
        )
      });
    } catch (error) {
      const statusCode = getGeminiStatusCode(error);

      console.error(
        "Answer generation failed:",
        error.message
      );

      if (isRetryableGeminiError(error)) {
        return res.status(
          statusCode === 429 ? 429 : 503
        ).json({
          success: false,
          error:
            statusCode === 429
              ? "Gemini request limit reached. Please wait before trying again."
              : "Gemini is temporarily unavailable. Please try again shortly."
        });
      }

      return res.status(500).json({
        success: false,
        error:
          "Answer generation failed. Check the server logs for details."
      });
    }
  }
);

// ============================================
// RETRIEVE SAVED ANSWERS
// ============================================

app.get(
  "/api/answers",
  verifyFirebaseToken,
  async (req, res) => {
    try {
      const paperId = req.query.paperId;

      if (!mongoose.isValidObjectId(paperId)) {
        return res.status(400).json({
          success: false,
          error: "A valid paperId is required."
        });
      }

      const paper = await getOwnedPaper(
        paperId,
        req.user.uid
      );

      if (!paper) {
        return res.status(404).json({
          success: false,
          error: "Paper not found."
        });
      }

      const answers = await Answer.find({
        paperId: paper._id,
        userId: req.user.uid
      })
        .sort({ createdAt: -1 })
        .select("question marks answer createdAt")
        .lean();

      return res.json({
        success: true,

        count: answers.length,

        answers
      });
    } catch (error) {
      console.error(
        "Saved answer retrieval error:",
        error.message
      );

      return res.status(500).json({
        success: false,
        error: "Failed to retrieve saved answers."
      });
    }
  }
);

// ============================================
// ADMIN DASHBOARD API
// ============================================

app.get(
  "/api/admin/login-stats",
  verifyFirebaseToken,
  requireAdmin,
  async (req, res) => {
    try {
      const totalLogins =
        await LoginHistory.countDocuments();

      const recentLogins =
        await LoginHistory.find()
          .sort({ loggedInAt: -1 })
          .limit(20)
          .select(
            "firebaseUid name email loginMethod loggedInAt"
          )
          .lean();

      let totalUsers = 0;

      let pageToken;

      do {
        const result = await firebaseAuth.listUsers(
          1000,
          pageToken
        );

        totalUsers += result.users.length;

        pageToken = result.pageToken;
      } while (pageToken);

      return res.json({
        success: true,

        statistics: {
          totalUsers,

          totalLogins
        },

        recentLogins
      });
    } catch (error) {
      console.error(
        "Admin statistics error:",
        error.message
      );

      return res.status(500).json({
        success: false,
        error: "Unable to load admin statistics."
      });
    }
  }
);

// ============================================
// ERROR HANDLER
// ============================================

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,

      error:
        error.code === "LIMIT_FILE_SIZE"
          ? `Each PDF must be ${MAX_MB} MB or smaller.`
          : error.code === "LIMIT_FILE_COUNT"
            ? `Select no more than ${MAX_FILES} PDFs.`
            : error.message
    });
  }

  if (error) {
    console.error(
      "Request error:",
      error.message
    );

    return res.status(400).json({
      success: false,
      error: error.message || "Request failed."
    });
  }

  next();
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(
    `ExamPilot AI running on port ${PORT}`
  );
});
