require('dotenv').config();
// Force IPv4 DNS resolution — fixes MongoDB Atlas SRV lookup on Windows
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
// Disable Node's "Happy Eyeballs" parallel connect (autoSelectFamily) — triggers a
// known Windows-only ERR_INTERNAL_ASSERTION crash in node:net on Node 18/20 when
// many outbound connections (Mongo, RSS/API fetches) race. See nodejs/node#48777.
const net = require('net');
if (typeof net.setDefaultAutoSelectFamily === 'function') {
    net.setDefaultAutoSelectFamily(false);
}
const express = require('express');
const compression = require('compression');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const multer = require('multer');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const News = require('./models/News').News;
const { generateSlug } = require('./models/News');
const Redirect = require('./models/Redirect');
const EPaper = require('./models/EPaper');
const Author = require('./models/Author');
const RSSParser = require('rss-parser');
const Groq = require('groq-sdk');
const mammoth = require('mammoth');
const AdmZip = require('adm-zip');

// ── LLM helpers ───────────────────────────────────────────────────────────────
// callMistral: now only used by generateDailyFact(). Editorial/itihas/weekly-roundup
//   moved to Groq (callGroq, openai/gpt-oss-120b) — see below.
//   Returns the raw JSON string from the model.
// Recursively flatten Mistral content that may arrive as nested array/object instead of a flat string
function flattenMistralContent(val) {
    if (typeof val === 'string') return val;
    if (Array.isArray(val)) return val.map(flattenMistralContent).filter(Boolean).join('\n\n');
    if (val && typeof val === 'object') return Object.values(val).map(flattenMistralContent).filter(Boolean).join('\n\n');
    return String(val || '');
}

async function callMistral(prompt, maxTokens = 1800, temperature = 0.7) {
    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`,
        },
        body: JSON.stringify({
            model: 'mistral-small-latest',
            messages: [{ role: 'user', content: prompt }],
            temperature,
            max_tokens: maxTokens,
            response_format: { type: 'json_object' },
        }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || JSON.stringify(data));
    return data.choices[0]?.message?.content || '{}';
}

// callGroq: used for short-burst batch tasks (shorts 400 tokens, explainers 350 tokens).
// Pass model='openai/gpt-oss-120b' for tasks needing higher accuracy.
function callGroq(prompt, maxTokens = 400, model = 'openai/gpt-oss-20b', temperature = 0.6) {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    return groq.chat.completions.create({
        model,
        messages:        [{ role: 'user', content: prompt }],
        temperature,
        max_tokens:      maxTokens,
        response_format: { type: 'json_object' },
        // GPT-OSS models spend part of max_tokens on internal reasoning before the
        // JSON answer — 'low' keeps that overhead small so short prompts don't get
        // truncated mid-JSON (json_validate_failed).
        reasoning_effort: 'low',
    }).then(c => c.choices[0]?.message?.content || '{}');
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Static legacy redirects (hardcoded for slugs deleted before the Redirect DB existed) ──
// Maps old garbled slug → destination URL.  Checked first in /news/:slug handler.
const LEGACY_REDIRECTS = {
    'bhri-baithk-mem-bhi-ge-kamgresi-8-vrishth-netaom-ne-de-die-istife-empi-mem-jbrds': '/',
    // Add more old garbled slugs here as needed:
    // 'old-broken-slug': '/',
};

// ── IP → City geolocation (in-memory cache, fire-and-forget on view) ──────────
const ipCityCache = new Map();
async function getCityFromIP(ip) {
    if (!ip) return null;
    const clean = ip.split(',')[0].trim().replace(/^::ffff:/, '');
    if (clean === '127.0.0.1' || clean === '::1' || clean.startsWith('192.168.') || clean.startsWith('10.') || clean.startsWith('172.')) return null;
    if (ipCityCache.has(clean)) return ipCityCache.get(clean);
    try {
        const r = await fetch(`http://ip-api.com/json/${clean}?fields=status,city,regionName`, { signal: AbortSignal.timeout(2500) });
        const d = await r.json();
        const city = (d.status === 'success' && d.city) ? d.city : null;
        ipCityCache.set(clean, city);
        if (ipCityCache.size > 5000) ipCityCache.delete(ipCityCache.keys().next().value);
        return city;
    } catch { return null; }
}

// ── RSS Configuration ─────────────────────────────────────────────────────────
const rssParser = new RSSParser({
    customFields: { item: ['media:content', 'media:thumbnail', 'enclosure', 'source'] },
    timeout: 10000
});

// ── HTML cleaner — strips tags AND decodes HTML entities ────────────────────────
// Normalize heading for cross-source duplicate detection
function normalizeHeading(heading) {
    return heading
        .toLowerCase()
        .replace(/[^\u0900-\u097fa-z0-9\s]/g, '') // keep Hindi + latin alphanum
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60); // compare first 60 chars
}

function cleanHtml(raw) {
    if (!raw) return '';
    return raw
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        // Preserve paragraph structure before stripping tags
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
        .replace(/[^\S\n]+/g, ' ')        // collapse horizontal whitespace, keep newlines
        .replace(/[ \t]*\n[ \t]*/g, '\n') // trim spaces around newlines
        .replace(/\n{3,}/g, '\n\n')       // max two consecutive newlines
        .trim();
}

function isFullArticleContent(content = '') {
    const text = cleanHtml(String(content || '')).trim();
    if (!text) return false;

    const normalizedText = text.replace(/\s+/g, ' ').trim();
    const paragraphs = text
        .split(/\n{2,}/)
        .map(part => part.trim())
        .filter(part => part.length > 40);

    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const charCount = normalizedText.length;
    return paragraphs.length >= 2 || wordCount >= 180 || charCount > 800;
}

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

async function repairLegacyImportedArticles({ dryRun = false, limit = 200 } = {}) {
    if (!isMongoDBConnected) {
        return { updated: 0, scanned: 0, dryRun, error: 'DB not ready' };
    }

    const docs = await News.find({
        isOriginal: { $ne: true },
        isPermanent: { $ne: true }
    }, { _id: 1, content: 1, full: 1 }).limit(limit).lean();

    let updated = 0;
    let scanned = docs.length;

    for (const article of docs) {
        const originalContent = String(article.content || '');
        const nextContent = paragraphizeLegacyImportedText(originalContent);
        const shouldBeFull = isFullArticleContent(nextContent || originalContent);

        if (!nextContent && !article.full && !shouldBeFull) continue;

        const patch = {};
        if (nextContent && nextContent !== originalContent) {
            patch.content = nextContent;
        }
        if (article.full !== shouldBeFull) {
            patch.full = shouldBeFull;
        }

        if (Object.keys(patch).length === 0) continue;
        if (dryRun) {
            updated += 1;
            continue;
        }

        await News.updateOne({ _id: article._id }, { $set: patch });
        invalidateNewsCache();
        updated += 1;
    }

    return { updated, scanned, dryRun };
}

