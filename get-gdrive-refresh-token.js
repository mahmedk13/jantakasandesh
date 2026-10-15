// ONE-TIME, run LOCALLY on your own machine (not in CI): authorizes this app against
// YOUR Google account via OAuth2 and prints a long-lived refresh token to paste into
// GitHub secrets. Needed because Drive service accounts have NO storage quota of their
// own on regular (non-Workspace) Google accounts — they can read/share files but cannot
// own newly uploaded ones (see "Service Accounts do not have storage quota" error).
// Authenticating as your own account instead means uploads count against your own
// Drive storage, which genuinely exists.
//
// One-time setup required first (Google Cloud Console):
//   1. APIs & Services → Credentials → Create Credentials → OAuth client ID.
//   2. Application type: "Desktop app". Give it any name. Create.
//   3. Download/copy its Client ID and Client Secret.
//   4. Run this script locally: node get-gdrive-refresh-token.js <clientId> <clientSecret>
//   5. It prints a URL — open it in your browser, sign in with the Google account whose
//      Drive you want backups to go to, approve, and you'll be redirected back here
//      automatically (this script runs a tiny local server to catch the redirect).
//   6. Copy the printed refresh token into a new GitHub repo secret: GDRIVE_REFRESH_TOKEN
//      Also add GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET (same values from step 3).
//      These three REPLACE the old GDRIVE_SERVICE_ACCOUNT_KEY secret — delete that one,
//      it's no longer used. GDRIVE_BACKUP_FOLDER_ID stays exactly as it already is; no
//      more "share this folder with a service account" step is needed either, since
//      you're now authorizing as yourself and already own your own Drive folders.
const http = require('http');
const { google } = require('googleapis');

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
    console.error('Usage: node get-gdrive-refresh-token.js <clientId> <clientSecret>');
    process.exit(1);
}

const PORT = 53682;
const redirectUri = `http://127.0.0.1:${PORT}`;
const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', // required to get a refresh_token back
    prompt: 'consent',      // forces a refresh_token even if you've authorized this app before
    scope: ['https://www.googleapis.com/auth/drive'],
});

console.log('\nOpen this URL in your browser and sign in with the Google account you want backups stored in:\n');
console.log(authUrl);
console.log('\nWaiting for you to approve access...\n');

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, redirectUri);
    const code = url.searchParams.get('code');
    if (!code) {
        res.end('No code received — close this tab and check the terminal.');
        return;
    }
    res.end('Authorized — you can close this tab and go back to the terminal.');
    server.close();

    const { tokens } = await oauth2Client.getToken(code);
    console.log('✓ Success. Add these as GitHub repo secrets:\n');
    console.log('GDRIVE_CLIENT_ID     =', clientId);
    console.log('GDRIVE_CLIENT_SECRET =', clientSecret);
    console.log('GDRIVE_REFRESH_TOKEN =', tokens.refresh_token);
});
server.listen(PORT);
