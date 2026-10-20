#!/usr/bin/env node
// Standalone RSS + NewsData.io + GNews + Currents import script — runs via GitHub
// Actions instead of Vercel's cron, so the CPU-heavy image download+compress work
// (sharp) happens on GitHub's runners instead of counting against Vercel's Fluid
// Active CPU quota. GNews/Currents are additionally still exposed as manual admin
// buttons in server.js for on-demand use — those are unaffected by this script.
// Usage: node fetch-news-import.js
require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const mongoose  = require('mongoose');
const ImageKit  = require('imagekit');
const sharp     = require('sharp');
const RSSParser = require('rss-parser');
const { News, generateSlug } = require('./models/News');

const rssParser = new RSSParser({
    customFields: { item: ['media:content', 'media:thumbnail', 'enclosure', 'source'] },
    timeout: 10000
});

const SITE_URL = (process.env.SITE_URL || 'https://www.jantakasandesh.in').replace(/\/$/, '');

const imagekit = (process.env.IMAGEKIT_PUBLIC_KEY && process.env.IMAGEKIT_PRIVATE_KEY && process.env.IMAGEKIT_URL_ENDPOINT)
    ? new ImageKit({
        publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
        privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
        urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
    })
    : null;

// ── RSS sources (kept in sync with server.js's own copy — this is a deliberate
// duplication, same convention sync-pbshabd.js already uses for its own category/
// state maps, rather than a shared module) ───────────────────────────────────
const RSS_SOURCES = [
    { name: 'BBC Hindi',         url: 'https://feeds.bbci.co.uk/hindi/rss.xml',                           defaultCategory: 'desh',       fullContent: false },
    { name: 'Aaj Tak',           url: 'https://feeds.feedburner.com/aajtaklive',                           defaultCategory: 'desh',       fullContent: false },
    { name: 'ABP Live',          url: 'https://www.abplive.com/news/india/feed',                           defaultCategory: 'desh',       fullContent: true  },
    { name: 'Amar Ujala',        url: 'https://www.amarujala.com/rss/india-news.xml',                      defaultCategory: 'desh',       fullContent: false },
    { name: 'News18 Hindi',      url: 'https://hindi.news18.com/commonfeeds/v1/hin/rss/nation.xml',        defaultCategory: 'desh',       fullContent: false },
    { name: 'Dainik Bhaskar',    url: 'https://www.bhaskar.com/rss-feed/1061/',                            defaultCategory: 'desh',       fullContent: false },
    { name: 'Google News Hindi', url: 'https://news.google.com/rss?hl=hi&gl=IN&ceid=IN:hi',                defaultCategory: 'desh',       fullContent: false },
    { name: 'ABP Live Khel',     url: 'https://www.abplive.com/sports/feed',                              defaultCategory: 'khel',       fullContent: true  },
    { name: 'BBC Hindi Khel',    url: 'https://feeds.bbci.co.uk/hindi/sport/rss.xml',                     defaultCategory: 'khel',       fullContent: false },
    { name: 'ABP Live Film',     url: 'https://www.abplive.com/entertainment/feed',                       defaultCategory: 'manoranjan', fullContent: true  },
    { name: 'ABP Live Vyapar',   url: 'https://www.abplive.com/business/feed',                            defaultCategory: 'vyapar',     fullContent: true  },
    { name: 'ABP Live Apradh',   url: 'https://www.abplive.com/crime/feed',                               defaultCategory: 'crime',      fullContent: true  },
    { name: 'BBC Hindi Videsh',  url: 'https://feeds.bbci.co.uk/hindi/world/rss.xml',                     defaultCategory: 'videsh',     fullContent: false },
    { name: 'ABP Live Rajniti',  url: 'https://www.abplive.com/politics/feed',                            defaultCategory: 'rajniti',    fullContent: true  },
    { name: 'ABP Live MP-CG',    url: 'https://www.abplive.com/states/madhya-pradesh-chhattisgarh/feed',  defaultCategory: 'rajya',      fullContent: true  },
    { name: 'News18 Hindi MP',   url: 'https://hindi.news18.com/commonfeeds/v1/hin/rss/states/madhya-pradesh.xml', defaultCategory: 'rajya', fullContent: false },
    { name: 'Patrika Bhopal',    url: 'https://cms.patrika.com/googlefeed/blog/location/bhopal-news',     defaultCategory: 'bhopal',     fullContent: false },
];

const BLOCKED_DOMAINS = ['khulasaonline.com'];
const isBlockedDomain = (url) => url && BLOCKED_DOMAINS.some(d => url.includes(d));

const NEWSDATA_CATEGORY_MAP = {
    'top': 'desh', 'politics': 'rajniti', 'sports': 'khel', 'entertainment': 'manoranjan',
    'business': 'vyapar', 'crime': 'crime', 'world': 'videsh', 'technology': 'desh',
    'health': 'desh', 'science': 'desh', 'education': 'desh',
};