function extractInlineArticlePhotoUrls(content = '') {
    if (!content || typeof content !== 'string') return [];

    const urls = [];
    const addUnique = (value) => {
        const match = String(value || '').trim().match(/https?:\/\/[^\s)]+/i);
        if (!match) return;
        const url = match[0].replace(/[\),.;]+$/, '');
        if (url && !urls.includes(url)) urls.push(url);
    };

    for (const match of content.matchAll(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi)) {
        addUnique(match[1]);
    }

    const lines = content.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const photoMatch = trimmed.match(/^(?:PHOTO|IMAGE)\s*:\s*(.+)$/i);
        if (!photoMatch) continue;
        const value = photoMatch[1].trim();
        const firstPart = value.split('|')[0].trim();
        addUnique(firstPart);
    }

    return urls;
}

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizeAuthorName(value = '') {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function findAuthorMatch(authorProfiles, articleAuthor) {
    if (!articleAuthor || !Array.isArray(authorProfiles)) return null;
    const normalizedTarget = normalizeAuthorName(articleAuthor);
    if (!normalizedTarget) return null;
    // Exact match only (name or slug) — partial/substring matching previously let a
    // short byline accidentally resolve to an unrelated author's profile/bio.
    return authorProfiles.find((author) => {
        if (!author || !author.name) return false;
        const profileName = normalizeAuthorName(author.name);
        const slugName = normalizeAuthorName((author.slug || '').replace(/-/g, ' '));
        return profileName === normalizedTarget || slugName === normalizedTarget;
    }) || null;
}

function isPbShabdArticle(item) {
    const src = (item.rssSource || '').trim();
    const auth = (item.author || '').trim();
    return src === 'PB SHABD' || auth === 'PB SHABD';
}

function isRealAuthorArticle(item, authorNameSet) {
    if (!item || !item.author || !authorNameSet || !authorNameSet.size) return false;
    return authorNameSet.has(normalizeAuthorName(item.author));
}

// Normalized set of real Author-profile names, for the "real author" priority tier below.
async function getAuthorNameSet() {
    try {
        const authors = await Author.find({}, { name: 1 }).lean();
        return new Set(authors.map(a => normalizeAuthorName(a.name)).filter(Boolean));
    } catch (_) {
        return new Set();
    }
}

// Re-ranks a date-desc sorted article list for category "Top 10" display. Never
// removes articles — only reorders. Priority tiers, highest first:
//   1. isPermanent === true, and/or article.author matches a real Author profile
//      (from `authorNameSet`) — always kept in front, in their original order.
//   2. PB SHABD — but capped at `maxRatio` of the first `windowSize` slots; any
//      overflow is pushed to just after the window instead of being dropped.
//   3. Articles tagged `full: true`.
//   4. Everything else.
function enforcePbShabdCap(list, authorNameSet, windowSize = 10, maxRatio = 0.5) {
    if (!Array.isArray(list) || list.length <= 1) return list;

    const isProtected = (item) => item && (item.isPermanent === true || isRealAuthorArticle(item, authorNameSet));
    const protectedQueue = list.filter(isProtected);
    const rest = list.filter(item => !isProtected(item));
    if (!rest.length) return list;

    const pbQueue = rest.filter(isPbShabdArticle);
    const fullQueue = rest.filter(item => !isPbShabdArticle(item) && item && item.full === true);
    const otherQueue = rest.filter(item => !isPbShabdArticle(item) && !(item && item.full === true));

    const maxPbInWindow = Math.floor(windowSize * maxRatio);
    const result = [];
    let pbIdx = 0, fullIdx = 0, otherIdx = 0, pbUsedInWindow = 0;

    while (pbIdx < pbQueue.length || fullIdx < fullQueue.length || otherIdx < otherQueue.length) {
        const inWindow = (protectedQueue.length + result.length) < windowSize;
        const pbCapped = inWindow && pbUsedInWindow >= maxPbInWindow;

        if (pbIdx < pbQueue.length && !pbCapped) {
            result.push(pbQueue[pbIdx++]);
            if (inWindow) pbUsedInWindow++;
        } else if (fullIdx < fullQueue.length) {
            result.push(fullQueue[fullIdx++]);
        } else if (otherIdx < otherQueue.length) {
            result.push(otherQueue[otherIdx++]);
        } else if (pbIdx < pbQueue.length) {
            result.push(pbQueue[pbIdx++]); // cap reached but nothing else left to fill with
        }
    }
    return protectedQueue.concat(result);
}

// Mirrors category.html's client-side optimizeCloudinaryUrl/stripEmbeddedMediaFromPreview/timeAgo
// so server-rendered category cards look identical once client JS hydrates.
function optimizeCloudinaryUrlForCard(url) {
    if (!url || !url.includes('cloudinary')) return url;
    return url.replace('/upload/', '/upload/q_auto,f_auto,w_400/');
}

function stripEmbeddedMediaFromPreview(text) {
    if (!text) return '';
    return String(text)
        .replace(/\r/g, '')
        .split('\n')
        .filter(line => !/^(?:PHOTO|IMAGE|VIDEO|YOUTUBE|X|TWITTER|TWEET)\s*:/i.test(line.trim()))
        .join('\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/https?:\/\/[^\s]+/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
}

function timeAgoLabel(dateVal) {
    if (!dateVal) return '';
    let diff = Math.floor((Date.now() - new Date(dateVal).getTime()) / 1000);
    if (diff < 0) diff += 19800; // correct IST stored as UTC (legacy PB SHABD articles)
    if (diff < 0) return '';
    if (diff < 60) return 'अभी-अभी';
    if (diff < 3600) return Math.floor(diff / 60) + ' मिनट पहले';
    if (diff < 86400) return Math.floor(diff / 3600) + ' घंटे पहले';
    if (diff < 172800) return 'कल';
    return Math.floor(diff / 86400) + ' दिन पहले';
}

function renderCategoryCardSSR(a, cat) {
    const url = a.slug ? `/news/${a.slug}` : `/news-detail.html?id=${a.id}`;
    const img = a.photos && a.photos.length ? optimizeCloudinaryUrlForCard(a.photos[0]) : null;
    const previewText = stripEmbeddedMediaFromPreview(a.content || '');
    const heading = escapeHtml(a.heading || 'समाचार');
    return `<a href="${url}" class="news-card">
            ${img
                ? `<img src="${escapeHtml(img)}" alt="${heading}" loading="lazy">`
                : `<div class="news-card-placeholder">NEWS</div>`}
            <div class="news-card-body">
                <div style="display:flex;gap:.35rem;align-items:center;flex-wrap:wrap;margin-bottom:.2rem;">
                    <span class="news-card-cat" style="color:${cat.color}">${escapeHtml(cat.name)}</span>
                    ${isPbShabdArticle(a) ? '<span class="nc-pb-badge">📡 PB</span>' : ''}
                </div>
                <p class="news-card-title">${heading}</p>
                ${previewText ? `<p class="news-card-preview">${escapeHtml(previewText)}</p>` : ''}
                <span class="news-card-date" data-date="${escapeHtml(String(a.date || ''))}">⏰ ${timeAgoLabel(a.date)}</span>
            </div>
        </a>`;
}

function renderArticleBodyForCrawler(text) {
    if (!text) return '<p>समाचार का विवरण उपलब्ध नहीं है।</p>';

    const escapeRegExp = (value) => String(value).replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');

    const protectInlineHtml = (value) => {
        const tagMap = new Map();
        const protectedValue = String(value || '').replace(/<(\/?)((?:b|strong|i|em|u|a|span))\b([^>]*)>/gi, (match, slash, tag, attrs) => {
            const token = `__SAFE_INLINE_TAG_${tagMap.size}__`;
            tagMap.set(token, `${slash ? '</' : '<'}${tag}${attrs || ''}>`);
            return token;
        });
        return { protectedValue, tagMap };
    };

    const restoreInlineHtml = (value, tagMap) => {
        let output = value;
        for (const [token, tagValue] of tagMap.entries()) {
            output = output.replace(new RegExp(escapeRegExp(token), 'g'), tagValue);
        }
        return output;
    };

    const formatInlineText = (value) => {
        const { protectedValue, tagMap } = protectInlineHtml(value);
        return restoreInlineHtml(
            escapeHtml(String(protectedValue || ''))
                .replace(/&lt;(\/?)((?:b|strong|i|em|u|a|span))\b([^&]*?)&gt;/gi, '<$1$2$3>')
                .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                .replace(/\*([^*\n]+?)\*/g, '<em>$1</em>'),
            tagMap
        );
    };

    const makeMediaHtml = (line) => {
        const trimmed = (line || '').trim();
        if (!trimmed) return '';

        const extractUrl = (value) => {
            if (!value) return '';
            const directMatch = value.match(/https?:\/\/[^\s)]+/i);
            if (directMatch) return directMatch[0].replace(/\)$/, '').replace(/\]$/, '');
            const markdownMatch = value.match(/\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/i);
            return markdownMatch ? markdownMatch[1] : '';
        };

        const standardImage = trimmed.match(/^!\[(.*?)\]\((https?:\/\/[^\s)]+)\)$/i);
        if (standardImage) {
            const caption = standardImage[1].trim() || 'फोटो';
            return `<figure class="embedded-media"><img src="${escapeHtml(standardImage[2])}" alt="${escapeHtml(caption)}"><figcaption>${escapeHtml(caption)}</figcaption></figure>`;
        }

        const photoMatch = trimmed.match(/^(?:PHOTO|IMAGE)\s*:\s*(.+)$/i);
        if (photoMatch) {
            const value = photoMatch[1].trim();
            const url = extractUrl(value.split('|')[0].trim());
            const caption = (value.includes('|') ? value.split('|').slice(1).join('|').trim() : 'फोटो') || 'फोटो';
            if (url) {
                return `<figure class="embedded-media"><img src="${escapeHtml(url)}" alt="${escapeHtml(caption || 'फोटो')}"><figcaption>${escapeHtml(caption || 'फोटो')}</figcaption></figure>`;
            }
        }

        const videoMatch = trimmed.match(/^(?:VIDEO|YOUTUBE)\s*:\s*(.+)$/i);
        if (videoMatch) {
            const value = videoMatch[1].trim();
            const url = extractUrl(value.split('|')[0].trim());
            const caption = (value.includes('|') ? value.split('|').slice(1).join('|').trim() : '').trim();
            if (url) {
                const ytMatch = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{11})/i);
                const youtubeId = ytMatch ? ytMatch[1] : null;
                if (youtubeId) {
                    return `<figure class="embedded-media"><div class="video-embed"><iframe src="https://www.youtube.com/embed/${youtubeId}?rel=0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div>${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}</figure>`;
                }
                return `<figure class="embedded-media"><div class="video-embed"><iframe src="${escapeHtml(url)}" allowfullscreen></iframe></div>${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}</figure>`;
            }
        }

        const tweetMatch = trimmed.match(/^(?:X|TWITTER)\s*:\s*(.+)$/i);
        if (tweetMatch) {
            const value = tweetMatch[1].trim();
            const url = extractUrl(value.split('|')[0].trim());
            const caption = (value.includes('|') ? value.split('|').slice(1).join('|').trim() : 'X पोस्ट').trim() || 'X पोस्ट';
            if (url) {
                return `<figure class="embedded-media tweet-embed"><blockquote class="twitter-tweet"><a href="${escapeHtml(url)}">${escapeHtml(caption)}</a></blockquote></figure>`;
            }
        }

        return '';
    };

    const { protectedValue: safeText, tagMap } = protectInlineHtml(String(text));
    const source = safeText
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/?(?:p|div|li|h[1-6]|blockquote|ul|ol|table|tr|td|th|figure|figcaption|section|article|header|footer)[^>]*>/gi, '\n')
        .replace(/<\/?(?:iframe|object|embed|svg|math|form|input|button|select|textarea|video|audio|source)[^>]*>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\r/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");

    let restoredSource = source;
    for (const [token, tagValue] of tagMap.entries()) {
        restoredSource = restoredSource.replace(new RegExp(escapeRegExp(token), 'g'), tagValue);
    }
    const paragraphized = restoredSource
        .replace(/([।!?])\s+(?=[A-Za-z\u0900-\u097F])/g, '$1\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    let lines = paragraphized.split(/\n{2,}|\n/).map(part => part.trim()).filter(Boolean);

    // Merge overly-short consecutive plain-text lines into readable paragraphs.
    // The sentence-boundary preprocessing above can turn one real paragraph into
    // one line per sentence — without this merge, every sentence would render as
    // its own <p>. Structural lines (headings/lists/media) are left untouched.
    const isStructuralLine = (l) =>
        /^##\s|^###\s|^-\s|^\d+\.\s/.test(l) ||
        /^(?:PHOTO|IMAGE|VIDEO|YOUTUBE|X|TWITTER|TWEET)\s*:/i.test(l) ||
        /^!\[.*?\]\(https?:\/\//i.test(l);

    const mergedLines = [];
    let currentParagraph = '';
    for (const line of lines) {
        if (isStructuralLine(line)) {
            if (currentParagraph) { mergedLines.push(currentParagraph); currentParagraph = ''; }
            mergedLines.push(line);
            continue;
        }
        const candidate = currentParagraph ? `${currentParagraph} ${line}` : line;
        if (candidate.length > 320 && currentParagraph) {
            mergedLines.push(currentParagraph);
            currentParagraph = line;
        } else {
            currentParagraph = candidate;
        }
    }
    if (currentParagraph) mergedLines.push(currentParagraph);
    lines = mergedLines;

    if (!lines.length) return '<p>समाचार का विवरण उपलब्ध नहीं है।</p>';

    let html = '';
    let inList = false;
    let inOl = false;

    const closeList = () => {
        if (inList) {
            html += '</ul>';
            inList = false;
        }
        if (inOl) {
            html += '</ol>';
            inOl = false;
        }
    };

    for (const rawLine of lines) {
        const line = rawLine.trim();
        const mediaHtml = makeMediaHtml(line);
        if (mediaHtml) {
            closeList();
            html += mediaHtml;
            continue;
        }

        if (line.startsWith('## ')) {
            closeList();
            html += `<h2 class="article-h2">${escapeHtml(line.slice(3))}</h2>`;
            continue;
        }

        if (line.startsWith('### ')) {
            closeList();
            html += `<h3 class="article-h3">${escapeHtml(line.slice(4))}</h3>`;
            continue;
        }

        if (/^-\s+/.test(line)) {
            if (inOl) {
                html += '</ol>';
                inOl = false;
            }
            if (!inList) {
                html += '<ul class="article-list">';
                inList = true;
            }
            html += `<li>${formatInlineText(line.replace(/^-\s+/, ''))}</li>`;
            continue;
        }

        if (/^\d+\.\s+/.test(line)) {
            if (inList) {
                html += '</ul>';
                inList = false;
            }
            if (!inOl) {
                html += '<ol class="article-list">';
                inOl = true;
            }
            html += `<li>${formatInlineText(line.replace(/^\d+\.\s+/, ''))}</li>`;
            continue;
        }

        closeList();
        html += `<p>${formatInlineText(line)}</p>`;
    }

    closeList();
    return html;
}

const RSS_SOURCES = [
    // General news
    { name: 'BBC Hindi',         url: 'https://feeds.bbci.co.uk/hindi/rss.xml',                           defaultCategory: 'desh',       fullContent: false },
    { name: 'Aaj Tak',           url: 'https://feeds.feedburner.com/aajtaklive',                           defaultCategory: 'desh',       fullContent: false },
    { name: 'ABP Live',          url: 'https://www.abplive.com/news/india/feed',                           defaultCategory: 'desh',       fullContent: true  },
    { name: 'Amar Ujala',        url: 'https://www.amarujala.com/rss/india-news.xml',                      defaultCategory: 'desh',       fullContent: false },
    { name: 'News18 Hindi',      url: 'https://hindi.news18.com/commonfeeds/v1/hin/rss/nation.xml',        defaultCategory: 'desh',       fullContent: false },
    { name: 'Dainik Bhaskar',    url: 'https://www.bhaskar.com/rss-feed/1061/',                            defaultCategory: 'desh',       fullContent: false },
    { name: 'Google News Hindi', url: 'https://news.google.com/rss?hl=hi&gl=IN&ceid=IN:hi',                defaultCategory: 'desh',       fullContent: false },
    // Category-specific
    { name: 'ABP Live Khel',     url: 'https://www.abplive.com/sports/feed',                              defaultCategory: 'khel',       fullContent: true  },
    { name: 'BBC Hindi Khel',    url: 'https://feeds.bbci.co.uk/hindi/sport/rss.xml',                     defaultCategory: 'khel',       fullContent: false },
    { name: 'ABP Live Film',     url: 'https://www.abplive.com/entertainment/feed',                       defaultCategory: 'manoranjan', fullContent: true  },
    { name: 'ABP Live Vyapar',   url: 'https://www.abplive.com/business/feed',                            defaultCategory: 'vyapar',     fullContent: true  },
    { name: 'ABP Live Apradh',   url: 'https://www.abplive.com/crime/feed',                               defaultCategory: 'crime',      fullContent: true  },
    { name: 'BBC Hindi Videsh',  url: 'https://feeds.bbci.co.uk/hindi/world/rss.xml',                     defaultCategory: 'videsh',     fullContent: false },
    { name: 'ABP Live Rajniti',  url: 'https://www.abplive.com/politics/feed',                            defaultCategory: 'rajniti',    fullContent: true  },
    // MP/Bhopal
    { name: 'ABP Live MP-CG',    url: 'https://www.abplive.com/states/madhya-pradesh-chhattisgarh/feed',  defaultCategory: 'rajya',      fullContent: true  },
    { name: 'News18 Hindi MP',   url: 'https://hindi.news18.com/commonfeeds/v1/hin/rss/states/madhya-pradesh.xml', defaultCategory: 'rajya', fullContent: false },
    { name: 'Patrika Bhopal',    url: 'https://cms.patrika.com/googlefeed/blog/location/bhopal-news',     defaultCategory: 'bhopal',     fullContent: false },
];

// Domains to skip across all import sources (RSS, NewsData, GNews, Currents)
const BLOCKED_DOMAINS = [
    'khulasaonline.com',
];
const isBlockedDomain = (url) => url && BLOCKED_DOMAINS.some(d => url.includes(d));

const CATEGORY_MAP = {
    // KHEL - Sports (checked first — sports events are universally specific)
    'खेल': 'khel', 'क्रिकेट': 'khel', 'आईपीएल': 'khel', 'फुटबॉल': 'khel', 'हॉकी': 'khel',
    'बैडमिंटन': 'khel', 'कुश्ती': 'khel', 'कबड्डी': 'khel', 'टेनिस': 'khel', 'मैच': 'khel',
    'sports': 'khel', 'sport': 'khel', 'cricket': 'khel', 'football': 'khel', 'ipl': 'khel',
    'hockey': 'khel', 'tennis': 'khel', 'wrestling': 'khel', 'badminton': 'khel', 'kabaddi': 'khel',
    'olympics': 'khel', 'cwg': 'khel', 'fifa': 'khel', 'bcci': 'khel',
    // MANORANJAN - Entertainment
    'मनोरंजन': 'manoranjan', 'बॉलीवुड': 'manoranjan', 'फिल्म': 'manoranjan', 'सिनेमा': 'manoranjan',
    'ओटीटी': 'manoranjan', 'वेब सीरीज': 'manoranjan', 'अभिनेता': 'manoranjan', 'अभिनेत्री': 'manoranjan',
    'entertainment': 'manoranjan', 'bollywood': 'manoranjan', 'cinema': 'manoranjan',
    'movie': 'manoranjan', 'film': 'manoranjan', 'actress': 'manoranjan', 'actor': 'manoranjan',
    'ott': 'manoranjan', 'web series': 'manoranjan', 'music': 'manoranjan', 'hollywood': 'manoranjan',
    // VYAPAR - Business
    'व्यापार': 'vyapar', 'बाजार': 'vyapar', 'शेयर': 'vyapar', 'अर्थव्यवस्था': 'vyapar',
    'रुपया': 'vyapar', 'बजट': 'vyapar', 'सेंसेक्स': 'vyapar', 'निफ्टी': 'vyapar',
    'business': 'vyapar', 'economy': 'vyapar', 'finance': 'vyapar', 'market': 'vyapar',
    'sensex': 'vyapar', 'nifty': 'vyapar', 'stock': 'vyapar', 'share market': 'vyapar',
    'rbi': 'vyapar', 'budget': 'vyapar', 'gdp': 'vyapar', 'inflation': 'vyapar',
    // BHOPAL - Bhopal city (checked BEFORE rajniti/crime so local Bhopal news isn't stolen by topic keywords)
    'भोपाल': 'bhopal', 'bhopal': 'bhopal',
    // RAJYA - MP districts/cities + other states (checked BEFORE rajniti/crime for same reason)
    'मध्य प्रदेश': 'rajya', 'मध्यप्रदेश': 'rajya', 'madhya pradesh': 'rajya',
    'इंदौर': 'rajya', 'ग्वालियर': 'rajya', 'जबलपुर': 'rajya', 'उज्जैन': 'rajya',
    'रीवा': 'rajya', 'सागर': 'rajya', 'सतना': 'rajya', 'रतलाम': 'rajya',
    'खंडवा': 'rajya', 'खरगोन': 'rajya', 'बालाघाट': 'rajya', 'छिंदवाड़ा': 'rajya',
    'होशंगाबाद': 'rajya', 'नर्मदापुरम': 'rajya', 'विदिशा': 'rajya', 'रायसेन': 'rajya',
    'सीहोर': 'rajya', 'गुना': 'rajya', 'शिवपुरी': 'rajya', 'भिंड': 'rajya',
    'मुरैना': 'rajya', 'दतिया': 'rajya', 'देवास': 'rajya', 'मंदसौर': 'rajya',
    'नीमच': 'rajya', 'पन्ना': 'rajya', 'मंडला': 'rajya', 'छतरपुर': 'rajya',
    'टीकमगढ़': 'rajya', 'दमोह': 'rajya', 'सीधी': 'rajya', 'सिंगरौली': 'rajya',
    'शहडोल': 'rajya', 'अनूपुर': 'rajya', 'उमरिया': 'rajya', 'बुरहानपुर': 'rajya',
    'झाबुआ': 'rajya', 'अलीराजपुर': 'rajya', 'बड़वानी': 'rajya', 'धार': 'rajya',
    'indore': 'rajya', 'gwalior': 'rajya', 'jabalpur': 'rajya', 'ujjain': 'rajya',
    'rewa': 'rajya', 'sagar': 'rajya', 'satna': 'rajya', 'ratlam': 'rajya',
    'khandwa': 'rajya', 'khargone': 'rajya', 'balaghat': 'rajya', 'chhindwara': 'rajya',
    // Other States
    'उत्तर प्रदेश': 'rajya', 'बिहार': 'rajya', 'राजस्थान': 'rajya', 'महाराष्ट्र': 'rajya',
    'पंजाब': 'rajya', 'हरियाणा': 'rajya', 'गुजरात': 'rajya', 'छत्तीसगढ़': 'rajya',
    'झारखंड': 'rajya', 'उत्तराखंड': 'rajya', 'हिमाचल': 'rajya', 'केरल': 'rajya',
    'uttar pradesh': 'rajya', 'bihar': 'rajya', 'rajasthan': 'rajya', 'maharashtra': 'rajya',
    'punjab': 'rajya', 'haryana': 'rajya', 'gujarat': 'rajya', 'chhattisgarh': 'rajya',
    // RAJNITI - Politics (national level — after geo keywords so state-level news stays in bhopal/rajya)
    'राजनीति': 'rajniti', 'चुनाव': 'rajniti', 'विधानसभा': 'rajniti', 'लोकसभा': 'rajniti',
    'राज्यसभा': 'rajniti', 'संसद': 'rajniti', 'भाजपा': 'rajniti', 'कांग्रेस': 'rajniti',
    'politics': 'rajniti', 'election': 'rajniti', 'political': 'rajniti', 'parliament': 'rajniti',
    'bjp': 'rajniti', 'congress': 'rajniti', 'aap': 'rajniti', 'modi': 'rajniti', 'rahul': 'rajniti',
    'cm ': 'rajniti', 'pm ': 'rajniti', 'minister': 'rajniti', 'मंत्री': 'rajniti',
    // VIDESH - International (checked before crime so foreign crime goes to videsh, not crime)
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
    // CRIME - Apradh (after videsh so international crime stays in videsh)
    'अपराध': 'crime', 'हत्या': 'crime', 'चोरी': 'crime', 'डकैती': 'crime',
    'दुष्कर्म': 'crime', 'गिरफ्तार': 'crime', 'बलात्कार': 'crime', 'हादसा': 'crime',
    'शव': 'crime', 'लाश': 'crime', 'कांड': 'crime', 'वारदात': 'crime',
    'हैवानियत': 'crime', 'सनसनी': 'crime', 'अपहरण': 'crime', 'दुर्घटना': 'crime',
    'फायरिंग': 'crime', 'गोलीबारी': 'crime', 'बम': 'crime', 'विस्फोट': 'crime',
    'मारपीट': 'crime', 'लूट': 'crime', 'जेल': 'crime', 'आरोपी': 'crime',
    'पीड़ित': 'crime', 'मृत': 'crime', 'घायल': 'crime', 'ठग': 'crime', 'नशे': 'crime',
    'crime': 'crime', 'murder': 'crime', 'rape': 'crime', 'theft': 'crime',
    'robbery': 'crime', 'arrested': 'crime', 'police': 'crime', 'accident': 'crime',
    'fraud': 'crime', 'scam': 'crime', 'घोटाला': 'crime', 'धोखाधड़ी': 'crime',
    'blast': 'crime', 'firing': 'crime', 'kidnap': 'crime', 'dead body': 'crime',
    // ITIHAS - History
    'इतिहास': 'itihas', 'पुरातत्व': 'itihas', 'विरासत': 'itihas', 'प्राचीन': 'itihas',
    'history': 'itihas', 'heritage': 'itihas', 'ancient': 'itihas', 'historical': 'itihas',
    // DESH - National (broad fallback, keep last)
    'देश': 'desh', 'भारत': 'desh', 'india': 'desh', 'nation': 'desh', 'national': 'desh',
    'आस्था': 'desh', 'धर्म': 'desh', 'हिंदू': 'desh', 'मुस्लिम': 'desh', 'मंदिर': 'desh',
    'मस्जिद': 'desh', 'धार्मिक': 'desh', 'विवाद': 'desh', 'विरोध': 'desh', 'controversy': 'desh',
};

function mapRssCategory(rssCategories, title, defaultCategory) {
    // 1. Scan title first — title keywords are more specific than feed category tags
    if (title) {
        const lowerTitle = title.toLowerCase();
        for (const [key, value] of Object.entries(CATEGORY_MAP)) {
            if (lowerTitle.includes(key)) return value;
        }
    }
    // 2. Check RSS category tags as fallback
    for (const cat of (rssCategories || [])) {
        const lower = (cat || '').toLowerCase().trim();
        for (const [key, value] of Object.entries(CATEGORY_MAP)) {
            if (lower.includes(key)) return value;
        }
    }
    return defaultCategory;
}

// Delete all Cloudinary images for an article's photos array
async function deleteCloudinaryPhotos(photos) {
    if (!photos || !photos.length) return;
    for (const photo of photos) {
        if (photo && photo.includes('cloudinary')) {
            // Extract public_id: last two path segments without extension
            // e.g. https://res.cloudinary.com/xxx/image/upload/v123/folder/public_id.jpg → folder/public_id
            const publicId = photo.split('/upload/')[1]?.replace(/^v\d+\//, '').replace(/\.[^/.]+$/, '');
            if (publicId) {
                await cloudinary.uploader.destroy(publicId).catch(err =>
                    console.log('Cloudinary delete failed for', publicId, err.message)
                );
            }
        }
    }
}

async function deleteOldNews() {
    if (!isMongoDBConnected) return;
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    try {
        // Fetch articles to delete so we can clean up their Cloudinary images
        const toDelete = await News.find(
            { date: { $lt: threeDaysAgo }, isPermanent: { $ne: true } },
            { _id: 1, photos: 1, slug: 1 }
        ).lean();

        if (!toDelete.length) return;

        // Delete Cloudinary images first
        for (const article of toDelete) {
            await deleteCloudinaryPhotos(article.photos);
        }

        // Save slugs to Redirect collection before deleting so 301 redirects work
        const slugsToSave = toDelete.map(a => a.slug).filter(Boolean);
        if (slugsToSave.length) {
            await Redirect.bulkWrite(
                slugsToSave.map(slug => ({
                    updateOne: { filter: { from: slug }, update: { $setOnInsert: { from: slug, to: '/' } }, upsert: true }
                }))
            ).catch(() => {});  // non-fatal
        }

        const ids = toDelete.map(a => a._id);
        const result = await News.deleteMany({ _id: { $in: ids } });
        if (result.deletedCount > 0) {
            console.log(`🗑️ Deleted ${result.deletedCount} articles older than 3 days (+ Cloudinary images)`);
        }
    } catch (err) {
        console.error('Error deleting old news:', err.message);
    }
}

async function fetchAndImportRSS() {
    console.log('=== Fetching RSS feeds (parallel + batch) ===');
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    // 1. Fetch all sources simultaneously (6s timeout each)
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

    // 2. Collect all candidate items from all feeds
    const candidates = [];
    for (const r of feedResults) {
        if (r.status !== 'fulfilled' || !r.value) continue;
        const { source, items } = r.value;
        for (const item of items) {
            const link = item.link || item.guid;
            if (!link || !item.title) continue;
            if (isBlockedDomain(link)) continue;
            // Also block articles aggregated via Google News where the original publisher is blocked
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
            if (finalContent.length < 80) continue;
            const full = isFullArticleContent(finalContent);

            candidates.push({
                heading:       item.title.trim(),
                headingNorm:   normalizeHeading(item.title),
                content:       finalContent,
                full,
                category:      mapRssCategory(item.categories, item.title, source.defaultCategory),
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

    if (!candidates.length) { console.log('=== RSS import done: 0 candidates ==='); await deleteOldNews(); return 0; }

    // 3a. Deduplicate within this batch (same story from multiple sources in same run)
    const seenNorms = new Set(), seenLinks = new Set();
    const dedupedCandidates = candidates.filter(c => {
        if (seenNorms.has(c.headingNorm) || seenLinks.has(c.rssLink)) return false;
        seenNorms.add(c.headingNorm);
        seenLinks.add(c.rssLink);
        return true;
    });

    // 3b. One batch duplicate check against existing DB records
    const allLinks = dedupedCandidates.map(c => c.rssLink);
    const allNorms = dedupedCandidates.map(c => c.headingNorm);
    let existingLinks = new Set(), existingNorms = new Set();
    if (isMongoDBConnected) {
        const existing = await News.find(
            { $or: [{ rssLink: { $in: allLinks } }, { headingNorm: { $in: allNorms } }] },
            { rssLink: 1, headingNorm: 1 }
        ).lean();
        existingLinks = new Set(existing.map(e => e.rssLink).filter(Boolean));
        existingNorms = new Set(existing.map(e => e.headingNorm).filter(Boolean));
    }

    const newDocs = dedupedCandidates.filter(c => !existingLinks.has(c.rssLink) && !existingNorms.has(c.headingNorm));
    if (!newDocs.length) { console.log('=== RSS import done: 0 new (all duplicates) ==='); await deleteOldNews(); return 0; }

    // 4a. Upload images to Cloudinary in parallel (bypass CDN hotlink 401 for OG tags)
    await Promise.allSettled(
        newDocs
            .filter(doc => doc.photos && doc.photos[0] && !doc.photos[0].includes('res.cloudinary.com'))
            .map(async doc => {
                const uploaded = await uploadImageFromUrl(doc.photos[0]);
                if (uploaded !== doc.photos[0]) doc.photos = [uploaded];
            })
    );

    // 4b. Generate slugs before insertMany (pre-save hook doesn't run with insertMany)
    const batchSlugs = new Set();
    for (const doc of newDocs) {
        if (!doc.heading) continue;
        const base = generateSlug(doc.heading);
        let slug = base, counter = 1;
        while (batchSlugs.has(slug)) { counter++; slug = `${base}-${counter}`; }
        batchSlugs.add(slug);
        doc.slug = slug;
    }

    // 4c. One batch insert for all new articles
    if (isMongoDBConnected) {
        await News.insertMany(newDocs, { ordered: false }).catch(err => {
            // ordered:false continues on duplicate key errors; log but don't throw
            if (err.code !== 11000) console.error('insertMany error:', err.message);
        });
    } else if (isDevelopment) {
        const allNews = readNewsData();
        newDocs.forEach(d => allNews.push({ ...d, id: Date.now().toString() + Math.random().toString(36).substr(2, 5) }));
        writeNewsData(allNews);
    }

    console.log(`=== RSS import done: ${newDocs.length} new articles ===`);
    await deleteOldNews();
    return newDocs.length;
}

// ── NewsData.io API Configuration ─────────────────────────────────────────────
// Category mapping from NewsData.io categories → our categories
const NEWSDATA_CATEGORY_MAP = {
    'top':           'desh',
    'politics':      'rajniti',
    'sports':        'khel',
    'entertainment': 'manoranjan',
    'business':      'vyapar',
    'crime':         'crime',
    'world':         'videsh',
    'technology':    'desh',
    'health':        'desh',
    'science':       'desh',
    'education':     'desh',
};

// NewsData.io free: 200 requests/day, 10 results per request
// We call 3 category requests per run = 3 of our 200 daily limit
async function fetchFromNewsDataAPI() {
    const apiKey = process.env.NEWSDATA_API_KEY;
    if (!apiKey) {
        console.log('⚠️ NEWSDATA_API_KEY not set, skipping NewsData.io fetch');
        return 0;
    }

    console.log('=== Fetching from NewsData.io API ===');
    let totalImported = 0;

    // Fetch Hindi + India news across key categories
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

                // Duplicate check (by URL or normalized heading)
                if (isMongoDBConnected) {
                    const normHead = normalizeHeading(item.title);
                    const exists = await News.findOne({
                        $or: [{ rssLink: item.link }, { headingNorm: normHead }]
                    }).lean();
                    if (exists) continue;
                }

                const photo = (item.image_url && item.image_url.startsWith('http')) ? item.image_url : null;
                // Skip articles older than 3 days (prevents old articles appearing as fresh)
                const itemDate = item.pubDate ? new Date(item.pubDate) : new Date();
                const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
                if (itemDate < threeDaysAgo) continue;
                const pubDate = itemDate; // use the source's real published date (avoid artificial freshening)
                // NewsData.io free plan returns "ONLY AVAILABLE IN PAID PLANS" in content field
                const isPaidOnly = typeof item.content === 'string' && item.content.toUpperCase().includes('ONLY AVAILABLE');
                const rawContent = isPaidOnly ? (item.description || '') : (item.content || item.description || '');
                const content = paragraphizeLegacyImportedText(rawContent);
                const full = isFullArticleContent(content);

                // Skip articles with no usable content
                if (!content.trim()) continue;

                // Map category
                const apiCat = (item.category && item.category[0]) ? item.category[0].toLowerCase() : 'top';
                let category = NEWSDATA_CATEGORY_MAP[apiCat] || 'desh';
                // Also run title scan to refine category
                category = mapRssCategory(item.category || [], item.title, category);

                const newsData = {
                    heading:       item.title.trim(),
                    headingNorm:   normalizeHeading(item.title),
                    content:       content,
                    full,
                    category:      category,
                    author:        'JKS News Desk',
                    photos:        photo ? [photo] : [],
                    date:          pubDate,
                    views:         0,
                    rssLink:       item.link,
                    rssSource:     'NewsData.io',
                    formattedDate: pubDate.toLocaleDateString('hi-IN', { year: 'numeric', month: 'long', day: 'numeric' })
                };

                if (isMongoDBConnected) {
                    await new News(newsData).save();
                    totalImported++;
                }
            }
            console.log(`✓ NewsData.io ${req.label}: processed`);
        } catch (err) {
            console.error(`✗ NewsData.io ${req.label} failed:`, err.message);
        }
    }

    console.log(`=== NewsData.io import done: ${totalImported} new articles ===`);
    return totalImported;
}

// ── GNews API ─────────────────────────────────────────────────────────────────
// Free: 100 requests/day, 10 results per request, full article content provided
async function fetchFromGNewsAPI() {
    const apiKey = process.env.GNEWS_API_KEY;
    if (!apiKey) {
        console.log('⚠️ GNEWS_API_KEY not set, skipping GNews fetch');
        return 0;
    }

    console.log('=== Fetching from GNews API ===');
    let totalImported = 0;

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

                if (isMongoDBConnected) {
                    const normHead = normalizeHeading(item.title);
                    const exists = await News.findOne({
                        $or: [{ rssLink: item.url }, { headingNorm: normHead }]
                    }).lean();
                    if (exists) continue;
                }

                const photo = (item.image && item.image.startsWith('http')) ? item.image : null;
                // Skip articles older than 3 days
                const itemPublished = item.publishedAt ? new Date(item.publishedAt) : new Date();
                if (itemPublished < new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)) continue;
                const pubDate = itemPublished; // use the source's real published date (avoid artificial freshening)
                // GNews provides full article content in item.content
                const rawContent = item.content || item.description || '';
                const content = paragraphizeLegacyImportedText(rawContent);
                const full = isFullArticleContent(content);

                const category = mapRssCategory([], item.title, req.label === 'politics' ? 'rajniti' :
                    req.label === 'sports' ? 'khel' : req.label === 'entertainment' ? 'manoranjan' :
                    req.label === 'business' ? 'vyapar' : req.label === 'world' ? 'videsh' : 'desh');

                const newsData = {
                    heading:       item.title.trim(),
                    headingNorm:   normalizeHeading(item.title),
                    content,
                    full,
                    category,
                    author:        'JKS News Desk',
                    photos:        photo ? [photo] : [],
                    date:          pubDate,
                    views:         0,
                    rssLink:       item.url,
                    rssSource:     'GNews',
                    formattedDate: pubDate.toLocaleDateString('hi-IN', { year: 'numeric', month: 'long', day: 'numeric' })
                };

                if (isMongoDBConnected) {
                    await new News(newsData).save();
                    totalImported++;
                }
            }
            console.log(`✓ GNews ${req.label}: processed`);
        } catch (err) {
            console.error(`✗ GNews ${req.label} failed:`, err.message);
        }
    }

    console.log(`=== GNews import done: ${totalImported} new articles ===`);
    return totalImported;
}

// ── Currents API ──────────────────────────────────────────────────────────────
// Free: 600 requests/day, full article content, good Hindi India coverage
async function fetchFromCurrentsAPI() {
    const apiKey = process.env.CURRENTS_API_KEY;
    if (!apiKey) {
        console.log('⚠️ CURRENTS_API_KEY not set, skipping Currents fetch');
        return 0;
    }

    console.log('=== Fetching from Currents API ===');
    let totalImported = 0;

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

                if (isMongoDBConnected) {
                    const normHead = normalizeHeading(item.title);
                    const exists = await News.findOne({
                        $or: [{ rssLink: item.url }, { headingNorm: normHead }]
                    }).lean();
                    if (exists) continue;
                }

                const photo = (item.image && item.image.startsWith('http') && item.image !== 'None') ? item.image : null;
                // Skip articles older than 3 days
                const itemPub = item.published ? new Date(item.published) : new Date();
                if (itemPub < new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)) continue;
                const pubDate = itemPub; // use the source's real published date (avoid artificial freshening)
                // Currents provides full article description
                const content = paragraphizeLegacyImportedText(item.description || '');
                const full = isFullArticleContent(content);

                const category = mapRssCategory(item.category || [], item.title, 'desh');

                const newsData = {
                    heading:       item.title.trim(),
                    headingNorm:   normalizeHeading(item.title),
                    content,
                    full,
                    category,
                    author:        'JKS News Desk',
                    photos:        photo ? [photo] : [],
                    date:          pubDate,
                    views:         0,
                    rssLink:       item.url,
                    rssSource:     'Currents',
                    formattedDate: pubDate.toLocaleDateString('hi-IN', { year: 'numeric', month: 'long', day: 'numeric' })
                };

                if (isMongoDBConnected) {
                    await new News(newsData).save();
                    totalImported++;
                }
            }
            console.log(`✓ Currents ${req.label}: processed`);
        } catch (err) {
            console.error(`✗ Currents ${req.label} failed:`, err.message);
        }
    }

    console.log(`=== Currents import done: ${totalImported} new articles ===`);
    return totalImported;
}

async function fetchAllNews() {
    // GNews (100 req/day) and Currents (600 req/day) are NOT called here
    // to preserve daily limits — use the admin buttons to fetch them manually.
    const rssCount  = await fetchAndImportRSS();
    const apiCount  = await fetchFromNewsDataAPI();
    return rssCount + apiCount;
}

// ── Groq: Generate one original daily editorial article ───────────────────────
// Topics are evergreen opinion/analysis — NOT breaking news.
// The model has no real-time data so we must NOT ask it to report specific
// current events, dates, or statistics it could hallucinate.
const DAILY_ARTICLE_TOPICS = [
    {
        category: 'desh',
        hint: 'भारत में शिक्षा व्यवस्था की चुनौतियाँ और सुधार की आवश्यकता',
        angle: 'शिक्षा की गुणवत्ता, सरकारी स्कूलों की स्थिति, डिजिटल शिक्षा'
    },
    {
        category: 'rajniti',
        hint: 'भारतीय लोकतंत्र और जनता की भागीदारी का महत्व',
        angle: 'मतदान, जनप्रतिनिधित्व, राजनीतिक जागरूकता'
    },
    {
        category: 'bhopal',
        hint: 'भोपाल के विकास में नागरिकों की भूमिका और जिम्मेदारी',
        angle: 'स्वच्छता, यातायात, बुनियादी सुविधाएं, शहरी विकास'
    },
    {
        category: 'vyapar',
        hint: 'भारत में बेरोजगारी की समस्या और युवाओं के लिए अवसर',
        angle: 'स्वरोजगार, कौशल विकास, स्टार्टअप संस्कृति'
    },
    {
        category: 'videsh',
        hint: 'भारत की सॉफ्ट पावर और वैश्विक छवि',
        angle: 'योग, संस्कृति, प्रवासी भारतीय, अंतरराष्ट्रीय संबंध'
    },
    {
        category: 'desh',
        hint: 'भारत में स्वास्थ्य सेवाओं की वर्तमान स्थिति और सुधार',
        angle: 'सरकारी अस्पताल, ग्रामीण स्वास्थ्य, स्वास्थ्य बीमा'
    },
    {
        category: 'rajniti',
        hint: 'मीडिया और पत्रकारिता की जिम्मेदारी आज के दौर में',
        angle: 'फेक न्यूज, पत्रकार की भूमिका, जिम्मेदार पत्रकारिता'
    },
    {
        category: 'desh',
        hint: 'भारत में महिला सशक्तिकरण: उपलब्धियाँ और शेष चुनौतियाँ',
        angle: 'शिक्षा, रोजगार, सुरक्षा, कानूनी अधिकार'
    },
    {
        category: 'vyapar',
        hint: 'डिजिटल इंडिया और ग्रामीण अर्थव्यवस्था पर इसका प्रभाव',
        angle: 'UPI, ई-कॉमर्स, इंटरनेट कनेक्टिविटी, किसान'
    },
    {
        category: 'desh',
        hint: 'भारत में पर्यावरण संरक्षण: समस्याएं और समाधान',
        angle: 'प्रदूषण, जलवायु परिवर्तन, नवीकरणीय ऊर्जा, वनीकरण'
    },
    {
        category: 'rajniti',
        hint: 'भारत में भ्रष्टाचार: कारण, प्रभाव और निवारण के उपाय',
        angle: 'पारदर्शिता, जवाबदेही, RTI, डिजिटल गवर्नेंस'
    },
    {
        category: 'bhopal',
        hint: 'मध्यप्रदेश की सांस्कृतिक विरासत और पर्यटन की संभावनाएं',
        angle: 'ऐतिहासिक स्थल, जनजातीय संस्कृति, हस्तशिल्प, पर्यटन'
    },
    {
        category: 'desh',
        hint: 'भारत में कृषि संकट: किसानों की समस्याएं और आधुनिक समाधान',
        angle: 'MSP, सिंचाई, आधुनिक तकनीक, किसान कल्याण'
    },
    {
        category: 'videsh',
        hint: 'बदलते विश्व में भारत की विदेश नीति और रणनीतिक महत्व',
        angle: 'पड़ोसी देश, व्यापार संतुलन, कूटनीति, राष्ट्रीय सुरक्षा'
    },
];

