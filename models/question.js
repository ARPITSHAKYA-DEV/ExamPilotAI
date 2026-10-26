
const mongoose = require("mongoose");

const questionSchema = new mongoose.Schema(
    {
        paperId: {
            type: mongoose.Schema.Types.ObjectId,
            required: true,
            index: true,
        },
        subject: {
            type: String,
            default: "General",
            index: true,
        },
        text: {
            type: String,
            required: true,
            trim: true,
        },
        normalizedText: {
            type: String,
            required: true,
            index: true,
        },
        questionNumber: {
            type: Number,
            default: null,
        },
        marks: {
            type: Number,
            default: null,
        },
    },
    { timestamps: true }
);

questionSchema.index({ paperId: 1, normalizedText: 1 }, { unique: true });

module.exports =
    mongoose.models.Question ||
    mongoose.model("Question", questionSchema);
