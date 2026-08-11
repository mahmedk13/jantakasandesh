const mongoose = require('mongoose');

const ePaperSchema = new mongoose.Schema({
    title:       { type: String, required: true, trim: true, maxlength: 200 },
    edition:     { type: String, trim: true, maxlength: 100 }, // e.g. "भोपाल संस्करण"
    pdfUrl:      { type: String, required: true },             // Cloudinary raw URL
    cloudinaryId:{ type: String },                             // public_id for deletion
    publishDate: { type: Date, default: Date.now },
    pageCount:   { type: Number, default: 0 },
    isActive:    { type: Boolean, default: true }
}, { timestamps: true });

// Index for listing latest ePapers
ePaperSchema.index({ publishDate: -1 });
ePaperSchema.index({ isActive: 1, publishDate: -1 });

module.exports = mongoose.model('EPaper', ePaperSchema);
