#!/usr/bin/env node
// One-off cleanup: PB SHABD articles imported while the sync workflow was missing the
// IMAGEKIT_* secrets got their `photos` set to PB SHABD's own AWS-signed S3 URL
// (X-Amz-Expires=3600 → dead ~1h after import). Those links are already expired and
// unrecoverable (we never stored the media_id needed to re-fetch them) — this clears
// `photos` back to [] so the front-end renders its existing "NEWS" placeholder card
// instead of a broken-image icon. Does NOT touch the article/slug/content — never deletes news.
require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const fs = require('fs');
const mongoose = require('mongoose');
const { News } = require('./models/News');

const DEAD_PHOTO_RE = /shabd-pb-bucket\.s3[^"']*amazonaws\.com/i;

(async () => {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    console.log('✅ MongoDB connected');

    const affected = await News.find({
        rssSource: 'PB SHABD',
        photos: { $elemMatch: { $regex: DEAD_PHOTO_RE } },
    }).select('_id heading slug photos date').lean();

    console.log(`Found ${affected.length} PB SHABD articles with expired S3 photo links.`);
    if (!affected.length) { await mongoose.disconnect(); return; }

    fs.writeFileSync(
        `pbshabd-expired-photos-backup-${Date.now()}.json`,
        JSON.stringify(affected, null, 2)
    );
    console.log('📦 Backup written before mutating.');

    let updated = 0;
    for (const doc of affected) {
        await News.updateOne({ _id: doc._id }, { $set: { photos: [] } }, { timestamps: false });
        updated++;
    }
    console.log(`✅ Cleared photos on ${updated} articles (now render default NEWS placeholder).`);

    await mongoose.disconnect();
})().catch(async e => { console.error('ERROR:', e.message); process.exit(1); });
