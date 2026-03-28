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

async function logAudit(auditStore, userId, email, method) {
  try {
    const { randomBytes } = await import('crypto');
    await auditStore.setJSON('evt:' + Date.now() + ':' + randomBytes(4).toString('hex'), {
      user_id: userId, role: 'admin', event_type: 'admin_role_setup', timestamp: new Date().toISOString(),
      detail: { email, method }
    });
  } catch {}
}

async function promoteToAdmin(url, headers, userId) {
  const res = await fetch(`${url}/rest/v1/profiles?id=eq.${userId}`, {
    method: 'PATCH', headers, body: JSON.stringify({ role: 'admin' })
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Profile update failed (${res.status}): ${errBody}`);
  }
  const updated = await res.json().catch(() => []);
  if (Array.isArray(updated) && updated.length > 0 && updated[0].role !== 'admin') {
    throw new Error('Role update was blocked by database policy. Please check Supabase RLS triggers.');
  }
  return updated;
}

export default async (req) => {
  if (req.method !== 'POST') return j({ error: 'Method not allowed' }, 405);
  let body;
  try { body = await req.json(); } catch { return j({ error: 'Bad JSON' }, 400); }

  const { email, adminPassword, express } = body;
  if (!email) return j({ error: 'Email required' }, 400);

  // Designated admin email — always allowed to self-promote
  const DESIGNATED_ADMIN_EMAIL = 'fariodele@gmail.com';

  const url = supabaseUrl();
  if (!url) return j({ error: 'Supabase URL not configured. Please set SUPABASE_URL in your Netlify environment variables.' }, 500);

  const serviceKey = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!serviceKey) return j({ error: 'Supabase service role key not configured. Please set SUPABASE_SERVICE_ROLE_KEY in your Netlify environment variables.' }, 500);

  const headers = supabaseHeaders();
  const auditStore = getStore({ name: 'zyqora-audit', consistency: 'strong' });

  // Verify the caller is authenticated via Supabase JWT
  const auth = req.headers.get('authorization');
  if (!auth || !auth.startsWith('Bearer ')) return j({ error: 'Not authenticated. Please sign in first.' }, 401);
  const token = auth.slice(7);
  const secret = Netlify.env.get('SUPABASE_JWT_SECRET');
  if (!secret) return j({ error: 'JWT secret not configured. Please set SUPABASE_JWT_SECRET in your Netlify environment variables.' }, 500);
  const jwt = verifySupabaseJWT(token, secret);
  if (!jwt || !jwt.sub) return j({ error: 'Invalid session. Please sign in again.' }, 401);

  // Get the caller's profile
  let callerProfile;
  try {
    const profileRes = await fetch(`${url}/rest/v1/profiles?id=eq.${jwt.sub}&select=*`, { headers });
    if (!profileRes.ok) {
      return j({ error: `Could not fetch profile (${profileRes.status}). Please check Supabase configuration.` }, 500);
    }
    const profiles = await profileRes.json();
    callerProfile = Array.isArray(profiles) && profiles.length > 0 ? profiles[0] : null;
  } catch (e) {
    return j({ error: `Failed to connect to Supabase: ${e.message}` }, 500);
  }

  if (!callerProfile) return j({ error: 'Profile not found. Please sign up first.' }, 404);

  // Already an admin — skip everything
  if (callerProfile.role === 'admin') {
    return j({ success: true, message: `${callerProfile.email} is already an admin.`, alreadyAdmin: true });
  }

  // Verify the email matches the authenticated user
  if (callerProfile.email.toLowerCase().trim() !== email.toLowerCase().trim()) {
    return j({ error: 'Email does not match your account.' }, 400);
  }

  // Designated admin email can always self-promote
  const isDesignatedAdmin = callerProfile.email.toLowerCase().trim() === DESIGNATED_ADMIN_EMAIL;

  // Express access mode: allow any authenticated user to self-promote if they are the
  // designated admin OR no admin exists yet (first-user setup)
  if (express || isDesignatedAdmin) {
    // For express mode by non-designated users, verify no admin exists
    if (!isDesignatedAdmin) {
      try {
        const res = await fetch(`${url}/rest/v1/profiles?role=eq.admin&select=id&limit=1`, { headers });
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length > 0) {
          // Admin exists — express mode not allowed for non-designated users without password
          const pw = Netlify.env.get('ADMIN_PASSWORD');
          if (!pw || !adminPassword || adminPassword !== pw) {
            return j({ error: 'An admin already exists. Use the admin password or ask an existing admin to promote you.' }, 403);
          }
        }
      } catch {}
    }

    try {
      await promoteToAdmin(url, headers, jwt.sub);
    } catch (e) {
      return j({ error: `Admin activation failed: ${e.message}` }, 500);
    }
    await logAudit(auditStore, jwt.sub, callerProfile.email, isDesignatedAdmin ? 'designated-admin' : 'express-setup');
    return j({ success: true, message: `${email} is now an admin. Welcome!`, firstAdmin: true });
  }

  // Standard flow: check if any admin already exists
  let adminExists = false;
  try {
    const res = await fetch(`${url}/rest/v1/profiles?role=eq.admin&select=id&limit=1`, { headers });
    if (!res.ok) {
      return j({ error: `Could not check admin status (${res.status}). Please verify Supabase configuration.` }, 500);
    }
    const rows = await res.json();
    adminExists = Array.isArray(rows) && rows.length > 0;
  } catch (e) {
    return j({ error: `Failed to check admin status: ${e.message}` }, 500);
  }

  if (!adminExists) {
    // First admin setup: authenticated user promotes themselves
    try {
      await promoteToAdmin(url, headers, jwt.sub);
    } catch (e) {
      return j({ error: `Admin activation failed: ${e.message}` }, 500);
    }
    await logAudit(auditStore, jwt.sub, callerProfile.email, 'first-admin-setup');
    return j({ success: true, message: `${email} is now an admin. Welcome!`, firstAdmin: true });
  } else {
    // Admin already exists — require ADMIN_PASSWORD env var
    const pw = Netlify.env.get('ADMIN_PASSWORD');
    if (!pw || !adminPassword || adminPassword !== pw) {
      return j({ error: 'An admin already exists. Use the admin password or ask an existing admin to promote you.' }, 403);
    }

    try {
      await promoteToAdmin(url, headers, jwt.sub);
    } catch (e) {
      return j({ error: `Admin activation failed: ${e.message}` }, 500);
    }
    await logAudit(auditStore, jwt.sub, callerProfile.email, 'admin-password');
    return j({ success: true, message: `${email} is now an admin. Welcome!` });
  }
};

export const config = { path: '/api/admin-setup' };
