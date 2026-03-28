import { createHmac } from 'crypto';

function j(d, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

// Verify a Supabase JWT using the JWT secret
function verifySupabaseJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;
    const expectedSig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
    if (signature !== expectedSig) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp && data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch { return null; }
}

// Fetch a user profile from Supabase using the service role key (bypasses RLS)
async function getProfile(userId) {
  const url = Netlify.env.get('SUPABASE_URL') || Netlify.env.get('SUPABASE_DATABASE_URL');
  const key = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return null;
  try {
    const res = await fetch(`${url}/rest/v1/profiles?id=eq.${userId}&select=*`, {
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}` }
    });
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  } catch { return null; }
}

// Authenticate a request: verify JWT, fetch profile, check not banned
export async function authenticateRequest(req) {
  const auth = req.headers.get('authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const secret = Netlify.env.get('SUPABASE_JWT_SECRET');
  if (!secret) return null;
  const jwt = verifySupabaseJWT(token, secret);
  if (!jwt || !jwt.sub) return null;
  const profile = await getProfile(jwt.sub);
  if (!profile || profile.banned) return null;
  return profile;
}

// API endpoint: verify session and return profile
export default async (req) => {
  if (req.method !== 'POST') return j({ error: 'Method not allowed' }, 405);
  let body;
  try { body = await req.json(); } catch { return j({ error: 'Bad JSON' }, 400); }
  const { action } = body;

  if (action === 'verify') {
    const profile = await authenticateRequest(req);
    if (!profile) return j({ error: 'Unauthorized' }, 401);
    return j({ success: true, user: profile });
  }

  return j({ error: 'Unknown action' }, 400);
};

export const config = { path: '/api/auth' };
