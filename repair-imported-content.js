require('dotenv').config();
const mongoose = require('mongoose');
const { News } = require('./models/News');

function cleanHtml(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:p|div|li|h[1-6]|tr|blockquote)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&rsquo;/gi, '’')
    .replace(/&lsquo;/gi, '‘')
    .replace(/&rdquo;/gi, '”')
    .replace(/&ldquo;/gi, '“')
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
  return paragraphs.length >= 2 || wordCount >= 180 || charCount > 600;
}

async function repair() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is missing');

  await mongoose.connect(uri);
  const docs = await News.find({
    isOriginal: { $ne: true },
    isPermanent: { $ne: true }
  }, { _id: 1, content: 1, full: 1, heading: 1, slug: 1 }).lean();

  let updated = 0;
  const updates = [];

  for (const doc of docs) {
    const original = String(doc.content || '');
    const nextContent = paragraphizeLegacyImportedText(original);
    const shouldBeFull = isFullArticleContent(nextContent || original);

    const changed = nextContent !== original || Boolean(doc.full) !== shouldBeFull;
    if (!changed) continue;

    updates.push({
      id: doc._id,
      heading: doc.heading,
      slug: doc.slug,
      updated: { content: nextContent, full: shouldBeFull }
    });

    await News.updateOne({ _id: doc._id }, { $set: { content: nextContent, full: shouldBeFull } });
    updated++;
  }

  console.log(JSON.stringify({ scanned: docs.length, updated, sample: updates.slice(0, 5) }, null, 2));
  await mongoose.disconnect();
}

repair().catch(err => {
  console.error('repair failed:', err.message);
  process.exit(1);
});
