// Uploads a local MongoDB dump file to a Google Drive folder via a service account,
// then prunes backups older than BACKUP_RETENTION_DAYS from that same folder.
// Usage: node backup-to-gdrive.js <path-to-dump-file>
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
const { google } = require('googleapis');

const BACKUP_RETENTION_DAYS = 30;

async function main() {
    const filePath = process.argv[2];
    if (!filePath || !fs.existsSync(filePath)) {
        console.error('Usage: node backup-to-gdrive.js <path-to-dump-file>');
        process.exit(1);
    }
    const folderId = process.env.GDRIVE_BACKUP_FOLDER_ID;
    const keyJson = process.env.GDRIVE_SERVICE_ACCOUNT_KEY;
    if (!folderId || !keyJson) {
        console.error('GDRIVE_BACKUP_FOLDER_ID and GDRIVE_SERVICE_ACCOUNT_KEY must be set');
        process.exit(1);
    }

    const credentials = JSON.parse(keyJson);
    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    const drive = google.drive({ version: 'v3', auth });

    const fileName = `jantakasandesh-backup-${new Date().toISOString().slice(0, 10)}.gz`;
    const { size } = fs.statSync(filePath);
    console.log(`Uploading ${fileName} (${(size / 1024 / 1024).toFixed(2)} MB) to Drive folder ${folderId}...`);

    const uploadRes = await drive.files.create({
        requestBody: { name: fileName, parents: [folderId] },
        media: { mimeType: 'application/gzip', body: fs.createReadStream(filePath) },
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
}

main().catch(err => {
    console.error('Backup upload failed:', err.message);
    process.exit(1);
});
