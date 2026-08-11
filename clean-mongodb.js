/**
 * clean-mongodb.js
 * Deletes all news articles from MongoDB EXCEPT:
 *   1. isPermanent === true
 *   2. isOriginal === true  (Editor's Desk articles)
 *   3. author matches "maroof ahmed khan" (case-insensitive)
 *
 * Run: node clean-mongodb.js
 */

require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const mongoose = require('mongoose');
const { News } = require('./models/News');

async function cleanMongoDB() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        console.error('❌  MONGODB_URI not found in .env');
        process.exit(1);
    }

    console.log('🔌  Connecting to MongoDB...');
    await mongoose.connect(uri);
    console.log('✅  Connected.\n');

    const total = await News.countDocuments();
    console.log(`📊  Total articles in DB: ${total}`);

    // Count what WILL be kept
    const keepCount = await News.countDocuments({
        $or: [
            { isPermanent: true },
            { isOriginal: true },
            { author: { $regex: /maroof ahmed khan/i } }
        ]
    });

    // Count what WILL be deleted
    const deleteCount = await News.countDocuments({
        isPermanent: { $ne: true },
        isOriginal:  { $ne: true },
        author:      { $not: /maroof ahmed khan/i }
    });

    console.log(`📌  Articles to KEEP : ${keepCount}`);
    console.log(`🗑️   Articles to DELETE: ${deleteCount}\n`);

    if (deleteCount === 0) {
        console.log('✅  Nothing to delete. Exiting.');
        await mongoose.disconnect();
        return;
    }

    // Safety prompt — confirm before deleting
    const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
    });

    readline.question(
        `⚠️  Are you sure you want to permanently delete ${deleteCount} articles? (yes/no): `,
        async (answer) => {
            readline.close();

            if (answer.trim().toLowerCase() !== 'yes') {
                console.log('❌  Aborted. No changes made.');
                await mongoose.disconnect();
                return;
            }

            console.log('\n🗑️  Deleting...');
            const result = await News.deleteMany({
                isPermanent: { $ne: true },
                isOriginal:  { $ne: true },
                author:      { $not: /maroof ahmed khan/i }
            });

            console.log(`✅  Deleted ${result.deletedCount} articles.`);

            const remaining = await News.countDocuments();
            console.log(`📊  Articles remaining in DB: ${remaining}`);

            await mongoose.disconnect();
            console.log('🔌  Disconnected. Done.');
        }
    );
}

cleanMongoDB().catch(err => {
    console.error('❌  Error:', err.message);
    process.exit(1);
});
