require("dotenv").config();
const mongoose = require("mongoose");

const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

// Use Render environment variables in production and the JSON file locally.
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  : require("./serviceAccountKey.json");

// Initialize Firebase Admin SDK.
initializeApp({
  credential: cert(serviceAccount)
});

const firebaseAuth = getAuth();
// Verify Firebase ID tokens sent by the frontend.
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

// Allow only your designated administrator.
function requireAdmin(req, res, next) {
  const adminEmail = (process.env.ADMIN_EMAIL || "")
    .trim()
    .toLowerCase();

  const userEmail = (req.user?.email || "").toLowerCase();

  if (!adminEmail || !req.user?.email_verified ||
      userEmail !== adminEmail) {
    return res.status(403).json({
      success: false,
      error: "Administrator access required."
    });
  }

  next();
}

console.log("Firebase Admin initialized successfully.");
const Paper = require("./models/Paper");
const Answer = require("./models/Answer");
const LoginHistory = require("./models/LoginHistory");
const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const path = require("path");
const { randomUUID } = require("crypto");
const { GoogleGenAI } = require("@google/genai");
const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const MAX_FILES = Number(process.env.MAX_UPLOAD_FILES || 10);
const MAX_MB = Number(process.env.MAX_UPLOAD_FILE_MB || 50);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Record a successful login in MongoDB.
app.post("/api/auth/login", verifyFirebaseToken, async (req, res) => {
  try {
    const { name, email, loginMethod } = req.body;

    // Use the verified Firebase token as the source of identity.
    const verifiedEmail = (req.user.email || "").trim().toLowerCase();

    if (!verifiedEmail) {
      return res.status(400).json({
        success: false,
        error: "The authenticated account has no email address."
      });
    }

    const allowedMethods = ["google.com", "password"];
    const safeLoginMethod = allowedMethods.includes(loginMethod)
      ? loginMethod
      : "unknown";

    const loginRecord = await LoginHistory.create({
      firebaseUid: req.user.uid,
      name: (name || req.user.name || "Student").toString().trim(),
      email: verifiedEmail,
      loginMethod: safeLoginMethod,
      loggedInAt: new Date()
    });

    res.status(201).json({
      success: true,
      message: "Login recorded successfully.",
      loginId: loginRecord._id
    });
  } catch (error) {
    console.error("Login tracking error:", error.message);

    res.status(500).json({
      success: false,
      error: "Unable to record login."
    });
  }
});

