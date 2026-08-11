#!/usr/bin/env node
// Standalone PB SHABD sync script — runs directly by GitHub Actions (no HTTP endpoint needed).
// Usage: node sync-pbshabd.js [--pages N] [--skip-images]
require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const mongoose   = require('mongoose');
const cloudinary = require('cloudinary').v2;
const { News, generateSlug } = require('./models/News');

const SITE_URL = (process.env.SITE_URL || 'https://voiceofkranti.com').replace(/\/$/, '');

// ── CLI args ────────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const maxPages  = parseInt(args[args.indexOf('--pages') + 1]) || 3;
const skipImages = args.includes('--skip-images');

// ── Config ──────────────────────────────────────────────────────────────────
const PBSHABD_BASE       = 'https://shabd.prasarbharati.org';
const IMPORT_TYPES       = new Set(['RUSH', 'PRI', 'URG']);
const VALID_IMAGE_EXTS   = new Set(['.JPG', '.JPEG', '.PNG', '.WEBP', '.GIF']);

const CRIME_CATEGORY_ID = '19';
const TARGET_STATES = [
    'UTTAR PRADESH', 'MADHYA PRADESH', 'RAJASTHAN', 'CHHATTISGARH',
    'HARYANA', 'PUNJAB', 'TELANGANA', 'ANDHRA PRADESH',
    'KARNATAKA', 'KERALA', 'BIHAR', 'WEST BENGAL',
];

const CATEGORY_MAP = {
    'खेल': 'khel', 'क्रिकेट': 'khel', 'cricket': 'khel', 'football': 'khel', 'ipl': 'khel',
    'hockey': 'khel', 'tennis': 'khel', 'wrestling': 'khel', 'badminton': 'khel', 'sports': 'khel',
    'मनोरंजन': 'manoranjan', 'बॉलीवुड': 'manoranjan', 'फिल्म': 'manoranjan',
    'bollywood': 'manoranjan', 'cinema': 'manoranjan', 'film': 'manoranjan',
    'व्यापार': 'vyapar', 'बाजार': 'vyapar', 'शेयर': 'vyapar', 'अर्थव्यवस्था': 'vyapar',
    'business': 'vyapar', 'economy': 'vyapar', 'market': 'vyapar', 'budget': 'vyapar',
    'भोपाल': 'bhopal', 'bhopal': 'bhopal',
    'मध्य प्रदेश': 'rajya', 'मध्यप्रदेश': 'rajya', 'madhya pradesh': 'rajya',
    'इंदौर': 'rajya', 'ग्वालियर': 'rajya', 'जबलपुर': 'rajya', 'उज्जैन': 'rajya',
    'indore': 'rajya', 'gwalior': 'rajya', 'jabalpur': 'rajya',
    'उत्तर प्रदेश': 'rajya', 'बिहार': 'rajya', 'राजस्थान': 'rajya', 'महाराष्ट्र': 'rajya',
    'uttar pradesh': 'rajya', 'bihar': 'rajya', 'rajasthan': 'rajya', 'maharashtra': 'rajya',
    'राजनीति': 'rajniti', 'चुनाव': 'rajniti', 'संसद': 'rajniti', 'भाजपा': 'rajniti', 'कांग्रेस': 'rajniti',
    'politics': 'rajniti', 'election': 'rajniti', 'parliament': 'rajniti', 'bjp': 'rajniti', 'modi': 'rajniti',
    'विदेश': 'videsh', 'अमेरिका': 'videsh', 'चीन': 'videsh', 'पाकिस्तान': 'videsh',
    'world': 'videsh', 'international': 'videsh', 'china': 'videsh', 'pakistan': 'videsh',
    'अपराध': 'crime', 'हत्या': 'crime', 'गिरफ्तार': 'crime', 'दुर्घटना': 'crime',
    'बलात्कार': 'crime', 'लूट': 'crime', 'डकैती': 'crime', 'तस्करी': 'crime',
    'फरार': 'crime', 'जेल': 'crime', 'पुलिस': 'crime', 'एफआईआर': 'crime',
    'आरोपी': 'crime', 'अभियुक्त': 'crime', 'पीड़ित': 'crime', 'शव': 'crime',
    'crime': 'crime', 'murder': 'crime', 'arrested': 'crime', 'accident': 'crime',
    'rape': 'crime', 'robbery': 'crime', 'theft': 'crime', 'police': 'crime', 'fir': 'crime',
    'देश': 'desh', 'भारत': 'desh', 'india': 'desh', 'national': 'desh',
};