async function generateDailyArticle() {
    if (!process.env.MISTRAL_API_KEY) {
        console.log('⚠️ MISTRAL_API_KEY not set, skipping daily article generation');
        return null;
    }
    if (!isMongoDBConnected) return null;

    // Pick a rotating topic based on day of week
    const topic = DAILY_ARTICLE_TOPICS[new Date().getDay() % DAILY_ARTICLE_TOPICS.length];
    const prompt = `तुम "वॉयस ऑफ क्रांति" के वरिष्ठ संपादक मारूफ अहमद खान हो।

तुम्हें नीचे दिए गए विषय पर एक **संपादकीय विश्लेषण लेख** (editorial opinion piece) लिखना है।

विषय: ${topic.hint}
कोण: ${topic.angle}

⚠️ अत्यंत महत्वपूर्ण निर्देश:
- यह एक विश्लेषण/राय लेख है — कोई काल्पनिक घटना, अपुष्ट आँकड़ा या नाम मत गढ़ो
- केवल स्थापित तथ्यों और सामान्य ज्ञान पर आधारित विश्लेषण
- कोई भी अश्लील, हिंसक, नफरती, साम्प्रदायिक सामग्री नहीं
- शुद्ध और सरल हिंदी, दोहराव बिल्कुल नहीं

लेख की **संरचना** (यह ढाँचा अनिवार्य है):
- परिचय पैराग्राफ: विषय का संक्षिप्त परिचय (80+ शब्द)
## [पहला उपशीर्षक — मुख्य समस्या या पृष्ठभूमि]
- विस्तृत विवरण (2 पैराग्राफ, 150+ शब्द)
## [दूसरा उपशीर्षक — कारण/विश्लेषण]
- विश्लेषण (1-2 पैराग्राफ, 120+ शब्द)
## [तीसरा उपशीर्षक — सुझाव या निष्कर्ष]
- सुझाव और निष्कर्ष (1 पैराग्राफ, 80+ शब्द)
## अक्सर पूछे जाने वाले सवाल
**प्रश्न:** [इस विषय से जुड़ा पहला सामान्य सवाल]?
**उत्तर:** [2-3 वाक्यों में जवाब]
**प्रश्न:** [दूसरा सवाल]?
**उत्तर:** [2-3 वाक्यों में जवाब]

कुल 650-800 शब्द। ## चिह्न हूबहू इसी तरह रखो।

नीचे दिए JSON फॉर्मेट में जवाब दो। केवल JSON, कुछ और नहीं:
{
  "heading": "लेख का शीर्षक (प्रश्न या statement style, 70-120 chars)",
  "content": "पूरा संरचित लेख (## subheadings, **प्रश्न:**/**उत्तर:** FAQs सहित; पैराग्राफ \\n\\n से अलग करें)"
}`;

    try {
        const raw = await callMistral(prompt, 3000, 0.7);
        const parsed = JSON.parse(raw);

        if (!parsed.heading || !parsed.content) {
            console.error('✗ Daily article: empty response from Mistral');
            return null;
        }
        parsed.content = flattenMistralContent(parsed.content);

        const safetyBlocklist = ['sex', 'porn', 'nude', 'bomb', 'terror', 'kill', 'rape', 'jihad'];
        const combined = (parsed.heading + ' ' + parsed.content).toLowerCase();
        if (safetyBlocklist.some(w => combined.includes(w))) {
            console.error('✗ Daily article: failed safety check, skipping');
            return null;
        }

        // Repetition check — reject if any paragraph repeats verbatim
        const paragraphs = parsed.content.split(/\n+/).filter(p => p.trim().length > 30);
        const unique = new Set(paragraphs.map(p => p.trim()));
        if (unique.size < paragraphs.length * 0.8) {
            console.error('✗ Daily article: too much repetition, skipping');
            return null;
        }

        const article = new News({
            heading:  parsed.heading.trim().slice(0, 200),
            content:  parsed.content.trim(),
            category: topic.category,
            author:   'Maroof Ahmed Khan',
            isPermanent: true,
            isOriginal: true,
            photos:   [],
            date:     new Date()
        });

        await article.save();
        console.log(`✓ Daily article published: "${parsed.heading.slice(0, 60)}..."`);
        return article;
    } catch (err) {
        console.error('✗ Daily article generation failed:', err.message);
        return null;
    }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Groq: Generate "Aaj Ka Itihas" — Today in History ────────────────────────
// TWO-PASS approach:
//   Pass 1 — Fact extraction: Ask the model to list ONLY facts it knows with
//             absolute certainty for this exact day+month, as structured JSON.
//             This forces explicit commitment before prose generation.
//   Pass 2 — Article writing: Write the Hindi article using ONLY the verified
//             facts from pass 1. If pass 1 returns empty lists, write a short
//             generic article without inventing specific events.
// Stored with isAajKaItihas:true + isPermanent:true so it is never auto-deleted.
async function generateAajKaItihas() {
    if (!process.env.MISTRAL_API_KEY) {
        console.log('⚠️ MISTRAL_API_KEY not set, skipping Aaj Ka Itihas');
        return null;
    }
    if (!isMongoDBConnected) return null;

    // Deduplicate: skip if already generated for today
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay   = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const existing = await News.findOne({ isAajKaItihas: true, date: { $gte: startOfDay, $lt: endOfDay } }).lean();
    if (existing) {
        console.log('✓ Aaj Ka Itihas already generated for today');
        return existing;
    }

    const HINDI_MONTHS = ['जनवरी','फ़रवरी','मार्च','अप्रैल','मई','जून','जुलाई','अगस्त','सितम्बर','अक्टूबर','नवम्बर','दिसम्बर'];
    const EN_MONTHS    = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const day       = today.getDate();
    const monthName = HINDI_MONTHS[today.getMonth()];
    const monthEN   = EN_MONTHS[today.getMonth()];

    // ── PASS 1: Fact verification ──────────────────────────────────────────────
    // Ask for a structured list of events the model knows with certainty.
    // Using English for this pass to reduce translation ambiguity.
    const verifyPrompt = `You are a strict fact-checker. For the calendar date ${day} ${monthEN}, list ONLY historical events, births, and deaths that you know with ABSOLUTE CERTAINTY happened on EXACTLY this day and month.

CRITICAL RULES — violations cause misinformation:
1. EXACT DATE ONLY: You must know both the day (${day}) AND the month (${monthEN}), not just the year.
2. NO EVENT CONFUSION: If a person died on this date, say "died" — do NOT say they "became president" or "took office". These are different events.
3. NO HALLUCINATED BATTLES: Only include military events if you know the EXACT location name, exact date, and confirmed outcome. Do NOT invent or confuse battle locations.
4. NO BIRTH MONTH CONFUSION: A person born on ${day} December is NOT born on ${day} ${monthEN}. Only include births where you are certain of both day AND month.
5. RETURN EMPTY ARRAYS if you have fewer than 2 high-certainty facts — do not fill space with guesses.

Return ONLY valid JSON (no markdown, no explanation):
{
  "events": [
    {"year": 1816, "fact_en": "Argentina declared independence from Spain", "fact_hi": "अर्जेंटीना ने स्पेन से स्वतंत्रता घोषित की"}
  ],
  "deaths": [
    {"year": 1850, "name": "Zachary Taylor", "name_hi": "ज़ैकरी टेलर", "role_hi": "अमेरिका के 12वें राष्ट्रपति, जिनका कार्यकाल के दौरान निधन हुआ"}
  ],
  "births": []
}`;

    let verifiedFacts = { events: [], deaths: [], births: [] };
    try {
        const rawVerify = await callMistral(verifyPrompt, 800, 0.1);
        // Strip markdown fences if present
        const cleanVerify = rawVerify.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/,'').trim();
        const parsed = JSON.parse(cleanVerify);
        verifiedFacts.events = Array.isArray(parsed.events) ? parsed.events : [];
        verifiedFacts.deaths = Array.isArray(parsed.deaths) ? parsed.deaths : [];
        verifiedFacts.births = Array.isArray(parsed.births) ? parsed.births : [];
        console.log(`✓ Itihas pass-1: ${verifiedFacts.events.length} events, ${verifiedFacts.births.length} births, ${verifiedFacts.deaths.length} deaths`);
    } catch (err) {
        console.warn('⚠️ Itihas pass-1 failed, proceeding with empty facts:', err.message);
    }

    // Build a Hindi summary of verified facts to feed into pass 2
    const factLines = [];
    for (const e of verifiedFacts.events) {
        factLines.push(`- ${e.year}: ${e.fact_hi || e.fact_en}`);
    }
    for (const d of verifiedFacts.deaths) {
        factLines.push(`- ${d.year}: ${d.name_hi || d.name} का निधन हुआ — ${d.role_hi || ''}`);
    }
    for (const b of verifiedFacts.births) {
        factLines.push(`- ${b.year}: ${b.name_hi || b.name} का जन्म हुआ — ${b.role_hi || ''}`);
    }
    const verifiedBlock = factLines.length > 0
        ? `नीचे दिए गए सत्यापित तथ्यों का उपयोग करो (केवल इन्हीं को article में शामिल करो):\n${factLines.join('\n')}`
        : `इस तारीख के लिए कोई निश्चित तथ्य उपलब्ध नहीं है। इस स्थिति में, इतिहास के सामान्य महत्व पर एक विचारशील लेख लिखो — कोई विशिष्ट घटना या व्यक्ति का नाम मत गढ़ो।`;

    // ── PASS 2: Article writing ────────────────────────────────────────────────
    const writePrompt = `तुम "वॉयस ऑफ क्रांति" के इतिहास स्तम्भकार हो।

आज की तारीख: ${day} ${monthName}

${verifiedBlock}

🔴 अनिवार्य नियम:
- ऊपर दिए गए सत्यापित तथ्यों के अलावा कोई नई घटना, व्यक्ति या वर्ष मत जोड़ो।
- कोई भी तथ्य मत बदलो — "निधन हुआ" को "राष्ट्रपति बने" मत लिखो।
- यदि सत्यापित सूची खाली है, तो इतिहास के महत्व पर सामान्य चिंतन लिखो।

लेख की **संरचना** (अनिवार्य):
- परिचय पैराग्राफ: इस तारीख का ऐतिहासिक महत्व (60+ शब्द)
## ${day} ${monthName} की प्रमुख ऐतिहासिक घटनाएं
- [वर्ष]: [घटना, 1-2 वाक्य] (केवल सत्यापित घटनाएं, section खाली छोड़ना बेहतर है)
## इस दिन जन्मे / दिवंगत हुए महान व्यक्तित्व
- [नाम] ([वर्ष]) — [योगदान, 1 वाक्य] (केवल सत्यापित जन्म/निधन)
## इतिहास से सीख
- निष्कर्ष पैराग्राफ (60+ शब्द)
## आज का ऐतिहासिक तथ्य
- [तथ्य 1] [एक वाक्य — केवल सत्यापित सूची से]
- [तथ्य 2] [एक वाक्य — केवल सत्यापित सूची से]
- [तथ्य 3] [एक वाक्य — केवल सत्यापित सूची से]

⚠️ [तथ्य N] prefix अनिवार्य है। ## और - bullet हूबहू रखो। कुल 480-620 शब्द।

JSON फॉर्मेट में जवाब दो। केवल JSON:
{
  "heading": "आज का इतिहास: ${day} ${monthName} — [एक आकर्षक उपशीर्षक]",
  "content": "पूरा संरचित लेख (पैराग्राफ \\n\\n से अलग करें)"
}`;

    try {
        const raw = await callMistral(writePrompt, 2000, 0.2);
        const cleanRaw = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/,'').trim();
        const parsed = JSON.parse(cleanRaw);

        if (!parsed.heading || !parsed.content) {
            console.error('✗ Aaj Ka Itihas: empty response from pass-2');
            return null;
        }

        // Safety check
        const safetyBlocklist = ['sex', 'porn', 'nude', 'bomb', 'terror', 'kill', 'rape', 'jihad'];
        const combined = (parsed.heading + ' ' + parsed.content).toLowerCase();
        if (safetyBlocklist.some(w => combined.includes(w))) {
            console.error('✗ Aaj Ka Itihas: failed safety check, skipping');
            return null;
        }

        const article = new News({
            heading:       parsed.heading.trim().slice(0, 220),
            content:       parsed.content.trim(),
            category:      'itihas',
            author:        'Maroof Ahmed Khan',
            isPermanent:   true,
            isOriginal:    true,
            isAajKaItihas: true,
            photos:        [],
            date:          new Date(),
            formattedDate: today.toLocaleDateString('hi-IN', { year: 'numeric', month: 'long', day: 'numeric' })
        });

        await article.save();
        console.log(`✓ Aaj Ka Itihas published: "${parsed.heading.slice(0, 60)}..."`);
        return article;
    } catch (err) {
        console.error('✗ Aaj Ka Itihas generation failed:', err.message);
        return null;
    }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Groq: Generate explainers (पृष्ठभूमि) for recent articles ─────────────────
// Runs in background, adds a 90-120 word Hindi background context to each article
// that doesn't have one yet. Skips Aaj Ka Itihas (self-contained historical pieces).
async function generateExplainers() {
    if (!process.env.GROQ_API_KEY) return;
    if (!isMongoDBConnected) return;

    const articles = await News.find(
        { 'explainer.generatedAt': null, isAajKaItihas: { $ne: true } },
        { _id: 1, heading: 1, content: 1 }
    ).sort({ date: -1 }).limit(20).lean();

    if (!articles.length) return;
    console.log(`=== Generating explainers for ${articles.length} articles ===`);
    let count = 0;

    for (const article of articles) {
        try {
            const snippet = (article.content || '').replace(/<[^>]+>/g, '').slice(0, 400);
            const prompt = `तुम एक हिंदी समाचार संपादक हो।
नीचे दी गई खबर के लिए 90-110 शब्दों में एक "पृष्ठभूमि" (background context) लिखो।

खबर: ${article.heading}
विवरण: ${snippet}

"पृष्ठभूमि" में शामिल करो:
1. यह विषय क्या है? (1-2 वाक्य)
2. यह खबर क्यों महत्वपूर्ण है? (1-2 वाक्य)
3. इसका आम जनता पर क्या असर हो सकता है? (1-2 वाक्य)

सरल हिंदी, 90-110 शब्द। कोई शीर्षक मत लगाओ, सीधे लिखो।
JSON: { "explainer": "पूरा पाठ" }`;

            const raw    = await callGroq(prompt, 350);
            const parsed = JSON.parse(raw);

            if (parsed.explainer && parsed.explainer.length > 40) {
                await News.updateOne(
                    { _id: article._id },
                    { $set: { 'explainer.text': parsed.explainer.slice(0, 500), 'explainer.generatedAt': new Date() } }
                );
                count++;
            }
            await new Promise(r => setTimeout(r, 350));
        } catch (err) {
            console.error(`✗ Explainer failed for ${article._id}:`, err.message);
        }
    }
    console.log(`=== Explainers done: ${count}/${articles.length} ===`);
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Groq: Generate "वॉयस ऑफ क्रांति का मत" for crime articles ───────────────
// Runs after explainers. For each crime article without a kaMat, generates
// a 60-80 word Hindi moral/civic lesson relevant to the type of crime,
// urging constructive action over violence (e.g., divorce over spousal murder,
// legal recourse over mob justice). Stored in article.kaMat.text.
async function generateKaMat() {
    if (!process.env.GROQ_API_KEY) return;
    if (!isMongoDBConnected) return;

    const articles = await News.find(
        { category: 'crime', 'kaMat.generatedAt': null },
        { _id: 1, heading: 1, content: 1 }
    ).sort({ date: -1 }).limit(15).lean();

    if (!articles.length) return;
    let count = 0;

    for (const article of articles) {
        try {
            const contentSnippet = (article.content || '').replace(/<[^>]+>/g, '').slice(0, 400);
            const prompt = `तुम "वॉयस ऑफ क्रांति" के संपादकीय दल के सदस्य हो। नीचे दी गई अपराध संबंधी खबर पढ़ो और 60-80 शब्दों में एक नैतिक/सामाजिक संदेश लिखो।

खबर: "${article.heading}"
विवरण: "${contentSnippet}"

संदेश लिखते समय:
- खबर में हुई हिंसा या अपराध के विकल्प सुझाओ (जैसे: घरेलू विवाद → तलाक/कानूनी रास्ता, वित्तीय विवाद → अदालत, गुस्सा → संयम)
- समाज को सकारात्मक दिशा दो — उपदेश नहीं, प्रेरणा दो
- पीड़ित के प्रति संवेदना रखो
- किसी जाति/धर्म/राजनीतिक दल का नाम न लो

केवल JSON में जवाब दो:
{"text": "60-80 शब्दों का संदेश"}`;

            const raw = await callGroq(prompt, 200, 'openai/gpt-oss-20b', 0.5);
            const clean = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
            const parsed = JSON.parse(clean);
            if (parsed.text && parsed.text.length > 20) {
                await News.updateOne(
                    { _id: article._id },
                    { $set: { 'kaMat.text': parsed.text.trim(), 'kaMat.generatedAt': new Date() } }
                );
                count++;
            }
        } catch (err) {
            if (err.message && err.message.includes('429')) {
                console.warn('⚠️ Ka Mat: rate limit hit, stopping batch early');
                break; // stop this batch, retry next scheduled run
            }
            // Other errors: skip this article silently
        }
        // 3s gap between requests to stay within 6000 TPM limit
        await new Promise(r => setTimeout(r, 3000));
    }
    if (count > 0) console.log(`✓ Ka Mat generated for ${count} crime articles`);
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Groq: Generate weekly roundup (साप्ताहिक समीक्षा) ─────────────────────────
// Runs on Sundays. Uses last 7 days' article headings as context so the model
// can reference real news themes without fabricating facts.
async function generateWeeklyRoundup() {
    if (!process.env.GROQ_API_KEY) return null;
    if (!isMongoDBConnected) return null;

    // Only run on Sundays (day=0)
    if (new Date().getDay() !== 0) return null;

    // Deduplicate: skip if roundup already published this week
    const startOfWeek = new Date();
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    const exists = await News.findOne({
        isOriginal: true,
        heading:    { $regex: /^साप्ताहिक समीक्षा:/i },
        date:       { $gte: startOfWeek }
    }).lean();
    if (exists) { console.log('✓ Weekly roundup already published this week'); return exists; }

    // Gather last 7 days' headlines grouped by category
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const articles = await News.find(
        { date: { $gte: since }, isOriginal: { $ne: true } },
        { heading: 1, category: 1 }
    ).sort({ date: -1 }).limit(60).lean();

    const byCategory = {};
    for (const a of articles) {
        if (!byCategory[a.category]) byCategory[a.category] = [];
        if (byCategory[a.category].length < 5) byCategory[a.category].push(a.heading);
    }

    const HINDI_CAT = { desh: 'देश', videsh: 'विदेश', rajya: 'राज्य', bhopal: 'भोपाल', crime: 'अपराध', khel: 'खेल', rajniti: 'राजनीति', manoranjan: 'मनोरंजन', vyapar: 'व्यापार', itihas: 'इतिहास' };
    const contextLines = Object.entries(byCategory)
        .map(([cat, heads]) => `${HINDI_CAT[cat] || cat}: ${heads.join(' | ')}`)
        .join('\n');

    if (!contextLines.trim()) { console.log('⚠️ No articles this week for roundup'); return null; }

    const today = new Date();
    const weekEnd   = today.toLocaleDateString('hi-IN', { day: 'numeric', month: 'long' });
    const weekStart = new Date(since).toLocaleDateString('hi-IN', { day: 'numeric', month: 'long' });

    const prompt = `तुम "वॉयस ऑफ क्रांति" के वरिष्ठ संपादक हो।
इस सप्ताह (${weekStart} – ${weekEnd}) की प्रमुख खबरों के ये शीर्षक हैं:

${contextLines}

⚠️ महत्वपूर्ण निर्देश:
- इन शीर्षकों में जो विषय हैं उनका विश्लेषण करो — कोई नई जानकारी मत जोड़ो
- संपादकीय दृष्टिकोण दो: इस सप्ताह की बड़ी थीम क्या रहीं?
- शुद्ध, सरल हिंदी; कोई साम्प्रदायिक/विवादास्पद सामग्री नहीं

लेख की **संरचना** (अनिवार्य):
- परिचय: इस सप्ताह की सबसे महत्वपूर्ण थीम (80+ शब्द)
## इस सप्ताह की बड़ी खबरें
- [विषय/श्रेणी]: [संक्षिप्त वर्णन और महत्व — 1-2 वाक्य] (यही format, 4-6 bullet points)
## विश्लेषण: क्यों महत्वपूर्ण हैं ये खबरें?
- [विश्लेषण बिंदु — 1-2 वाक्य] (यही format, 3-4 bullet points)
## आगे क्या?
- अगले सप्ताह क्या देखना होगा (1 पैराग्राफ, 60+ शब्द)
## इस सप्ताह की मुख्य बातें
- [बुलेट पॉइंट 1]
- [बुलेट पॉइंट 2]
- [बुलेट पॉइंट 3]
- [बुलेट पॉइंट 4]

## चिह्न और - bullet हूबहू इसी तरह रखो। कुल 550-700 शब्द।

JSON: { "heading": "साप्ताहिक समीक्षा: ${weekStart}–${weekEnd} — [एक आकर्षक उपशीर्षक]", "content": "पूरा संरचित लेख (पैराग्राफ \\n\\n से अलग करें)" }`;

    try {
        const raw    = await callGroq(prompt, 3000, 'openai/gpt-oss-120b', 0.7);
        const parsed = JSON.parse(raw);
        if (!parsed.heading || !parsed.content) { console.error('✗ Weekly roundup: empty Groq response'); return null; }
        parsed.content = flattenMistralContent(parsed.content);

        const safetyBlocklist = ['sex', 'porn', 'nude', 'bomb', 'terror', 'kill', 'rape', 'jihad'];
        if (safetyBlocklist.some(w => (parsed.heading + parsed.content).toLowerCase().includes(w))) {
            console.error('✗ Weekly roundup: failed safety check'); return null;
        }

        const article = new News({
            heading:       parsed.heading.trim().slice(0, 220),
            content:       parsed.content.trim(),
            category:      'desh',
            author:        'Maroof Ahmed Khan',
            isPermanent:   true,
            isOriginal:    true,
            photos:        [],
            date:          new Date(),
            formattedDate: today.toLocaleDateString('hi-IN', { year: 'numeric', month: 'long', day: 'numeric' })
        });
        await article.save();
        console.log(`✓ Weekly roundup published: "${parsed.heading.slice(0, 60)}..."`);
        return article;
    } catch (err) {
        console.error('✗ Weekly roundup failed:', err.message);
        return null;
    }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Groq: Generate daily "क्या आप जानते हैं?" fact article ──────────────────
// A rotating educational piece (300-400 words). Category: itihas or desh.
// Provides a second original article per day at a different time offset.
const DAILY_FACT_TOPICS = [
    { hint: 'भारतीय संविधान की प्रमुख विशेषताएं — विश्व के सबसे बड़े लिखित संविधान का महत्व', cat: 'desh' },
    { hint: 'इसरो की उपलब्धियां: चंद्रयान-3 से आदित्य L1 तक — भारत की अंतरिक्ष क्रांति', cat: 'desh' },
    { hint: 'ताज महल का इतिहास: निर्माण, वास्तुकला और यूनेस्को विरासत का महत्व', cat: 'itihas' },
    { hint: 'भारतीय रेलवे: 170 साल का सफर — दुनिया के सबसे बड़े रेल नेटवर्कों में से एक', cat: 'desh' },
    { hint: 'भारत में मानसून: कैसे काम करता है, कृषि और जनजीवन पर इसका प्रभाव', cat: 'desh' },
    { hint: 'भारत के राष्ट्रीय प्रतीक: राष्ट्रगान, राष्ट्रगीत, राष्ट्रीय ध्वज का इतिहास', cat: 'itihas' },
    { hint: 'प्राचीन भारत के वैज्ञानिक: आर्यभट्ट, ब्रह्मगुप्त और शून्य की खोज', cat: 'itihas' },
    { hint: 'भारत की भाषाई विविधता: 22 अनुसूचित भाषाएं और हिंदी का राजभाषा का सफर', cat: 'desh' },
    { hint: 'भारतीय कृषि: हरित क्रांति से जैविक खेती तक — किसान और खाद्य सुरक्षा', cat: 'desh' },
    { hint: 'योग का इतिहास और वैज्ञानिक महत्व — भारत से विश्व तक का सफर', cat: 'itihas' },
    { hint: 'भारत के स्वतंत्रता संग्राम की अनसुनी कहानियां: गुमनाम नायकों का योगदान', cat: 'itihas' },
    { hint: 'भारतीय क्रिकेट का इतिहास: 1983 से 2023 तक — विश्व कप जीत की कहानियां', cat: 'khel' },
    { hint: 'गंगा नदी: धार्मिक, सांस्कृतिक और पारिस्थितिक महत्व — प्रदूषण और संरक्षण', cat: 'desh' },
    { hint: 'भारत में बाघ संरक्षण: प्रोजेक्ट टाइगर की सफलता और वन्यजीव विरासत', cat: 'desh' },
    { hint: 'भारतीय शास्त्रीय संगीत: रागों की दुनिया और महान संगीतकारों की विरासत', cat: 'itihas' },
    { hint: 'भारत की न्यायिक प्रणाली: सुप्रीम कोर्ट, हाई कोर्ट और PIL का महत्व', cat: 'rajniti' },
    { hint: 'भारतीय रुपये का इतिहास: मुद्रा की यात्रा कौड़ी से डिजिटल पेमेंट तक', cat: 'vyapar' },
    { hint: 'भारत के प्रमुख त्योहार: दिवाली, ईद, क्रिसमस — एकता में विविधता', cat: 'desh' },
    { hint: 'भारत की शिक्षा प्रणाली: गुरुकुल से IIT तक — राष्ट्रीय शिक्षा नीति 2020', cat: 'desh' },
    { hint: 'पृथ्वी का भूगोल: भारत की भौगोलिक विविधता — हिमालय से सागर तट तक', cat: 'itihas' },
];

async function generateDailyFact() {
    if (!process.env.MISTRAL_API_KEY) return null;
    if (!isMongoDBConnected) return null;

    // Deduplicate: skip if a "क्या आप जानते हैं:" article already published today
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay   = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const exists = await News.findOne({
        isOriginal: true,
        heading:    { $regex: /^क्या आप जानते हैं:/i },
        date:       { $gte: startOfDay, $lt: endOfDay }
    }).lean();
    if (exists) { console.log('✓ Daily fact already published today'); return exists; }

    // Rotate topic by day-of-year
    const dayOfYear = Math.floor((today - new Date(today.getFullYear(), 0, 0)) / 86400000);
    const topic     = DAILY_FACT_TOPICS[dayOfYear % DAILY_FACT_TOPICS.length];

    const prompt = `तुम "वॉयस ऑफ क्रांति" के शैक्षणिक स्तंभकार हो।

विषय: ${topic.hint}

इस विषय पर एक रोचक और शैक्षणिक हिंदी लेख लिखो।

⚠️ महत्वपूर्ण निर्देश:
- केवल सत्यापित जानकारी — कोई अनुमान नहीं
- गैर-विवादास्पद, शैक्षणिक, सकारात्मक सामग्री
- सरल हिंदी, 350-450 शब्द

लेख की **संरचना** (अनिवार्य):
- परिचय पैराग्राफ (60+ शब्द)
## [पहला उपशीर्षक — मुख्य जानकारी]
- 2 पैराग्राफ (100+ शब्द)
## [दूसरा उपशीर्षक — रोचक तथ्य या महत्व]
- 1-2 पैराग्राफ (80+ शब्द)
## क्या आप यह भी जानते हैं?
- [तथ्य 1] [पहले तथ्य की सामग्री — एक सटीक और रोचक वाक्य]
- [तथ्य 2] [दूसरे तथ्य की सामग्री — एक सटीक और रोचक वाक्य]
- [तथ्य 3] [तीसरे तथ्य की सामग्री — एक सटीक और रोचक वाक्य]

⚠️ अनिवार्य: हर bullet [तथ्य 1], [तथ्य 2], [तथ्य 3] prefix से शुरू होनी चाहिए।

## अक्सर पूछे जाने वाले सवाल
**प्रश्न:** [इस विषय से संबंधित एक सामान्य सवाल]?
**उत्तर:** [2 वाक्यों में जवाब]

## चिह्न और - bullet हूबहू इसी तरह रखो।

JSON: { "heading": "क्या आप जानते हैं: [आकर्षक उपशीर्षक]", "content": "पूरा संरचित लेख (पैराग्राफ \\n\\n से अलग करें)" }`;

    try {
        const raw = await callMistral(prompt, 2500);
        const parsed = JSON.parse(raw);
        if (!parsed.heading || !parsed.content) { console.error('✗ Daily fact: empty response'); return null; }
        if (Array.isArray(parsed.content)) parsed.content = parsed.content.join('\n\n');
        else if (typeof parsed.content !== 'string') parsed.content = Object.values(parsed.content || {}).join('\n\n');

        const safetyBlocklist = ['sex', 'porn', 'nude', 'bomb', 'terror', 'kill', 'rape', 'jihad'];
        if (safetyBlocklist.some(w => (parsed.heading + parsed.content).toLowerCase().includes(w))) {
            console.error('✗ Daily fact: failed safety check'); return null;
        }

        // Ensure heading always starts with "क्या आप जानते हैं:" prefix
        const PREFIX = 'क्या आप जानते हैं: ';
        const heading = parsed.heading.trim().startsWith('क्या आप जानते')
            ? parsed.heading.trim()
            : PREFIX + parsed.heading.trim();

        const article = new News({
            heading:       heading.slice(0, 220),
            content:       parsed.content.trim(),
            category:      topic.cat,
            author:        'Maroof Ahmed Khan',
            isPermanent:   true,
            isOriginal:    true,
            isDailyFact:   true,
            photos:        [],
            date:          new Date(),
            formattedDate: today.toLocaleDateString('hi-IN', { year: 'numeric', month: 'long', day: 'numeric' })
        });
        await article.save();
        console.log(`✓ Daily fact published: "${heading.slice(0, 60)}..."`);
        return article;
    } catch (err) {
        console.error('✗ Daily fact generation failed:', err.message);
        return null;
    }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Groq: Generate 60-second shorts ──────────────────────────────────────────
const SHORTS_CATEGORIES = ['desh', 'rajniti', 'crime', 'bhopal'];
const SHORTS_PER_CATEGORY = 25;

async function generateShorts() {
    if (!process.env.GROQ_API_KEY) {
        console.log('⚠️ GROQ_API_KEY not set, skipping shorts generation');
        return;
    }
    if (!isMongoDBConnected) return;

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    console.log('=== Generating 60-second shorts via Groq ===');
    let totalGenerated = 0;

    for (const category of SHORTS_CATEGORIES) {
        // Pick latest articles in this category that don't have shorts yet
        const articles = await News.find(
            { category, 'shortNews.generatedAt': null },
            { _id: 1, heading: 1, content: 1, category: 1, photos: 1, slug: 1, date: 1, author: 1 }
        ).sort({ date: -1 }).limit(SHORTS_PER_CATEGORY).lean();

        for (const article of articles) {
            try {
                const rawText = (article.content || '').replace(/<[^>]+>/g, '').slice(0, 800);
                const prompt = `तुम एक हिंदी न्यूज़ एडिटर हो। नीचे दी गई खबर को "30 सेकंड में खबर" फॉर्मेट में बदलो।

खबर का शीर्षक: ${article.heading}
खबर का विवरण: ${rawText}

नीचे दिए गए JSON फॉर्मेट में जवाब दो। केवल JSON दो, कोई और टेक्स्ट नहीं:
{
  "headline": "एक लाइन में मुख्य खबर (max 100 chars)",
  "whatHappened": "क्या हुआ? 2-3 वाक्यों में (max 200 chars)",
  "keyPoints": ["बिंदु 1 (max 80 chars)", "बिंदु 2 (max 80 chars)", "बिंदु 3 (max 80 chars)"],
  "whyItMatters": "क्यों जरूरी है? 1-2 वाक्यों में (max 150 chars)"
}`;

                const raw = await callGroq(prompt, 600);
                const parsed = JSON.parse(raw);

                if (!parsed.headline || !parsed.whatHappened) continue;

                await News.updateOne(
                    { _id: article._id },
                    {
                        $set: {
                            'shortNews.headline':      parsed.headline.slice(0, 120),
                            'shortNews.whatHappened':  parsed.whatHappened.slice(0, 250),
                            'shortNews.keyPoints':     (parsed.keyPoints || []).slice(0, 4).map(p => String(p).slice(0, 100)),
                            'shortNews.whyItMatters':  (parsed.whyItMatters || '').slice(0, 200),
                            'shortNews.generatedAt':   new Date()
                        }
                    }
                );
                totalGenerated++;

                // Small delay to be respectful of rate limits
                await new Promise(r => setTimeout(r, 200));
            } catch (err) {
                console.error(`✗ Shorts generation failed for "${article.heading.slice(0, 40)}...":`, err.message);
            }
        }
        console.log(`✓ Shorts generated for category: ${category}`);
    }

    console.log(`=== Shorts generation done: ${totalGenerated} articles processed ===`);
}
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3000;

// Admin credentials from environment variables
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Download image using browser-like headers (bypasses CDN hotlink protection) then upload to Cloudinary.
// Returns Cloudinary URL on success, original URL on failure.
async function uploadImageFromUrl(imageUrl) {
    if (!imageUrl || imageUrl.includes('res.cloudinary.com') || !process.env.CLOUDINARY_API_KEY) return imageUrl;
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
        const cloudUrl = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                { folder: 'news', transformation: [{ width: 1200, height: 630, crop: 'fill', format: 'jpg', quality: 'auto' }] },
                (err, result) => err ? reject(err) : resolve(result.secure_url)
            );
            stream.end(buffer);
        });
        return cloudUrl;
    } catch (e) {
        console.warn('uploadImageFromUrl failed for', imageUrl, '—', e.message);
        return imageUrl;
    }
}

