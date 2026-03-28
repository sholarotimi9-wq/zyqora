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

// Read CVs from the cvs table
async function getCVs(userId) {
  const url = supabaseUrl();
  if (!url) return [];
  const res = await fetch(
    `${url}/rest/v1/cvs?user_id=eq.${userId}&select=id,cv_data,created_at,updated_at&order=created_at.desc`,
    { headers: supabaseHeaders() }
  );
  if (!res.ok) return [];
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];
  return rows.map(row => {
    const cv = row.cv_data || {};
    cv.id = row.id;
    cv._created_at = row.created_at;
    cv._updated_at = row.updated_at;
    return cv;
  });
}

// Save a single CV (insert or update)
async function upsertCV(userId, cv) {
  const url = supabaseUrl();
  const headers = supabaseHeaders();
  if (!url) return { ok: false, detail: 'Supabase URL not configured' };

  // Strip internal fields from cv_data before storing
  const cvData = { ...cv };
  delete cvData.id;
  delete cvData._created_at;
  delete cvData._updated_at;

  if (cv.id) {
    // Update existing CV — check it belongs to the user
    const res = await fetch(`${url}/rest/v1/cvs?id=eq.${cv.id}&user_id=eq.${userId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ cv_data: cvData, updated_at: new Date().toISOString() })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, detail: `Update failed (${res.status}): ${text}` };
    }
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length > 0) {
      return { ok: true, cv: { ...cvData, id: rows[0].id } };
    }
    // If no rows updated (id not found), insert as new
  }

  // Insert new CV
  const row = {
    user_id: userId,
    cv_data: cvData,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  const res = await fetch(`${url}/rest/v1/cvs`, {
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
    return { ok: true, cv: { ...cvData, id: inserted[0].id } };
  }
  return { ok: true };
}

// Replace all CVs for a user (full sync from frontend)
async function saveCVs(userId, cvs) {
  const url = supabaseUrl();
  const headers = supabaseHeaders();
  if (!url) return { ok: false, detail: 'Supabase URL not configured' };

  if (cvs.length === 0) {
    const delRes = await fetch(`${url}/rest/v1/cvs?user_id=eq.${userId}`, {
      method: 'DELETE',
      headers
    });
    if (!delRes.ok) {
      const text = await delRes.text().catch(() => '');
      return { ok: false, detail: `Delete failed (${delRes.status}): ${text}` };
    }
    return { ok: true, cvs: [] };
  }

  // Separate CVs with existing UUIDs (updates) from new ones (inserts)
  // Track original index so we can return results in client order
  const existingIds = [];
  const toUpdate = [];
  const toInsert = [];

  for (let idx = 0; idx < cvs.length; idx++) {
    const cv = cvs[idx];
    const cvData = { ...cv };
    delete cvData.id;
    delete cvData._created_at;
    delete cvData._updated_at;

    // UUID format check (standard UUID v4 pattern)
    if (cv.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cv.id)) {
      existingIds.push(cv.id);
      toUpdate.push({ id: cv.id, cvData, originalIndex: idx });
    } else {
      // New CV or legacy text ID — insert as new with auto-generated UUID
      toInsert.push({ cvData, originalIndex: idx });
    }
  }

  // Use an array matching the original input order
  const results = new Array(cvs.length);

  // Update existing CVs
  for (const item of toUpdate) {
    const res = await fetch(`${url}/rest/v1/cvs?id=eq.${item.id}&user_id=eq.${userId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ cv_data: item.cvData, updated_at: new Date().toISOString() })
    });
    if (res.ok) {
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0) {
        results[item.originalIndex] = { ...item.cvData, id: rows[0].id };
      }
    }
  }

  // Insert new CVs
  if (toInsert.length > 0) {
    const rows = toInsert.map(item => ({
      user_id: userId,
      cv_data: item.cvData,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }));
    const res = await fetch(`${url}/rest/v1/cvs`, {
      method: 'POST',
      headers,
      body: JSON.stringify(rows)
    });
    if (res.ok) {
      const inserted = await res.json();
      if (Array.isArray(inserted)) {
        inserted.forEach((row, i) => {
          results[toInsert[i].originalIndex] = { ...toInsert[i].cvData, id: row.id };
        });
      }
    }
  }

  // Filter out any undefined entries (failed operations)
  const orderedResults = results.filter(Boolean);

  // Delete CVs that are no longer in the array
  if (existingIds.length > 0) {
    const idFilter = existingIds.map(id => `"${id}"`).join(',');
    await fetch(`${url}/rest/v1/cvs?user_id=eq.${userId}&id=not.in.(${idFilter})`, {
      method: 'DELETE',
      headers
    });
  } else {
    // All CVs are new insertions — delete all old ones
    // Get the IDs of newly inserted CVs to exclude from deletion
    const newIds = orderedResults.map(r => r.id).filter(Boolean);
    if (newIds.length > 0) {
      const idFilter = newIds.map(id => `"${id}"`).join(',');
      await fetch(`${url}/rest/v1/cvs?user_id=eq.${userId}&id=not.in.(${idFilter})`, {
        method: 'DELETE',
        headers
      });
    }
  }

  return { ok: true, cvs: orderedResults };
}

// Delete a single CV
async function deleteCV(userId, cvId) {
  const url = supabaseUrl();
  const headers = supabaseHeaders();
  const res = await fetch(`${url}/rest/v1/cvs?id=eq.${cvId}&user_id=eq.${userId}`, {
    method: 'DELETE',
    headers
  });
  return { ok: res.ok };
}