function categorize(title, stateHint, desc) {
    const checks = [title.toLowerCase(), stateHint.toLowerCase(), (desc || '').toLowerCase()];
    for (const text of checks) {
        for (const [key, val] of Object.entries(CATEGORY_MAP)) {
            if (text.includes(key)) return val;
        }
    }
    return 'desh';
}

// ── Cookie helpers ───────────────────────────────────────────────────────────
function extractCookies(headers) {
    const out = {};
    for (const c of (headers.getSetCookie?.() || [])) {
        const [nv] = c.split(';');
        const eq = nv.indexOf('=');
        if (eq > 0) out[nv.slice(0, eq).trim()] = nv.slice(eq + 1).trim();
    }
    return out;
}
function cookieHeader(obj) {
    return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ── PB SHABD helpers ─────────────────────────────────────────────────────────
async function login() {
    const r = await fetch(`${PBSHABD_BASE}/login`, { signal: AbortSignal.timeout(15000) });
    const html = await r.text();
    const m = html.match(/name="_token"\s+value="([^"]+)"/);
    if (!m) throw new Error('CSRF token not found');
    let cookies = extractCookies(r.headers);

    const auth = await fetch(`${PBSHABD_BASE}/authenticate`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': cookieHeader(cookies),
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
        body: new URLSearchParams({ _token: m[1], email: process.env.PBSHABD_EMAIL, password: process.env.PBSHABD_PASSWORD }).toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
    });
    cookies = { ...cookies, ...extractCookies(auth.headers) };
    const firstLoc = auth.headers.get('location') || '';
    if (firstLoc.includes('/login') || (auth.status !== 302 && auth.status !== 200))
        throw new Error('Login failed — check PBSHABD_EMAIL / PBSHABD_PASSWORD');

    // Follow all redirects (e.g. /reset → /stories) to establish the session
    let loc = firstLoc;
    while (loc) {
        const redir = await fetch(loc, {
            headers: { 'Cookie': cookieHeader(cookies) },
            redirect: 'manual',
            signal: AbortSignal.timeout(15000),
        });
        cookies = { ...cookies, ...extractCookies(redir.headers) };
        loc = redir.status === 302 ? redir.headers.get('location') : null;
    }
    return cookies;
}

async function fetchPage(cookies, page, state = '', category = '', search = '') {
    const params = new URLSearchParams({ page: String(page), length: '50', filter: 'ALL', language: 'हिन्दी', state, search, category });
    const r = await fetch(`${PBSHABD_BASE}/api/data?${params}`, {
        headers: {
            'Cookie': cookieHeader(cookies),
            'Accept': 'application/json',
            'Authorization': 'Bearer',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': `${PBSHABD_BASE}/stories`,
        },
        signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`API ${r.status}`);
    return r.json();
}

async function getImageUrl(cookies, mediaId, ext) {
    const params = new URLSearchParams({ id: mediaId, st: 'pb-s3', ext, type: 'IMAGE' });
    const r = await fetch(`${PBSHABD_BASE}/getS3Urls?${params}`, {
        headers: { 'Cookie': cookieHeader(cookies), 'X-Requested-With': 'XMLHttpRequest' },
        signal: AbortSignal.timeout(10000),
    });
    return r.ok ? (await r.text()).trim() : null;
}

async function uploadToCloudinary(imageUrl) {
    if (!imageUrl || !process.env.CLOUDINARY_API_KEY) return imageUrl;
    try {
        const res = await fetch(imageUrl, { signal: AbortSignal.timeout(8000) });
        if (!res.ok || !res.headers.get('content-type')?.startsWith('image')) return null;
        const buffer = Buffer.from(await res.arrayBuffer());
        return await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                { folder: 'news', transformation: [{ width: 1200, height: 630, crop: 'fill', format: 'jpg', quality: 'auto' }] },
                (err, result) => err ? reject(err) : resolve(result.secure_url)
            );
            stream.end(buffer);
        });
    } catch { return null; }
}

