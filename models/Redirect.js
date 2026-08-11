const mongoose = require('mongoose');

// Stores slugs of deleted articles so /news/:slug can 301-redirect them
// instead of serving a 404. This prevents AdSense "Low Value Content" issues
// caused by broken links appearing in crawl reports.
const redirectSchema = new mongoose.Schema({
    from:      { type: String, required: true, unique: true, index: true }, // old article slug
    to:        { type: String, default: '/' },                               // redirect target
    createdAt: { type: Date,   default: Date.now, expires: 60 * 60 * 24 * 365 } // TTL: 1 year
});

module.exports = mongoose.models.Redirect || mongoose.model('Redirect', redirectSchema);