const CATEGORY_MAP = {
    'खेल': 'khel', 'क्रिकेट': 'khel', 'आईपीएल': 'khel', 'फुटबॉल': 'khel', 'हॉकी': 'khel',
    'बैडमिंटन': 'khel', 'कुश्ती': 'khel', 'कबड्डी': 'khel', 'टेनिस': 'khel', 'मैच': 'khel',
    'sports': 'khel', 'sport': 'khel', 'cricket': 'khel', 'football': 'khel', 'ipl': 'khel',
    'hockey': 'khel', 'tennis': 'khel', 'wrestling': 'khel', 'badminton': 'khel', 'kabaddi': 'khel',
    'olympics': 'khel', 'cwg': 'khel', 'fifa': 'khel', 'bcci': 'khel',
    'मनोरंजन': 'manoranjan', 'बॉलीवुड': 'manoranjan', 'फिल्म': 'manoranjan', 'सिनेमा': 'manoranjan',
    'ओटीटी': 'manoranjan', 'वेब सीरीज': 'manoranjan', 'अभिनेता': 'manoranjan', 'अभिनेत्री': 'manoranjan',
    'entertainment': 'manoranjan', 'bollywood': 'manoranjan', 'cinema': 'manoranjan',
    'movie': 'manoranjan', 'film': 'manoranjan', 'actress': 'manoranjan', 'actor': 'manoranjan',
    'ott': 'manoranjan', 'web series': 'manoranjan', 'music': 'manoranjan', 'hollywood': 'manoranjan',
    'व्यापार': 'vyapar', 'बाजार': 'vyapar', 'शेयर': 'vyapar', 'अर्थव्यवस्था': 'vyapar',
    'रुपया': 'vyapar', 'बजट': 'vyapar', 'सेंसेक्स': 'vyapar', 'निफ्टी': 'vyapar',
    'business': 'vyapar', 'economy': 'vyapar', 'finance': 'vyapar', 'market': 'vyapar',
    'sensex': 'vyapar', 'nifty': 'vyapar', 'stock': 'vyapar', 'share market': 'vyapar',
    'rbi': 'vyapar', 'budget': 'vyapar', 'gdp': 'vyapar', 'inflation': 'vyapar',
    'प्रधानमंत्री': 'desh', 'पीएम मोदी': 'desh', 'केंद्र सरकार': 'desh', 'केंद्रीय मंत्रिमंडल': 'desh',
    'केंद्रीय कैबिनेट': 'desh', 'राष्ट्रपति': 'desh', 'सुप्रीम कोर्ट': 'desh', 'सर्वोच्च न्यायालय': 'desh',
    'केंद्रीय बजट': 'desh', 'आम बजट': 'desh', 'नीति आयोग': 'desh', 'गृह मंत्रालय': 'desh',
    'रक्षा मंत्रालय': 'desh', 'विदेश मंत्रालय': 'desh', 'वित्त मंत्रालय': 'desh',
    'prime minister': 'desh', 'pm modi': 'desh', 'union cabinet': 'desh', 'central government': 'desh',
    'supreme court': 'desh', 'union budget': 'desh', 'niti aayog': 'desh',
    'राजनीति': 'rajniti', 'चुनाव': 'rajniti', 'विधानसभा': 'rajniti', 'लोकसभा': 'rajniti',
    'राज्यसभा': 'rajniti', 'संसद': 'rajniti', 'भाजपा': 'rajniti', 'कांग्रेस': 'rajniti',
    'politics': 'rajniti', 'election': 'rajniti', 'political': 'rajniti', 'parliament': 'rajniti',
    'bjp': 'rajniti', 'congress': 'rajniti', 'aap': 'rajniti', 'modi': 'rajniti', 'rahul': 'rajniti',
    'cm ': 'rajniti', 'pm ': 'rajniti', 'minister': 'rajniti', 'मंत्री': 'rajniti',
    'विदेश': 'videsh', 'अमेरिका': 'videsh', 'चीन': 'videsh', 'पाकिस्तान': 'videsh',
    'रूस': 'videsh', 'यूक्रेन': 'videsh', 'इजराइल': 'videsh', 'ईरान': 'videsh',
    'सीरिया': 'videsh', 'अफगानिस्तान': 'videsh', 'बांग्लादेश': 'videsh', 'नेपाल': 'videsh', 'श्रीलंका': 'videsh',
    'सऊदी': 'videsh', 'दुबई': 'videsh', 'यूएई': 'videsh', 'तुर्की': 'videsh',
    'world': 'videsh', 'international': 'videsh', 'global': 'videsh', 'america': 'videsh',
    'china': 'videsh', 'pakistan': 'videsh', 'russia': 'videsh', 'ukraine': 'videsh',
    'israel': 'videsh', 'iran': 'videsh', 'syria': 'videsh', 'trump': 'videsh', 'nato': 'videsh',
    'afghanistan': 'videsh', 'bangladesh': 'videsh', 'nepal': 'videsh', 'saudi': 'videsh',
    'dubai': 'videsh', 'turkey': 'videsh', 'japan': 'videsh', 'germany': 'videsh',
    'france': 'videsh', 'uk': 'videsh', 'britain': 'videsh', 'canada': 'videsh',
    'अपराध': 'crime', 'हत्या': 'crime', 'चोरी': 'crime', 'डकैती': 'crime',
    'दुष्कर्म': 'crime', 'गिरफ्तार': 'crime', 'बलात्कार': 'crime', 'हादसा': 'crime',
    'शव': 'crime', 'लाश': 'crime', 'कांड': 'crime', 'वारदात': 'crime',
    'हैवानियत': 'crime', 'सनसनी': 'crime', 'अपहरण': 'crime', 'दुर्घटना': 'crime',
    'फायरिंग': 'crime', 'गोलीबारी': 'crime', 'बम': 'crime', 'विस्फोट': 'crime',
    'मारपीट': 'crime', 'लूट': 'crime', 'जेल': 'crime', 'आरोपी': 'crime',
    'ठग': 'crime', 'नशे': 'crime',
    'crime': 'crime', 'murder': 'crime', 'rape': 'crime', 'theft': 'crime',
    'robbery': 'crime', 'arrested': 'crime', 'police': 'crime', 'accident': 'crime',
    'fraud': 'crime', 'scam': 'crime', 'घोटाला': 'crime', 'धोखाधड़ी': 'crime',
    'blast': 'crime', 'firing': 'crime', 'kidnap': 'crime', 'dead body': 'crime',
    'भोपाल': 'bhopal', 'bhopal': 'bhopal',
    'इतिहास': 'itihas', 'पुरातत्व': 'itihas', 'विरासत': 'itihas', 'प्राचीन': 'itihas',
    'history': 'itihas', 'heritage': 'itihas', 'ancient': 'itihas', 'historical': 'itihas',
};

