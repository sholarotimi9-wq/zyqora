// UKVI Sponsor List — fetches, caches, parses and matches company names
const UKVI_CSV_URL = 'https://assets.publishing.service.gov.uk/media/69c270b7bb0dfe55b83e4c53/2026-03-24_-_Worker_and_Temporary_Worker.csv';

// In-memory cache (persists across warm invocations)
let sponsorCache = null;
let cacheTimestamp = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function parseCSV(text) {
  const lines = text.split('\n');
  if (lines.length < 2) return [];
  // Find header line (skip BOM and empty lines)
  let headerIdx = 0;
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const cleaned = lines[i].replace(/^\uFEFF/, '').trim().toLowerCase();
    if (cleaned.includes('organisation') || cleaned.includes('name')) {
      headerIdx = i;
      break;
    }
  }
  const headers = parseCSVLine(lines[headerIdx]).map(h => h.replace(/^\uFEFF/, '').trim().toLowerCase());
  const nameIdx = headers.findIndex(h => h.includes('organisation'));
  const cityIdx = headers.findIndex(h => h.includes('town') || h.includes('city'));
  const ratingIdx = headers.findIndex(h => h.includes('rating'));
  const routeIdx = headers.findIndex(h => h.includes('route') || h.includes('type'));
  const sponsors = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCSVLine(line);
    const name = cols[nameIdx]?.trim();
    if (!name) continue;
    sponsors.push({
      organisation_name: name,
      city: cols[cityIdx]?.trim() || '',
      rating: cols[ratingIdx]?.trim() || '',
      route: cols[routeIdx]?.trim() || ''
    });
  }
  return sponsors;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

async function loadSponsors() {
  if (sponsorCache && (Date.now() - cacheTimestamp < CACHE_TTL)) return sponsorCache;
  const res = await fetch(UKVI_CSV_URL);
  if (!res.ok) throw new Error('Failed to fetch UKVI sponsor list: ' + res.status);
  const text = await res.text();
  sponsorCache = parseCSV(text);
  cacheTimestamp = Date.now();
  return sponsorCache;
}

// Company name normalization
function normalizeName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/\b(ltd|limited|plc|inc|incorporated|llp|llc|corp|corporation|co\.|company|group|holdings|uk|international|&)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Levenshtein distance
function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[b.length][a.length];
}

function matchCompany(companyName, sponsors) {
  if (!companyName) return { isUKSponsor: false, confidenceScore: 0, matchedCompanyName: null };
  const normalized = normalizeName(companyName);
  if (!normalized) return { isUKSponsor: false, confidenceScore: 0, matchedCompanyName: null };

  let bestScore = 0;
  let bestMatch = null;

  for (const sponsor of sponsors) {
    const sponsorNorm = normalizeName(sponsor.organisation_name);
    if (!sponsorNorm) continue;

    // Exact match after normalization
    if (normalized === sponsorNorm) {
      return {
        isUKSponsor: true,
        confidenceScore: 100,
        matchedCompanyName: sponsor.organisation_name,
        city: sponsor.city,
        rating: sponsor.rating,
        route: sponsor.route
      };
    }

    // Check if one contains the other (for partial company names)
    if (normalized.length >= 3 && sponsorNorm.length >= 3) {
      if (sponsorNorm.includes(normalized) || normalized.includes(sponsorNorm)) {
        const shorter = Math.min(normalized.length, sponsorNorm.length);
        const longer = Math.max(normalized.length, sponsorNorm.length);
        const containScore = Math.round((shorter / longer) * 95);
        if (containScore > bestScore) {
          bestScore = containScore;
          bestMatch = sponsor;
        }
      }
    }

    // Fuzzy matching with Levenshtein for similar-length strings
    const lenDiff = Math.abs(normalized.length - sponsorNorm.length);
    if (lenDiff <= Math.max(normalized.length, sponsorNorm.length) * 0.3) {
      const dist = levenshtein(normalized, sponsorNorm);
      const maxLen = Math.max(normalized.length, sponsorNorm.length);
      const similarity = Math.round((1 - dist / maxLen) * 100);
      if (similarity > bestScore) {
        bestScore = similarity;
        bestMatch = sponsor;
      }
    }
  }

  if (bestScore > 80 && bestMatch) {
    return {
      isUKSponsor: true,
      confidenceScore: bestScore,
      matchedCompanyName: bestMatch.organisation_name,
      city: bestMatch.city,
      rating: bestMatch.rating,
      route: bestMatch.route
    };
  }

  return { isUKSponsor: false, confidenceScore: bestScore, matchedCompanyName: null };
}

export default async (req) => {
  const url = new URL(req.url);
  const headers = { 'Content-Type': 'application/json' };

  try {
    if (req.method === 'GET') {
      // Single company check via query param
      const company = url.searchParams.get('company');
      if (company) {
        const sponsors = await loadSponsors();
        const result = matchCompany(company, sponsors);
        return new Response(JSON.stringify(result), { headers });
      }
      // Return sponsor stats
      const sponsors = await loadSponsors();
      return new Response(JSON.stringify({ count: sponsors.length, cached: !!sponsorCache }), { headers });
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const { companies } = body;
      if (!Array.isArray(companies)) {
        return new Response(JSON.stringify({ error: 'Provide an array of company names' }), { status: 400, headers });
      }
      const sponsors = await loadSponsors();
      const results = companies.map(name => ({
        company: name,
        ...matchCompany(name, sponsors)
      }));
      return new Response(JSON.stringify({ results }), { headers });
    }

    return new Response('Method Not Allowed', { status: 405 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
};

export const config = { path: '/api/visa-sponsors' };
