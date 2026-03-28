import { createHmac } from 'crypto';

function j(d, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

function verifySupabaseJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;
    const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
    if (signature !== expected) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp && data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch { return null; }
}

function authenticateJWT(req) {
  const auth = req.headers.get('authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const secret = Netlify.env.get('SUPABASE_JWT_SECRET');
  if (!secret) return null;
  const jwt = verifySupabaseJWT(token, secret);
  if (!jwt || !jwt.sub) return null;
  return jwt.sub;
}

function supabaseUrl() {
  return Netlify.env.get('SUPABASE_URL') || Netlify.env.get('SUPABASE_DATABASE_URL');
}

function supabaseHeaders() {
  const key = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY');
  return { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
}

// List cover letters for a user
async function getCoverLetters(userId) {
  const url = supabaseUrl();
  if (!url) return [];
  const res = await fetch(
    `${url}/rest/v1/cover_letters?user_id=eq.${userId}&select=id,content,created_at,updated_at&order=created_at.desc`,
    { headers: supabaseHeaders() }
  );
  if (!res.ok) return [];
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];
  return rows.map(row => ({
    id: row.id,
    ...row.content,
    created_at: row.created_at,
    updated_at: row.updated_at
  }));
}

// Save a cover letter
async function saveCoverLetter(userId, data, existingId) {
  const url = supabaseUrl();
  const headers = supabaseHeaders();
  if (!url) return { ok: false, detail: 'Supabase URL not configured' };

  const content = { ...data };
  delete content.id;
  delete content.created_at;
  delete content.updated_at;

  if (existingId) {
    // Update existing
    const res = await fetch(`${url}/rest/v1/cover_letters?id=eq.${existingId}&user_id=eq.${userId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ content, updated_at: new Date().toISOString() })
    });
    if (res.ok) {
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0) {
        return { ok: true, id: rows[0].id };
      }
    }
  }

  // Insert new
  const res = await fetch(`${url}/rest/v1/cover_letters`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      user_id: userId,
      content,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, detail: `Insert failed (${res.status}): ${text}` };
  }
  const inserted = await res.json();
  if (Array.isArray(inserted) && inserted.length > 0) {
    return { ok: true, id: inserted[0].id };
  }
  return { ok: true };
}

// Delete a cover letter
async function deleteCoverLetter(userId, id) {
  const url = supabaseUrl();
  const res = await fetch(`${url}/rest/v1/cover_letters?id=eq.${id}&user_id=eq.${userId}`, {
    method: 'DELETE',
    headers: supabaseHeaders()
  });
  return { ok: res.ok };
}

export default async (req) => {
  if (req.method !== 'POST') return j({ error: 'Method not allowed' }, 405);

  const userId = authenticateJWT(req);
  if (!userId) return j({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await req.json(); } catch { return j({ error: 'Bad JSON' }, 400); }

  const { action } = body;

  try {
    if (action === 'list') {
      const letters = await getCoverLetters(userId);
      return j({ success: true, coverLetters: letters });
    }

    if (action === 'save') {
      const { coverLetter, id } = body;
      if (!coverLetter || typeof coverLetter !== 'object') return j({ error: 'coverLetter must be an object' }, 400);
      const result = await saveCoverLetter(userId, coverLetter, id);
      if (!result.ok) return j({ error: result.detail || 'Failed to save cover letter' }, 500);
      return j({ success: true, id: result.id });
    }

    if (action === 'delete') {
      const { id } = body;
      if (!id) return j({ error: 'id is required' }, 400);
      const result = await deleteCoverLetter(userId, id);
      if (!result.ok) return j({ error: 'Failed to delete cover letter' }, 500);
      return j({ success: true });
    }

    return j({ error: 'Unknown action' }, 400);
  } catch (e) {
    return j({ error: 'Internal error' }, 500);
  }
};

export const config = { path: '/api/cover-letter' };