function mapRssCategory(rssCategories, title, defaultCategory, content) {
    if (title) {
        const lowerTitle = title.toLowerCase();
        for (const [key, value] of Object.entries(CATEGORY_MAP)) {
            if (lowerTitle.includes(key)) return value;
        }
    }
    if (content) {
        const lowerContent = content.toLowerCase();
        for (const [key, value] of Object.entries(CATEGORY_MAP)) {
            if (lowerContent.includes(key)) return value;
        }
    }
    for (const cat of (rssCategories || [])) {
        const lower = (cat || '').toLowerCase().trim();
        for (const [key, value] of Object.entries(CATEGORY_MAP)) {
            if (lower.includes(key)) return value;
        }
    }
    return defaultCategory === 'desh' ? 'rajya' : defaultCategory;
}

const STATE_MAP = {
    'madhya pradesh': 'mp', 'मध्य प्रदेश': 'mp', 'मध्यप्रदेश': 'mp',
    'indore': 'mp', 'इंदौर': 'mp', 'gwalior': 'mp', 'ग्वालियर': 'mp',
    'jabalpur': 'mp', 'जबलपुर': 'mp', 'ujjain': 'mp', 'उज्जैन': 'mp',
    'bhopal': 'mp', 'भोपाल': 'mp',
    'रीवा': 'mp', 'rewa': 'mp', 'सागर': 'mp', 'sagar': 'mp', 'सतना': 'mp', 'satna': 'mp',
    'रतलाम': 'mp', 'ratlam': 'mp', 'खंडवा': 'mp', 'khandwa': 'mp', 'खरगोन': 'mp', 'khargone': 'mp',
    'बालाघाट': 'mp', 'balaghat': 'mp', 'छिंदवाड़ा': 'mp', 'chhindwara': 'mp',
    'होशंगाबाद': 'mp', 'नर्मदापुरम': 'mp', 'विदिशा': 'mp', 'रायसेन': 'mp', 'सीहोर': 'mp',
    'गुना': 'mp', 'शिवपुरी': 'mp', 'भिंड': 'mp', 'मुरैना': 'mp', 'दतिया': 'mp', 'देवास': 'mp',
    'मंदसौर': 'mp', 'नीमच': 'mp', 'पन्ना': 'mp', 'मंडला': 'mp', 'छतरपुर': 'mp', 'टीकमगढ़': 'mp',
    'दमोह': 'mp', 'सीधी': 'mp', 'सिंगरौली': 'mp', 'शहडोल': 'mp', 'अनूपुर': 'mp', 'उमरिया': 'mp',
    'बुरहानपुर': 'mp', 'झाबुआ': 'mp', 'अलीराजपुर': 'mp', 'बड़वानी': 'mp', 'धार': 'mp',
    'uttar pradesh': 'up', 'उत्तर प्रदेश': 'up',
    'bihar': 'bihar', 'बिहार': 'bihar',
    'rajasthan': 'rajasthan', 'राजस्थान': 'rajasthan',
    'maharashtra': 'maharashtra', 'महाराष्ट्र': 'maharashtra',
    'punjab': 'punjab', 'पंजाब': 'punjab',
    'haryana': 'haryana', 'हरियाणा': 'haryana',
    'gujarat': 'gujarat', 'गुजरात': 'gujarat',
    'chhattisgarh': 'chhattisgarh', 'छत्तीसगढ़': 'chhattisgarh',
    'jharkhand': 'jharkhand', 'झारखंड': 'jharkhand',
    'uttarakhand': 'uttarakhand', 'उत्तराखंड': 'uttarakhand', 'देहरादून': 'uttarakhand', 'dehradun': 'uttarakhand',
    'himachal': 'himachal', 'हिमाचल': 'himachal',
    'kerala': 'kerala', 'केरल': 'kerala',
    'telangana': 'telangana', 'तेलंगाना': 'telangana',
    'andhra pradesh': 'andhra_pradesh', 'आंध्र प्रदेश': 'andhra_pradesh',
    'karnataka': 'karnataka', 'कर्नाटक': 'karnataka',
    'west bengal': 'west_bengal', 'पश्चिम बंगाल': 'west_bengal',
    'delhi': 'delhi', 'दिल्ली': 'delhi', 'new delhi': 'delhi', 'नई दिल्ली': 'delhi',
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

function normalizeHeading(heading) {
    return heading
        .toLowerCase()
        .replace(/[^\u0900-\u097fa-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);
}

function cleanHtml(raw) {
    if (!raw) return '';
    return raw
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&rsquo;/gi, '\u2019')
        .replace(/&lsquo;/gi, '\u2018')
        .replace(/&rdquo;/gi, '\u201d')
        .replace(/&ldquo;/gi, '\u201c')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/&#\d+;/gi, ' ')
        .replace(/[^\S\n]+/g, ' ')
        .replace(/[ \t]*\n[ \t]*/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function isFullArticleContent(content = '') {
    const text = cleanHtml(String(content || '')).trim();
    if (!text) return false;
    const normalizedText = text.replace(/\s+/g, ' ').trim();
    const paragraphs = text.split(/\n{2,}/).map(part => part.trim()).filter(part => part.length > 40);
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const charCount = normalizedText.length;
    return paragraphs.length >= 2 || wordCount >= 180 || charCount > 800;
}

function plainBodyCharCount(content = '') {
    return cleanHtml(String(content || '')).replace(/\s+/g, ' ').trim().length;
}

const MIN_IMPORTED_BODY_CHARS = 1400;

function paragraphizeLegacyImportedText(content = '') {
    if (typeof content !== 'string') return '';
    const cleaned = cleanHtml(content).trim();
    if (!cleaned) return '';
    const withParagraphBreaks = cleaned
        .replace(/([。!?])\s+(?=[A-Za-z\u0900-\u097F])/g, '$1\n')
        .replace(/([.!?])\s+(?=[A-Za-z\u0900-\u097F])/g, '$1\n')
        .replace(/\n{3,}/g, '\n\n')
        .split(/\n{2,}|\n/)
        .map(part => part.trim())
        .filter(Boolean);
    if (!withParagraphBreaks.length) return cleaned;
    const paragraphs = [];
    let current = '';
    for (const part of withParagraphBreaks) {
        const candidate = current ? `${current} ${part}` : part;
        if ((candidate.length > 220 || (current && /[.!?]\s*$/.test(current) && part.length > 80)) && current) {
            paragraphs.push(current.trim());
            current = part;
        } else {
            current = candidate;
        }
    }
    if (current) paragraphs.push(current.trim());
    if (paragraphs.length > 1) return paragraphs.join('\n\n');
    if (cleaned.length > 260) {
        const sentences = cleaned.split(/(?<=[.!?])\s+/).map(part => part.trim()).filter(Boolean);
        if (sentences.length > 1) {
            const grouped = [];
            let chunk = '';
            for (const sentence of sentences) {
                const next = chunk ? `${chunk} ${sentence}` : sentence;
                if (next.length > 220 && chunk) {
                    grouped.push(chunk.trim());
                    chunk = sentence;
                } else {
                    chunk = next;
                }
            }
            if (chunk) grouped.push(chunk.trim());
            if (grouped.length > 1) return grouped.join('\n\n');
        }
    }
    return cleaned;
}

// ── Image compression + ImageKit upload (same as server.js's compressImageBuffer /
// uploadBufferToImageKit / uploadImageFromUrl — the CPU-heavy sharp work this whole
// script exists to move off Vercel) ───────────────────────────────────────────
async function compressImageBuffer(buffer) {
    try {
        return await sharp(buffer)
            .rotate()
            .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85, mozjpeg: true })
            .toBuffer();
    } catch (err) {
        console.warn('Image compression failed, uploading original buffer:', err.message);
        return buffer;
    }
}

async function uploadBufferToImageKit(buffer, fileName, folder) {
    if (!imagekit) return null;
    try {
        const compressed = await compressImageBuffer(buffer);
        const result = await imagekit.upload({ file: compressed, fileName, folder, useUniqueFileName: true });
        return result.url;
    } catch (err) {
        console.warn('ImageKit upload failed:', err.message);
        return null;
    }
}

async function uploadImageFromUrl(imageUrl) {
    if (!imageUrl || imageUrl.includes('res.cloudinary.com') || imageUrl.includes('ik.imagekit.io') || !imagekit) return imageUrl;
    try {
        const res = await fetch(imageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer': new URL(imageUrl).origin + '/',
                'Accept': 'image/*,*/*;q=0.8',
            },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok || !res.headers.get('content-type')?.startsWith('image')) return imageUrl;
        const buffer = Buffer.from(await res.arrayBuffer());
        const url = await uploadBufferToImageKit(buffer, `news-${Date.now()}.jpg`, 'news');
        return url || imageUrl;
    } catch (e) {
        console.warn('uploadImageFromUrl failed for', imageUrl, '—', e.message);
        return imageUrl;
    }
}

