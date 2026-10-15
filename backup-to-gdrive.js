// Runs a MongoDB dump and uploads it to Google Drive via a service account, then
// prunes backups older than BACKUP_RETENTION_DAYS from that same folder.
//
// Strategy: full dump once a week (keeps a complete, correct baseline — this is
// the only backup type that can capture article DELETIONS, since a query-filtered
// incremental dump has no way to represent "this document no longer exists").
// Every other day: an incremental dump of ONLY the `news` collection, filtered to
// documents published or genuinely edited in the last INCREMENTAL_LOOKBACK_DAYS —
// cuts dump time/size dramatically on a ~20k-article collection that only gets a
// few hundred new/edited articles per day. The small collections (authors,
// cityviews, epapers — together under 1MB) are skipped on incremental days and
// only covered by the weekly full, since filtering them saves negligible time.
// Relies on `updatedAt` only reflecting REAL edits, not pageviews — the view-count
// route explicitly passes `timestamps:false` so a pageview never counts as an edit.
// LIMITATION: if an article is deleted between full backups, a restore built from
// full+incrementals alone would not reflect that deletion until the next full
// backup overwrites the baseline (at most ~6 days of staleness) — acceptable given
// restores are a rare/manual operation, but worth knowing before relying on this.
//
// One-time setup required (cannot be done from code — needs your Google Cloud/Drive access):
//   1. Google Cloud Console → create/select a project → enable the "Google Drive API".
//   2. IAM & Admin → Service Accounts → create one → "Keys" tab → "Add key" → JSON. Download it.
//   3. In Google Drive, create (or pick) a backups folder → "Share" it with the service
//      account's email (the "client_email" field in the downloaded JSON) → give it "Editor" access.
//   4. Copy the folder's ID from its URL: drive.google.com/drive/folders/<THIS_PART>.
//   5. Add two GitHub repo secrets:
//        GDRIVE_SERVICE_ACCOUNT_KEY = the entire contents of the downloaded JSON key file
//        GDRIVE_BACKUP_FOLDER_ID    = the folder ID from step 4
//      (MONGODB_URI secret already exists and is reused for the mongodump step.)
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { google } = require('googleapis');

const BACKUP_RETENTION_DAYS = 30;
const INCREMENTAL_LOOKBACK_DAYS = 3; // overlap margin in case a run is ever missed
const FULL_BACKUP_DAY = 0; // Sunday — getDay() === 0

function runMongodump(uri, extraArgs, archivePath) {
    execFileSync('mongodump', [`--uri=${uri}`, '--gzip', `--archive=${archivePath}`, ...extraArgs], { stdio: 'inherit' });
}

function buildDump(uri, tmpDir) {
    const isFullDay = new Date().getDay() === FULL_BACKUP_DAY;
    if (isFullDay) {
        const archivePath = path.join(tmpDir, 'full.gz');
        runMongodump(uri, ['--excludeCollection=sessions'], archivePath);
        return { archivePath, kind: 'full' };
    }

    const cutoff = new Date(Date.now() - INCREMENTAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const query = JSON.stringify({
        $or: [
            { date: { $gte: { $date: cutoff } } },
            { updatedAt: { $gte: { $date: cutoff } } },
        ],
    });
    const archivePath = path.join(tmpDir, 'incremental.gz');
    runMongodump(uri, ['--collection=news', `--query=${query}`], archivePath);
    return { archivePath, kind: 'incremental' };
}

async function main() {
    const uri = process.env.MONGODB_URI;
    const folderId = process.env.GDRIVE_BACKUP_FOLDER_ID;
    const keyJson = process.env.GDRIVE_SERVICE_ACCOUNT_KEY;
    if (!uri || !folderId || !keyJson) {
        console.error('MONGODB_URI, GDRIVE_BACKUP_FOLDER_ID and GDRIVE_SERVICE_ACCOUNT_KEY must be set');
        process.exit(1);
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-backup-'));
    const { archivePath, kind } = buildDump(uri, tmpDir);

    const credentials = JSON.parse(keyJson);
    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    const drive = google.drive({ version: 'v3', auth });

    const dateStr = new Date().toISOString().slice(0, 10);
    const fileName = `jantakasandesh-backup-${kind}-${dateStr}.gz`;
    const { size } = fs.statSync(archivePath);
    console.log(`Uploading ${fileName} (${(size / 1024 / 1024).toFixed(2)} MB, ${kind}) to Drive folder ${folderId}...`);

    const uploadRes = await drive.files.create({
        requestBody: { name: fileName, parents: [folderId] },
        media: { mimeType: 'application/gzip', body: fs.createReadStream(archivePath) },
        fields: 'id, name, size',
    });
    console.log(`✓ Uploaded: ${uploadRes.data.name} (id: ${uploadRes.data.id})`);

    // Prune old backups — keeps Drive storage bounded; backups (unlike articles) are
    // disposable/regenerable, so age-based deletion here is safe and expected.
    const cutoff = new Date(Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const list = await drive.files.list({
        q: `'${folderId}' in parents and name contains 'jantakasandesh-backup-' and trashed = false`,
        fields: 'files(id, name, createdTime)',
        orderBy: 'createdTime',
    });
    const old = (list.data.files || []).filter(f => new Date(f.createdTime) < cutoff);
    for (const f of old) {
        await drive.files.delete({ fileId: f.id });
        console.log(`✓ Pruned old backup: ${f.name}`);
    }
    console.log(`Done. ${old.length} old backup(s) pruned, retention = ${BACKUP_RETENTION_DAYS} days.`);

    fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().catch(err => {
    console.error('Backup failed:', err.message);
    process.exit(1);
});

