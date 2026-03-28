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

// Field name mapping: frontend camelCase → database snake_case
const FIELD_MAP = {
  atsScore: 'ats_score',
  atsDate: 'ats_date',
  careerScore: 'career_score',
  careerLabel: 'career_label',
  jobMatches: 'job_matches'
};
const REVERSE_MAP = Object.fromEntries(Object.entries(FIELD_MAP).map(([k, v]) => [v, k]));

// Convert database row to frontend-friendly format
function rowToFrontend(row) {
  if (!row) return {};
  const result = {};
  for (const [dbCol, feKey] of Object.entries(REVERSE_MAP)) {
    if (row[dbCol] !== null && row[dbCol] !== undefined) {
      result[feKey] = row[dbCol];
    }
  }
  if (row.updated_at) result.updatedAt = row.updated_at;
  return result;
}

// Read dashboard data from database
async function getDashboardData(userId) {
  const url = supabaseUrl();
  const res = await fetch(
    `${url}/rest/v1/user_dashboard?user_id=eq.${userId}&select=*`,
    { headers: supabaseHeaders() }
  );
  if (!res.ok) return {};
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return {};
  return rowToFrontend(rows[0]);
}

// Upsert dashboard data in database
async function upsertDashboardData(userId, fields) {
  const url = supabaseUrl();
  const headers = supabaseHeaders();

  // Build the database row from frontend fields
  const row = { user_id: userId, updated_at: new Date().toISOString() };
  for (const [feKey, dbCol] of Object.entries(FIELD_MAP)) {
    if (fields[feKey] !== undefined) {
      row[dbCol] = fields[feKey];
    }
  }

  // Try to get existing row first
  const existingRes = await fetch(
    `${url}/rest/v1/user_dashboard?user_id=eq.${userId}&select=*`,
    { headers }
  );
  const existingRows = existingRes.ok ? await existingRes.json() : [];
  const exists = Array.isArray(existingRows) && existingRows.length > 0;

  if (exists) {
    // Update (merge with existing — only set fields that are provided)
    const updateFields = { updated_at: new Date().toISOString() };
    for (const [feKey, dbCol] of Object.entries(FIELD_MAP)) {
      if (fields[feKey] !== undefined) {
        updateFields[dbCol] = fields[feKey];
      }
    }
    const res = await fetch(`${url}/rest/v1/user_dashboard?user_id=eq.${userId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(updateFields)
    });
    if (!res.ok) return null;
    const updated = await res.json();
    return Array.isArray(updated) && updated.length > 0 ? rowToFrontend(updated[0]) : null;
  } else {
    // Insert new row
    const res = await fetch(`${url}/rest/v1/user_dashboard`, {
      method: 'POST',
      headers,
      body: JSON.stringify(row)
    });
    if (!res.ok) return null;
    const inserted = await res.json();
    return Array.isArray(inserted) && inserted.length > 0 ? rowToFrontend(inserted[0]) : null;
  }
}

// One-time migration from Supabase Storage
let _migrationAttempted = {};
async function migrateFromStorage(userId) {
  if (_migrationAttempted[userId]) return {};
  _migrationAttempted[userId] = true;

  try {
    const url = supabaseUrl();
    const key = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const storageHeaders = { 'apikey': key, 'Authorization': `Bearer ${key}` };
    const path = `${userId}/dashboard.json`;
    const res = await fetch(`${url}/storage/v1/object/user-data/${path}`, { headers: storageHeaders });
    if (!res.ok) return {};
    const data = await res.json();
    if (!data || typeof data !== 'object') return {};
    // Migrate to database
    const migrated = await upsertDashboardData(userId, data);
    return migrated || {};
  } catch { return {}; }
}

export default async (req) => {
  if (req.method !== 'POST') return j({ error: 'Method not allowed' }, 405);

  const userId = authenticateJWT(req);
  if (!userId) return j({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await req.json(); } catch { return j({ error: 'Bad JSON' }, 400); }

  const { action } = body;

  try {
    // Get dashboard data
    if (action === 'get') {
      let data = await getDashboardData(userId);
      // If empty, try migrating from Storage (one-time)
      if (Object.keys(data).length === 0) {
        data = await migrateFromStorage(userId);
      }
      return j({ success: true, data });
    }

    // Update specific dashboard fields (merge with existing)
    if (action === 'update') {
      const { fields } = body;
      if (!fields || typeof fields !== 'object') return j({ error: 'fields must be an object' }, 400);
      // Only allow known fields
      const allowed = Object.keys(FIELD_MAP);
      const cleanFields = {};
      for (const key of allowed) {
        if (fields[key] !== undefined) cleanFields[key] = fields[key];
      }
      const result = await upsertDashboardData(userId, cleanFields);
      if (!result) return j({ error: 'Failed to save dashboard data' }, 500);
      return j({ success: true, data: result });
    }

    return j({ error: 'Unknown action' }, 400);
  } catch (e) {
    return j({ error: 'Internal error' }, 500);
  }
};

export const config = { path: '/api/dashboard-data' };
