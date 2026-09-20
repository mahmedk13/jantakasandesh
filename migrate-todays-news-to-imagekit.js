// One-time migration: move Cloudinary-hosted photos on articles CREATED on the
// IST calendar day 2026-09-20 over to ImageKit, before deploying the ImageKit
// switchover — so these very recent articles don't go dark if/when Cloudinary
// deactivates. Filters by `createdAt` (not `updatedAt`/`date`) per IST day
// boundaries. Only touches photos actually hosted on res.cloudinary.com —
// external hotlinked photos (RSS/API thumbnails never uploaded anywhere) are
// left untouched. Uses `{ timestamps: false }` on the update so `updatedAt`
// is not bumped by this housekeeping fix.
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const ImageKit = require('imagekit');
const { News } = require('./models/News');

const imagekit = new ImageKit({
    publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
    urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
});

// IST day 2026-09-20 00:00 -> 2026-09-21 00:00, expressed in UTC (IST = UTC+5:30)
const IST_DAY_START_UTC = new Date('2026-09-19T18:30:00.000Z');
const IST_DAY_END_UTC   = new Date('2026-09-20T18:30:00.000Z');

async function downloadImage(url) {
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

async function run() {
    if (!process.env.IMAGEKIT_PRIVATE_KEY) throw new Error('IMAGEKIT_* env vars not set');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✓ Connected to MongoDB');

    const candidates = await News.find(
        {
            createdAt: { $gte: IST_DAY_START_UTC, $lt: IST_DAY_END_UTC },
            photos: { $regex: 'res\\.cloudinary\\.com' }
        },
        { heading: 1, photos: 1, createdAt: 1 }
    ).lean();

    console.log(`Found ${candidates.length} articles (created IST 2026-09-20) with at least one Cloudinary photo`);

    const backup = candidates.map(a => ({ _id: a._id, photos: a.photos }));
    const backupFile = `news-photos-cloudinary-backup-${Date.now()}.json`;
    fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
    console.log(`✓ Backed up original photos arrays to ${backupFile}`);

    let ok = 0, failed = 0, skippedPhotos = 0;
    for (const article of candidates) {
        try {
            const nextPhotos = [];
            let changed = false;
            for (const photo of article.photos) {
                if (!photo || !photo.includes('res.cloudinary.com')) {
                    nextPhotos.push(photo);
                    continue;
                }
                try {
                    const buffer = await downloadImage(photo);
                    const fileName = photo.split('/').pop() || `news-${article._id}.jpg`;
                    const result = await imagekit.upload({ file: buffer, fileName, folder: 'news', useUniqueFileName: true });
                    nextPhotos.push(result.url);
                    changed = true;
                } catch (photoErr) {
                    console.warn(`  ⚠️ photo failed for "${article.heading.slice(0, 40)}" (${article._id}): ${photoErr.message} — keeping original URL`);
                    nextPhotos.push(photo);
                    skippedPhotos++;
                }
            }
            if (changed) {
                await News.updateOne({ _id: article._id }, { $set: { photos: nextPhotos } }, { timestamps: false });
                console.log(`✓ Migrated "${article.heading.slice(0, 50)}" (${article._id})`);
                ok++;
            }
        } catch (err) {
            console.error(`✗ Failed "${article.heading.slice(0, 50)}" (${article._id}):`, err.message);
            failed++;
        }
    }

    console.log(`\nDone. ${ok} articles migrated, ${failed} article failures, ${skippedPhotos} individual photos left on Cloudinary (download failed).`);
    await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
