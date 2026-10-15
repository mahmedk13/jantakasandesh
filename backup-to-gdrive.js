// Runs a MongoDB dump and uploads it to Google Drive (authenticated as a real Google
// account via OAuth2, NOT a service account — see below for why), then prunes backups
// older than BACKUP_RETENTION_DAYS from that same folder.
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
// Why OAuth2 + refresh token instead of a service account: service accounts have
// NO storage quota of their own on a regular (non-Workspace) Google account — they
// can read/share files but cannot own newly uploaded ones ("Service Accounts do not
// have storage quota" error). Shared Drives / domain delegation fix this but require
// a paid Google Workspace plan. Authenticating as your own account instead means
// uploads count against your own real Drive storage.
//
// One-time setup required (cannot be done from code — needs your Google Cloud/Drive access):
//   1. Google Cloud Console → APIs & Services → enable the "Google Drive API".
//   2. APIs & Services → Credentials → Create Credentials → OAuth client ID →
//      Application type "Desktop app" → Create. Note its Client ID and Client Secret.
//   3. Run locally (one time): node get-gdrive-refresh-token.js <clientId> <clientSecret>
//      — follow its instructions to authorize with your own Google account.
//   4. Create (or pick) a backups folder in YOUR OWN Google Drive, copy its ID from
//      the URL: drive.google.com/drive/folders/<THIS_PART>. No sharing step needed —
//      it's already your own folder.
//   5. Add GitHub repo secrets: GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET,
//      GDRIVE_REFRESH_TOKEN (all three printed by step 3), and GDRIVE_BACKUP_FOLDER_ID
//      (the folder ID from step 4). Remove the old GDRIVE_SERVICE_ACCOUNT_KEY secret —
//      it's no longer used. (MONGODB_URI secret already exists and is reused.)
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
    const clientId = process.env.GDRIVE_CLIENT_ID;
    const clientSecret = process.env.GDRIVE_CLIENT_SECRET;
    const refreshToken = process.env.GDRIVE_REFRESH_TOKEN;
    if (!uri || !folderId || !clientId || !clientSecret || !refreshToken) {
        console.error('MONGODB_URI, GDRIVE_BACKUP_FOLDER_ID, GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET and GDRIVE_REFRESH_TOKEN must be set');
        process.exit(1);
    }

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    // Fail fast with an unambiguous message before spending time on the dump itself.
    try {
        await drive.files.get({ fileId: folderId, fields: 'id, name, mimeType' });
    } catch (err) {
        console.error(
            `Cannot access Drive folder ${folderId}: ${err.message}. Check that ` +
            'GDRIVE_BACKUP_FOLDER_ID is the bare folder ID (not the full URL) and that ' +
            'it belongs to the same Google account the refresh token was issued for.'
        );
        process.exit(1);
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-backup-'));
    const { archivePath, kind } = buildDump(uri, tmpDir);

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
    if (/File not found/i.test(err.message || '')) {
        console.error(
            'Hint: "File not found" from the Drive API almost always means either ' +
            'GDRIVE_BACKUP_FOLDER_ID is wrong, or the folder was never actually shared ' +
            "with the service account's own email (the \"client_email\" field in its JSON " +
            'key) with at least Editor access — creating a service account does NOT ' +
            'automatically grant it access to anything in your Drive.'
        );
    }
    process.exit(1);
});