function stripHtml(html) {
    return (html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n')
        .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
}

// Removes the title and synopsis paragraphs that PB SHABD duplicates at the top of story_intro_line
function cleanPbContent(text, title) {
    const norm = s => (s || '').trim().replace(/\s+/g, ' ');
    let t = text.trim();
    // Only strip the title repeat — keep synopsis as the article intro paragraph
    const titlePrefix = norm(title).substring(0, 30);
    if (titlePrefix && norm(t).startsWith(titlePrefix)) {
        const end = t.indexOf('\n');
        t = end >= 0 ? t.slice(end) : t;
    }
    return t.replace(/^\n+/, '').trim();
}

// ── Email report ────────────────────────────────────────────────────────────
async function sendReport({ imported, skipped, stories, error }) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return;

    const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    const ok  = !error;
    const subject = `PB SHABD Sync | ${now}`;

    const rows = stories.map((s, i) => `
    <tr>
      <td style="padding:6px 12px;color:#6b7280">${i + 1}</td>
      <td style="padding:6px 12px">${s.title}</td>
      <td style="padding:6px 12px"><a href="${SITE_URL}/news-detail.html?slug=${s.slug}" style="color:#1d4ed8">${SITE_URL}/news-detail.html?slug=${s.slug}</a></td>
    </tr>`).join('');

    const html = `
<div style="font-family:sans-serif;max-width:860px;color:#111">
  <h2 style="color:#1d4ed8;margin-bottom:4px">PB SHABD Sync</h2>
  <p style="color:#6b7280;margin-top:0">${now}</p>
  <p><strong>Status:</strong> ${ok ? '✅ Success' : '❌ Failed — ' + error.message}</p>
  <p><strong>Imported:</strong> ${imported} stories &nbsp;|&nbsp; <strong>Already existed:</strong> ${skipped}</p>
  ${stories.length ? `
  <h3 style="border-bottom:1px solid #e5e7eb;padding-bottom:6px">Imported Stories</h3>
  <table border="1" cellspacing="0" style="border-collapse:collapse;font-size:13px;width:100%;border-color:#e5e7eb">
    <thead><tr style="background:#f8fafc">
      <th style="padding:6px 12px;text-align:left">#</th>
      <th style="padding:6px 12px;text-align:left">Title</th>
      <th style="padding:6px 12px;text-align:left">URL</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>` : '<p>No new stories imported.</p>'}
</div>`;

    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'PB SHABD Sync <onboarding@resend.dev>', to: ['mahmedk13@gmail.com'], subject, html }),
        signal: AbortSignal.timeout(10000),
    });
    if (res.ok) console.log('📧 Report sent to mahmedk13@gmail.com');
    else console.warn('⚠️ Email failed:', await res.text());
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    if (!process.env.PBSHABD_EMAIL || !process.env.PBSHABD_PASSWORD)
        throw new Error('PBSHABD_EMAIL / PBSHABD_PASSWORD not set');
    if (!process.env.MONGODB_URI)
        throw new Error('MONGODB_URI not set');

    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key:    process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
    });

    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    console.log('✅ MongoDB connected');

    console.log('🔐 Logging into PB SHABD…');
    const cookies = await login();
    console.log('✅ Logged in');

    let totalImported = 0, totalSkipped = 0;
    const seenStoryIds = new Set();
    const importedStories = []; // { title, slug }

    // Build fetch plan: crime passes first, then per-state, then general
    const fetchPlan = [
        // Crime (all states)
        { page: 1, state: '', pbCatId: CRIME_CATEGORY_ID, search: '', label: 'Crime pg1' },
        { page: 2, state: '', pbCatId: CRIME_CATEGORY_ID, search: '', label: 'Crime pg2' },
        // MP and UP get 2 pages each — priority states
        { page: 1, state: 'MADHYA PRADESH', pbCatId: '', search: '', label: 'MP pg1' },
        { page: 2, state: 'MADHYA PRADESH', pbCatId: '', search: '', label: 'MP pg2' },
        { page: 1, state: 'UTTAR PRADESH',  pbCatId: '', search: '', label: 'UP pg1' },
        { page: 2, state: 'UTTAR PRADESH',  pbCatId: '', search: '', label: 'UP pg2' },
        // Bhopal search
        { page: 1, state: '', pbCatId: '', search: 'भोपाल', label: 'Bhopal pg1' },
        { page: 2, state: '', pbCatId: '', search: 'भोपाल', label: 'Bhopal pg2' },
        // Remaining target states: 1 page each
        ...TARGET_STATES
            .filter(s => s !== 'MADHYA PRADESH' && s !== 'UTTAR PRADESH')
            .map(state => ({ page: 1, state, pbCatId: '', search: '', label: state })),
        // General Hindi sweeps
        ...Array.from({ length: maxPages }, (_, i) => ({ page: i + 1, state: '', pbCatId: '', search: '', label: `General pg${i + 1}` })),
    ];

    for (const { page, state, pbCatId, search, label } of fetchPlan) {
        console.log(`📄 Fetching [${label}]…`);
        const json = await fetchPage(cookies, page, state, pbCatId, search);
        const stories = json.data || [];
        if (!stories.length) { console.log(`  No stories for [${label}]`); continue; }

        let importable = 0, dups = 0;
        for (const story of stories) {
            if (seenStoryIds.has(story.story_id)) continue;
            const hasImage = (story.media || []).some(m =>
                m.type === 'IMAGE' && VALID_IMAGE_EXTS.has((m.extention || '').toUpperCase()));
            // Import RUSH/PRI/URG always; import ORD only if it has an image (camera icon)
            if (!IMPORT_TYPES.has(story.news_type) && !hasImage) continue;
            seenStoryIds.add(story.story_id);
            importable++;

            // Skip stories that carry video/audio — their content is broadcast-script formatted
            if ((story.media || []).some(m => m.type === 'VIDEO' || m.type === 'AUDIO')) continue;

            const rssLink = `${PBSHABD_BASE}/download?story_id=${story.story_id}`;
            if (await News.findOne({ rssLink }).lean()) { dups++; continue; }

            const raw = stripHtml(story.story_intro_line);
            const content = cleanPbContent(raw, story.title) || story.description || '';
            if (!content) continue;

            let photoUrl = null;
            if (!skipImages) {
                const imgMedia = (story.media || []).find(m =>
                    m.type === 'IMAGE' && VALID_IMAGE_EXTS.has((m.extention || '').toUpperCase()));
                if (imgMedia) {
                    const s3Url = await getImageUrl(cookies, imgMedia.media_id, imgMedia.extention);
                    if (s3Url) photoUrl = await uploadToCloudinary(s3Url);
                }
            }

            const category = categorize(story.title, story.state || '', story.description || '');
            const base = generateSlug(story.title);
            let slug = base, ctr = 1;
            while (await News.findOne({ slug }).lean()) { ctr++; slug = `${base}-${ctr}`; }

            await new News({
                heading:    story.title,
                content,
                category,
                author:     story.rnu_name || 'PB SHABD',
                photos:     photoUrl ? [photoUrl] : [],
                rssSource:  'PB SHABD',
                rssLink,
                isOriginal: false,
                headingNorm:(story.title || '').toLowerCase().replace(/\s+/g, ' ').trim(),
                date:       new Date(story.created_at_src || story.created_at || Date.now()),
                slug,
            }).save();

            totalImported++;
            importedStories.push({ title: story.title, slug });
            console.log(`  ✔ [${story.news_type}] ${story.title.substring(0, 60)}`);
        }
        totalSkipped += dups;
        if (importable > 0 && dups === importable) console.log(`  All importable stories already in DB for [${label}]`);
    }

    console.log(`\n✅ Done: ${totalImported} imported, ${totalSkipped} already existed.`);
    await sendReport({ imported: totalImported, skipped: totalSkipped, stories: importedStories, error: null });
    await mongoose.disconnect();
}

main().catch(async err => {
    console.error('❌', err.message);
    await sendReport({ imported: 0, skipped: 0, stories: [], error: err }).catch(() => {});
    process.exit(1);
});
