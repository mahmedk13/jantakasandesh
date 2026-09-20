// One-time migration: move existing ePaper PDFs from Cloudinary to ImageKit
// (Cloudinary account is over free-tier usage and scheduled for deactivation).
// Downloads each PDF via a signed Cloudinary URL, re-uploads to ImageKit, then
// updates the EPaper doc's pdfUrl/imagekitFileId and clears cloudinaryId (so
// signedPdfUrl() in server.js stops trying to re-sign a soon-to-be-dead account).
// Writes a JSON backup of the original doc values before mutating anything.
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const ImageKit = require('imagekit');
const EPaper = require('./models/EPaper');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const imagekit = new ImageKit({
    publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
    urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
});

function signedCloudinaryPdfUrl(cloudinaryId) {
    return cloudinary.url(cloudinaryId, {
        resource_type: 'raw',
        type: 'upload',
        sign_url: true,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        secure: true,
    });
}

async function run() {
    if (!process.env.IMAGEKIT_PRIVATE_KEY) throw new Error('IMAGEKIT_* env vars not set');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✓ Connected to MongoDB');

    const papers = await EPaper.find({ cloudinaryId: { $exists: true, $ne: '' } });
    console.log(`Found ${papers.length} ePaper(s) still on Cloudinary`);

    const backup = papers.map(p => p.toObject());
    const backupFile = `epaper-cloudinary-backup-${Date.now()}.json`;
    fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
    console.log(`✓ Backed up original records to ${backupFile}`);

    let ok = 0, failed = 0;
    for (const paper of papers) {
        try {
            const downloadUrl = signedCloudinaryPdfUrl(paper.cloudinaryId);
            const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(30000) });
            if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
            const buffer = Buffer.from(await res.arrayBuffer());

            const fileName = paper.cloudinaryId.split('/').pop() || `epaper-${paper._id}`;
            const result = await imagekit.upload({
                file: buffer,
                fileName,
                folder: 'epaper',
                useUniqueFileName: true,
            });

            paper.pdfUrl = result.url;
            paper.imagekitFileId = result.fileId;
            paper.cloudinaryId = '';
            await paper.save();

            console.log(`✓ Migrated "${paper.title}" (${paper._id}) → ${result.url}`);
            ok++;
        } catch (err) {
            console.error(`✗ Failed "${paper.title}" (${paper._id}):`, err.message);
            failed++;
        }
    }

    console.log(`\nDone. ${ok} migrated, ${failed} failed.`);
    if (failed > 0) console.log('Failed docs were left untouched (still pointing at Cloudinary) — re-run this script to retry them.');
    await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
