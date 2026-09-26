#!/usr/bin/env node
// One-off cleanup: the video re-hosting feature (added 2026-09-25) uploaded EVERY
// "VIDEO" media entry per PB SHABD story instead of just one — some stories had 20+
// duplicate renditions, which blew through ImageKit's video processing quota within a
// day (confirmed via direct fetch: "403 Video transformations limit exceeded").
// sync-pbshabd.js is already fixed to cap at 1 video/story going forward; this script
// trims the already-uploaded excess back down to 1 per article: deletes the extra
// files from ImageKit, trims `videos` to length 1, and strips the extra VIDEO: marker
// lines from `content`. Never touches the article itself — only the video attachments.
require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const fs = require('fs');
const mongoose = require('mongoose');
const ImageKit = require('imagekit');
const { News } = require('./models/News');

const imagekit = new ImageKit({
    publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
    urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
});

async function deleteImageKitFile(url) {
    try {
        const urlPath = new URL(url).pathname.split('/').filter(Boolean).slice(1).join('/');
        const fileName = urlPath.split('/').pop();
        const folderPath = '/' + urlPath.split('/').slice(0, -1).join('/');
        const matches = await imagekit.listFiles({ path: folderPath, searchQuery: `name = "${fileName}"` });
        if (matches?.[0]?.fileId) await imagekit.deleteFile(matches[0].fileId);
    } catch (err) {
        console.log('  ImageKit delete failed for', url, err.message);
    }
}

(async () => {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    console.log('✅ MongoDB connected');

    const affected = await News.find({ 'videos.1': { $exists: true } })
        .select('_id heading videos content').lean();
    console.log(`Found ${affected.length} articles with more than 1 video.`);
    if (!affected.length) { await mongoose.disconnect(); return; }

    fs.writeFileSync(`pbshabd-excess-videos-backup-${Date.now()}.json`, JSON.stringify(affected, null, 2));
    console.log('📦 Backup written before mutating.');

    let deletedFiles = 0;
    for (const doc of affected) {
        const [keep, ...extra] = doc.videos;
        for (const url of extra) {
            await deleteImageKitFile(url);
            deletedFiles++;
        }
        // Keep only the first VIDEO: marker line, drop the rest
        let seen = false;
        const strippedContent = (doc.content || '').split('\n').filter(line => {
            if (/^VIDEO\s*:/i.test(line.trim())) {
                if (seen) return false;
                seen = true;
            }
            return true;
        }).join('\n').replace(/\n{3,}/g, '\n\n').trim();

        await News.updateOne({ _id: doc._id }, { $set: { videos: [keep], content: strippedContent } });
        console.log(`  ✔ ${doc.heading.slice(0, 50)} — kept 1, removed ${extra.length}`);
    }

    console.log(`\n✅ Done. Deleted ${deletedFiles} excess video files from ImageKit across ${affected.length} articles.`);
    await mongoose.disconnect();
})().catch(async e => { console.error('ERROR:', e.message); process.exit(1); });