if (process.env.MONGODB_URI) mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 }).then(() => console.log("MongoDB connected")).catch(e => console.error("MongoDB connection failed:", e.message));
else console.warn("MONGODB_URI is not configured; uploads will only persist until the server restarts.");
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const cache = new Map();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024, files: MAX_FILES } });
const getPaper = async id => (mongoose.connection.readyState === 1 ? await Paper.findById(id) : null) || cache.get(id);
const parseJSON = result => JSON.parse((result.text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
app.get("/api/health", (req,res) => res.json({ success:true, database:mongoose.connection.readyState === 1 ? "connected" : "unavailable", gemini:!!ai, model:MODEL }));
// Dashboard: return statistics and recent uploads
app.get("/api/dashboard", async (req, res) => {
  try {
    let papers = [];

    if (mongoose.connection.readyState === 1) {
      papers = await Paper.find()
        .sort({ createdAt: -1 })
        .lean();
    } else {
      papers = [...cache.values()]
        .sort((a, b) =>
          new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
        );
    }

    const totalPapers = papers.length;

    const questionsExtracted = papers.reduce(
      (total, paper) => total + (paper.questions?.length || 0),
      0
    );

    // Count exact repeated questions across distinct uploaded papers.
    const questionGroups = new Map();

    for (const paper of papers) {
      const seenInPaper = new Set();

      for (const question of paper.questions || []) {
        if (!question.text) continue;

        const key = question.text
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim();

        if (!key || seenInPaper.has(key)) continue;
        seenInPaper.add(key);

        if (!questionGroups.has(key)) {
          questionGroups.set(key, new Set());
        }

        questionGroups.get(key).add(String(paper._id));
      }
    }

    const repeatedQuestions = [...questionGroups.values()]
      .filter(paperIds => paperIds.size > 1).length;

    // Group extracted questions by topic.
    const topicGroups = new Map();

    for (const paper of papers) {
      for (const question of paper.questions || []) {
        const topic = String(question.topic || "").trim();

        if (!topic) continue;

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

    const importantTopics = [...topicGroups.values()]
      .map(item => ({
        topic: item.topic,
        questionCount: item.questionCount,
        paperCount: item.papers.size,
        priority:
          item.papers.size >= 3 || item.questionCount >= 4
            ? "High"
            : item.papers.size >= 2 || item.questionCount >= 2
              ? "Medium"
              : "Low"
      }))
      .sort((a, b) =>
        b.paperCount - a.paperCount ||
        b.questionCount - a.questionCount
      )
      .slice(0, 5);

    const recentUploads = papers.slice(0, 5).map(paper => ({
      paperId: String(paper._id),
      fileName: paper.originalName,
      subject: paper.subject,
      status: paper.status,
      extractionMethod: paper.extractionMethod,
      uploadedAt: paper.createdAt || null,
      questionCount: paper.questions?.length || 0,
      batchId: paper.batchId || null
    }));

    res.json({
      success: true,
      stats: {
        totalPapers,
        questionsExtracted,
        repeatedQuestions,
        importantTopics: topicGroups.size
      },
      recentUploads,
      topics: importantTopics
    });
  } catch (error) {
    console.error("Dashboard error:", error.message);

    res.status(500).json({
      success: false,
      error: "Unable to load dashboard statistics."
    });
  }
});

// Accept the legacy singular `paper` field and the current multi-file `papers` field.
app.post("/api/papers/upload", upload.fields([{ name:"papers", maxCount:MAX_FILES }, { name:"paper", maxCount:1 }]), async (req,res) => {
  try {
    const files = [...(req.files?.papers || []), ...(req.files?.paper || [])];
    if (!files.length) return res.status(400).json({ error:"Select at least one PDF." });
    const subject = String(req.body.subject || "").trim();
    if (!subject || subject.length > 100) return res.status(400).json({ error:"Enter a valid subject." });
    const requestedBatchId = String(req.body.batchId || "");
    if (requestedBatchId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedBatchId)) return res.status(400).json({ error:"Invalid upload batch ID." });
    const batchId = requestedBatchId || randomUUID();
    const documents = await Promise.all(files.map(async file => {
      const originalName = path.basename(file.originalname);
      try {
        if ((!/\.pdf$/i.test(originalName) && file.mimetype !== "application/pdf") || file.buffer.subarray(0,5).toString() !== "%PDF-") throw new Error("This file is not a valid PDF.");
        const parsed = await pdfParse(file.buffer);
        let text = (parsed.text || "").trim(), extractionMethod = "pdf-parse", warning = "";
        if (!text && ai) {
          try {
            const ocr = await ai.models.generateContent({ model:MODEL, contents:[{ inlineData:{ mimeType:"application/pdf", data:file.buffer.toString("base64") } },{ text:"Transcribe this exam paper. Preserve question numbers, subquestions, marks and headings. Use [unclear] for unreadable content. Do not guess. Return transcription only." }] });
            text = (ocr.text || "").trim(); if (text) extractionMethod = "gemini-pdf-vision";
          } catch(e) { warning = `Gemini PDF transcription failed: ${e.message}`; }
        }
        if (!text) throw new Error(warning || "No selectable text was found. This may be a scanned PDF; configure Gemini vision/OCR fallback.");
        if (text.length > 200000) warning = "Extracted text truncated at the 200,000-character limit.";
        const record = { batchId, subject, originalName, extractedText:text.slice(0,200000), extractionMethod, extractionWarning:warning, status:"uploaded" };
        let saved;
        if (mongoose.connection.readyState === 1) saved = await Paper.create(record);
        else { saved = { ...record, _id:new mongoose.Types.ObjectId() }; cache.set(String(saved._id), saved); }
        return { paperId:String(saved._id), fileName:originalName, status:"ready", extractedCharacters:text.length, extractionMethod, warning };
      } catch(e) { return { fileName:originalName, status:"error", error:e.message }; }
    }));
    if (!documents.some(d => d.status === "ready")) return res.status(422).json({ success:false,batchId,documents,error:"No selected PDF could be extracted." });
    res.status(201).json({ success:true,batchId,subject,documents });
  } catch(e) { console.error("Upload failed:",e.message); res.status(500).json({ error:"Upload processing failed. Check server configuration." }); }
});

async function analyzePapers(docs,batchId) {
  if (!ai) throw new Error("Gemini is not configured. Set GEMINI_API_KEY in the server environment or local .env file.");
  const outcomes = await Promise.all(docs.map(async paper => {
    try {
      if (paper.status === "analyzed" && Array.isArray(paper.questions) && paper.questions.length) return { paper, questions:paper.questions, error:null };



      const result = await ai.models.generateContent({ model:MODEL, config:{ responseMimeType:"application/json" }, contents: `
You are an exam-question extraction engine for ExamPilot AI.

TASK:
Extract every actual exam question from the supplied question paper.

SUBJECT: ${paper.subject}
SOURCE FILE: ${paper.originalName}

DOCUMENT TEXT:
${paper.extractedText.slice(0, 24000)}

RULES:
1. Extract every identifiable question, including questions in sections,
   internal choices, subquestions, and numerical problems.
2. Preserve the original question wording as closely as possible.
3. Preserve question numbers such as Q1(a), Q2(b), Section B, etc.
4. Extract marks only when explicitly supported by the document.
5. Never invent questions, question numbers, marks, units, or page numbers.
6. Ignore page headers, footers, instructions, and unrelated text unless
   they are part of an actual question.
7. Assign a concise topic based on the question's content.
8. Use null when a value cannot be determined reliably.
9. Do not combine separate questions into one question.
10. Return as many valid questions as the document contains, up to 150.
11. If the supplied text is incomplete or unreadable, extract only the
    questions that can actually be identified.

Return valid JSON in exactly this structure:
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
      ]
}
` });



      const parsed = parseJSON(result);
      if (!Array.isArray(parsed.questions)) throw new Error("Gemini response did not contain a valid questions array.");
      const questions = parsed.questions.filter(q => q && typeof q.text === "string" && q.text.trim()).slice(0,150).map((q,i) => ({ id:String(i+1), text:q.text.trim().slice(0,2000), questionNumber:q.questionNumber || null, marks:q.marks == null || !Number.isFinite(Number(q.marks)) ? null : Number(q.marks), page:q.page == null || !Number.isFinite(Number(q.page)) ? null : Number(q.page), unit:q.unit || null, topic:q.topic || null, paperId:String(paper._id), sourceDocument:paper.originalName }));
      if (!questions.length) throw new Error("No questions were identified in the extracted text.");
      paper.questions = questions; paper.topics = (Array.isArray(parsed.topics)?parsed.topics:[]).filter(t=>t?.topic).map(t=>({topic:String(t.topic),mentions:1})); paper.status = "analyzed";
      if (paper.save && mongoose.connection.readyState === 1) await paper.save(); else cache.set(String(paper._id),paper);
      return { paper,questions,error:null };
    } catch(e) { console.error(`Analysis failed for ${paper.originalName}:`,e.message); return {paper,questions:[],error:e.message}; }
  }));
  const good=outcomes.filter(o=>!o.error), questions=good.flatMap(o=>o.questions), grouped=new Map();
  for(const q of questions){const name=String(q.topic||"Uncategorized").trim(),key=name.toLowerCase(),row=grouped.get(key)||{topic:name,papers:new Set(),questions:[],years:new Set(),sources:new Set(),marks:[]};row.papers.add(q.paperId);row.questions.push(q);row.sources.add(q.sourceDocument);if(q.marks)row.marks.push(q.marks);const year=q.sourceDocument.match(/(?:19|20)\d{2}/)?.[0];if(year)row.years.add(year);grouped.set(key,row);}
  const topics=[...grouped.values()].map(t=>({topic:t.topic,paperCount:t.papers.size,questionCount:t.questions.length,years:[...t.years],sources:[...t.sources],marks:t.marks,representativeQuestions:t.questions.slice(0,3),priority:t.papers.size>=3||t.questions.length>=4?"High":t.papers.size>=2||t.questions.length>=2?"Medium":"Low"}));
  const exact=new Map();for(const q of questions){const key=q.text.toLowerCase().replace(/[^a-z0-9]+/g," ").trim(),arr=exact.get(key)||[];if(!arr.some(x=>x.paperId===q.paperId))arr.push(q);exact.set(key,arr);}
  const repeatedQuestions=[...exact.values()].filter(arr=>arr.length>1).map(arr=>({text:arr[0].text,paperCount:arr.length,occurrences:arr.map(q=>({sourceDocument:q.sourceDocument,questionNumber:q.questionNumber,page:q.page}))}));
  return {batchId,subject:docs[0]?.subject,documents:outcomes.map(o=>({paperId:String(o.paper._id),fileName:o.paper.originalName,status:o.error?"error":"analyzed",error:o.error,extractionMethod:o.paper.extractionMethod,warning:o.paper.extractionWarning})),documentCount:docs.length,completedCount:good.length,questionCount:questions.length,questions,topics,repeatedQuestions,partial:good.length<docs.length,priorityMethod:"High: at least 3 distinct papers or 4 questions; Medium: at least 2 papers or 2 questions; Low: otherwise. Historical evidence only, not a prediction."};
}
async function loadBatch(batchId){const stored=mongoose.connection.readyState===1?await Paper.find({batchId}):[];const known=new Set(stored.map(p=>String(p._id)));return [...stored,...[...cache.values()].filter(p=>p.batchId===batchId&&!known.has(String(p._id)))];}
app.get("/api/batches/:batchId/analyze",async(req,res)=>{try{const docs=await loadBatch(req.params.batchId);if(!docs.length)return res.status(404).json({success:false,error:"No documents found for this upload batch."});res.json({success:true,...await analyzePapers(docs,req.params.batchId)});}catch(e){res.status(500).json({success:false,error:e.message||"Question analysis failed."});}});
app.get("/api/papers/:paperId/analyze",async(req,res)=>{try{const p=await getPaper(req.params.paperId);if(!p)return res.status(404).json({success:false,error:"Paper not found. Upload it again."});const docs=p.batchId?await loadBatch(p.batchId):[p];res.json({success:true,...await analyzePapers(docs,p.batchId||null)});}catch(e){res.status(500).json({success:false,error:e.message||"Question analysis failed."});}});

app.post("/api/answers",async(req,res)=>{try{if(!ai)return res.status(503).json({error:"Gemini is not configured. Set GEMINI_API_KEY in the server environment."});const question=String(req.body.question||"").trim(),topic=String(req.body.topic||""),marks=Number(req.body.marks);if(!question||question.length>3000)return res.status(400).json({error:"Enter a question of up to 3000 characters."});if(![2,5,7,10,15].includes(marks))return res.status(400).json({error:"Choose 2, 5, 7, 10 or 15 marks."});const ids=Array.isArray(req.body.paperIds)?req.body.paperIds:(req.body.paperId?[req.body.paperId]:[]);if(ids.some(id=>!mongoose.isValidObjectId(id)))return res.status(400).json({error:"Invalid paper ID."});const docs=(await Promise.all(ids.map(getPaper))).filter(Boolean),context=docs.map(d=>`Source: ${d.originalName}\n${d.extractedText.slice(0,Math.floor(15000/Math.max(1,docs.length)))}`).join("\n\n");const generated=await ai.models.generateContent({model:MODEL,contents:`Answer accurately in an exam-oriented format suitable for ${marks} marks. Use supplied source material as primary evidence. Do not invent citations; say if sources lack enough information.\nSubject: ${docs[0]?.subject||"General"}\nSelected topic: ${topic}\nQuestion: ${question}\nSource material:\n${context||"No uploaded source material."}`});const answer=(generated.text||"").trim();if(!answer)throw new Error("Gemini returned an empty answer.");let saved=null;if(docs[0]&&mongoose.connection.readyState===1)saved=await Answer.create({paperId:docs[0]._id,question,marks,answer});res.json({success:true,answerId:saved?.id||null,answer,question,topic,marks,usedSourceMaterial:!!context,sources:docs.map(d=>d.originalName)});}catch(e){console.error("Answer generation failed:",e.message);res.status(500).json({error:"Answer generation failed. Check Gemini configuration and try again."});}});
app.get("/api/answers",async(req,res)=>{try{if(!mongoose.isValidObjectId(req.query.paperId))return res.status(400).json({success:false,error:"A valid paperId is required."});const answers=await Answer.find({paperId:req.query.paperId}).sort({createdAt:-1}).select("question marks answer createdAt");res.json({success:true,count:answers.length,answers});}catch(e){res.status(500).json({success:false,error:"Failed to retrieve saved answers."});}});
app.use((e,req,res,next)=>{if(e instanceof multer.MulterError)return res.status(400).json({error:e.code==="LIMIT_FILE_SIZE"?`Each PDF must be ${MAX_MB} MB or smaller.`:e.code==="LIMIT_FILE_COUNT"?`Select no more than ${MAX_FILES} PDFs.`:e.message});if(e)return res.status(400).json({error:e.message||"Request failed."});next();});

// ============================================
// ADMIN DASHBOARD API
// ============================================

app.get(
  "/api/admin/login-stats",
  verifyFirebaseToken,
  requireAdmin,
  async (req, res) => {
    try {
      // Count all login events stored in MongoDB.
      const totalLogins = await LoginHistory.countDocuments();

      // Retrieve the 20 most recent login events.
      const recentLogins = await LoginHistory.find()
        .sort({ loggedInAt: -1 })
        .limit(20)
        .select(
          "firebaseUid name email loginMethod loggedInAt"
        )
        .lean();

      // Count registered Firebase users, including users
      // beyond the first page of 1,000 accounts.
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
      console.error("Admin statistics error:", error);

      return res.status(500).json({
        success: false,
        error: "Unable to load admin statistics."
      });
    }
  }
);
app.listen(PORT,()=>console.log(`ExamPilot AI running at http://localhost:${PORT}`));
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