// ── RSS import (same logic as server.js's fetchAndImportRSS) ─────────────────
async function fetchAndImportRSS() {
    console.log('=== Fetching RSS feeds (parallel + batch) ===');
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    const feedResults = await Promise.allSettled(
        RSS_SOURCES.map(source =>
            Promise.race([
                rssParser.parseURL(source.url),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000))
            ])
            .then(feed => ({ source, items: (feed.items || []).slice(0, 20) }))
            .catch(err => { console.error(`✗ ${source.name}: ${err.message}`); return null; })
        )
    );

    const candidates = [];
    for (const r of feedResults) {
        if (r.status !== 'fulfilled' || !r.value) continue;
        const { source, items } = r.value;
        for (const item of items) {
            const link = item.link || item.guid;
            if (!link || !item.title) continue;
            if (isBlockedDomain(link)) continue;
            const rssSourceUrl = item.source?.$?.url || item.source?.url || '';
            if (rssSourceUrl && isBlockedDomain(rssSourceUrl)) continue;
            const itemDate = item.pubDate ? new Date(item.pubDate) : new Date();
            if (itemDate < threeDaysAgo) continue;

            let photo = null;
            if (item.enclosure?.url) photo = item.enclosure.url;
            else if (item['media:content']?.['$']?.url) photo = item['media:content']['$'].url;
            else if (item['media:thumbnail']?.['$']?.url) photo = item['media:thumbnail']['$'].url;

            const pubDate = itemDate;
            const rawContent = item.content || item.contentSnippet || item.summary || item.title || '';
            const finalContent = paragraphizeLegacyImportedText(rawContent).slice(0, 2000);
            if (plainBodyCharCount(finalContent) < MIN_IMPORTED_BODY_CHARS) continue;
            const full = isFullArticleContent(finalContent);

            const category = mapRssCategory(item.categories, item.title, source.defaultCategory, finalContent);
            candidates.push({
                heading:       item.title.trim(),
                headingNorm:   normalizeHeading(item.title),
                content:       finalContent,
                full,
                category,
                state:         category === 'rajya' ? detectState(item.title, finalContent) : null,
                author:        'JKS News Desk',
                photos:        photo ? [photo] : [],
                date:          pubDate,
                views:         0,
                rssLink:       link,
                rssSource:     source.name,
                formattedDate: pubDate.toLocaleDateString('hi-IN', { year: 'numeric', month: 'long', day: 'numeric' })
            });
        }
    }

    if (!candidates.length) { console.log('=== RSS import done: 0 candidates ==='); return { count: 0, stories: [] }; }

    const seenNorms = new Set(), seenLinks = new Set();
    const dedupedCandidates = candidates.filter(c => {
        if (seenNorms.has(c.headingNorm) || seenLinks.has(c.rssLink)) return false;
        seenNorms.add(c.headingNorm);
        seenLinks.add(c.rssLink);
        return true;
    });

    const allLinks = dedupedCandidates.map(c => c.rssLink);
    const allNorms = dedupedCandidates.map(c => c.headingNorm);
    const existing = await News.find(
        { $or: [{ rssLink: { $in: allLinks } }, { headingNorm: { $in: allNorms } }] },
        { rssLink: 1, headingNorm: 1 }
    ).lean();
    const existingLinks = new Set(existing.map(e => e.rssLink).filter(Boolean));
    const existingNorms = new Set(existing.map(e => e.headingNorm).filter(Boolean));

    const newDocs = dedupedCandidates.filter(c => !existingLinks.has(c.rssLink) && !existingNorms.has(c.headingNorm));
    if (!newDocs.length) { console.log('=== RSS import done: 0 new (all duplicates) ==='); return { count: 0, stories: [] }; }

    await Promise.allSettled(
        newDocs
            .filter(doc => doc.photos && doc.photos[0] && !doc.photos[0].includes('res.cloudinary.com') && !doc.photos[0].includes('ik.imagekit.io'))
            .map(async doc => {
                const uploaded = await uploadImageFromUrl(doc.photos[0]);
                if (uploaded !== doc.photos[0]) doc.photos = [uploaded];
            })
    );

    const batchSlugs = new Set();
    for (const doc of newDocs) {
        if (!doc.heading) continue;
        const base = generateSlug(doc.heading);
        let slug = base, counter = 1;
        while (batchSlugs.has(slug)) { counter++; slug = `${base}-${counter}`; }
        batchSlugs.add(slug);
        doc.slug = slug;
    }

    await News.insertMany(newDocs, { ordered: false }).catch(err => {
        if (err.code !== 11000) console.error('insertMany error:', err.message);
    });

    const stories = newDocs.map(d => ({ title: d.heading, slug: d.slug, source: d.rssSource }));
    console.log(`=== RSS import done: ${newDocs.length} new articles ===`);
    return { count: newDocs.length, stories };
}

