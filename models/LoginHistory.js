const mongoose = require("mongoose");

const loginHistorySchema = new mongoose.Schema(
  {
    firebaseUid: {
      type: String,
      required: true,
      index: true
    },

    name: {
      type: String,
      default: "Student",
      trim: true
    },

    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true
    },

    loginMethod: {
      type: String,
      enum: ["google.com", "password", "unknown"],
      default: "unknown"
    },

    loggedInAt: {
      type: Date,
      default: Date.now,
      index: true
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model("LoginHistory", loginHistorySchema);