// Track if MongoDB is connected
let isMongoDBConnected = false;
const isDevelopment = process.env.NODE_ENV !== 'production';

// JSON file storage functions for development
const NEWS_DATA_FILE = path.join(__dirname, 'news-data.json');

function readNewsData() {
    try {
        if (fs.existsSync(NEWS_DATA_FILE)) {
            const data = fs.readFileSync(NEWS_DATA_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (err) {
        console.error('Error reading news data:', err);
    }
    return [];
}

function writeNewsData(newsArray) {
    try {
        fs.writeFileSync(NEWS_DATA_FILE, JSON.stringify(newsArray, null, 2));
        return true;
    } catch (err) {
        console.error('Error writing news data:', err);
        return false;
    }
}

// Connect to MongoDB - Force MongoDB in production
// Caches the in-flight connection promise so concurrent cold-start requests
// (common on Vercel serverless) await the SAME connect() attempt instead of
// each opening a brand-new connection to Atlas — avoids the connection-storm
// pattern that leads to "Server selection timed out" for readers under load.
let connectionPromise = null;

const connectDB = async () => {
    // Already connected — skip
    if (isMongoDBConnected && mongoose.connection.readyState === 1) return;

    // A connection attempt is already in progress — reuse it.
    if (connectionPromise) return connectionPromise;

    connectionPromise = (async () => {
        console.log('=== MongoDB Connection Attempt ===');
        console.log('Environment:', process.env.NODE_ENV || 'development');
        console.log('MONGODB_URI exists:', !!process.env.MONGODB_URI);
        console.log('CLOUDINARY_CLOUD_NAME exists:', !!process.env.CLOUDINARY_CLOUD_NAME);

        // In development, allow fallback to JSON file
        if (isDevelopment && !process.env.MONGODB_URI) {
            console.log('⚠️ Development mode: MongoDB URI not found, using JSON file storage');
            console.log('✓ JSON file mode enabled for local development');
            return;
        }

        if (!process.env.MONGODB_URI) {
            const errorMsg = '❌ MONGODB_URI not found in environment variables';
            console.error(errorMsg);
            if (process.env.NODE_ENV === 'production') {
                console.error('⚠️ Production requires MongoDB. Set MONGODB_URI in Vercel environment variables.');
            }
            throw new Error(errorMsg);
        }

        try {
            console.log('Connecting to MongoDB...');
            const maskedUri = process.env.MONGODB_URI.replace(/\/\/([^:]+):([^@]+)@/, '//***:***@');
            console.log('MongoDB URI (masked):', maskedUri);

            await mongoose.connect(process.env.MONGODB_URI, {
                serverSelectionTimeoutMS: 8000, // fail fast instead of blocking readers for 30s
                connectTimeoutMS: 10000,
                socketTimeoutMS: 45000,
                maxPoolSize: 10,   // bound per-instance pool — many concurrent serverless
                minPoolSize: 0,    // instances can otherwise exhaust Atlas's connection limit
                bufferCommands: false, // fail fast instead of silently queueing queries
            });
            // Prevent unhandled 'error' events from crashing the process after initial connect
            mongoose.connection.on('error', err => {
                console.error('❌ MongoDB connection error:', err.message);
                isMongoDBConnected = false;
            });
            mongoose.connection.on('disconnected', () => {
                console.warn('⚠️ MongoDB disconnected');
                isMongoDBConnected = false;
            });
            mongoose.connection.on('reconnected', () => {
                console.log('✓ MongoDB reconnected');
                isMongoDBConnected = true;
            });
            console.log('✓ Connected to MongoDB Atlas successfully');
            isMongoDBConnected = true;
        } catch (err) {
            console.error('❌ MongoDB connection failed:', err.message);
            if (isDevelopment) {
                console.log('⚠️ Development mode: Falling back to JSON file storage');
            } else {
                console.error('⚠️ Production MongoDB connection failed. Check MONGODB_URI and Atlas Network Access (IP allowlist) in Vercel settings.');
            }
            isMongoDBConnected = false;
            throw err;
        }
    })();

    try {
        await connectionPromise;
    } finally {
        // Let the next call retry with a fresh attempt whether this one succeeded or failed.
        connectionPromise = null;
    }
};

// Initialize DB connection (async)
// Initialise DB connection.
// On Vercel (serverless) the module is cached per container — connectDB runs once per cold start.
// setInterval/setTimeout for RSS auto-import only work in a long-lived process (local dev / Node server).
// On Vercel, trigger RSS import manually via the admin panel (/api/admin/fetch-rss).
const dbReady = connectDB();
dbReady.catch(err => console.error('DB init error:', err.message));
dbReady.then(() => ensureDefaultAuthors()).catch(() => {});

async function ensureDefaultAuthors() {
    try {
        if (!isMongoDBConnected) return;
        const seededAuthors = [
            {
                name: 'Maroof Ahmed Khan',
                slug: 'maroof-ahmed-khan',
                photo: 'https://voiceofkranti.com/og-banner.svg',
                description: 'Maroof Ahmed Khan वॉयस ऑफ क्रांति के संस्थापक एवं प्रधान संपादक हैं। वे जनसरोकार, निष्पक्ष रिपोर्टिंग और जनता की आवाज़ को प्रमुखता देने के लिए प्रतिबद्ध हैं।',
                isFeatured: true
            },
            {
                name: 'Sanjida Khanam',
                slug: 'sanjida-khanam',
                photo: 'https://voiceofkranti.com/og-banner.svg',
                description: 'Sanjida Khanam डिजिटल हिंदी पत्रकारिता के साथ सामाजिक, राजनीतिक और जनहित से जुड़े मुद्दों की रिपोर्टिंग में सक्रिय हैं।',
                isFeatured: true
            }
        ];

        for (const authorData of seededAuthors) {
            const existing = await Author.findOne({ slug: authorData.slug }).lean();
            if (!existing) {
                await Author.create(authorData);
            } else {
                await Author.updateOne({ _id: existing._id }, { $set: { ...authorData } }, { upsert: true });
            }
        }
    } catch (err) {
        console.warn('Default author seeding skipped:', err.message);
    }
}

if (require.main === module) {
    // Running locally — kick off RSS + API polling
    dbReady.then(() => {
        console.log('=== Starting वॉयस ऑफ क्रांति Server (local) ===');
        setTimeout(() => fetchAllNews(), 5000);
        setInterval(() => fetchAllNews(), 30 * 60 * 1000);
        // Generate shorts once at startup (after RSS), then every 4 hours
        setTimeout(() => generateShorts(), 60 * 1000);
        setInterval(() => generateShorts(), 4 * 60 * 60 * 1000);
        // Generate one original editorial article daily (first run 2 min after startup)
        setTimeout(() => generateDailyArticle(), 2 * 60 * 1000);
        setInterval(() => generateDailyArticle(), 24 * 60 * 60 * 1000);
        // Generate Aaj Ka Itihas daily (first run 3 min after startup)
        setTimeout(() => generateAajKaItihas(), 3 * 60 * 1000);
        setInterval(() => generateAajKaItihas(), 24 * 60 * 60 * 1000);
        // Generate explainers (first run 5 min after startup, then every 6 hours)
        setTimeout(() => generateExplainers(), 5 * 60 * 1000);
        setInterval(() => generateExplainers(), 6 * 60 * 60 * 1000);
        // Generate "का मत" moral lessons for crime articles (7 min offset, every 6 hours)
        setTimeout(() => generateKaMat(), 7 * 60 * 1000);
        setInterval(() => generateKaMat(), 6 * 60 * 60 * 1000);
        // Generate daily "क्या आप जानते हैं?" fact article (4 min offset, 24h interval)
        setTimeout(() => generateDailyFact(), 4 * 60 * 1000);
        setInterval(() => generateDailyFact(), 24 * 60 * 60 * 1000);
        // Generate weekly roundup every Sunday (check every 12h; skips if not Sunday or already done)
        setTimeout(() => generateWeeklyRoundup(), 6 * 60 * 1000);
        setInterval(() => generateWeeklyRoundup(), 12 * 60 * 60 * 1000);
    });
}

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Trust reverse proxy (Render, Railway, Heroku etc.) so secure cookies work
if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

// Session configuration - Set up immediately with MongoStore if URI available
const isProduction = process.env.NODE_ENV === 'production';
const SESSION_TTL_MS  = 30 * 24 * 60 * 60 * 1000;   // 30 days in ms
const SESSION_TTL_SEC = 30 * 24 * 60 * 60;            // 30 days in seconds (MongoStore)
const sessionConfig = {
    secret: process.env.SESSION_SECRET || 'janta-ka-sandesh-secret-key-2026',
    resave: false,
    saveUninitialized: false,
    name: 'sessionId',
    cookie: { 
        secure: isProduction,
        httpOnly: true,
        maxAge: SESSION_TTL_MS,
        sameSite: isProduction ? 'strict' : 'lax',
        path: '/'
    }
};

// Add MongoDB store if MONGODB_URI is available
if (process.env.MONGODB_URI) {
    sessionConfig.store = MongoStore.create({
        mongoUrl: process.env.MONGODB_URI,
        collectionName: 'sessions',
        ttl: SESSION_TTL_SEC,
        autoRemove: 'native'
    });
    console.log('✓ Using MongoDB session store');
} else {
    console.log('⚠️ Using memory session store (development mode)');
}

app.use(session(sessionConfig));

// Gzip compress all responses
app.use(compression());

// Redirect jantakasandesh.in and www.voiceofkranti.com → voiceofkranti.com (301 permanent)
app.use((req, res, next) => {
    const host = req.hostname || '';
    if (host.includes('jantakasandesh') || host === 'www.voiceofkranti.com') {
        return res.redirect(301, 'https://voiceofkranti.com' + req.originalUrl);
    }
    next();
});

// ── Category landing page metadata ───────────────────────────────────────────
const CATEGORY_PAGE_INFO = {
    desh: {
        name: 'देश', emoji: '🇮🇳', color: '#ff9933',
        title: 'देश की ताज़ा खबरें — वॉयस ऑफ क्रांति',
        metaDesc: 'भारत की राष्ट्रीय राजनीति, केंद्र सरकार की नीतियों और देशव्यापी घटनाओं की ताज़ा हिंदी खबरें।',
        intro: 'देश की ताज़ा राजनीति, सामाजिक और राष्ट्रीय घटनाओं की खबरें।'
    },
    videsh: {
        name: 'विदेश', emoji: '🌍', color: '#3b82f6',
        title: 'विदेश की ताज़ा खबरें — वॉयस ऑफ क्रांति',
        metaDesc: 'अंतर्राष्ट्रीय समाचार, कूटनीति और वैश्विक घटनाओं की ताज़ा जानकारी।',
        intro: 'दुनिया की बड़ी घटनाओं और भारत से जुड़े अंतर्राष्ट्रीय समाचार।'
    },
    rajya: {
        name: 'राज्य', emoji: '🗺️', color: '#10b981',
        title: 'राज्यों की ताज़ा खबरें — वॉयस ऑफ क्रांति',
        metaDesc: 'मध्यप्रदेश और अन्य राज्यों की ताज़ा खबरें, नीतियां और स्थानीय घटनाएं।',
        intro: 'राज्य स्तर की खबरें, नीति और स्थानीय घटनाओं का अपडेट।'
    },
    bhopal: {
        name: 'भोपाल', emoji: '🏙️', color: '#8b5cf6',
        title: 'भोपाल की ताज़ा खबरें — वॉयस ऑफ क्रांति',
        metaDesc: 'भोपाल की स्थानीय खबरें, विकास, यातायात और शहर की जनता से जुड़ी घटनाएं।',
        intro: 'भोपाल की शहर की खबरें और स्थानीय विकास से जुड़ी अपडेट्स।'
    },
    crime: {
        name: 'अपराध', emoji: '🚔', color: '#ef4444',
        title: 'अपराध की ताज़ा खबरें — वॉयस ऑफ क्रांति',
        metaDesc: 'देश और मध्यप्रदेश की अपराध खबरें, पुलिस कार्रवाई और judicial updates।',
        intro: 'अपराध, जांच और सुरक्षा से जुड़ी खबरें।'
    },
    apradh: {
        name: 'अपराध', emoji: '🚔', color: '#ef4444',
        title: 'अपराध की ताज़ा खबरें — वॉयस ऑफ क्रांति',
        metaDesc: 'देश और मध्यप्रदेश की अपराध खबरें, पुलिस कार्रवाई और judicial updates।',
        intro: 'अपराध, जांच और सुरक्षा से जुड़ी खबरें।'
    },
    khel: {
        name: 'खेल', emoji: '⚽', color: '#f59e0b',
        title: 'खेल की ताज़ा खबरें — वॉयस ऑफ क्रांति',
        metaDesc: 'क्रिकेट, फुटबॉल, कुश्ती और अंतरराष्ट्रीय खेलों की ताज़ा खबरें।',
        intro: 'खेल जगत की ताज़ा खबरें, परिणाम और खिलाड़ी अपडेट।'
    },
    rajniti: {
        name: 'राजनीति', emoji: '🏛️', color: '#6366f1',
        title: 'राजनीति की ताज़ा खबरें — वॉयस ऑफ क्रांति',
        metaDesc: 'चुनाव, नेता, नीति और संसद से जुड़ी ताज़ा हिंदी खबरें।',
        intro: 'राजनीतिक घटनाओं, चुनाव और नीति से जुड़ी खबरें।'
    },
    manoranjan: {
        name: 'मनोरंजन', emoji: '🎬', color: '#ec4899',
        title: 'मनोरंजन की ताज़ा खबरें — वॉयस ऑफ क्रांति',
        metaDesc: 'बॉलीवुड, टेलीविजन, संगीत और सेलेब्रिटी की हिंदी खबरें।',
        intro: 'फिल्म, टीवी, संगीत और सेलेब्रिटी की ताज़ा खबरें।'
    },
    vyapar: {
        name: 'व्यापार', emoji: '💼', color: '#14b8a6',
        title: 'व्यापार की ताज़ा खबरें — वॉयस ऑफ क्रांति',
        metaDesc: 'अर्थव्यवस्था, मार्केट, बजट और व्यवसाय से जुड़ी खबरें।',
        intro: 'मार्केट, अर्थव्यवस्था और व्यापार से जुड़ी खबरें।'
    },
    itihas: {
        name: 'इतिहास', emoji: '📜', color: '#c4922a',
        title: 'इतिहास और विरासत — वॉयस ऑफ क्रांति',
        metaDesc: 'भारतीय इतिहास, विरासत और ऐतिहासिक घटनाओं की हिंदी खबरें।',
        intro: 'इतिहास, विरासत और प्रमुख घटनाओं की छोटी-सी झलक।'
    }
};
// ─────────────────────────────────────────────────────────────────────────────

// ── Slug-based article URLs: /news/:slug ─────────────────────────────────────
// Injects server-side OG/Twitter meta tags so social crawlers get the article image
app.get('/news/:slug', async (req, res) => {
    try {
        const slug = req.params.slug;

        // 1. Check static legacy redirect table first (no DB needed, instant)
        if (LEGACY_REDIRECTS[slug]) {
            return res.redirect(301, LEGACY_REDIRECTS[slug]);
        }

        let article = null;

        // Always attempt DB query — on Vercel serverless, isMongoDBConnected may be
        // false on cold-start even when MongoDB is reachable. Let try/catch handle failure.
        // Call connectDB() fresh (not the stale module-load `dbReady` promise) so a
        // container that recovers after a cold-start hiccup doesn't keep failing forever.
        let dbError = false;
        try {
            await connectDB();
            article = await News.findOne({ slug }).lean();
            // Case-insensitive fallback
            if (!article) {
                article = await News.findOne({ slug: new RegExp('^' + slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }).lean();
            }
            // Keyword fallback — slug words matched against heading
            if (!article) {
                const words = slug.split('-').filter(w => w.length >= 4);
                if (words.length >= 2) {
                    const regexes = words.slice(0, 4).map(w => new RegExp(w, 'i'));
                    article = await News.findOne({ $and: regexes.map(r => ({ heading: r })) }).lean();
                }
            }
        } catch (dbErr) {
            console.error('DB lookup failed for slug', slug, dbErr.message);
            dbError = true;
        }

        // DB was reachable but article genuinely doesn't exist → check redirect table
        // before returning 404, so deleted article slugs 301-redirect to homepage
        if (!dbError && !article) {
            try {
                const redirect = await Redirect.findOne({ from: slug }).lean();
                if (redirect) {
                    return res.redirect(301, redirect.to || '/');
                }
            } catch (_) {}
            return res.redirect(301, '/');
        }

        // Read the static HTML template
        const htmlPath = path.join(__dirname, 'public', 'news-detail.html');
        let html = require('fs').readFileSync(htmlPath, 'utf8');

        if (article) {
            const pageUrl  = `https://voiceofkranti.com/news/${slug}`;
            const esc = s => (s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            const title    = esc('वॉयस ऑफ क्रांति | ' + (article.heading || 'वॉयस ऑफ क्रांति'));
            const desc     = esc((article.content || '').replace(/<[^>]+>/g, '').slice(0, 155).trim() || 'वॉयस ऑफ क्रांति पर ताज़ा हिंदी समाचार पढ़ें।');
            const publishedAt = article.date ? new Date(article.date) : new Date();
            const modifiedAt = article.updatedAt ? new Date(article.updatedAt) : publishedAt;
            const isoPublished = publishedAt.toISOString();
            const isoModified = modifiedAt.toISOString();
            const dateLabel = article.formattedDate || publishedAt.toLocaleDateString('hi-IN', { day: 'numeric', month: 'long', year: 'numeric' });
            const modifiedLabel = modifiedAt.toLocaleDateString('hi-IN', { day: 'numeric', month: 'long', year: 'numeric' });
            const authorLabel = article.author || (article.rssSource ? 'JKS News Desk' : 'वॉयस ऑफ क्रांति');
            const authorProfiles = await Author.find({}).sort({ name: 1 }).lean();
            const matchedAuthor = !article.author ? null : findAuthorMatch(authorProfiles, article.author);
            const authorLink = matchedAuthor ? `/authors/${encodeURIComponent(matchedAuthor.slug)}` : '';
            const authorMarkup = matchedAuthor ? `<a href="${authorLink}" class="news-detail-author-link">${esc(matchedAuthor.name)}</a>` : `<strong>${esc(authorLabel)}</strong>`;
            const authorMeta = `<meta name="author" content="${esc(authorLabel)}"><meta property="article:author" content="${esc(authorLabel)}"><meta property="article:published_time" content="${esc(isoPublished)}"><meta property="article:modified_time" content="${esc(isoModified)}"><meta property="article:publisher" content="वॉयस ऑफ क्रांति">`;
            const authorCardMarkup = matchedAuthor
                ? `<div class="nd-author-card"><div class="nd-author-avatar">${esc((matchedAuthor.name || 'A').charAt(0).toUpperCase())}</div><div class="nd-author-info"><a href="${authorLink}" class="news-detail-author-link" style="color:#1e293b;text-decoration:none;">${esc(matchedAuthor.name)}</a><p>${esc((matchedAuthor.description || 'वॉयस ऑफ क्रांति की रिपोर्टिंग में इस लेखक की विशिष्ट भूमिका और दृष्टि प्रमुख है।').slice(0, 220))}</p></div></div>`
                : `<div class="nd-author-card"><div class="nd-author-avatar">${esc((authorLabel || 'V').charAt(0).toUpperCase())}</div><div class="nd-author-info"><strong>${esc(authorLabel)}</strong><p>वॉयस ऑफ क्रांति की संपादकीय टीम आपके लिए भोपाल, मध्यप्रदेश और देश की सटीक और विश्वसनीय समाचार प्रस्तुत करती है।</p></div></div>`;
            const lintedBody = renderArticleBodyForCrawler(article.content || '');
            const rawImage = (article.photos && article.photos.length > 0)
                ? article.photos[0]
                : (article.photo || null);
            // Force JPEG at 1200×630 for Cloudinary so WhatsApp/FB scraper gets a compatible image.
            const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
            const fallbackOgImage = cloudName
                ? `https://res.cloudinary.com/${cloudName}/image/fetch/f_jpg,q_auto,w_1200,h_630,c_fill/${encodeURIComponent('https://voiceofkranti.com/og-banner.svg')}`
                : 'https://voiceofkranti.com/og-banner.svg';
            const image = rawImage
                ? (rawImage.includes('res.cloudinary.com') && rawImage.includes('/upload/')
                    ? rawImage.replace('/upload/', '/upload/f_jpg,q_auto,w_1200,h_630,c_fill/')
                    : rawImage)
                : fallbackOgImage;

            const photoMarkup = rawImage
                ? `<div class="news-detail-image-wrapper"><img src="${esc(rawImage)}" alt="${esc(article.heading || 'समाचार')}" class="news-detail-image"></div>`
                : `<div class="news-detail-gallery"><div class="main-photo-container"><div class="news-img-placeholder" style="height:300px;"><span class="placeholder-word">NEWS</span><span class="placeholder-lines"><em></em><em></em><em></em></span></div></div></div>`;

            const categoryNames = { desh:'देश', videsh:'विदेश', rajya:'राज्य', bhopal:'भोपाल', crime:'अपराध', khel:'खेल', rajniti:'राजनीति', manoranjan:'मनोरंजन', vyapar:'व्यापार', itihas:'इतिहास' };
            const categoryMarkup = article.category ? `<a href="/?category=${article.category}" class="category-badge category-badge-large" style="text-decoration:none;cursor:pointer;">${categoryNames[article.category] || article.category}</a>` : '';
            const articleMarkup = `
                <article class="news-detail-article" data-ssr-article="true">
                    <nav class="nd-breadcrumb">
                        <a href="/">होम</a>
                        <span class="nd-bc-sep">›</span>
                        ${article.category ? `<a href="/?category=${article.category}">${categoryNames[article.category] || article.category}</a><span class="nd-bc-sep">›</span>` : ''}
                        <span class="nd-bc-current">${esc(article.heading || 'समाचार')}</span>
                    </nav>
                    ${categoryMarkup}
                    <h1 class="news-detail-title">${esc(article.heading || 'समाचार')}</h1>
                    <div class="news-detail-meta">
                        ${(authorLabel ? `<span class="news-detail-author">लेखक: ${authorMarkup}</span>` : '')}
                        <time class="news-detail-date" datetime="${esc(isoPublished)}">प्रकाशित: ${esc(dateLabel)}</time>
                        <span class="news-detail-date">अंतिम अपडेट: ${esc(modifiedLabel)}</span>
                    </div>
                    <div class="news-detail-meta" style="margin-top:0.5rem;">
                        <span class="news-detail-author">प्रकाशक: <strong>वॉयस ऑफ क्रांति</strong></span>
                    </div>
                    ${photoMarkup}
                    <div class="news-detail-content">
                        <div class="news-detail-text">${lintedBody}</div>
                        ${(article.rssSource && article.rssSource !== 'PB SHABD') ? `<p class="news-source-credit">📡 स्रोत: ${article.rssLink ? `<a href="${esc(article.rssLink)}" target="_blank" rel="noopener noreferrer">${esc(article.rssSource)}</a>` : `<strong>${esc(article.rssSource)}</strong>`}</p>` : ''}
                        ${(article.rssLink && article.rssSource !== 'PB SHABD' && !article.isAiScraped) ? `<div class="read-full-article"><a href="${esc(article.rssLink)}" target="_blank" rel="noopener noreferrer" class="read-full-btn">📰 पूरी खबर पढ़ें (${esc(article.rssSource || 'मूल स्रोत')} पर जाएं)</a></div>` : ''}
                    </div>
                    ${authorCardMarkup}
                    <div class="share-section">
                        <h3 class="share-title">📢 इस खबर को शेयर करें</h3>
                        <div class="share-buttons">
                            <button onclick="shareOnWhatsApp()" class="share-btn whatsapp-btn" title="WhatsApp">
                                <svg viewBox="0 0 24 24" width="26" height="26" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                            </button>
                            <button onclick="shareOnFacebook()" class="share-btn facebook-btn" title="Facebook">
                                <svg viewBox="0 0 24 24" width="26" height="26" fill="white"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
                            </button>
                            <button onclick="shareOnTwitter()" class="share-btn twitter-btn" title="X (Twitter)">
                                <svg viewBox="0 0 24 24" width="26" height="26" fill="white"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L1.254 2.25H8.08l4.259 5.629 5.905-5.629zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                            </button>
                            <button onclick="copyLink()" class="share-btn copy-btn" title="लिंक कॉपी करें" id="copyBtn">
                                <svg viewBox="0 0 24 24" width="26" height="26" fill="white"><path d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" stroke="white" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
                            </button>
                        </div>
                    </div>
                </article>
            `;

            html = html.replace(
                /<div id="newsDetail" class="news-detail-container">[\s\S]*?<\/div>\s*(?=<!-- Related Articles -->)/,
                `<div id="newsDetail" class="news-detail-container" data-ssr-article="true">${articleMarkup}</div>`
            );

            // NewsArticle JSON-LD schema for Google (server-side so crawlers see it)
            const schema = JSON.stringify({
                "@context": "https://schema.org",
                "@type": "NewsArticle",
                "mainEntityOfPage": { "@type": "WebPage", "@id": pageUrl },
                "headline": article.heading,
                "description": desc,
                "url": pageUrl,
                "datePublished": isoPublished,
                "dateModified": isoModified,
                "image": [image],
                "author": { "@type": "Person", "name": authorLabel, "url": "https://voiceofkranti.com/about.html" },
                "publisher": {
                    "@type": "Organization",
                    "name": "वॉयस ऑफ क्रांति",
                    "url": "https://voiceofkranti.com",
                    "email": "editor@voiceofkranti.com",
                    "logo": { "@type": "ImageObject", "url": "https://voiceofkranti.com/logo.svg", "width": 200, "height": 60 }
                },
                "inLanguage": "hi",
                "isAccessibleForFree": true
            });

            // BreadcrumbList schema for search result breadcrumb display
            const catNamesMap = { desh:'देश', videsh:'विदेश', rajya:'राज्य', bhopal:'भोपाल', crime:'अपराध', khel:'खेल', rajniti:'राजनीति', manoranjan:'मनोरंजन', vyapar:'व्यापार', itihas:'इतिहास' };
            const catName = catNamesMap[article.category] || article.category || '';
            const breadcrumbItems = [
                { "@type": "ListItem", "position": 1, "name": "होम", "item": "https://voiceofkranti.com/" }
            ];
            if (catName) breadcrumbItems.push({ "@type": "ListItem", "position": 2, "name": catName, "item": `https://voiceofkranti.com/?category=${article.category}` });
            breadcrumbItems.push({ "@type": "ListItem", "position": catName ? 3 : 2, "name": article.heading, "item": pageUrl });
            const breadcrumb = JSON.stringify({ "@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": breadcrumbItems });

            // news_keywords meta for Google News
            const catKeywordsMap = { desh:'भारत,राष्ट्रीय समाचार,देश', videsh:'विदेश समाचार,अंतर्राष्ट्रीय', rajya:'राज्य समाचार,मध्यप्रदेश', bhopal:'भोपाल,मध्यप्रदेश', crime:'अपराध,क्राइम न्यूज़', khel:'खेल समाचार,sports news', rajniti:'राजनीति,politics', manoranjan:'मनोरंजन,बॉलीवुड', vyapar:'व्यापार,business', itihas:'इतिहास' };
            const newsKeywords = ((catKeywordsMap[article.category] || article.category || '') + ',हिंदी समाचार,voice of kranti').replace(/^,/, '');

            // Replace placeholder meta content values — use function replacement
            // to prevent $ in article titles being interpreted as regex backreferences
            const r = (pattern, value) => (_, ...args) => {
                const captures = args.slice(0, -2); // all capture groups
                return captures[0] + value + (captures[1] || '');
            };
            html = html
                .replace(/(<title id="page-title">)[^<]*(<\/title>)/,            r(null, title))
                .replace(/(<meta id="meta-description"[^>]*content=")[^"]*(")/,  r(null, desc))
                .replace(/(<meta id="meta-canonical"[^>]*content=")[^"]*(")/,    r(null, pageUrl))
                .replace(/(<link id="link-canonical"[^>]*href=")[^"]*(")/,       r(null, pageUrl))
                .replace(/(<meta id="og-title"[^>]*content=")[^"]*(")/,          r(null, title))
                .replace(/(<meta id="og-description"[^>]*content=")[^"]*(")/,    r(null, desc))
                .replace(/(<meta id="og-url"[^>]*content=")[^"]*(")/,            r(null, pageUrl))
                .replace(/(<meta id="og-image"[^>]*content=")[^"]*(")/,          r(null, image))
                .replace(/(<meta id="og-image-secure"[^>]*content=")[^"]*(")/,  r(null, image))
                .replace(/(<meta id="og-image-alt"[^>]*content=")[^"]*(")/,     r(null, esc(article.heading || 'वॉयस ऑफ क्रांति')))
                .replace(/(<meta id="og-image-type"[^>]*content=")[^"]*(")/,    r(null, 'image/jpeg'))
                .replace(/(<meta id="twitter-title"[^>]*content=")[^"]*(")/,     r(null, title))
                .replace(/(<meta id="twitter-description"[^>]*content=")[^"]*(")/,r(null, desc))
                .replace(/(<meta id="twitter-image"[^>]*content=")[^"]*(")/,     r(null, image))
                .replace(/(<meta id="twitter-image-alt"[^>]*content=")[^"]*(")/,r(null, esc(article.heading || 'वॉयस ऑफ क्रांति')))
                .replace(/(<meta id="news-keywords"[^>]*content=")[^"]*(")/,     r(null, newsKeywords))
                .replace(/<\/head>/, `${authorMeta}\n</head>`)
                .replace(/(<script id="json-ld-schema"[^>]*>)[^<]*(<\/script>)/,    r(null, schema))
                .replace(/(<script id="json-ld-breadcrumb"[^>]*>)[^<]*(<\/script>)/, r(null, breadcrumb));
        }

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        // Prevent Vercel edge caching so social crawlers always get fresh OG tags
        res.setHeader('Cache-Control', 'no-store');
        res.send(html);
    } catch (err) {
        console.error('Slug route error:', err.message);
        res.sendFile(path.join(__dirname, 'public', 'news-detail.html'));
    }
});

// API: fetch a single article by slug
app.get('/api/authors', async (req, res) => {
    try {
        if (!isMongoDBConnected) {
            try {
                await Promise.race([
                    connectDB(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 7000))
                ]);
            } catch (_) {}
            if (!isMongoDBConnected) return res.status(503).json({ error: 'DB not ready', retry: true });
        }

        const authors = await Author.find({}).sort({ name: 1 }).lean();
        res.json(authors.map(author => ({ ...author, id: author._id.toString() })));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/authors/:slug', async (req, res) => {
    try {
        if (!isMongoDBConnected) {
            try {
                await Promise.race([
                    connectDB(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 7000))
                ]);
            } catch (_) {}
            if (!isMongoDBConnected) return res.status(503).json({ error: 'DB not ready', retry: true });
        }

        const author = await Author.findOne({ slug: req.params.slug }).lean();
        if (!author) return res.status(404).json({ error: 'Author not found' });
        res.json({ ...author, id: author._id.toString() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/authors', requireAuth, async (req, res) => {
    try {
        const { name, photo, description } = req.body || {};
        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'Author name is required' });
        }

        const slugBase = (name || '').trim();
        const slug = slugBase
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .trim()
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .slice(0, 80) || 'author';

        const authorData = {
            name: slugBase,
            slug,
            photo: photo || '',
            description: description || '',
            isFeatured: false
        };

        const existing = await Author.findOne({ $or: [{ name: new RegExp('^' + slugBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }, { slug }] }).lean();
        if (existing) {
            return res.status(409).json({ error: 'Author already exists' });
        }

        const author = await Author.create(authorData);
        res.status(201).json({ success: true, author: { ...author.toObject(), id: author._id.toString() } });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/authors/:slug', requireAuth, async (req, res) => {
    try {
        const { name, photo, description } = req.body || {};
        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'Author name is required' });
        }

        const author = await Author.findOne({ slug: req.params.slug }).lean();
        if (!author) {
            return res.status(404).json({ error: 'Author not found' });
        }

        const slugBase = name.trim();
        const nextSlug = slugBase
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .trim()
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .slice(0, 80) || author.slug;

        const updated = await Author.findByIdAndUpdate(
            author._id,
            {
                $set: {
                    name: slugBase,
                    slug: nextSlug,
                    photo: photo || author.photo || '',
                    description: description || author.description || '',
                }
            },
            { new: true }
        ).lean();

        res.json({ success: true, author: { ...updated, id: updated._id.toString() } });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/authors/:slug', async (req, res) => {
    try {
        const author = await Author.findOne({ slug: req.params.slug }).lean();
        if (!author) return res.redirect(301, '/authors.html');

        const photo = author.photo || 'https://voiceofkranti.com/og-banner.svg';
        const description = (author.description || 'वॉयस ऑफ क्रांति के साथ इस लेखक की रिपोर्टिंग जनता के लिए सटीक, निष्पक्ष और उपयोगी जानकारी उपलब्ध कराती है।').replace(/"/g, '&quot;');
        const authorName = author.name || 'Author';
        const pageTitle = `${authorName} | वॉयस ऑफ क्रांति`;
        const metaDescription = `${authorName} की प्रोफ़ाइल | वॉयस ऑफ क्रांति`;

        const html = `<!DOCTYPE html>
<html lang="hi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#ff9933" />
  <title>${pageTitle}</title>
  <meta name="description" content="${metaDescription}" />
  <meta name="robots" content="index, follow" />
  <link rel="canonical" href="https://voiceofkranti.com/authors/${author.slug}" />
  <meta property="og:type" content="profile" />
  <meta property="og:url" content="https://voiceofkranti.com/authors/${author.slug}" />
  <meta property="og:title" content="${pageTitle}" />
  <meta property="og:description" content="${metaDescription}" />
  <meta property="og:image" content="${photo}" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${pageTitle}" />
  <meta name="twitter:description" content="${metaDescription}" />
  <meta name="twitter:image" content="${photo}" />
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 52 52%22><rect width=%2252%22 height=%2252%22 rx=%229%22 fill=%22%23ff9933%22/><rect x=%2219%22 y=%225%22 width=%2214%22 height=%2222%22 rx=%227%22 fill=%22white%22/><path d=%22M 10,22 Q 10,35 26,35 Q 42,35 42,22%22 fill=%22none%22 stroke=%22white%22 stroke-width=%222.5%22 stroke-linecap=%22round%22/><line x1=%2226%22 y1=%2235%22 x2=%2226%22 y2=%2243%22 stroke=%22white%22 stroke-width=%222.5%22 stroke-linecap=%22round%22/><line x1=%2217%22 y1=%2243%22 x2=%2235%22 y2=%2243%22 stroke=%22white%22 stroke-width=%222.5%22 stroke-linecap=%22round%22/><path d=%22M 42,18 C 47,22 47,31 42,35%22 fill=%22none%22 stroke=%22white%22 stroke-opacity=%22.8%22 stroke-width=%222%22 stroke-linecap=%22round%22/></svg>">
  <link rel="stylesheet" href="/styles.css?v=21" />
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #f8fafc; color: #1f2937; }
    .container { max-width: 1100px; margin: 0 auto; padding: 0 1rem; }
    .info-page { padding: 2rem 0 4rem; }
    .info-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 18px; padding: 2rem; box-shadow: 0 10px 35px rgba(15,23,42,0.06); }
    .founder-section { display: flex; gap: 2.5rem; align-items: center; }
    .founder-photo-wrap { flex: 0 0 220px; text-align: center; }
    .founder-photo-wrap img { width: 200px; height: 200px; border-radius: 50%; object-fit: cover; object-position: center top; border: 5px solid #ff9933; box-shadow: 0 8px 30px rgba(255,153,51,0.3); }
    .founder-badge { display: inline-block; background: linear-gradient(135deg, #ff9933, #ff6b00); color: #fff; font-size: 0.78rem; font-weight: 700; padding: 0.35rem 1rem; border-radius: 20px; margin-top: 1rem; }
    .founder-info h2 { font-size: 2rem; margin: 0 0 0.5rem; color: #1f2937; }
    .founder-designation { font-size: 1.08rem; color: #4f46e5; font-weight: 600; margin: 0 0 1rem; }
    .founder-info p { color: #4a5568; line-height: 1.8; margin: 0 0 1rem; }
    .founder-stats { display: flex; gap: 1rem; flex-wrap: wrap; margin-top: 1.25rem; }
    .founder-stat { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 0.8rem 1rem; min-width: 105px; text-align: center; }
    .founder-stat-num { display: block; font-size: 1.4rem; font-weight: 800; color: #ff9933; }
    .founder-stat-lbl { font-size: 0.78rem; color: #64748b; }
    .founder-values { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-top: 1rem; }
    .founder-value-item { background: #f8fafc; border-left: 4px solid #ff9933; border-radius: 8px; padding: 1rem; }
    .founder-value-item h4 { margin: 0 0 0.35rem; }
    .founder-value-item p { margin: 0; color: #64748b; line-height: 1.7; }
    .founder-contact a { color: #4f46e5; text-decoration: none; }
    .founder-contact a:hover { text-decoration: underline; }
    @media (max-width: 640px) { .founder-section { flex-direction: column; text-align: center; } .founder-photo-wrap { flex-basis: auto; } }
  </style>
</head>
<body>
  <header class="header" style="background:linear-gradient(135deg,#ff9933,#ff6b00);padding:1rem 0;color:#fff;">
    <div class="container" style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;">
      <a href="/" style="color:#fff;text-decoration:none;font-weight:800;font-size:1.5rem;">वॉयस ऑफ क्रांति</a>
      <nav style="display:flex;gap:1rem;flex-wrap:wrap;">
        <a href="/" style="color:#fff;text-decoration:none;">होम</a>
        <a href="/authors.html" style="color:#fff;text-decoration:none;">लेखक</a>
      </nav>
    </div>
  </header>
  <main class="container info-page">
    <div class="info-card">
      <div class="founder-section">
        <div class="founder-photo-wrap">
          <img src="${photo}" alt="${authorName}" />
          <span class="founder-badge">लेखक</span>
        </div>
        <div class="founder-info">
          <h2>${authorName}</h2>
          <p class="founder-designation">लेखक — वॉयस ऑफ क्रांति</p>
          <p>${description}</p>
          <div class="founder-stats">
            <div class="founder-stat"><span class="founder-stat-num">LIVE</span><span class="founder-stat-lbl">रिपोर्टिंग</span></div>
            <div class="founder-stat"><span class="founder-stat-num">24/7</span><span class="founder-stat-lbl">अपडेट</span></div>
          </div>
        </div>
      </div>
    </div>

    <div class="info-card" style="margin-top:1.5rem;">
      <h2>लेखक का दृष्टिकोण</h2>
      <p>${authorName} की रिपोर्टिंग और संपादकीय दृष्टि तीन मूल स्तंभों पर आधारित है:</p>
      <div class="founder-values">
        <div class="founder-value-item"><h4>⚖️ सत्यनिष्ठा</h4><p>हर खबर को प्रकाशित करने से पहले उसकी सत्यता की जाँच की जाती है।</p></div>
        <div class="founder-value-item"><h4>🎯 निष्पक्षता</h4><p>किसी भी राजनीतिक दल या विचारधारा के प्रति पक्षपात नहीं।</p></div>
        <div class="founder-value-item"><h4>🤝 जनसेवा</h4><p>समाचार केवल सूचना नहीं — यह जनता की आवाज़ को बुलंद करने का माध्यम है।</p></div>
        <div class="founder-value-item"><h4>⚡ त्वरित रिपोर्टिंग</h4><p>घटनाएँ होते ही पाठकों तक पहुँचाने की प्रतिबद्धता।</p></div>
      </div>
    </div>

    <div class="info-card founder-contact" style="margin-top:1.5rem;">
      <h2>लेखक से जुड़ें</h2>
      <p>📧 संपादकीय सुझाव या प्रश्न के लिए: <a href="mailto:editor@voiceofkranti.com">editor@voiceofkranti.com</a></p>
      <p>🌐 वेबसाइट: <a href="https://voiceofkranti.com">voiceofkranti.com</a></p>
      <p>📍 भोपाल, मध्यप्रदेश, भारत</p>
    </div>
  </main>
</body>
</html>`;

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (error) {
        console.error('Author profile route error:', error);
        res.redirect(301, '/authors.html');
    }
});

app.get('/api/news/by-slug/:slug', async (req, res) => {
    try {
        if (isDevelopment && !isMongoDBConnected) {
            const allNews = readNewsData();
            const article = allNews.find(n => n.slug === req.params.slug);
            if (!article) return res.status(404).json({ error: 'Not found' });
            return res.json(article);
        }
        // Ensure DB is connected — retry if initial cold-start attempt failed
        if (!isMongoDBConnected) {
            try {
                // Keep timeout well under Vercel Hobby's 10s function limit so we always
                // return 503 (triggerable client retry) rather than a silent 504 gateway timeout
                await Promise.race([
                    connectDB(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 7000))
                ]);
            } catch (_) { /* timeout — fall through */ }
            if (!isMongoDBConnected) {
                return res.status(503).json({ error: 'DB not ready', retry: true });
            }
        }
        // Exact match first, then case-insensitive fallback
        let article = await News.findOne({ slug: req.params.slug }).lean();
        if (!article) {
            article = await News.findOne({ slug: new RegExp('^' + req.params.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }).lean();
        }
        // Last resort: search by significant words extracted from the slug
        if (!article) {
            const words = req.params.slug.split('-').filter(w => w.length >= 4);
            if (words.length >= 2) {
                const regexes = words.slice(0, 4).map(w => new RegExp(w, 'i'));
                article = await News.findOne({ $and: regexes.map(r => ({ heading: r })) }).lean();
            }
        }
        if (!article) return res.status(404).json({ error: 'Not found' });
        res.json({ ...article, id: article._id.toString() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Fetch a single article by MongoDB ObjectId (for legacy ?id= links)
app.get('/api/news/by-id/:id', async (req, res) => {
    try {
        if (!isMongoDBConnected) {
            try {
                await Promise.race([
                    connectDB(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 7000))
                ]);
            } catch (_) { /* timeout */ }
            if (!isMongoDBConnected) return res.status(503).json({ error: 'DB not ready', retry: true });
        }
        const mongoose = require('mongoose');
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ error: 'Invalid id' });
        }
        const article = await News.findById(req.params.id).lean();
        if (!article) return res.status(404).json({ error: 'Not found' });
        res.json({ ...article, id: article._id.toString() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Related articles: keyword match from heading + same category fallback
app.get('/api/news/related/:id', async (req, res) => {
    try {
        if (!isMongoDBConnected) return res.json([]);
        const current = await News.findById(req.params.id, { heading: 1, category: 1 }).lean();
        if (!current) return res.json([]);

        // Extract meaningful words (4+ chars) from the heading
        const stopWords = new Set(['\u0915\u093e','\u0915\u0947','\u0915\u0940','\u0939\u0948','\u0939\u094b','\u0928\u0947','\u0915\u094b','\u092e\u0947\u0902','\u0938\u0947','\u092a\u0930','\u0914\u0930','\u092f\u0939','\u0935\u0939','\u0907\u0938','\u0909\u0938','\u092a\u0930','\u090f\u0915','\u0926\u094b','\u0924\u0940\u0928','\u0906\u091c']);
        const words = (current.heading || '')
            .split(/[\s,।\-:]+/)
            .map(w => w.trim())
            .filter(w => w.length >= 3 && !stopWords.has(w));

        let related = [];

        // Try keyword OR-match first (at least 2 words must match)
        if (words.length >= 2) {
            const keywordRegexes = words.slice(0, 6).map(w => new RegExp(w, 'i'));
            // Find articles where heading matches any of the key words, same category preferred
            const keywordResults = await News.find(
                { _id: { $ne: current._id }, heading: { $in: keywordRegexes } },
                { heading: 1, photos: 1, slug: 1, date: 1, category: 1, content: 1 }
            ).sort({ date: -1 }).limit(8).lean();

            // Score: count how many keywords match each result's heading
            related = keywordResults
                .map(a => ({
                    ...a,
                    id: a._id.toString(),
                    score: words.filter(w => new RegExp(w, 'i').test(a.heading)).length
                }))
                .sort((a, b) => b.score - a.score)
                .slice(0, 4);
        }

        // Fallback: same category if not enough keyword matches
        if (related.length < 4) {
            const existingIds = related.map(a => a._id);
            const fallback = await News.find(
                { category: current.category, _id: { $ne: current._id, $nin: existingIds } },
                { heading: 1, photos: 1, slug: 1, date: 1, category: 1, content: 1 }
            ).sort({ date: -1 }).limit(4 - related.length).lean();
            related = [...related, ...fallback.map(a => ({ ...a, id: a._id.toString() }))];
        }

        res.json(related);
    } catch (error) {
        res.json([]);
    }
});

// ── Category landing pages: /c/:category ─────────────────────────────────────
// Serves category.html with server-side injected meta tags for each category.
app.get('/c/:category', async (req, res) => {
    const aliasMap = { apradh: 'crime' };
    const rawCatId = req.params.category;
    const catId = aliasMap[rawCatId] || rawCatId;
    const cat = CATEGORY_PAGE_INFO[catId];
    if (!cat) return res.redirect(301, '/');

    const htmlPath = path.join(__dirname, 'public', 'category.html');
    let html;
    try { html = fs.readFileSync(htmlPath, 'utf8'); }
    catch (_) { return res.redirect(301, '/'); }

    const pageUrl = `https://voiceofkranti.com/c/${catId}`;

    html = html
        .replace(/(<title[^>]*>)[^<]*(<\/title>)/,                         `$1${cat.title}$2`)
        .replace(/(<meta id="meta-description"[^>]*content=")[^"]*(")/,    `$1${cat.metaDesc}$2`)
        .replace(/(<meta id="meta-canonical"[^>]*content=")[^"]*(")/,      `$1${pageUrl}$2`)
        .replace(/(<link id="link-canonical"[^>]*href=")[^"]*(")/,         `$1${pageUrl}$2`)
        .replace(/(<meta id="og-title"[^>]*content=")[^"]*(")/,            `$1${cat.title}$2`)
        .replace(/(<meta id="og-description"[^>]*content=")[^"]*(")/,      `$1${cat.metaDesc}$2`)
        .replace(/(<meta id="og-url"[^>]*content=")[^"]*(")/,              `$1${pageUrl}$2`)
        .replace(/(<meta id="cat-id"[^>]*content=")[^"]*(")/,              `$1${catId}$2`);

    // Server-render the first 10 article cards as real <a href> links so
    // Googlebot-News sees crawlable HTML links without needing to run JS.
    try {
        if (isMongoDBConnected) {
            const projection = { heading: 1, content: 1, category: 1, photos: 1, date: 1, slug: 1, rssSource: 1, author: 1, isPermanent: 1, full: 1 };
            const docs = await News.find({ category: catId, isOriginal: { $ne: true } }, projection)
                .sort({ date: -1 })
                .limit(40)
                .lean();
            const authorNameSet = await getAuthorNameSet();
            const ranked = enforcePbShabdCap(docs, authorNameSet, 10, 0.5).slice(0, 10);
            if (ranked.length > 0) {
                const cardsHtml = ranked.map(a => renderCategoryCardSSR({ ...a, id: a._id.toString() }, cat)).join('\n');
                html = html.replace(
                    /<div id="newsGrid" class="news-grid">[\s\S]*?<\/div>\s*(?=<div id="scrollSentinel")/,
                    `<div id="newsGrid" class="news-grid" data-ssr-count="${ranked.length}">${cardsHtml}</div>\n        `
                );
            }
        }
    } catch (err) {
        console.error('Category SSR card render failed:', err.message);
        // Fall through — client-side fetch in category.html still renders the grid.
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
});
// ─────────────────────────────────────────────────────────────────────────────

// 301 redirect: /news-detail.html?id=xxx → /news/:slug (avoid duplicate content)
app.get('/news-detail.html', async (req, res, next) => {
    const id = req.query.id;
    if (!id || !isMongoDBConnected) return next();
    try {
        const article = await News.findById(id, { slug: 1 }).lean();
        if (article && article.slug) {
            return res.redirect(301, `/news/${article.slug}`);
        }
    } catch (_) { /* invalid id — fall through to static */ }
    return next();
});

// Static files — no cache for HTML, 1-day cache for assets (CSS/JS/images versioned by ?v=)
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: 0,
    etag: true,
    setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) {
            // Always revalidate HTML so CSS/JS version bumps are picked up instantly
            res.setHeader('Cache-Control', 'no-cache');
        } else if (/\.(css|js|png|jpg|jpeg|webp|gif|svg|ico|woff2?)$/.test(filePath)) {
            // Assets — 7 days (versioned via ?v= query string in HTML)
            res.setHeader('Cache-Control', 'public, max-age=604800');
        }
    }
}));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { maxAge: '7d', etag: true }));

const mediaCloudinaryUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: function (req, file, cb) {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        if (mimetype && extname) return cb(null, true);
        cb(new Error('Only image files are allowed in Cloudinary media uploads!'));
    }
});

app.post('/api/media/upload-cloudinary', requireAuth, mediaCloudinaryUpload.single('mediaFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No image file received' });
        }

        if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
            return res.status(500).json({ error: 'Cloudinary is not configured in this environment.' });
        }

        const result = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                {
                    folder: 'janta-ka-sandesh/media',
                    transformation: [{ quality: 'auto', fetch_format: 'auto' }]
                },
                (error, uploadResult) => {
                    if (error) return reject(error);
                    resolve(uploadResult);
                }
            );
            stream.end(req.file.buffer);
        });

        res.json({ success: true, url: result.secure_url, publicId: result.public_id });
    } catch (error) {
        console.error('Cloudinary media upload error:', error);
        res.status(500).json({ error: error.message || 'Cloudinary media upload failed' });
    }
});

// ── Dynamic sitemap including all live news articles ──────────────────────────
// Google News sitemap best practice: only articles published in the last 2 days,
// capped at 1000 URLs. Older/all articles live in the general /sitemap.xml instead.
app.get('/sitemap-news.xml', async (req, res) => {
    try {
        // Wait for DB on cold start (up to 8s)
        if (!isMongoDBConnected) {
            try {
                await Promise.race([
                    connectDB(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
                ]);
            } catch (e) {
                return res.status(503).set('Content-Type', 'text/plain').send('Sitemap unavailable during cold start, please retry.');
            }
        }

        let newsUrls = [];
        if (isMongoDBConnected) {
            // Only include articles with slugs — ?id= URLs are redirects and cause
            // "Page with redirect" warnings in Google Search Console
            const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
            const articles = await News.find(
                { slug: { $exists: true, $ne: '' }, date: { $gte: twoDaysAgo } },
                { _id: 1, slug: 1, date: 1, heading: 1 }
            ).sort({ date: -1 }).limit(1000).lean();
            newsUrls = articles.map(a => ({
                loc: `https://voiceofkranti.com/news/${a.slug}`,
                lastmod: a.date ? new Date(a.date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
                pubDate: a.date ? new Date(a.date).toISOString() : new Date().toISOString(),
                // Strip XML-invalid control characters (U+0001–U+0008, U+000B, U+000C, U+000E–U+001F, U+FFFE, U+FFFF)
                title: (a.heading || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            }));
        }

        // Google News format: news articles only, no static pages
        const newsXml = newsUrls.map(p => `  <url>
    <loc>${p.loc}</loc>
    <lastmod>${p.lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
    <news:news>
      <news:publication>
        <news:name>वॉयस ऑफ क्रांति</news:name>
        <news:language>hi</news:language>
      </news:publication>
      <news:publication_date>${p.pubDate}</news:publication_date>
      <news:title>${p.title}</news:title>
    </news:news>
  </url>`).join('\n');

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
${newsXml}
</urlset>`;

        res.set('Content-Type', 'application/xml');
        res.set('Cache-Control', 'public, max-age=3600');
        res.send(xml);
    } catch (err) {
        res.status(500).send('Sitemap error');
    }
});

// General sitemap: full canonical article archive (no news: tags, no age limit) —
// this is what Google indexes for long-tail/older articles once they age out of
// the news sitemap above.
app.get('/sitemap.xml', async (req, res) => {
    try {
        if (!isMongoDBConnected) {
            try {
                await Promise.race([
                    connectDB(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
                ]);
            } catch (e) {
                return res.status(503).set('Content-Type', 'text/plain').send('Sitemap unavailable during cold start, please retry.');
            }
        }

        let urls = [];
        if (isMongoDBConnected) {
            const articles = await News.find(
                { slug: { $exists: true, $ne: '' } },
                { _id: 1, slug: 1, date: 1 }
            ).sort({ date: -1 }).limit(50000).lean();
            urls = articles.map(a => ({
                loc: `https://voiceofkranti.com/news/${a.slug}`,
                lastmod: a.date ? new Date(a.date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]
            }));
        }

        const staticUrls = [
            { loc: 'https://voiceofkranti.com/', priority: '1.0' },
            { loc: 'https://voiceofkranti.com/latest', priority: '0.8' },
            { loc: 'https://voiceofkranti.com/about.html', priority: '0.5' },
        ];
        const categoryUrls = Object.keys(CATEGORY_PAGE_INFO)
            .filter(k => k !== 'apradh') // alias of 'crime', avoid duplicate canonical URL
            .map(k => ({ loc: `https://voiceofkranti.com/c/${k}`, priority: '0.7' }));

        const today = new Date().toISOString().split('T')[0];
        const staticXml = [...staticUrls, ...categoryUrls].map(p => `  <url>
    <loc>${p.loc}</loc>
    <lastmod>${today}</lastmod>
    <priority>${p.priority}</priority>
  </url>`).join('\n');

        const urlsXml = urls.map(p => `  <url>
    <loc>${p.loc}</loc>
    <lastmod>${p.lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>`).join('\n');

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticXml}
${urlsXml}
</urlset>`;

        res.set('Content-Type', 'application/xml');
        res.set('Cache-Control', 'public, max-age=3600');
        res.send(xml);
    } catch (err) {
        res.status(500).send('Sitemap error');
    }
});

app.get('/news-sitemap.xml', async (req, res) => {
    return app._router.handle({
        method: 'GET',
        url: '/sitemap-news.xml',
        headers: req.headers,
        query: req.query,
        params: req.params,
        body: req.body,
        get: req.get.bind(req),
        originalUrl: req.originalUrl,
        socket: req.socket
    }, res);
});

app.get('/sitemap-index.xml', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://voiceofkranti.com/sitemap.xml</loc>
    <lastmod>${today}</lastmod>
  </sitemap>
  <sitemap>
    <loc>https://voiceofkranti.com/sitemap-news.xml</loc>
    <lastmod>${today}</lastmod>
  </sitemap>
</sitemapindex>`;
    res.set('Content-Type', 'application/xml');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(xml);
});

// Configure multer for Cloudinary uploads
const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'janta-ka-sandesh',
        allowed_formats: ['jpeg', 'jpg', 'png', 'gif', 'webp'],
        transformation: [{ width: 1200, height: 800, crop: 'limit' }]
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: function (req, file, cb) {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only image files are allowed!'));
        }
    }
});

// Authentication middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.isAuthenticated) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized. Please login.' });
    }
}

// Routes
app.get('/', async (req, res) => {
    try {
        let initialNews = [];
        if (isMongoDBConnected) {
            const projection = { heading: 1, content: 1, category: 1, author: 1, photos: 1, date: 1, formattedDate: 1, rssLink: 1, isPermanent: 1, isOriginal: 1, slug: 1 };
            const docs = await News.find({ isOriginal: { $ne: true } }, projection).sort({ date: -1 }).limit(200).lean();
            initialNews = docs.map(d => ({ ...d, id: d._id.toString() }));
        }
        let html = require('fs').readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
        // Inject pre-fetched news so the page renders instantly without a client-side API call
        const payload = JSON.stringify(initialNews).replace(/<\/script>/gi, '<\\/script>');
        html = html.replace('</head>', `<script>window.__INITIAL_NEWS__=${payload};</script></head>`);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (err) {
        // Fall back to static file if SSR fails
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/admin', (req, res) => {
    if (req.session && req.session.isAuthenticated) {
        res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    } else {
        res.redirect('/login');
    }
});

// Contact Form API
app.post('/api/contact', (req, res) => {
    const { name, email, subject, message } = req.body;
    if (!name || !email || !subject || !message) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    // Basic email format validation
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(email)) {
        return res.status(400).json({ error: 'Invalid email' });
    }
    // Log contact (replace with email sending in production)
    console.log(`[Contact] From: ${name} <${email}> | Subject: ${subject} | Message: ${message.substring(0, 100)}`);
    res.json({ success: true });
});

// Login API
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        req.session.regenerate((err) => {
            if (err) {
                console.error('Session regenerate error:', err);
                return res.status(500).json({ error: 'Session initialization failed' });
            }
            
            req.session.isAuthenticated = true;
            req.session.username = username;
            
            req.session.save((err) => {
                if (err) {
                    console.error('Session save error:', err);
                    return res.status(500).json({ error: 'Session save failed' });
                }
                console.log('✓ Session saved successfully for user:', username);
                res.json({ success: true, message: 'Login successful' });
            });
        });
    } else {
        res.status(401).json({ error: 'Invalid username or password' });
    }
});

// Logout API
app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            res.status(500).json({ error: 'Logout failed' });
        } else {
            res.json({ success: true, message: 'Logged out successfully' });
        }
    });
});

// Check auth status
app.get('/api/auth/status', (req, res) => {
    console.log('Auth check - Session exists:', !!req.session);
    console.log('Auth check - isAuthenticated:', req.session?.isAuthenticated);
    res.json({ 
        isAuthenticated: req.session && req.session.isAuthenticated === true 
    });
});

// Change password API (requires login)
app.post('/api/change-password', requireAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Current and new password are required' });
    }
    
    if (currentPassword !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Current password is incorrect' });
    }
    
    if (newPassword.length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    
    // In production, password changes require environment variable updates on the hosting platform
    if (process.env.NODE_ENV === 'production') {
        return res.status(400).json({ 
            error: 'Password changes in production must be done through environment variables on your hosting platform (e.g., Render dashboard).' 
        });
    }
    
    // Update .env file (local development only)
    const envPath = path.join(__dirname, '.env');
    try {
        let envContent = fs.readFileSync(envPath, 'utf8');
        envContent = envContent.replace(/ADMIN_PASSWORD=.*/g, `ADMIN_PASSWORD=${newPassword}`);
        fs.writeFileSync(envPath, envContent);
        
        res.json({ 
            success: true, 
            message: 'Password changed successfully. Please restart server for changes to take effect.' 
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update password. Please update ADMIN_PASSWORD in environment variables manually.' });
    }
});

// Simple in-memory cache for news list (60 s TTL — short to stay in sync across Vercel instances)
const newsCache = new Map(); // key: category|all, value: { data, expires }
const NEWS_CACHE_TTL = 60 * 1000; // 60 seconds
function invalidateNewsCache() { newsCache.clear(); }

app.post('/api/fix-imported-content', requireAuth, async (req, res) => {
    try {
        const dryRun = req.body?.dryRun === true || req.query.dryRun === 'true';
        const limit = Math.min(Math.max(parseInt(req.body?.limit || req.query.limit || '200', 10) || 200, 1), 1000);
        const result = await repairLegacyImportedArticles({ dryRun, limit });
        if (!dryRun) invalidateNewsCache();
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('Error repairing imported content:', error);
        res.status(500).json({ error: 'Failed to repair imported content', details: error.message });
    }
});

// API to get all news
app.get('/api/news', async (req, res) => {
    try {
        const category = req.query.category;
        const writtenOnly = req.query.written === 'true';
        const source = req.query.source;
        const fullOnly = req.query.full === 'true' || req.query.full === '1';
        const hours = parseFloat(req.query.hours) || null;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
        const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
        const cacheAllowed = !source && !fullOnly && !req.query.limit && !req.query.skip && !hours;
        const cacheKey = source === 'pb' ? 'pb' : (fullOnly ? 'full' : (writtenOnly ? 'written' : (category || 'all')));

        // Use JSON file in development if MongoDB is not connected
        if (isDevelopment && !isMongoDBConnected) {
            const newsData = readNewsData();
            const filtered = newsData.filter(news => {
                if (news.isOriginal && !writtenOnly) return false;
                if (writtenOnly && !news.isOriginal) return false;
                if (fullOnly && news.full !== true) return false;
                if (source === 'pb' && news.rssSource !== 'PB SHABD') return false;
                if (category && news.category !== category) return false;
                if (hours && new Date(news.date) < new Date(Date.now() - hours * 60 * 60 * 1000)) return false;
                return true;
            });
            const sorted = filtered.sort((a, b) => new Date(b.date) - new Date(a.date));
            const paged = sorted.slice(skip, skip + limit);
            // No DB in this fallback mode, so the "real author" tier can't be checked here.
            return res.json((category && !writtenOnly && skip === 0) ? enforcePbShabdCap(paged, new Set(), 10, 0.5) : paged);
        }

        // On cold start retry DB connection; return 503 if still not ready so client retries quickly.
        if (!isMongoDBConnected) {
            try {
                await Promise.race([
                    connectDB(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 25000))
                ]);
            } catch (_) { /* timeout — fall through to 503 below */ }
            if (!isMongoDBConnected) {
                return res.status(503).json({ error: 'DB not ready', retry: true });
            }
        }

        if (cacheAllowed) {
            const cached = newsCache.get(cacheKey);
            if (cached && cached.expires > Date.now()) {
                res.set('X-Cache', 'HIT');
                return res.json(cached.data);
            }
        }

        let query = {};
        if (writtenOnly) {
            query = { isOriginal: true };
        } else if (category) {
            query = { category, isOriginal: { $ne: true } };
        } else {
            query = { isOriginal: { $ne: true } };
        }
        if (fullOnly) {
            query.$or = [
                { full: true },
                {
                    $expr: {
                        $gt: [
                            { $strLenCP: { $trim: { input: { $ifNull: ['$content', ''] } } } },
                            600
                        ]
                    }
                }
            ];
        }
        if (source === 'pb') {
            query.$or = [
                { rssSource: 'PB SHABD' },
                { rssSource: 'PB SHABD ' },
                { author: 'PB SHABD' },
                { author: 'PB SHABD ' }
            ];
        }
        if (hours) {
            const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
            query.date = { $gte: cutoff };
        }
        const projection = { heading: 1, content: 1, category: 1, author: 1, photos: 1, date: 1, formattedDate: 1, rssLink: 1, isPermanent: 1, isOriginal: 1, slug: 1, rssSource: 1, full: 1 };

        const news = await News.find(query, projection)
            .sort({ date: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        const newsData = news.map(item => ({
            ...item,
            full: item.full === true || isFullArticleContent(String(item.content || '')),
            id: item._id.toString()
        }));

        // Category "Top 10" priority order: isPermanent/real-author first, then PB
        // SHABD (capped at 50%), then full-tagged, then everything else — reorders
        // only, no article is ever removed.
        const finalNewsData = (category && !writtenOnly && skip === 0)
            ? enforcePbShabdCap(newsData, await getAuthorNameSet(), 10, 0.5)
            : newsData;

        if (cacheAllowed && finalNewsData.length > 0) {
            newsCache.set(cacheKey, { data: finalNewsData, expires: Date.now() + NEWS_CACHE_TTL });
        }
        res.set('X-Cache', 'MISS');
        res.json(finalNewsData);
    } catch (error) {
        console.error('Error fetching news:', error);
        res.status(500).json({ error: 'Failed to fetch news' });
    }
});

// Search API: searches heading, content, category, author
app.get('/api/news/search', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json([]);
    // Escape regex special chars to prevent ReDoS
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    try {
        if (!isMongoDBConnected) {
            try {
                await Promise.race([
                    connectDB(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 25000))
                ]);
            } catch (_) {}
            if (!isMongoDBConnected) return res.status(503).json({ error: 'DB not ready' });
        }
        const results = await News.find(
            { $or: [{ heading: regex }, { content: regex }, { category: regex }, { author: regex }] },
            { heading: 1, category: 1, author: 1, photos: 1, date: 1, slug: 1, rssSource: 1, content: 1, formattedDate: 1, isPermanent: 1, isOriginal: 1, views: 1 }
        ).sort({ date: -1 }).limit(1000).lean();
        res.json(results.map(r => ({ ...r, id: r._id.toString() })));
    } catch (e) {
        console.error('Search error:', e);
        res.status(500).json({ error: 'Search failed' });
    }
});

// API to add news (admin only)
app.post('/api/news', requireAuth, upload.array('photos', 5), async (req, res) => {
    try {
        const { heading, content, category, author } = req.body;
        
        if (!heading || !content || !category || !author) {
            return res.status(400).json({ error: 'Heading, content, category and author are required' });
        }

        // Optional manual slug — sanitize to lowercase a-z, 0-9, hyphens only, max 80 chars
        const rawSlug = (req.body.manualSlug || '').trim();
        const cleanSlug = rawSlug
            ? rawSlug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
            : '';

        // Support external image URL (from scraper) when no file is uploaded.
        // Upload to Cloudinary so og:image always works for WhatsApp/X sharing.
        let photos = req.files ? req.files.map(file => file.path) : [];
        if (photos.length === 0 && req.body.photoUrl) {
            const externalUrl = req.body.photoUrl;
            if (externalUrl.includes('res.cloudinary.com')) {
                photos = [externalUrl];
            } else {
                try {
                    const result = await cloudinary.uploader.upload(externalUrl, {
                        folder: 'news',
                        transformation: [{ width: 1200, height: 630, crop: 'fill', format: 'jpg', quality: 'auto' }]
                    });
                    photos = [result.secure_url];
                } catch (uploadErr) {
                    console.warn('Cloudinary upload of external image failed, storing URL directly:', uploadErr.message);
                    photos = [externalUrl];
                }
            }
        }

        if (photos.length === 0) {
            const inlinePhotos = extractInlineArticlePhotoUrls(content);
            if (inlinePhotos.length > 0) {
                photos = inlinePhotos;
            }
        }

        const newsData = {
            heading,
            content,
            category,
            author,
            ...(cleanSlug ? { slug: cleanSlug } : {}),
            // AI-scraper articles pass these so the source name renders as a real,
            // clickable credit link (same template used for RSS/API imports).
            ...(req.body.rssSource ? { rssSource: req.body.rssSource.trim() } : {}),
            ...(req.body.rssLink ? { rssLink: req.body.rssLink.trim() } : {}),
            isAiScraped: req.body.isAiScraped === 'true',
            photos,
            date: new Date(),
            views: 0,
            isPermanent: req.body.isPermanent === 'true',
            isOriginal: req.body.isOriginal === 'true',
            formattedDate: new Date().toLocaleDateString('hi-IN', { 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric' 
            })
        };

        // Use JSON file in development if MongoDB is not connected
        if (isDevelopment && !isMongoDBConnected) {
            const allNews = readNewsData();
            const newId = Date.now().toString();
            const newNewsItem = { ...newsData, id: newId };
            allNews.push(newNewsItem);
            writeNewsData(allNews);
            return res.json({ success: true, news: newNewsItem });
        }

        const newNews = new News(newsData);
        await newNews.save();
        invalidateNewsCache();

        res.json({ 
            success: true, 
            news: {
                ...newNews.toObject(),
                id: newNews._id.toString()
            }
        });
    } catch (error) {
        console.error('Error adding news:', error);
        res.status(500).json({ error: error.message });
    }
});

// API to update news (admin only)
app.put('/api/news/:id', requireAuth, upload.array('photos', 5), async (req, res) => {
    try {
        const { heading, content, category, author, keepExistingPhotos } = req.body;
        
        if (!heading || !content || !category || !author) {
            return res.status(400).json({ error: 'Heading, content, category and author are required' });
        }

        // Use JSON file in development if MongoDB is not connected
        if (isDevelopment && !isMongoDBConnected) {
            const allNews = readNewsData();
            const newsIndex = allNews.findIndex(n => n.id === req.params.id);
            
            if (newsIndex === -1) {
                return res.status(404).json({ error: 'News not found' });
            }
            
            const nextPhotos = req.files && req.files.length > 0
                ? req.files.map(file => file.path)
                : (req.body.photoUrl ? [req.body.photoUrl] : extractInlineArticlePhotoUrls(content));

            allNews[newsIndex] = {
                ...allNews[newsIndex],
                heading,
                content,
                category,
                author,
                photos: nextPhotos.length > 0 ? nextPhotos : allNews[newsIndex].photos,
                formattedDate: new Date().toLocaleDateString('hi-IN', { 
                    year: 'numeric', 
                    month: 'long', 
                    day: 'numeric' 
                })
            };
            
            writeNewsData(allNews);
            return res.json({ success: true, news: allNews[newsIndex] });
        }

        const news = await News.findById(req.params.id);
        
        if (!news) {
            return res.status(404).json({ error: 'News not found' });
        }

        news.heading = heading;
        news.content = content;
        news.category = category;
        news.author = author;
        news.isPermanent = req.body.isPermanent === 'true';
        news.isOriginal = req.body.isOriginal === 'true';
        news.formattedDate = new Date().toLocaleDateString('hi-IN', { 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
        });

        // Allow updating the slug manually (only if a clean value is provided)
        const rawSlugEdit = (req.body.manualSlug || '').trim();
        const cleanSlugEdit = rawSlugEdit
            ? rawSlugEdit.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
            : '';
        if (cleanSlugEdit && cleanSlugEdit !== news.slug) {
            news.slug = cleanSlugEdit;
        }

        let updatedPhotos = [];
        if (req.files && req.files.length > 0) {
            updatedPhotos = req.files.map(file => file.path);
        } else if (req.body.photoUrl) {
            updatedPhotos = [req.body.photoUrl];
        } else {
            updatedPhotos = extractInlineArticlePhotoUrls(content);
        }

        if (updatedPhotos.length > 0) {
            if (req.files && req.files.length > 0 && !keepExistingPhotos) {
                await deleteCloudinaryPhotos(news.photos);
            }
            news.photos = updatedPhotos;
        }
        
        await news.save();
        invalidateNewsCache();
        
        res.json({ 
            success: true, 
            news: {
                ...news.toObject(),
                id: news._id.toString()
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API to increment view count
app.put('/api/news/:id/view', async (req, res) => {
    try {
        // Use JSON file in development if MongoDB is not connected
        if (isDevelopment && !isMongoDBConnected) {
            const allNews = readNewsData();
            const newsIndex = allNews.findIndex(n => n.id === req.params.id);
            
            if (newsIndex === -1) {
                return res.status(404).json({ error: 'News not found' });
            }
            
            allNews[newsIndex].views = (allNews[newsIndex].views || 0) + 1;
            writeNewsData(allNews);
            return res.json({ success: true, views: allNews[newsIndex].views });
        }
        
        const news = await News.findByIdAndUpdate(
            req.params.id,
            { $inc: { views: 1 } },
            { new: true }
        );
        
        if (!news) {
            return res.status(404).json({ error: 'News not found' });
        }

        // Track city asynchronously — don't delay the response
        const clientIp = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
        getCityFromIP(clientIp).then(city => {
            if (city && isMongoDBConnected) {
                mongoose.connection.db.collection('cityviews').updateOne(
                    { city },
                    { $inc: { count: 1 }, $set: { updatedAt: new Date() } },
                    { upsert: true }
                ).catch(() => {});
            }
        }).catch(() => {});

        res.json({ success: true, views: news.views });
    } catch (error) {
        console.error('Error incrementing views:', error);
        res.status(500).json({ error: error.message });
    }
});

// API to delete news (admin only)
app.delete('/api/news/:id', requireAuth, async (req, res) => {
    try {
        // Use JSON file in development if MongoDB is not connected
        if (isDevelopment && !isMongoDBConnected) {
            const allNews = readNewsData();
            const newsIndex = allNews.findIndex(n => n.id === req.params.id);
            
            if (newsIndex === -1) {
                return res.status(404).json({ error: 'News not found' });
            }
            
            allNews.splice(newsIndex, 1);
            writeNewsData(allNews);
            return res.json({ success: true });
        }
        
        const news = await News.findById(req.params.id);
        
        if (!news) {
            return res.status(404).json({ error: 'News not found' });
        }
        
        // Delete photos from Cloudinary if exist
        await deleteCloudinaryPhotos(news.photos);

        // Save slug to Redirect so the old URL 301-redirects to homepage
        if (news.slug) {
            await Redirect.updateOne(
                { from: news.slug },
                { $setOnInsert: { from: news.slug, to: '/' } },
                { upsert: true }
            ).catch(() => {});  // non-fatal
        }

        await News.findByIdAndDelete(req.params.id);
        invalidateNewsCache();
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting news:', error);
        res.status(500).json({ error: error.message });
    }
});

// API to manually trigger RSS + API import (admin only)
app.post('/api/admin/fetch-rss', requireAuth, async (req, res) => {
    try {
        const count = await fetchAllNews();
        invalidateNewsCache(); // clear cache so homepage shows fresh news immediately
        res.json({ success: true, imported: count, message: `${count} नए लेख आयात किए गए` });
    } catch (error) {
        console.error('Manual fetch error:', error);
        res.status(500).json({ error: 'Fetch failed: ' + error.message });
    }
});

// Manual trigger: fetch fresh articles from NewsData.io API
app.post('/api/admin/fetch-newsdata', requireAuth, async (req, res) => {
    try {
        if (!process.env.NEWSDATA_API_KEY) return res.status(503).json({ error: 'NEWSDATA_API_KEY not set' });
        const count = await fetchFromNewsDataAPI();
        invalidateNewsCache();
        res.json({ success: true, imported: count, message: `${count} नए लेख NewsData.io से आयात किए गए` });
    } catch (error) {
        console.error('NewsData fetch error:', error);
        res.status(500).json({ error: 'Fetch failed: ' + error.message });
    }
});

// Manual trigger: fetch fresh articles from GNews API
app.post('/api/admin/fetch-gnews', requireAuth, async (req, res) => {
    try {
        if (!process.env.GNEWS_API_KEY) return res.status(503).json({ error: 'GNEWS_API_KEY not set' });
        const count = await fetchFromGNewsAPI();
        invalidateNewsCache();
        res.json({ success: true, imported: count, message: `${count} नए लेख GNews से आयात किए गए` });
    } catch (error) {
        console.error('GNews fetch error:', error);
        res.status(500).json({ error: 'Fetch failed: ' + error.message });
    }
});

// Manual trigger: fetch fresh articles from Currents API
app.post('/api/admin/fetch-currents', requireAuth, async (req, res) => {
    try {
        if (!process.env.CURRENTS_API_KEY) return res.status(503).json({ error: 'CURRENTS_API_KEY not set' });
        const count = await fetchFromCurrentsAPI();
        invalidateNewsCache();
        res.json({ success: true, imported: count, message: `${count} नए लेख Currents से आयात किए गए` });
    } catch (error) {
        console.error('Currents fetch error:', error);
        res.status(500).json({ error: 'Fetch failed: ' + error.message });
    }
});

// Public API: Aaj Ka Itihas articles (latest first, limited to 60, one per day)
app.get('/api/aaj-ka-itihas', async (req, res) => {
    try {
        if (!isMongoDBConnected) return res.json([]);
        const raw = await News.find(
            { isAajKaItihas: true },
            { heading: 1, content: 1, date: 1, formattedDate: 1, slug: 1 }
        ).sort({ date: -1 }).limit(120).lean();
        // Deduplicate: keep only one article per calendar day (newest)
        const seen = new Set();
        const articles = raw.filter(a => {
            const day = new Date(a.date).toDateString();
            if (seen.has(day)) return false;
            seen.add(day);
            return true;
        }).slice(0, 60);
        res.json(articles.map(a => ({ ...a, id: a._id.toString() })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Public API: Weekly roundup articles (latest 20)
app.get('/api/weekly-roundup', async (req, res) => {
    try {
        if (!isMongoDBConnected) return res.json([]);
        const articles = await News.find(
            { isOriginal: true, heading: { $regex: /^साप्ताहिक समीक्षा:/i } },
            { heading: 1, content: 1, date: 1, formattedDate: 1, slug: 1 }
        ).sort({ date: -1 }).limit(20).lean();
        res.json(articles.map(a => ({ ...a, id: a._id.toString() })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: manually trigger Aaj Ka Itihas generation
app.post('/api/admin/generate-aaj-ka-itihas', requireAuth, async (req, res) => {
    try {
        if (!isMongoDBConnected) return res.status(503).json({ error: 'MongoDB not connected' });
        if (!process.env.MISTRAL_API_KEY) return res.status(503).json({ error: 'MISTRAL_API_KEY not set' });
        // Force regeneration: remove today’s existing article first if force=true
        if (req.body.force === 'true') {
            const today = new Date();
            const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
            const endOfDay   = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
            await News.deleteOne({ isAajKaItihas: true, date: { $gte: startOfDay, $lt: endOfDay } });
        }
        const article = await generateAajKaItihas();
        if (!article) return res.status(500).json({ error: 'लेख नहीं बन सका, दोबारा कोशिश करें' });
        invalidateNewsCache();
        res.json({ success: true, message: `✅ आज का इतिहास प्रकाशित: "${article.heading.slice(0, 60)}..."` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ── URL Scraper: extract headline / image / text from any news URL ────────────
// Uses OG meta tags + paragraph text. No external scraping library needed.
// Returns raw extracted data; optionally rewrites content via Groq.
app.post('/api/admin/scrape-url', requireAuth, async (req, res) => {
    const { url, rewrite } = req.body;
    if (!url || !/^https?:\/\/.+/.test(url)) {
        return res.status(400).json({ error: 'Valid URL required' });
    }
    try {
        const html = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'hi-IN,hi;q=0.9,en;q=0.8',
            },
            signal: AbortSignal.timeout(15000),
        }).then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.text();
        });

        // Helper: decode HTML entities
        const decode = s => s
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
            .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));

        const meta = (prop) => {
            const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
                      || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'));
            return m ? decode(m[1].trim()) : '';
        };

        const ogTitle    = meta('og:title')       || meta('twitter:title');
        const ogDesc     = meta('og:description') || meta('twitter:description');
        const ogImage    = meta('og:image')        || meta('twitter:image');
        const ogSite     = meta('og:site_name')    || new URL(url).hostname.replace('www.', '');
        const h1Match    = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
        const h1         = h1Match ? decode(h1Match[1].replace(/<[^>]+>/g, '').trim()) : '';
        const heading    = ogTitle || h1;

        // Strip known noise sections before extracting paragraphs
        const GARBAGE_PATTERNS = /cookie|privacy policy|terms of use|all rights reserved|subscribe|newsletter|advertisement|follow us|share this|whatsapp|telegram|download app|click here|read more|also read|related news|ताज़ा खबरें|और पढ़ें|शेयर करें|सब्सक्राइब/i;
        let bodyHtml = html;
        // Prefer article/main content area over whole page
        const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
            || html.match(/<div[^>]*class="[^"]*(?:story|article|content|post|entry|detail)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        if (articleMatch) bodyHtml = articleMatch[1];
        // Remove noise tags entirely
        bodyHtml = bodyHtml.replace(/<(nav|header|footer|aside|script|style|noscript|form|figure|figcaption|button|iframe)[^>]*>[\s\S]*?<\/\1>/gi, '');
        bodyHtml = bodyHtml.replace(/<div[^>]*class="[^"]*(?:ad|share|social|related|sidebar|cookie|banner|tags|breadcrumb|popup|modal|widget|promo)[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');

        // Extract up to 15 paragraphs, filter garbage, take best 10
        const pMatches = [...bodyHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)];
        const paragraphs = pMatches
            .map(m => decode(m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()))
            .filter(p => p.length > 60 && !GARBAGE_PATTERNS.test(p))
            .slice(0, 15);

        const rawText = paragraphs.join('\n\n') || ogDesc;

        // If rewrite=true, rewrite full news in Hindi with 10 detailed paragraphs
        let content = rawText;
        if (rewrite && process.env.GROQ_API_KEY && rawText) {
            const prompt = `तुम "वॉयस ऑफ क्रांति" के वरिष्ठ समाचार संपादक हो।
नीचे "${ogSite}" की एक खबर का मूल पाठ दिया है। इसे एक पूर्ण, स्वतंत्र हिंदी समाचार लेख के रूप में लिखो।

सख्त नियम:
- केवल उपलब्ध तथ्य लिखो; किसी भी सूचना को कल्पना या जोड़ना मत.
- अगर मूल खबर में किसी तथ्य का उल्लेख नहीं है, तो उसे न लिखो; "जानकारी उपलब्ध नहीं" लिखो.
- अगर खबर आपराधिक/आपराधिक घटना से संबंधित है, तो नीचे दिए गए सभी घटक अलग-अलग स्पष्ट रूप से शामिल करो:
  1) आरोपी/आरोपी का नाम (अगर हो)
  2) अपराध का उद्देश्य/उद्देश्य/मोटिव (अगर हो)
  3) पीड़ित/शिकार का नाम (अगर हो)
  4) पुलिस का कथित/version/पुलिस का विवरण (अगर हो)
  5) घटना का विस्तृत वर्णन (क्या हुआ, कब, कहाँ, कैसे)
- अन्य महत्वपूर्ण तथ्य भी जोड़ें: नाम, स्थान, समय, संख्या, मंशा, कथित कारण, शिकायत, गिरफ्तारी, मेडिकल रिपोर्ट, बयान आदि (अगर मूल में हैं)
- ठीक 10 पैराग्राफ लिखो (900-1200 शब्द)
- पहला पैराग्राफ: मुख्य घटना, 5W1H
- दूसरा से पाँचवाँ पैराग्राफ: विस्तृत वर्णन, आरोप, कारण, पीड़ित, दृश्य, समय, स्थान
- छठा से आठवाँ पैराग्राफ: पुलिस बयान, जांच, प्रतिक्रिया, दस्तावेज़, गिरफ्तारी, प्रारंभिक तथ्य
- नौवाँ पैराग्राफ: सामाजिक/प्रशासनिक प्रभाव या背景
- दसवाँ पैराग्राफ: निष्कर्ष, स्थिति, आगे की संभावना
- अपने शब्दों में लिखो — सीधे कॉपी न करो
- सरल, स्पष्ट, पत्रकारिता-शैली हिंदी में लिखो
- किसी भी तथ्य को भ्रमित करने वाले शब्द या अनुमानित विवरण से बचो

मूल पाठ:
${rawText.slice(0, 4000)}

JSON में जवाब दो: { "content": "पूरा हिंदी लेख (10 पैराग्राफ)" }`;
            try {
                const raw = await callGroq(prompt, 1800, 'openai/gpt-oss-120b', 0.3);
                const parsed = JSON.parse(raw);
                if (parsed.content) content = parsed.content;
            } catch (_) { /* keep rawText on Groq failure */ }
        }
        // Source credit is rendered separately via rssSource/rssLink (real <a> tag) —
        // not embedded as text here, since AI-generated markdown formatting is unreliable.

        res.json({ heading, content, image: ogImage, sourceUrl: url, sourceName: ogSite, desc: ogDesc });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ─────────────────────────────────────────────────────────────────────────────

// Manual trigger: generate one original editorial article via Mistral
app.post('/api/admin/generate-daily-article', requireAuth, async (req, res) => {
    try {
        if (!isMongoDBConnected) return res.status(503).json({ error: 'MongoDB not connected' });
        if (!process.env.MISTRAL_API_KEY) return res.status(503).json({ error: 'MISTRAL_API_KEY not set' });
        const article = await generateDailyArticle();
        if (!article) return res.status(500).json({ error: 'लेख नहीं बन सका, दोबारा कोशिश करें' });
        invalidateNewsCache();
        res.json({ success: true, message: `✅ लेख प्रकाशित: "${article.heading.slice(0, 60)}..."` });
    } catch (error) {
        console.error('Daily article error:', error);
        res.status(500).json({ error: error.message });
    }
});

// One-time admin: generate slugs for all articles that don't have one yet
app.post('/api/admin/migrate-slugs', requireAuth, async (req, res) => {
    try {
        if (!isMongoDBConnected) return res.status(503).json({ error: 'MongoDB not connected' });
        const articles = await News.find({ slug: null }, { _id: 1, heading: 1 }).lean();
        let updated = 0;
        for (const a of articles) {
            const base = generateSlug(a.heading);
            let slug = base;
            let counter = 1;
            while (await News.findOne({ slug, _id: { $ne: a._id } }).select('_id').lean()) {
                counter++;
                slug = `${base}-${counter}`;
            }
            await News.updateOne({ _id: a._id }, { $set: { slug } });
            updated++;
        }
        res.json({ success: true, updated, message: `${updated} articles updated with slugs` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin: manually trigger shorts generation
app.post('/api/admin/generate-shorts', requireAuth, async (req, res) => {
    res.json({ success: true, message: 'Shorts generation started in background' });
    generateShorts().catch(err => console.error('Shorts generation error:', err.message));
});

// Admin: manually trigger explainer generation
app.post('/api/admin/generate-explainers', requireAuth, async (req, res) => {
    res.json({ success: true, message: 'Explainer generation started in background' });
    generateExplainers().catch(err => console.error('Explainer generation error:', err.message));
    generateKaMat().catch(err => console.error('Ka Mat generation error:', err.message));
});

// Admin: manually trigger ka-mat generation for crime articles
app.post('/api/admin/generate-ka-mat', requireAuth, async (req, res) => {
    res.json({ success: true, message: 'Ka Mat generation started in background' });
    generateKaMat().catch(err => console.error('Ka Mat generation error:', err.message));
});

// Admin: manually trigger weekly roundup
app.post('/api/admin/generate-weekly-roundup', requireAuth, async (req, res) => {
    try {
        if (!isMongoDBConnected) return res.status(503).json({ error: 'MongoDB not connected' });
        if (!process.env.GROQ_API_KEY) return res.status(503).json({ error: 'GROQ_API_KEY not set' });
        // Allow force on any day (ignore the Sunday check)
        const force = req.body.force === 'true';
        let article;
        if (force) {
            // Temporarily override day-of-week check by calling the inner logic directly
            const today = new Date();
            const startOfWeek = new Date(today); startOfWeek.setDate(today.getDate() - today.getDay()); startOfWeek.setHours(0,0,0,0);
            await News.deleteOne({ isOriginal: true, heading: { $regex: /^साप्ताहिक समीक्षा:/i }, date: { $gte: startOfWeek } });
            // Patch: temporarily make getDay() return 0 for this call
            const origGetDay = Date.prototype.getDay;
            Date.prototype.getDay = function() { return 0; };
            article = await generateWeeklyRoundup();
            Date.prototype.getDay = origGetDay;
        } else {
            article = await generateWeeklyRoundup();
        }
        if (!article) return res.status(500).json({ error: 'साप्ताहिक समीक्षा नहीं बन सकी (केवल रविवार को चलती है या पहले से बन चुकी है; force=true से ओवरराइड करें)' });
        invalidateNewsCache();
        res.json({ success: true, message: `✅ साप्ताहिक समीक्षा प्रकाशित: "${article.heading.slice(0,60)}..."` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: manually trigger daily fact generation
app.post('/api/admin/generate-daily-fact', requireAuth, async (req, res) => {
    try {
        if (!isMongoDBConnected) return res.status(503).json({ error: 'MongoDB not connected' });
        if (!process.env.GROQ_API_KEY) return res.status(503).json({ error: 'GROQ_API_KEY not set' });
        if (req.body.force === 'true') {
            const today = new Date();
            const s = new Date(today.getFullYear(), today.getMonth(), today.getDate());
            const e = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
            await News.deleteOne({ isOriginal: true, heading: { $regex: /^क्या आप जानते हैं:/i }, date: { $gte: s, $lt: e } });
        }
        const article = await generateDailyFact();
        if (!article) return res.status(500).json({ error: 'लेख नहीं बन सका' });
        invalidateNewsCache();
        res.json({ success: true, message: `✅ लेख प्रकाशित: "${article.heading.slice(0,60)}..."` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: delete articles older than 1 month (keeps isPermanent articles safe)
app.post('/api/admin/recategorize-rss', requireAuth, async (req, res) => {
    try {
        if (!isMongoDBConnected) return res.status(503).json({ error: 'MongoDB not connected' });
        // Re-run mapRssCategory on all RSS articles whose category might be wrong
        const articles = await News.find({ rssLink: { $ne: null }, heading: { $ne: null } }, { heading: 1, category: 1, rssSource: 1 }).lean();
        let fixed = 0;
        for (const a of articles) {
            const correct = mapRssCategory([], a.heading, a.category);
            if (correct !== a.category) {
                await News.updateOne({ _id: a._id }, { $set: { category: correct } });
                fixed++;
            }
        }
        invalidateNewsCache();
        console.log(`🔄 recategorize-rss: fixed ${fixed} / ${articles.length} articles`);
        res.json({ success: true, fixed, total: articles.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/clean-duplicates', requireAuth, async (req, res) => {
    try {
        if (!isMongoDBConnected) return res.status(503).json({ error: 'MongoDB not connected' });
        // Find all headingNorm values that appear more than once
        const dups = await News.aggregate([
            { $match: { headingNorm: { $ne: null } } },
            { $group: { _id: '$headingNorm', ids: { $push: '$_id' }, count: { $sum: 1 } } },
            { $match: { count: { $gt: 1 } } }
        ]);
        let deleted = 0;
        for (const dup of dups) {
            // Keep the first (oldest _id), delete the rest
            const toDelete = dup.ids.slice(1);
            const r = await News.deleteMany({ _id: { $in: toDelete } });
            deleted += r.deletedCount;
        }
        invalidateNewsCache();
        console.log(`🧹 clean-duplicates: removed ${deleted} duplicate articles`);
        res.json({ success: true, deleted, groups: dups.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/delete-old-articles', requireAuth, async (req, res) => {
    try {
        if (!isMongoDBConnected) return res.status(503).json({ error: 'MongoDB not connected' });
        // Use START of day 1 month ago so re-running the same day
        // doesn't delete articles that were already safe the previous run
        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - 1);
        cutoff.setHours(0, 0, 0, 0);
        const result = await News.deleteMany({ date: { $lt: cutoff }, isPermanent: { $ne: true } });
        invalidateNewsCache();
        console.log(`🗑️ Admin deleted ${result.deletedCount} articles older than 1 month (cutoff: ${cutoff.toISOString()})`);
        res.json({ success: true, deleted: result.deletedCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Public: get recent "क्या आप जानते हैं?" daily fact articles
app.get('/api/news/daily-facts', async (req, res) => {
    try {
        const raw = await News.find(
            { $or: [{ isDailyFact: true }, { heading: { $regex: /^क्या आप जानते हैं:/i } }] },
            { heading: 1, category: 1, photos: 1, slug: 1, date: 1, content: 1 }
        ).sort({ date: -1 }).limit(20).lean();
        // Deduplicate: keep only one article per calendar day (newest)
        const seen = new Set();
        const facts = raw.filter(f => {
            const day = new Date(f.date).toDateString();
            if (seen.has(day)) return false;
            seen.add(day);
            return true;
        }).slice(0, 6);
        res.json(facts.map(f => ({ ...f, id: f._id.toString() })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Public: get shorts feed (articles that have shortNews)
app.get('/api/news/shorts', async (req, res) => {
    try {
        const category = req.query.category;
        const query = { 'shortNews.generatedAt': { $ne: null } };
        if (category && SHORTS_CATEGORIES.includes(category)) query.category = category;

        const shorts = await News.find(
            query,
            { heading: 1, category: 1, photos: 1, slug: 1, date: 1, author: 1, rssLink: 1, shortNews: 1 }
        ).sort({ date: -1 }).limit(100).lean();

        res.json(shorts.map(s => ({ ...s, id: s._id.toString() })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// Vercel Cron Job endpoint — called by Vercel cron (vercel.json) or cron-job.org
// Public cron endpoint — fetches news (no sensitive data, open is safe)
app.get('/api/cron/fetch-rss', async (req, res) => {
    // Still honor Vercel cron secret header if set (blocks random scanners)
    const vercelCronSecret = req.headers['x-vercel-cron-secret'];
    const authHeader = req.headers['authorization'];
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret) {
        const isVercelCron   = vercelCronSecret === cronSecret;
        const isBearer       = authHeader === `Bearer ${cronSecret}` || authHeader === cronSecret;
        // Parse query string manually in case Express req.query is not populated (Vercel edge)
        const rawUrl         = req.url || '';
        const qIdx           = rawUrl.indexOf('?');
        const qs             = qIdx !== -1 ? rawUrl.slice(qIdx + 1) : '';
        const isQuerySecret  = qs.split('&').some(p => p === `secret=${cronSecret}` || p.startsWith(`secret=${cronSecret}`));

        if (!isVercelCron && !isBearer && !isQuerySecret) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
    }

    // Run fetch synchronously BEFORE responding — Vercel freezes on res.json() so
    // fire-and-forget never executes. Parallel RSS (~5s) fits within Hobby's 10s limit.
    let count = 0;
    try {
        await connectDB();
        count = await fetchAllNews();
        invalidateNewsCache();
    } catch (err) {
        console.error('Cron error:', err);
    }

    res.json({ success: true, message: `Fetch complete: ${count} new articles`, count });
});

// ── Shared cron auth helper ───────────────────────────────────────────────────
function isCronAuthorized(req) {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) return true;
    const isVercel  = req.headers['x-vercel-cron-secret'] === cronSecret;
    const isBearer  = (req.headers['authorization'] || '') === `Bearer ${cronSecret}`;
    const rawUrl    = req.url || '';
    const qs        = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?') + 1) : '';
    const isQuery   = qs.split('&').some(p => p === `secret=${cronSecret}`);
    return isVercel || isBearer || isQuery;
}

// Vercel Cron: generate one daily editorial article every 24 h
app.get('/api/cron/generate-daily-article', async (req, res) => {
    if (!isCronAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
        await connectDB();
        await generateDailyArticle();
        invalidateNewsCache();
        res.json({ success: true, message: 'Daily article generation complete' });
    } catch (err) {
        console.error('Cron/daily-article error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Vercel Cron: generate Aaj Ka Itihas every 24 h
app.get('/api/cron/generate-aaj-ka-itihas', async (req, res) => {
    if (!isCronAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
        await connectDB();
        await generateAajKaItihas();
        invalidateNewsCache();
        res.json({ success: true, message: 'Aaj Ka Itihas generation complete' });
    } catch (err) {
        console.error('Cron/aaj-ka-itihas error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Vercel Cron: generate shorts every 6 h
app.get('/api/cron/generate-shorts', async (req, res) => {
    if (!isCronAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
        await connectDB();
        await generateShorts();
        invalidateNewsCache();
        res.json({ success: true, message: 'Shorts generation complete' });
    } catch (err) {
        console.error('Cron/shorts error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Vercel Cron: generate explainers every 6 h
app.get('/api/cron/generate-explainers', async (req, res) => {
    if (!isCronAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
        await connectDB();
        await generateExplainers();
        res.json({ success: true, message: 'Explainers generation complete' });
    } catch (err) {
        console.error('Cron/explainers error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Vercel Cron: generate ka-mat every 6 h
app.get('/api/cron/generate-ka-mat', async (req, res) => {
    if (!isCronAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
        await connectDB();
        await generateKaMat();
        res.json({ success: true, message: 'Ka-Mat generation complete' });
    } catch (err) {
        console.error('Cron/ka-mat error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── ePaper: Cloudinary storage for raw PDFs ─────────────────────────────────
const ePaperStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'epaper',
        resource_type: 'raw',
        allowed_formats: ['pdf'],
        public_id: (req, file) => {
            const date = new Date().toISOString().split('T')[0];
            const base = file.originalname.replace(/\.pdf$/i, '').replace(/[^a-z0-9 ]/gi, '-').trim().slice(0, 60);
            return `epaper-${date}-${base}`;
        }
    }
});
const uploadPDF = multer({
    storage: ePaperStorage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf' || path.extname(file.originalname).toLowerCase() === '.pdf') {
            cb(null, true);
        } else {
            cb(new Error('केवल PDF फ़ाइलें अनुमत हैं'));
        }
    }
});

function toEPaperDateSlug(dateLike) {
    const d = new Date(dateLike);
    if (Number.isNaN(d.getTime())) return null;
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function dateRangeFromSlug(slug) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(slug)) return null;
    const start = new Date(`${slug}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime())) return null;
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    return { start, end };
}

// Public page: ePaper reader
app.get('/epaper', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'epaper.html'));
});

app.get('/latest', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'latest.html'));
});

// Public page: ePaper reader with date URL
app.get('/epaper/:dateSlug', (req, res) => {
    if (!dateRangeFromSlug(req.params.dateSlug)) {
        return res.redirect('/epaper');
    }
    res.sendFile(path.join(__dirname, 'public', 'epaper.html'));
});

// Generate a Cloudinary signed delivery URL (24-hour expiry) for raw PDFs
// that are behind account-level access restrictions.
function signedPdfUrl(paper) {
    if (!paper.cloudinaryId) return paper.pdfUrl;
    try {
        return cloudinary.url(paper.cloudinaryId, {
            resource_type: 'raw',
            type:          'upload',
            sign_url:      true,
            expires_at:    Math.floor(Date.now() / 1000) + 86400, // 24 h
            secure:        true,
        });
    } catch {
        return paper.pdfUrl;
    }
}

// Public API: list ePapers (latest 20)
app.get('/api/epaper', async (req, res) => {
    try {
        if (!isMongoDBConnected) return res.json([]);
        const papers = await EPaper.find({ isActive: true })
            .sort({ publishDate: -1 })
            .limit(20)
            .lean();
        res.json(papers.map(p => ({
            ...p,
            id:      p._id.toString(),
            pdfUrl:  signedPdfUrl(p),
            dateSlug: toEPaperDateSlug(p.publishDate)
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Public API: get an ePaper by date slug (YYYY-MM-DD)
app.get('/api/epaper/by-date/:dateSlug', async (req, res) => {
    try {
        if (!isMongoDBConnected) return res.status(503).json({ error: 'DB not connected' });
        const range = dateRangeFromSlug(req.params.dateSlug);
        if (!range) return res.status(400).json({ error: 'Invalid date format' });

        const paper = await EPaper.findOne({
            isActive: true,
            publishDate: { $gte: range.start, $lt: range.end }
        })
            .sort({ publishDate: -1 })
            .lean();

        if (!paper) return res.status(404).json({ error: 'ePaper not found' });
        res.json({ ...paper, id: paper._id.toString(), pdfUrl: signedPdfUrl(paper), dateSlug: toEPaperDateSlug(paper.publishDate) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin API: generate a Cloudinary signed upload params so the browser can
// upload PDFs directly (bypasses Vercel's 4.5 MB serverless body limit).
app.get('/api/admin/epaper/sign', requireAuth, (req, res) => {
    try {
        const timestamp = Math.round(Date.now() / 1000);
        // Explicit public_id keeps parity with old multer uploads (no .pdf extension in URL),
        // which avoids a Cloudinary CDN quirk that blocks raw files ending in .pdf.
        const publicId  = `epaper-${new Date().toISOString().split('T')[0]}-${timestamp}`;
        const params    = { access_mode: 'public', folder: 'epaper', public_id: publicId, timestamp };
        const signature = cloudinary.utils.api_sign_request(params, process.env.CLOUDINARY_API_SECRET);
        res.json({
            signature,
            timestamp,
            api_key:    process.env.CLOUDINARY_API_KEY,
            cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
            folder:     'epaper',
            public_id:  publicId,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin API: save ePaper metadata after browser has uploaded PDF directly to Cloudinary.
// Body: { pdfUrl, cloudinaryId, title, edition?, publishDate?, pageCount? }
app.post('/api/admin/epaper', requireAuth, async (req, res) => {
    try {
        const { pdfUrl, cloudinaryId, title, edition, publishDate, pageCount } = req.body;
        if (!pdfUrl)   return res.status(400).json({ error: 'PDF URL आवश्यक है' });
        if (!title)    return res.status(400).json({ error: 'शीर्षक आवश्यक है' });

        const paper = new EPaper({
            title:        title.trim().slice(0, 200),
            edition:      (edition || '').trim().slice(0, 100),
            pdfUrl,
            cloudinaryId: cloudinaryId || '',
            publishDate:  publishDate ? new Date(publishDate) : new Date(),
            pageCount:    parseInt(pageCount, 10) || 0
        });
        await paper.save();
        res.json({ success: true, paper: { ...paper.toObject(), id: paper._id.toString() } });
    } catch (err) {
        console.error('ePaper save error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Admin API: delete an ePaper
app.delete('/api/admin/epaper/:id', requireAuth, async (req, res) => {
    try {
        if (!isMongoDBConnected) return res.status(503).json({ error: 'DB not connected' });
        const paper = await EPaper.findById(req.params.id);
        if (!paper) return res.status(404).json({ error: 'नहीं मिला' });
        // Delete PDF from Cloudinary
        if (paper.cloudinaryId) {
            await cloudinary.uploader.destroy(paper.cloudinaryId, { resource_type: 'raw' })
                .catch(e => console.warn('Cloudinary ePaper delete:', e.message));
        }
        await EPaper.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ─────────────────────────────────────────────────────────────────────────────

// Admin: top 10 most viewed articles (last 3 days: today + yesterday + day before)
app.get('/api/admin/top-news', requireAuth, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const since = new Date();
        since.setDate(since.getDate() - 2);
        since.setHours(0, 0, 0, 0);

        if (isDevelopment && !isMongoDBConnected) {
            const all = readNewsData();
            const top = all
                .filter(n => (n.views || 0) > 0 && new Date(n.date) >= since)
                .sort((a, b) => (b.views || 0) - (a.views || 0))
                .slice(0, limit)
                .map(n => ({ _id: n.id, heading: n.heading, category: n.category, slug: n.slug, views: n.views || 0, date: n.date }));
            return res.json(top);
        }
        const top = await News.find(
            { date: { $gte: since } },
            { heading: 1, category: 1, slug: 1, views: 1, date: 1 }
        )
            .sort({ views: -1 })
            .limit(limit)
            .lean();
        res.json(top);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PB SHABD importer — accepts up to 50 zip files (each: 1 .docx + 1 .jpg)
const pbShabdUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function parsePbShabdText(rawText) {
    const text = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const titleMatch = text.match(/Title\s*:\s*([\s\S]*?)(?=\n[\s\u00a0]*\n|\nSynopsis\s*:)/i);
    const heading = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';
    const contentMatch = text.match(/Synopsis\s*:\s*([\s\S]*?)(?=Story\s*Line\s*:|$)/i);
    const content = contentMatch ? contentMatch[1].replace(/\n{3,}/g, '\n\n').trim() : '';
    const cityMatch = text.match(/\*{1,2}\s*SHABD\s*,\s*([^,*]+),/i);
    const city = cityMatch ? cityMatch[1].trim() : '';
    return { heading, content, city };
}

app.post('/api/admin/import-pbshabd', requireAuth, pbShabdUpload.array('zips', 50), async (req, res) => {
    if (!req.files || req.files.length === 0)
        return res.status(400).json({ error: 'कोई ZIP फ़ाइल नहीं मिली' });
    const results = [];
    for (const file of req.files) {
        try {
            const zip = new AdmZip(file.buffer);
            const entries = zip.getEntries();
            const docxEntry = entries.find(e => e.entryName.toLowerCase().endsWith('.docx'));
            const imgEntry  = entries.find(e => /\.(jpg|jpeg|png)$/i.test(e.entryName));
            if (!docxEntry) { results.push({ file: file.originalname, error: 'DOCX नहीं मिला' }); continue; }
            const { value: rawText } = await mammoth.extractRawText({ buffer: docxEntry.getData() });
            const { heading, content, city } = parsePbShabdText(rawText);
            if (!heading) { results.push({ file: file.originalname, error: 'Title नहीं मिला' }); continue; }
            // Skip duplicate (same heading already in DB)
            const norm = heading.toLowerCase().replace(/\s+/g, ' ').trim();
            if (await News.findOne({ headingNorm: norm }).lean()) {
                results.push({ file: file.originalname, skipped: true, heading }); continue;
            }
            let photoUrl = null;
            if (imgEntry) {
                const imgBuf = imgEntry.getData();
                photoUrl = await new Promise(resolve => {
                    const stream = cloudinary.uploader.upload_stream(
                        { folder: 'news', transformation: [{ width: 1200, height: 630, crop: 'fill', format: 'jpg', quality: 'auto' }] },
                        (err, result) => resolve(err ? null : result.secure_url)
                    );
                    stream.end(imgBuf);
                });
            }
            const category = mapRssCategory(city ? [city] : [], heading, 'desh');
            const base = generateSlug(heading);
            let slug = base, counter = 1;
            while (await News.findOne({ slug }).lean()) { counter++; slug = `${base}-${counter}`; }
            await new News({
                heading,
                content: content || heading,
                category,
                author: 'PB SHABD',
                photos: photoUrl ? [photoUrl] : [],
                rssSource: 'PB SHABD',
                isOriginal: false,
                headingNorm: norm,
                date: new Date(),
                slug,
            }).save();
            results.push({ file: file.originalname, heading, category, slug });
        } catch (err) {
            results.push({ file: file.originalname, error: err.message });
        }
    }
    const imported = results.filter(r => !r.error && !r.skipped).length;
    const skipped  = results.filter(r => r.skipped).length;
    res.json({ imported, skipped, results });
});

// ── PB SHABD automated sync ───────────────────────────────────────────────────
const PBSHABD_BASE = 'https://shabd.prasarbharati.org';

function pbExtractCookies(headers) {
    const cookies = {};
    const list = headers.getSetCookie ? headers.getSetCookie() : [];
    for (const c of list) {
        const [nameVal] = c.split(';');
        const eq = nameVal.indexOf('=');
        if (eq > 0) cookies[nameVal.slice(0, eq).trim()] = nameVal.slice(eq + 1).trim();
    }
    return cookies;
}
function pbCookieHeader(obj) {
    return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('; ');
}
function pbStripHtml(html) {
    return (html || '')
        .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n')
        .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/\n{3,}/g, '\n\n').trim();
}

function getPbStoryTimestamp(story) {
    const raw = story?.created_at_src || story?.created_at || story?.updated_at || story?.date || story?.published_at || story?.timestamp;
    const ts = parsePbShabdTimestamp(raw);
    return ts === null ? null : ts.getTime();
}

// PB SHABD sends naive IST wall-clock timestamps ("YYYY-MM-DD HH:mm:ss", no
// timezone marker). On a UTC server that string gets parsed as if it were
// already UTC, storing dates ~5.5h in the future — which broke chronological
// sorting in the live feed. Convert to true UTC unless a timezone is present.
function parsePbShabdTimestamp(raw) {
    if (!raw) return null;
    const hasExplicitTz = /Z$|[+-]\d{2}:?\d{2}$/.test(String(raw).trim());
    const naive = new Date(raw);
    if (Number.isNaN(naive.getTime())) return null;
    return hasExplicitTz ? naive : new Date(naive.getTime() - (5.5 * 60 * 60 * 1000));
}

function isRecentPbStory(story, maxHours = 2) {
    const ts = getPbStoryTimestamp(story);
    if (ts === null) return false;
    return ts >= (Date.now() - (maxHours * 60 * 60 * 1000));
}

// Removes the title and synopsis paragraphs that PB SHABD duplicates at the top of story_intro_line
function pbCleanContent(text, title) {
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

async function pbShabdLogin() {
    const loginRes = await fetch(`${PBSHABD_BASE}/login`, { signal: AbortSignal.timeout(15000) });
    const html = await loginRes.text();
    const m = html.match(/name="_token"\s+value="([^"]+)"/);
    if (!m) throw new Error('CSRF token not found on login page');
    let cookies = pbExtractCookies(loginRes.headers);

    const authRes = await fetch(`${PBSHABD_BASE}/authenticate`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': pbCookieHeader(cookies),
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
        body: new URLSearchParams({ _token: m[1], email: process.env.PBSHABD_EMAIL || '', password: process.env.PBSHABD_PASSWORD || '' }).toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
    });
    cookies = { ...cookies, ...pbExtractCookies(authRes.headers) };
    const firstLoc = authRes.headers.get('location') || '';
    if (firstLoc.includes('/login') || (authRes.status !== 302 && authRes.status !== 200))
        throw new Error('Login failed — check PBSHABD_EMAIL / PBSHABD_PASSWORD in .env');

    // Follow all redirects (e.g. /reset → /stories) to establish the session
    let loc = firstLoc;
    while (loc) {
        const redir = await fetch(loc, {
            headers: { 'Cookie': pbCookieHeader(cookies) },
            redirect: 'manual',
            signal: AbortSignal.timeout(15000),
        });
        cookies = { ...cookies, ...pbExtractCookies(redir.headers) };
        loc = redir.status === 302 ? redir.headers.get('location') : null;
    }
    return cookies;
}

async function pbShabdFetchPage(cookies, page) {
    const params = new URLSearchParams({ page: String(page), length: '50', filter: 'ALL', language: '', state: '', search: '', category: '' });
    const res = await fetch(`${PBSHABD_BASE}/api/data?${params}`, {
        headers: {
            'Cookie': pbCookieHeader(cookies),
            'Accept': 'application/json',
            'Authorization': 'Bearer',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': `${PBSHABD_BASE}/stories`,
        },
        signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
}

async function pbShabdGetImage(cookies, mediaId, ext) {
    try {
        const params = new URLSearchParams({ id: mediaId, st: 'pb-s3', ext, type: 'IMAGE' });
        const res = await fetch(`${PBSHABD_BASE}/getS3Urls?${params}`, {
            headers: { 'Cookie': pbCookieHeader(cookies), 'X-Requested-With': 'XMLHttpRequest' },
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return null;
        const s3Url = (await res.text()).trim();
        return s3Url ? await uploadImageFromUrl(s3Url) : null;
    } catch { return null; }
}

const PBSHABD_IMPORT_TYPES = new Set(['RUSH', 'PRI', 'URG']);
const PBSHABD_IMAGE_EXTS  = new Set(['.JPG', '.JPEG', '.PNG', '.WEBP', '.GIF']);

app.post('/api/admin/sync-pbshabd', requireAuth, async (req, res) => {
    if (!process.env.PBSHABD_EMAIL || !process.env.PBSHABD_PASSWORD)
        return res.status(400).json({ error: 'PBSHABD_EMAIL और PBSHABD_PASSWORD .env में set करें' });
    if (!isMongoDBConnected) return res.status(503).json({ error: 'MongoDB not connected' });

    let cookies;
    try { cookies = await pbShabdLogin(); }
    catch (e) { return res.status(401).json({ error: e.message }); }

    const maxPages  = parseInt(req.query.pages) || 3;
    const skipImages = req.query.skipImages === 'true'; // cron passes this to stay under timeout
    const imported = [], skippedDup = [], errors = [];

    for (let page = 1; page <= maxPages; page++) {
        let json;
        try { json = await pbShabdFetchPage(cookies, page); }
        catch (e) { errors.push(`Page ${page}: ${e.message}`); break; }

        const stories = (json.data || []).filter(s => {
            if (s.language !== 'हिन्दी') return false;
            if (!isRecentPbStory(s, 6)) return false;
            return true;
        });
        if (!stories.length) break;

        // Count importable (RUSH/PRI/URG) stories and duplicates among them
        let importableCount = 0, dupCount = 0;

        for (const story of stories) {
            if (!PBSHABD_IMPORT_TYPES.has(story.news_type)) {
                // ORD stories are only imported when they carry an image (camera icon)
                const hasImage = (story.media || []).some(m =>
                    m.type === 'IMAGE' && PBSHABD_IMAGE_EXTS.has((m.extention || '').toUpperCase()));
                if (!hasImage) continue;
            }
            // Skip stories with video/audio — their content is broadcast-script formatted
            if ((story.media || []).some(m => m.type === 'VIDEO' || m.type === 'AUDIO')) continue;
            importableCount++;

            const rssLink = `${PBSHABD_BASE}/download?story_id=${story.story_id}`;
            if (await News.findOne({ rssLink }).lean()) { skippedDup.push(story.story_id); dupCount++; continue; }

            const rawContent = pbStripHtml(story.story_intro_line);
            const content = pbCleanContent(rawContent, story.title) || story.description || '';
            if (!content) { skippedDup.push(story.story_id + ':empty'); continue; }

            try {
                // Only upload images with recognized extensions; skip PDFs and other non-image files
                let photoUrl = null;
                if (!skipImages) {
                    const imgMedia = (story.media || []).find(m =>
                        m.type === 'IMAGE' && PBSHABD_IMAGE_EXTS.has((m.extention || '').toUpperCase()));
                    if (imgMedia) photoUrl = await pbShabdGetImage(cookies, imgMedia.media_id, imgMedia.extention);
                }

                const stateHint = (story.state || '').toLowerCase();
                const category  = mapRssCategory(stateHint ? [stateHint] : [], story.title, 'desh');

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
                    date:       parsePbShabdTimestamp(story.created_at_src || story.created_at) || new Date(),
                    slug,
                }).save();
                imported.push(story.story_id);
            } catch (e) { errors.push(`${story.story_id}: ${e.message}`); }
        }
        // Stop if every RUSH/PRI/URG story on this page was already imported
        if (importableCount > 0 && dupCount === importableCount) break;
    }

    res.json({ imported: imported.length, skipped: skippedDup.length, errors, importedIds: imported });
});

// Admin: top cities by total views
app.get('/api/admin/top-cities', requireAuth, async (req, res) => {
    try {
        if (!isMongoDBConnected) return res.json([]);
        const limit = parseInt(req.query.limit) || 15;
        const cities = await mongoose.connection.db.collection('cityviews')
            .find({})
            .sort({ count: -1 })
            .limit(limit)
            .toArray();
        res.json(cities);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Export app for Vercel (serverless). When running locally, also start the HTTP server.
module.exports = app;

// 404 handler — must come after all other routes
app.use((req, res) => {
    res.redirect(301, '/');
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log('=== Server Started Successfully (local) ===');
        console.log(`✓ वॉयस ऑफ क्रांति server running on http://localhost:${PORT}`);
        console.log(`✓ Admin panel: http://localhost:${PORT}/admin`);
        console.log(`✓ Public page: http://localhost:${PORT}`);
        console.log(`✓ MongoDB Connected: ${isMongoDBConnected}`);
        console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log('=================================');
    });
}