// ── GNews API (same logic as server.js's fetchFromGNewsAPI) ──────────────────
// Free: 100 requests/day, 10 results per request, full article content provided
async function fetchFromGNewsAPI() {
    const apiKey = process.env.GNEWS_API_KEY;
    if (!apiKey) {
        console.log('⚠️ GNEWS_API_KEY not set, skipping GNews fetch');
        return { count: 0, stories: [] };
    }

    console.log('=== Fetching from GNews API ===');
    let totalImported = 0;
    const stories = [];
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    const requests = [
        { url: `https://gnews.io/api/v4/top-headlines?lang=hi&country=in&max=10&apikey=${apiKey}`, label: 'top-headlines' },
        { url: `https://gnews.io/api/v4/top-headlines?lang=hi&country=in&topic=politics&max=10&apikey=${apiKey}`, label: 'politics' },
        { url: `https://gnews.io/api/v4/top-headlines?lang=hi&country=in&topic=sports&max=10&apikey=${apiKey}`, label: 'sports' },
    ];

    for (const req of requests) {
        try {
            const response = await fetch(req.url);
            if (!response.ok) {
                console.error(`✗ GNews ${req.label}: HTTP ${response.status}`);
                continue;
            }
            const data = await response.json();
            if (!data.articles) {
                console.error(`✗ GNews ${req.label}: no articles field`);
                continue;
            }

            for (const item of data.articles) {
                if (!item.title || !item.url) continue;
                if (isBlockedDomain(item.url)) continue;

                const normHead = normalizeHeading(item.title);
                const exists = await News.findOne({
                    $or: [{ rssLink: item.url }, { headingNorm: normHead }]
                }).lean();
                if (exists) continue;

                const photo = (item.image && item.image.startsWith('http')) ? item.image : null;
                const itemPublished = item.publishedAt ? new Date(item.publishedAt) : new Date();
                if (itemPublished < threeDaysAgo) continue;
                const pubDate = itemPublished;
                const rawContent = item.content || item.description || '';
                const content = paragraphizeLegacyImportedText(rawContent);
                if (plainBodyCharCount(content) < MIN_IMPORTED_BODY_CHARS) continue;
                const full = isFullArticleContent(content);

                const category = mapRssCategory([], item.title, req.label === 'politics' ? 'rajniti' :
                    req.label === 'sports' ? 'khel' : req.label === 'entertainment' ? 'manoranjan' :
                    req.label === 'business' ? 'vyapar' : req.label === 'world' ? 'videsh' : 'desh', content);

                const newsData = {
                    heading:       item.title.trim(),
                    headingNorm:   normHead,
                    content,
                    full,
                    category,
                    state:         category === 'rajya' ? detectState(item.title, content) : null,
                    author:        'JKS News Desk',
                    photos:        photo ? [photo] : [],
                    date:          pubDate,
                    views:         0,
                    rssLink:       item.url,
                    rssSource:     'GNews',
                    formattedDate: pubDate.toLocaleDateString('hi-IN', { year: 'numeric', month: 'long', day: 'numeric' })
                };

                const saved = await new News(newsData).save();
                totalImported++;
                stories.push({ title: saved.heading, slug: saved.slug, source: 'GNews' });
            }
            console.log(`✓ GNews ${req.label}: processed`);
        } catch (err) {
            console.error(`✗ GNews ${req.label} failed:`, err.message);
        }
    }

    console.log(`=== GNews import done: ${totalImported} new articles ===`);
    return { count: totalImported, stories };
}

