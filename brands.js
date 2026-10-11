// ── Multi-domain white-label branding ────────────────────────────────────────
// Same codebase/DB/ImageKit serves multiple domains, each with its own name,
// logo, tagline, contact and social presence. Add a new domain by adding an
// entry to BRANDS below — no other code changes needed as long as every page
// keeps using the literal 'voiceofkranti.com' / 'वॉयस ऑफ क्रांति' / 'logo.svg' /
// 'og-banner.svg' strings that applyBrand() swaps out at request time.

const BRANDS = {
    'voiceofkranti.com': {
        key: 'vok',
        isDefault: true,
        domain: 'voiceofkranti.com',
        // canonicalHost = the exact host that should ultimately be served (matches
        // whichever of apex/www is set as "Production" in Vercel's domain settings);
        // altHost = the other variant, which gets 301-redirected to canonicalHost.
        canonicalHost: 'voiceofkranti.com',
        altHost: 'www.voiceofkranti.com',
        slug: 'voiceofkranti',
        nameHi: 'वॉयस ऑफ क्रांति',
        nameEn: 'Voice of Kranti',
        tagline: 'सत्य की आवाज़, जनता का विश्वास',
        email: 'editor@voiceofkranti.com',
        logoFile: 'logo.svg',
        ogBannerFile: 'og-banner.svg',
        twitterHandle: '@voiceofkranti',
        rni: 'MPHIN/26/A5773',
        showSocial: true,
        showRni: true,
    },
    'jantakasandesh.in': {
        key: 'jks',
        isDefault: false,
        // Vercel has www.jantakasandesh.in set as Production (apex 308s to www) —
        // the opposite of voiceofkranti.com — so domain/canonicalHost include www
        // here to match, otherwise our own www-normalization fights Vercel's and
        // loops forever (ERR_TOO_MANY_REDIRECTS).
        domain: 'www.jantakasandesh.in',
        canonicalHost: 'www.jantakasandesh.in',
        altHost: 'jantakasandesh.in',
        slug: 'jantakasandesh',
        nameHi: 'जनता का संदेश',
        nameEn: 'Janta Ka Sandesh',
        tagline: 'सत्य की आवाज़, जनता का विश्वास',
        email: 'editor@jantakasandesh.in',
        logoFile: 'logo-jks.svg',
        ogBannerFile: 'og-banner-jks.svg',
        twitterHandle: '',
        rni: '',
        showSocial: false,
        showRni: false,
    },
};

const DEFAULT_BRAND = BRANDS['voiceofkranti.com'];

function getBrand(hostname) {
    if (!hostname) return DEFAULT_BRAND;
    const h = hostname.toLowerCase().replace(/^www\./, '');
    return BRANDS[h] || DEFAULT_BRAND;
}

// Rewrites every Voice-of-Kranti-specific literal in `html` (name, domain,
// logo/og-image filenames, RNI number, social links) to match `brand`. No-op
// for the default brand. Order matters — longer/more specific strings first.
function applyBrand(html, brand) {
    if (typeof html !== 'string' || !html) return html;
    if (!brand || brand.isDefault) return html;

    let out = html;

    if (!brand.showSocial) {
        // JSON-LD "sameAs" entries pointing at the default brand's own social accounts
        out = out.replace(/\s*"https:\/\/(www\.)?(facebook\.com|x\.com|instagram\.com|youtube\.com)\/[^"]*",?\n?/g, '\n');
        out = out.replace(/,(\s*)\]/g, '$1]'); // fix any trailing comma left behind
        // twitter:site meta tag
        out = out.replace(/\s*<meta name="twitter:site"[^>]*>\n?/g, '');
        // Footer social icon row
        out = out.replace(/<div class="footer-social">[\s\S]*?<\/div>/g, '');
    }

    if (!brand.showRni) {
        out = out.replace(/<p([^>]*)>RNI:\s*MPHIN\/26\/A5773<\/p>/g, '');
        out = out.replace(/<li><strong>RNI पंजीकरण:<\/strong>[^<]*<\/li>\s*/g, '');
        out = out.split('RNI: MPHIN/26/A5773').join('');
    }

    // Asset filenames (before the domain swap so full URLs end up fully rebranded)
    out = out.split('og-banner.svg').join(brand.ogBannerFile);
    out = out.split('logo.svg').join(brand.logoFile);

    // Email addresses first and exact — brand.domain may carry a 'www.' prefix for
    // display URLs (see brands.js canonicalHost comment), but mail is always sent
    // to the bare domain, so this must NOT fall through to the generic domain swap
    // below (which would otherwise produce an invalid 'editor@www.…' address).
    out = out.split('editor@voiceofkranti.com').join(brand.email);

    // Domain (longest literal first)
    out = out.split('voiceofkranti.com').join(brand.domain);

    // Brand name variants
    out = out.split('वॉयस ऑफ क्रांति').join(brand.nameHi);
    out = out.split('VOICE OF KRANTI').join(brand.nameEn.toUpperCase());
    out = out.split('voice of kranti').join(brand.nameEn.toLowerCase());

    // Twitter handle / bare lowercase slug remnants (usernames, meta keywords)
    if (brand.showSocial && brand.twitterHandle) {
        out = out.split('@voiceofkranti').join(brand.twitterHandle);
    }
    out = out.split('voiceofkranti').join(brand.slug);

    return out;
}

module.exports = { BRANDS, DEFAULT_BRAND, getBrand, applyBrand };
