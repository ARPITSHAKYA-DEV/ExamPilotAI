const mongoose = require("mongoose");

const answerSchema = new mongoose.Schema(
  {
    // Firebase UID of the user who generated the answer.
    userId: {
      type: String,
      required: true,
      index: true
    },

    paperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Paper",
      required: true,
      index: true
    },

    question: {
      type: String,
      required: true
    },

    marks: {
      type: Number,
      default: 5
    },

    answer: {
      type: String,
      required: true
    },

    reviewed: {
      type: Boolean,
      default: false
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model("Answer", answerSchema);