// ── Currents API (same logic as server.js's fetchFromCurrentsAPI) ────────────
// Free: 600 requests/day, full article content, good Hindi India coverage
async function fetchFromCurrentsAPI() {
    const apiKey = process.env.CURRENTS_API_KEY;
    if (!apiKey) {
        console.log('⚠️ CURRENTS_API_KEY not set, skipping Currents fetch');
        return { count: 0, stories: [] };
    }

    console.log('=== Fetching from Currents API ===');
    let totalImported = 0;
    const stories = [];
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    const requests = [
        { url: `https://api.currentsapi.services/v1/latest-news?language=hi&country=IN&apiKey=${apiKey}`, label: 'latest-hi' },
    ];

    for (const req of requests) {
        try {
            const response = await fetch(req.url);
            if (!response.ok) {
                console.error(`✗ Currents ${req.label}: HTTP ${response.status}`);
                continue;
            }
            const data = await response.json();
            if (data.status !== 'ok' || !data.news) {
                console.error(`✗ Currents ${req.label}: ${data.message || 'unknown error'}`);
                continue;
            }

            for (const item of data.news) {
                if (!item.title || !item.url) continue;
                if (isBlockedDomain(item.url)) continue;

                const normHead = normalizeHeading(item.title);
                const exists = await News.findOne({
                    $or: [{ rssLink: item.url }, { headingNorm: normHead }]
                }).lean();
                if (exists) continue;

                const photo = (item.image && item.image.startsWith('http') && item.image !== 'None') ? item.image : null;
                const itemPub = item.published ? new Date(item.published) : new Date();
                if (itemPub < threeDaysAgo) continue;
                const pubDate = itemPub;
                const content = paragraphizeLegacyImportedText(item.description || '');
                if (plainBodyCharCount(content) < MIN_IMPORTED_BODY_CHARS) continue;
                const full = isFullArticleContent(content);

                const category = mapRssCategory(item.category || [], item.title, 'desh', content);

                const newsData = {
                    heading:       item.title.trim(),
                    headingNorm:   normHead,
                    content,
                    full,
                    category,
                    state:         category === 'rajya' ? detectState(item.title, content) : null,
                    author:        'JKS News Desk',
                    photos:        photo ? [photo] : [],
                    date:          pubDate,
                    views:         0,
                    rssLink:       item.url,
                    rssSource:     'Currents',
                    formattedDate: pubDate.toLocaleDateString('hi-IN', { year: 'numeric', month: 'long', day: 'numeric' })
                };

                const saved = await new News(newsData).save();
                totalImported++;
                stories.push({ title: saved.heading, slug: saved.slug, source: 'Currents' });
            }
            console.log(`✓ Currents ${req.label}: processed`);
        } catch (err) {
            console.error(`✗ Currents ${req.label} failed:`, err.message);
        }
    }

    console.log(`=== Currents import done: ${totalImported} new articles ===`);
    return { count: totalImported, stories };
}

