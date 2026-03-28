export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  let body;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: 'Bad JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return new Response(JSON.stringify({ error: 'AI service is not configured. Please check your API key.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  const baseUrl = (Netlify.env.get('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com').replace(/\/+$/, '');
  const { prompt, system, max_tokens, stream } = body;
  if (!prompt) return new Response(JSON.stringify({ error: 'No prompt provided' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  const payload = { model: 'claude-haiku-4-5-20251001', max_tokens: max_tokens || 1000, stream: !!stream, messages: [{ role: 'user', content: prompt }] };
  if (system) payload.system = system;
  try {
    const upstream = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(payload)
    });
    if (stream) return new Response(upstream.body, { headers: { 'Content-Type': 'text/event-stream' } });
    const data = await upstream.json();
    if (!upstream.ok) return new Response(JSON.stringify({ error: data.error?.message || 'AI service temporarily unavailable. Please try again.' }), { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ text: data.content?.[0]?.text || '' }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Failed to connect to AI service. Please try again.' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }
};
export const config = { path: '/api/ai' };
