// One-time backfill: tag existing rajya-category articles (created before the
// state auto-tagging feature existed) with a `state` value, using the same
// keyword-matching logic as detectState() in sync-pbshabd.js.
// Only fills in articles where state is currently null/missing — never overwrites
// an existing value, never deletes/modifies any other field. Run: node backfill-state.js
require('dotenv').config();
const mongoose = require('mongoose');
const { News } = require('./models/News');

// Keep in sync with STATE_MAP in sync-pbshabd.js / STATE_LIST in public/admin.html
// and public/category.html if states are ever added/removed.
const STATE_MAP = {
    'madhya pradesh': 'mp', 'मध्य प्रदेश': 'mp', 'मध्यप्रदेश': 'mp',
    'indore': 'mp', 'इंदौर': 'mp', 'gwalior': 'mp', 'ग्वालियर': 'mp',
    'jabalpur': 'mp', 'जबलपुर': 'mp', 'ujjain': 'mp', 'उज्जैन': 'mp',
    'uttar pradesh': 'up', 'उत्तर प्रदेश': 'up',
    'bihar': 'bihar', 'बिहार': 'bihar',
    'rajasthan': 'rajasthan', 'राजस्थान': 'rajasthan',
    'maharashtra': 'maharashtra', 'महाराष्ट्र': 'maharashtra',
    'punjab': 'punjab', 'पंजाब': 'punjab',
    'haryana': 'haryana', 'हरियाणा': 'haryana',
    'gujarat': 'gujarat', 'गुजरात': 'gujarat',
    'chhattisgarh': 'chhattisgarh', 'छत्तीसगढ़': 'chhattisgarh',
    'jharkhand': 'jharkhand', 'झारखंड': 'jharkhand',
    'uttarakhand': 'uttarakhand', 'उत्तराखंड': 'uttarakhand',
    'himachal': 'himachal', 'हिमाचल': 'himachal',
    'kerala': 'kerala', 'केरल': 'kerala',
    'telangana': 'telangana',
    'andhra pradesh': 'andhra_pradesh',
    'karnataka': 'karnataka',
    'west bengal': 'west_bengal',
};

function detectState(title, content) {
    const checks = [(title || '').toLowerCase(), (content || '').toLowerCase()];
    for (const text of checks) {
        for (const [key, val] of Object.entries(STATE_MAP)) {
            if (text.includes(key)) return val;
        }
    }
    return 'other';
}

async function run() {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    const cursor = News.find({
        category: 'rajya',
        $or: [{ state: null }, { state: { $exists: false } }],
    }).select('heading content').cursor();

    let updated = 0, checked = 0;
    const perState = {};
    for await (const doc of cursor) {
        checked++;
        const state = detectState(doc.heading, doc.content);
        await News.updateOne({ _id: doc._id }, { $set: { state } });
        perState[state] = (perState[state] || 0) + 1;
        updated++;
    }

    console.log(`\n✅ Done: checked ${checked} untagged rajya articles, updated ${updated}.`);
    console.log('Breakdown:', perState);
    await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