// ── NewsData.io import (same logic as server.js's fetchFromNewsDataAPI) ──────
async function fetchFromNewsDataAPI() {
    const apiKey = process.env.NEWSDATA_API_KEY;
    if (!apiKey) {
        console.log('⚠️ NEWSDATA_API_KEY not set, skipping NewsData.io fetch');
        return { count: 0, stories: [] };
    }

    console.log('=== Fetching from NewsData.io API ===');
    let totalImported = 0;
    const stories = [];

    const requests = [
        { url: `https://newsdata.io/api/1/news?apikey=${apiKey}&language=hi&country=in&category=top,politics,crime`, label: 'top/politics/crime' },
        { url: `https://newsdata.io/api/1/news?apikey=${apiKey}&language=hi&country=in&category=sports,entertainment,business`, label: 'sports/entertainment/business' },
        { url: `https://newsdata.io/api/1/news?apikey=${apiKey}&language=hi&country=in&category=world`, label: 'world' },
    ];

    for (const req of requests) {
        try {
            const response = await fetch(req.url);
            if (!response.ok) {
                console.error(`✗ NewsData.io ${req.label}: HTTP ${response.status}`);
                continue;
            }
            const data = await response.json();
            if (data.status !== 'success' || !data.results) {
                console.error(`✗ NewsData.io ${req.label}: ${data.message || 'unknown error'}`);
                continue;
            }

            for (const item of data.results) {
                if (!item.title || !item.link) continue;
                if (isBlockedDomain(item.link)) continue;

                const normHead = normalizeHeading(item.title);
                const exists = await News.findOne({
                    $or: [{ rssLink: item.link }, { headingNorm: normHead }]
                }).lean();
                if (exists) continue;

                const photo = (item.image_url && item.image_url.startsWith('http')) ? item.image_url : null;
                const itemDate = item.pubDate ? new Date(item.pubDate) : new Date();
                const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
                if (itemDate < threeDaysAgo) continue;
                const pubDate = itemDate;
                const isPaidOnly = typeof item.content === 'string' && item.content.toUpperCase().includes('ONLY AVAILABLE');
                const rawContent = isPaidOnly ? (item.description || '') : (item.content || item.description || '');
                const content = paragraphizeLegacyImportedText(rawContent);
                const full = isFullArticleContent(content);

                if (!content.trim() || plainBodyCharCount(content) < MIN_IMPORTED_BODY_CHARS) continue;

                const apiCat = (item.category && item.category[0]) ? item.category[0].toLowerCase() : 'top';
                let category = NEWSDATA_CATEGORY_MAP[apiCat] || 'desh';
                category = mapRssCategory(item.category || [], item.title, category, content);

                const newsData = {
                    heading:       item.title.trim(),
                    headingNorm:   normalizeHeading(item.title),
                    content:       content,
                    full,
                    category:      category,
                    state:         category === 'rajya' ? detectState(item.title, content) : null,
                    author:        'JKS News Desk',
                    photos:        photo ? [photo] : [],
                    date:          pubDate,
                    views:         0,
                    rssLink:       item.link,
                    rssSource:     'NewsData.io',
                    formattedDate: pubDate.toLocaleDateString('hi-IN', { year: 'numeric', month: 'long', day: 'numeric' })
                };

                const saved = await new News(newsData).save();
                totalImported++;
                stories.push({ title: saved.heading, slug: saved.slug, source: 'NewsData.io' });
            }
            console.log(`✓ NewsData.io ${req.label}: processed`);
        } catch (err) {
            console.error(`✗ NewsData.io ${req.label} failed:`, err.message);
        }
    }

    console.log(`=== NewsData.io import done: ${totalImported} new articles ===`);
    return { count: totalImported, stories };
}

