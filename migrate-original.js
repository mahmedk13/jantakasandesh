// One-time migration: tag manually-written articles as isOriginal: true
// Criteria: rssLink is null (not from a feed) AND no rssSource (not from any API import)
require('dotenv').config();
const mongoose = require('mongoose');
const { News } = require('./models/News');

async function run() {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const result = await News.updateMany(
        { rssLink: null, rssSource: null, isOriginal: { $ne: true } },
        { $set: { isOriginal: true } }
    );

    console.log(`Tagged ${result.modifiedCount} existing articles as isOriginal: true`);
    await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
