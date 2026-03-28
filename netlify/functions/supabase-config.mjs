// Returns public Supabase configuration to the frontend.
// Both values are safe to expose publicly (anon key has limited permissions).
export default async () => {
  const url = Netlify.env.get('SUPABASE_URL') || Netlify.env.get('SUPABASE_DATABASE_URL');
  const anonKey = Netlify.env.get('SUPABASE_ANON_KEY');
  if (!url || !anonKey) {
    return new Response(JSON.stringify({ error: 'Supabase not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return new Response(JSON.stringify({ url, anonKey }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
  });
};

export const config = { path: '/api/supabase-config' };