// ── Email report (same Resend-based pattern as sync-pbshabd.js's sendReport) ─
async function sendReport({ imported, breakdown, stories, error }) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return;

    const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    const ok  = !error;
    const subject = `RSS/API Fetch | ${now}`;

    const rows = stories.map((s, i) => `
    <tr>
      <td style="padding:6px 12px;color:#6b7280">${i + 1}</td>
      <td style="padding:6px 12px">${s.title}</td>
      <td style="padding:6px 12px;color:#6b7280">${s.source}</td>
      <td style="padding:6px 12px"><a href="${SITE_URL}/news/${s.slug}" style="color:#1d4ed8">${SITE_URL}/news/${s.slug}</a></td>
    </tr>`).join('');

    const breakdownLine = breakdown
        ? `${breakdown.rss || 0} RSS + ${breakdown.newsdata || 0} NewsData.io + ${breakdown.gnews || 0} GNews + ${breakdown.currents || 0} Currents`
        : '';

    const html = `
<div style="font-family:sans-serif;max-width:860px;color:#111">
  <h2 style="color:#1d4ed8;margin-bottom:4px">RSS + API News Fetch</h2>
  <p style="color:#6b7280;margin-top:0">${now}</p>
  <p><strong>Status:</strong> ${ok ? '✅ Success' : '❌ Failed — ' + error.message}</p>
  <p><strong>Imported:</strong> ${imported} stories ${breakdownLine ? `(${breakdownLine})` : ''}</p>
  ${stories.length ? `
  <h3 style="border-bottom:1px solid #e5e7eb;padding-bottom:6px">Imported Stories</h3>
  <table border="1" cellspacing="0" style="border-collapse:collapse;font-size:13px;width:100%;border-color:#e5e7eb">
    <thead><tr style="background:#f8fafc">
      <th style="padding:6px 12px;text-align:left">#</th>
      <th style="padding:6px 12px;text-align:left">Title</th>
      <th style="padding:6px 12px;text-align:left">Source</th>
      <th style="padding:6px 12px;text-align:left">URL</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>` : '<p>No new stories imported.</p>'}
</div>`;

    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'RSS Fetch <onboarding@resend.dev>', to: ['mahmedk13@gmail.com'], subject, html }),
        signal: AbortSignal.timeout(10000),
    });
    if (res.ok) console.log('📧 Report sent to mahmedk13@gmail.com');
    else console.warn('⚠️ Email failed:', await res.text());
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI not set');

    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    console.log('✅ MongoDB connected');

    const rss      = await fetchAndImportRSS();
    const api      = await fetchFromNewsDataAPI();
    const gnews    = await fetchFromGNewsAPI();
    const currents = await fetchFromCurrentsAPI();

    const total = rss.count + api.count + gnews.count + currents.count;
    const allStories = [...rss.stories, ...api.stories, ...gnews.stories, ...currents.stories];
    console.log(`=== Done: ${total} total new articles (${rss.count} RSS + ${api.count} NewsData.io + ${gnews.count} GNews + ${currents.count} Currents) ===`);

    await sendReport({
        imported: total,
        breakdown: { rss: rss.count, newsdata: api.count, gnews: gnews.count, currents: currents.count },
        stories: allStories,
        error: null,
    });

    await mongoose.disconnect();
    process.exit(0);
}

main().catch(async err => {
    console.error('❌ Fatal error:', err);
    await sendReport({ imported: 0, breakdown: null, stories: [], error: err }).catch(() => {});
    process.exit(1);
});
