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

// Verify JWT and check admin role
async function requireAdmin(req) {
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
  if (!profile || profile.banned || profile.role !== 'admin') return null;
  return profile;
}

async function logAudit(store, admin, eventType, detail) {
  const { randomBytes } = await import('crypto');
  await store.setJSON('evt:' + Date.now() + ':' + randomBytes(4).toString('hex'), {
    user_id: admin.id, role: admin.role, event_type: eventType, timestamp: new Date().toISOString(), detail
  }).catch(() => {});
}

export default async (req) => {
  if (req.method !== 'POST') return j({ error: 'Method not allowed' }, 405);
  let body;
  try { body = await req.json(); } catch { return j({ error: 'Bad JSON' }, 400); }

  const admin = await requireAdmin(req);
  if (!admin) return j({ error: 'Unauthorized' }, 403);

  const rs = getStore({ name: 'zyqora-reviews', consistency: 'strong' });
  const auditStore = getStore({ name: 'zyqora-audit', consistency: 'strong' });
  const url = supabaseUrl();
  const headers = supabaseHeaders();
  const { action } = body;

  try {
    if (action === 'stats') {
      // Fetch all profiles from Supabase
      const profilesRes = await fetch(`${url}/rest/v1/profiles?select=*&order=created_at.desc`, { headers });
      const users = await profilesRes.json();
      const vu = Array.isArray(users) ? users : [];

      // Fetch total CV count from database
      const cvsCountRes = await fetch(`${url}/rest/v1/cvs?select=user_id`, { headers });
      const cvsRows = cvsCountRes.ok ? await cvsCountRes.json() : [];
      const totalCVs = Array.isArray(cvsRows) ? cvsRows.length : 0;
      // Count CVs per user for enriching user list
      const cvCountByUser = {};
      if (Array.isArray(cvsRows)) {
        cvsRows.forEach(r => { cvCountByUser[r.user_id] = (cvCountByUser[r.user_id] || 0) + 1; });
      }

      // Fetch reviews from Netlify Blobs
      const rl = await rs.list().catch(() => ({ blobs: [] }));
      const revs = await Promise.all(rl.blobs.map(b => rs.get(b.key, { type: 'json' }).catch(() => null)));
      const vr = revs.filter(Boolean);
      const avg = vr.length ? (vr.reduce((s, r) => s + r.rating, 0) / vr.length).toFixed(1) : '0.0';

      const now = new Date();
      const dayAgo = new Date(now - 864e5);
      const weekAgo = new Date(now - 7 * 864e5);
      const monthAgo = new Date(now - 30 * 864e5);

      const activeWeek = vu.filter(u => u.last_active && new Date(u.last_active) > weekAgo).length;
      const activeMonth = vu.filter(u => u.last_active && new Date(u.last_active) > monthAgo).length;
      const newToday = vu.filter(u => u.created_at && new Date(u.created_at) > dayAgo).length;
      const newWeek = vu.filter(u => u.created_at && new Date(u.created_at) > weekAgo).length;
      const newMonth = vu.filter(u => u.created_at && new Date(u.created_at) > monthAgo).length;

      const planCounts = { Free: 0, Pro: 0, Enterprise: 0 };
      vu.forEach(u => { planCounts[u.plan || 'Free'] = (planCounts[u.plan || 'Free'] || 0) + 1; });
      const monthlyRevenue = (planCounts.Pro || 0) * 9.99 + (planCounts.Enterprise || 0) * 29;

      // Fetch recent audit logs
      const auditList = await auditStore.list().catch(() => ({ blobs: [] }));
      const recentAuditKeys = auditList.blobs.sort((a, b) => b.key.localeCompare(a.key)).slice(0, 50);
      const auditLogs = await Promise.all(recentAuditKeys.map(b => auditStore.get(b.key, { type: 'json' }).catch(() => null)));

      // Map Supabase profile fields to frontend format
      const safeUsers = vu.map(u => ({
        id: u.id, name: u.full_name, email: u.email, role: u.role,
        plan: u.plan, banned: u.banned, createdAt: u.created_at, lastActive: u.last_active,
        cvCount: cvCountByUser[u.id] || 0
      }));

      return j({
        stats: {
          totalReviews: vr.length, avgRating: avg, totalUsers: vu.length, totalCVs,
          proUsers: planCounts.Pro || 0, enterpriseUsers: planCounts.Enterprise || 0, freeUsers: planCounts.Free || 0,
          activeWeek, activeMonth, newToday, newWeek, newMonth,
          monthlyRevenue: monthlyRevenue.toFixed(2), planCounts
        },
        reviews: vr.sort((a, b) => new Date(b.date) - new Date(a.date)),
        users: safeUsers.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)),
        auditLogs: auditLogs.filter(Boolean).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      });
    }

    if (action === 'delete-review') {
      await rs.delete(body.id);
      await logAudit(auditStore, admin, 'admin_delete_review', { review_id: body.id });
      return j({ success: true });
    }

    if (action === 'toggle-review') {
      const r = await rs.get(body.id, { type: 'json' });
      if (!r) return j({ error: 'Not found' }, 404);
      r.approved = !r.approved;
      await rs.setJSON(body.id, r);
      await logAudit(auditStore, admin, 'admin_toggle_review', { review_id: body.id, approved: r.approved });
      return j({ success: true, approved: r.approved });
    }

    if (action === 'change-plan') {
      const patchRes = await fetch(`${url}/rest/v1/profiles?id=eq.${body.id}`, {
        method: 'PATCH', headers, body: JSON.stringify({ plan: body.plan })
      });
      if (!patchRes.ok) return j({ error: 'Failed to update plan' }, 500);
      await logAudit(auditStore, admin, 'admin_change_plan', { target_id: body.id, new_plan: body.plan });
      return j({ success: true });
    }

    if (action === 'toggle-ban') {
      // Get current banned status
      const getRes = await fetch(`${url}/rest/v1/profiles?id=eq.${body.id}&select=banned`, { headers });
      const rows = await getRes.json();
      if (!Array.isArray(rows) || rows.length === 0) return j({ error: 'Not found' }, 404);
      const newBanned = !rows[0].banned;
      await fetch(`${url}/rest/v1/profiles?id=eq.${body.id}`, {
        method: 'PATCH', headers, body: JSON.stringify({ banned: newBanned })
      });
      await logAudit(auditStore, admin, 'admin_toggle_ban', { target_id: body.id, banned: newBanned });
      return j({ success: true, banned: newBanned });
    }

    if (action === 'delete-user') {
      // Delete auth user via Supabase Admin API (cascade deletes profile)
      const delRes = await fetch(`${url}/auth/v1/admin/users/${body.id}`, {
        method: 'DELETE', headers: { 'apikey': Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY'), 'Authorization': `Bearer ${Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY')}` }
      });
      if (!delRes.ok) {
        // Fallback: delete profile directly
        await fetch(`${url}/rest/v1/profiles?id=eq.${body.id}`, { method: 'DELETE', headers });
      }
      await logAudit(auditStore, admin, 'admin_delete_user', { target_id: body.id });
      return j({ success: true });
    }

    if (action === 'set-role') {
      if (!['user', 'admin'].includes(body.role)) return j({ error: 'Invalid role' }, 400);
      await fetch(`${url}/rest/v1/profiles?id=eq.${body.id}`, {
        method: 'PATCH', headers, body: JSON.stringify({ role: body.role })
      });
      await logAudit(auditStore, admin, 'admin_set_role', { target_id: body.id, new_role: body.role });
      return j({ success: true, role: body.role });
    }

    if (action === 'audit-logs') {
      const auditList = await auditStore.list().catch(() => ({ blobs: [] }));
      const allKeys = auditList.blobs.sort((a, b) => b.key.localeCompare(a.key)).slice(0, 200);
      const logs = await Promise.all(allKeys.map(b => auditStore.get(b.key, { type: 'json' }).catch(() => null)));
      return j({ logs: logs.filter(Boolean).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)) });
    }

    return j({ error: 'Unknown action' }, 400);
  } catch (e) { return j({ error: 'Internal error' }, 500); }
};

export const config = { path: '/api/admin' };
