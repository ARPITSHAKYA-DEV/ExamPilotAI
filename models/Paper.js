
const mongoose = require("mongoose");

const paperSchema = new mongoose.Schema(
  {
    subject: {
      type: String,
      default: "Not specified"
    },

    batchId: { type: String, index: true },

    originalName: {
      type: String,
      required: true
    },

    extractedText: {
      type: String,
      default: ""
    },

    status: {
      type: String,
      enum: ["uploaded", "analyzed", "partial", "error"],
      default: "uploaded"
    },

    extractionMethod: { type: String, default: "pdf-parse" },
    extractionWarning: { type: String, default: "" },
    questions: { type: [mongoose.Schema.Types.Mixed], default: [] },

    topics: [
      {
        topic: String,
        mentions: {
          type: Number,
          default: 1
        }
      }
    ]
  },
  { timestamps: true }
);

module.exports = mongoose.model("Paper", paperSchema);

