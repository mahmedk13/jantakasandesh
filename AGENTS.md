# Voice of Kranti Development Rules

## Project
Voice of Kranti is a Hindi news portal built with:
- Node.js
- Express
- MongoDB
- HTML
- CSS
- JavaScript

## Critical rules

1. NEVER delete news automatically.
2. NEVER delete MongoDB articles because they are old.
3. Never modify or expose .env secrets.
4. Preserve existing functionality unless explicitly asked to remove it.
5. Run `node --check server.js` after server.js changes.
6. Test MongoDB-related changes carefully.
7. Article URLs must remain permanent.
8. Existing article URLs must not be broken.
9. Use 301 redirects when correcting old slugs.
10. Use Asia/Kolkata/IST for editorial-day calculations.
11. Original articles remain featured until midnight IST of publication day.
12. Prasar Bharati/PB SHABD must not exceed 50% of category Top 10.
13. Preserve source name and original source URL.
14. Server-rendered article content must remain available in initial HTML.
15. Do not invent journalists, quotes, facts or sources.
16. AI-rewritten articles must not be marked as original reporting unless they genuinely are.