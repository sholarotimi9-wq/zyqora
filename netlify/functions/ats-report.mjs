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

// List ATS reports for a user
async function getATSReports(userId) {
  const url = supabaseUrl();
  if (!url) return [];
  const res = await fetch(
    `${url}/rest/v1/ats_reports?user_id=eq.${userId}&select=id,cv_id,report_data,score,grade,job_description,created_at,updated_at&order=created_at.desc`,
    { headers: supabaseHeaders() }
  );
  if (!res.ok) return [];
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];
  return rows.map(row => ({
    id: row.id,
    cvId: row.cv_id,
    score: row.score,
    grade: row.grade,
    jobDescription: row.job_description,
    reportData: row.report_data,
    created_at: row.created_at,
    updated_at: row.updated_at
  }));
}

// Save an ATS report
async function saveATSReport(userId, reportData, score, grade, jobDescription, cvId) {
  const url = supabaseUrl();
  const headers = supabaseHeaders();
  if (!url) return { ok: false, detail: 'Supabase URL not configured' };

  const row = {
    user_id: userId,
    report_data: reportData,
    score: score || null,
    grade: grade || null,
    job_description: jobDescription || '',
    cv_id: cvId || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const res = await fetch(`${url}/rest/v1/ats_reports`, {
    method: 'POST',
    headers,
    body: JSON.stringify(row)
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

// Delete an ATS report
async function deleteATSReport(userId, id) {
  const url = supabaseUrl();
  const res = await fetch(`${url}/rest/v1/ats_reports?id=eq.${id}&user_id=eq.${userId}`, {
    method: 'DELETE',
    headers: supabaseHeaders()
  });
  return { ok: res.ok };
}

// Get latest ATS report for a user (for dashboard)
async function getLatestATSReport(userId) {
  const url = supabaseUrl();
  if (!url) return null;
  const res = await fetch(
    `${url}/rest/v1/ats_reports?user_id=eq.${userId}&select=id,score,grade,created_at&order=created_at.desc&limit=1`,
    { headers: supabaseHeaders() }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return { score: rows[0].score, grade: rows[0].grade, date: rows[0].created_at };
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
      const reports = await getATSReports(userId);
      return j({ success: true, reports });
    }

    if (action === 'save') {
      const { reportData, score, grade, jobDescription, cvId } = body;
      if (!reportData || typeof reportData !== 'object') return j({ error: 'reportData must be an object' }, 400);
      const result = await saveATSReport(userId, reportData, score, grade, jobDescription, cvId);
      if (!result.ok) return j({ error: result.detail || 'Failed to save ATS report' }, 500);
      return j({ success: true, id: result.id });
    }

    if (action === 'delete') {
      const { id } = body;
      if (!id) return j({ error: 'id is required' }, 400);
      const result = await deleteATSReport(userId, id);
      if (!result.ok) return j({ error: 'Failed to delete ATS report' }, 500);
      return j({ success: true });
    }

    if (action === 'latest') {
      const latest = await getLatestATSReport(userId);
      return j({ success: true, report: latest });
    }

    return j({ error: 'Unknown action' }, 400);
  } catch (e) {
    return j({ error: 'Internal error' }, 500);
  }
};

export const config = { path: '/api/ats-report' };
