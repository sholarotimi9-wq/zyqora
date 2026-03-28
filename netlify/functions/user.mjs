import { createHmac } from 'crypto';
import { getStore } from '@netlify/blobs';

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

function supabaseHeaders() {
  const key = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY');
  return { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
}

function supabaseUrl() {
  return Netlify.env.get('SUPABASE_URL') || Netlify.env.get('SUPABASE_DATABASE_URL');
}

async function authenticateRequest(req) {
  const auth = req.headers.get('authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const secret = Netlify.env.get('SUPABASE_JWT_SECRET');
  if (!secret) return null;
  const jwt = verifySupabaseJWT(token, secret);
  if (!jwt || !jwt.sub) return null;
  const url = supabaseUrl();
  const res = await fetch(`${url}/rest/v1/profiles?id=eq.${jwt.sub}&select=*`, { headers: supabaseHeaders() });
  const rows = await res.json();
  const profile = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  if (!profile || profile.banned) return null;
  return { ...profile, _jwt: jwt };
}

export default async (req) => {
  if (req.method !== 'POST') return j({ error: 'Method not allowed' }, 405);
  let body;
  try { body = await req.json(); } catch { return j({ error: 'Bad JSON' }, 400); }

  const caller = await authenticateRequest(req);
  if (!caller) return j({ error: 'Unauthorized' }, 401);

  const url = supabaseUrl();
  const headers = supabaseHeaders();
  const auditStore = getStore({ name: 'zyqora-audit', consistency: 'strong' });
  const { action } = body;

  try {
    // Update own profile
    if (action === 'update-profile') {
      const updates = {};
      if (body.name && typeof body.name === 'string') updates.full_name = body.name.trim();
      if (body.jobTitle !== undefined && typeof body.jobTitle === 'string') updates.job_title = body.jobTitle.trim();
      if (body.linkedin !== undefined && typeof body.linkedin === 'string') updates.linkedin = body.linkedin.trim();
      updates.last_active = new Date().toISOString();

      const patchRes = await fetch(`${url}/rest/v1/profiles?id=eq.${caller.id}`, {
        method: 'PATCH', headers, body: JSON.stringify(updates)
      });
      const updated = await patchRes.json();
      const profile = Array.isArray(updated) && updated.length > 0 ? updated[0] : caller;
      return j({ success: true, user: profile });
    }

    // Delete own account
    if (action === 'delete-account') {
      const { confirmEmail } = body;
      if (!confirmEmail || confirmEmail.toLowerCase().trim() !== caller.email.toLowerCase().trim()) {
        return j({ error: 'Please confirm your email address to delete your account' }, 400);
      }
      // Delete auth user via Supabase Admin API (cascade deletes profile)
      const serviceKey = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY');
      await fetch(`${url}/auth/v1/admin/users/${caller.id}`, {
        method: 'DELETE', headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }
      });
      // Audit log
      const { randomBytes } = await import('crypto');
      await auditStore.setJSON('evt:' + Date.now() + ':' + randomBytes(4).toString('hex'), {
        user_id: caller.id, role: caller.role || 'user', event_type: 'account_deletion',
        timestamp: new Date().toISOString(), detail: { email: caller.email }
      }).catch(() => {});
      return j({ success: true, message: 'Account deleted successfully' });
    }

    // Export own data (includes profile, CVs, dashboard, and activity logs)
    if (action === 'export-data') {
      const auditList = await auditStore.list().catch(() => ({ blobs: [] }));
      const userLogs = [];
      for (const b of auditList.blobs.slice(0, 500)) {
        const log = await auditStore.get(b.key, { type: 'json' }).catch(() => null);
        if (log && log.user_id === caller.id) userLogs.push(log);
      }
      // Fetch user's CVs from database
      const cvsRes = await fetch(`${url}/rest/v1/cvs?user_id=eq.${caller.id}&select=id,cv_data,created_at,updated_at&order=created_at.asc`, { headers });
      const cvsRows = cvsRes.ok ? await cvsRes.json() : [];
      const cvs = (Array.isArray(cvsRows) ? cvsRows : []).map(r => ({ ...r.cv_data, id: r.id }));
      // Fetch user's cover letters from database
      const clRes = await fetch(`${url}/rest/v1/cover_letters?user_id=eq.${caller.id}&select=id,content,created_at,updated_at&order=created_at.desc`, { headers });
      const clRows = clRes.ok ? await clRes.json() : [];
      const coverLetters = (Array.isArray(clRows) ? clRows : []).map(r => ({ id: r.id, ...r.content }));
      // Fetch user's ATS reports from database
      const atsRes = await fetch(`${url}/rest/v1/ats_reports?user_id=eq.${caller.id}&select=id,report_data,score,grade,created_at&order=created_at.desc`, { headers });
      const atsRows = atsRes.ok ? await atsRes.json() : [];
      const atsReports = (Array.isArray(atsRows) ? atsRows : []).map(r => ({ id: r.id, score: r.score, grade: r.grade, reportData: r.report_data, created_at: r.created_at }));
      // Fetch user's dashboard data from database
      const dashRes = await fetch(`${url}/rest/v1/user_dashboard?user_id=eq.${caller.id}&select=*`, { headers });
      const dashRows = dashRes.ok ? await dashRes.json() : [];
      const dashboard = Array.isArray(dashRows) && dashRows.length > 0 ? dashRows[0] : {};
      const { _jwt, ...safeProfile } = caller;
      return j({ success: true, data: { profile: safeProfile, cvs, coverLetters, atsReports, dashboard, activityLogs: userLogs } });
    }

    return j({ error: 'Unknown action' }, 400);
  } catch (e) { return j({ error: 'Internal error' }, 500); }
};

export const config = { path: '/api/user' };