// Merge CVs (add only new ones — for localStorage migration)
async function mergeCVs(userId, newCVs) {
  const url = supabaseUrl();
  const headers = supabaseHeaders();
  const existingCVs = await getCVs(userId);
  const existingNames = new Set(existingCVs.map(c => `${c.name || ''}|${c.title || ''}`));

  const toInsert = newCVs.filter(cv => {
    const key = `${cv.name || ''}|${cv.title || ''}`;
    return !existingNames.has(key);
  });

  if (toInsert.length > 0) {
    const totalCount = existingCVs.length + toInsert.length;
    if (totalCount > 50) return { ok: false, error: 'Too many CVs after merge' };

    const rows = toInsert.map(cv => {
      const cvData = { ...cv };
      delete cvData.id;
      delete cvData._created_at;
      delete cvData._updated_at;
      return {
        user_id: userId,
        cv_data: cvData,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
    });

    await fetch(`${url}/rest/v1/cvs`, {
      method: 'POST',
      headers,
      body: JSON.stringify(rows)
    });
  }

  return { ok: true, cvs: await getCVs(userId) };
}

// One-time migration from old user_cvs table to new cvs table
let _migrationAttempted = {};
async function migrateFromOldTable(userId) {
  if (_migrationAttempted[userId]) return [];
  _migrationAttempted[userId] = true;

  try {
    const url = supabaseUrl();
    const headers = supabaseHeaders();

    // Check old user_cvs table for data
    const res = await fetch(
      `${url}/rest/v1/user_cvs?user_id=eq.${userId}&select=id,cv_data,created_at,updated_at&order=created_at.asc`,
      { headers }
    );
    if (!res.ok) return [];
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      // Also try Supabase Storage
      return await migrateFromStorage(userId);
    }

    // Migrate to new cvs table
    const cvs = rows.map(row => {
      const cv = row.cv_data || {};
      return cv;
    });
    if (cvs.length > 0) {
      const newRows = cvs.map(cv => {
        const cvData = { ...cv };
        delete cvData.id;
        return {
          user_id: userId,
          cv_data: cvData,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
      });
      await fetch(`${url}/rest/v1/cvs`, {
        method: 'POST',
        headers,
        body: JSON.stringify(newRows)
      });
    }
    return await getCVs(userId);
  } catch { return []; }
}

// Legacy migration from Supabase Storage
async function migrateFromStorage(userId) {
  try {
    const url = supabaseUrl();
    const key = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const storageHeaders = { 'apikey': key, 'Authorization': `Bearer ${key}` };
    const path = `${userId}/cvs.json`;
    const res = await fetch(`${url}/storage/v1/object/user-data/${path}`, { headers: storageHeaders });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return [];

    const headers = supabaseHeaders();
    const rows = data.map(cv => {
      const cvData = { ...cv };
      delete cvData.id;
      return {
        user_id: userId,
        cv_data: cvData,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
    });
    await fetch(`${url}/rest/v1/cvs`, {
      method: 'POST',
      headers,
      body: JSON.stringify(rows)
    });
    return await getCVs(userId);
  } catch { return []; }
}

export default async (req) => {
  if (req.method !== 'POST') return j({ error: 'Method not allowed' }, 405);

  const userId = authenticateJWT(req);
  if (!userId) return j({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await req.json(); } catch { return j({ error: 'Bad JSON' }, 400); }

  const { action } = body;

  try {
    // List user's CVs
    if (action === 'list') {
      let cvs = await getCVs(userId);
      if (cvs.length === 0) {
        const migrated = await migrateFromOldTable(userId);
        if (migrated.length > 0) {
          cvs = migrated;
        }
      }
      return j({ success: true, cvs });
    }

    // Save/upsert a single CV
    if (action === 'upsert') {
      const { cv } = body;
      if (!cv || typeof cv !== 'object') return j({ error: 'cv must be an object' }, 400);
      const result = await upsertCV(userId, cv);
      if (!result.ok) return j({ error: result.detail || 'Failed to save CV' }, 500);
      return j({ success: true, cv: result.cv });
    }

    // Save full CV array (replace all CVs — legacy support + full sync)
    if (action === 'save') {
      const { cvs } = body;
      if (!Array.isArray(cvs)) return j({ error: 'cvs must be an array' }, 400);
      if (cvs.length > 50) return j({ error: 'Maximum 50 CVs allowed' }, 400);
      const payload = JSON.stringify(cvs);
      if (payload.length > 5 * 1024 * 1024) return j({ error: 'CV data too large (max 5MB)' }, 400);
      const result = await saveCVs(userId, cvs);
      if (!result.ok) return j({ error: result.detail || 'Failed to save CVs' }, 500);
      return j({ success: true, cvs: result.cvs || [] });
    }

    // Delete a single CV
    if (action === 'delete') {
      const { cvId } = body;
      if (!cvId) return j({ error: 'cvId is required' }, 400);
      const result = await deleteCV(userId, cvId);
      if (!result.ok) return j({ error: 'Failed to delete CV' }, 500);
      return j({ success: true });
    }

    // Merge CVs from localStorage migration
    if (action === 'merge') {
      const { cvs: localCVs } = body;
      if (!Array.isArray(localCVs)) return j({ error: 'cvs must be an array' }, 400);
      const result = await mergeCVs(userId, localCVs);
      if (!result.ok) return j({ error: result.error }, 400);
      return j({ success: true, cvs: result.cvs });
    }

    return j({ error: 'Unknown action' }, 400);
  } catch (e) {
    return j({ error: 'Internal error' }, 500);
  }
};

export const config = { path: '/api/cv' };
