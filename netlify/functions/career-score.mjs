export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  let body;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: 'Bad JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return new Response(JSON.stringify({ error: 'No API key configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } });

  const baseUrl = (Netlify.env.get('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com').replace(/\/+$/, '');
  const { cvData } = body;

  if (!cvData) return new Response(JSON.stringify({ error: 'No CV data provided' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  // Build CV text from structured data
  const parts = [];
  if (cvData.name) parts.push(`Name: ${cvData.name}`);
  if (cvData.title) parts.push(`Job Title: ${cvData.title}`);
  if (cvData.email) parts.push(`Email: ${cvData.email}`);
  if (cvData.phone) parts.push(`Phone: ${cvData.phone}`);
  if (cvData.loc) parts.push(`Location: ${cvData.loc}`);
  if (cvData.linkedin) parts.push(`LinkedIn: ${cvData.linkedin}`);
  if (cvData.summary) parts.push(`Professional Summary: ${cvData.summary}`);
  const skillsList = cvData.tags || cvData.skills;
  if (skillsList && skillsList.length) parts.push(`Skills: ${Array.isArray(skillsList) ? skillsList.join(', ') : skillsList}`);
  if (cvData.exps && cvData.exps.length) {
    parts.push('Work Experience:');
    cvData.exps.forEach(e => {
      parts.push(`- ${e.role || ''} at ${e.co || ''} (${e.period || ''})`);
      if (e.desc) parts.push(`  ${e.desc}`);
    });
  }
  if (cvData.edus && cvData.edus.length) {
    parts.push('Education:');
    cvData.edus.forEach(e => parts.push(`- ${e.deg || ''} from ${e.inst || ''} (${e.yr || ''})${e.grade ? ' — Grade: ' + e.grade : ''}`));
  }
  if (cvData.certs && cvData.certs.length) {
    parts.push('Certifications:');
    cvData.certs.forEach(c => {
      if (typeof c === 'string') parts.push(`- ${c}`);
      else parts.push(`- ${c.name || ''}${c.issuer ? ' — ' + c.issuer : ''}${c.yr ? ' (' + c.yr + ')' : ''}`);
    });
  }
  if (cvData.awards && cvData.awards.length) {
    parts.push('Awards:');
    cvData.awards.forEach(a => {
      if (typeof a === 'string') parts.push(`- ${a}`);
      else parts.push(`- ${a.title || ''}${a.org ? ' — ' + a.org : ''}${a.yr ? ' (' + a.yr + ')' : ''}`);
    });
  }
  const cvText = parts.join('\n');

  const system = `You are an expert career analyst and HR consultant. Analyse the provided CV/resume data and produce a detailed, personalised career readiness score and insights.

You MUST respond with valid JSON only. No markdown, no code fences, no explanation text outside the JSON.

Scoring criteria (each out of the max shown):
- experience (max 30): Quality, progression, seniority, years of experience, achievement focus
- skills (max 20): Breadth, relevance to stated role, in-demand technical/soft skills mix
- education (max 15): Relevance to career, institution quality, grade/classification
- certifications (max 10): Industry-relevant certifications, recency
- profileCompleteness (max 10): Contact info, LinkedIn, summary quality, location
- presentation (max 15): Bullet point quality, quantified achievements, action verbs, summary clarity

Return this exact JSON structure:
{
  "overallScore": <number 0-100>,
  "overallLabel": "<e.g. Strong Candidate, Developing Professional, Senior-Level Ready>",
  "overallSummary": "<1-2 sentence personalised summary of their career readiness>",
  "breakdown": {
    "experience": {"score": <number>, "max": 30, "label": "<short label>"},
    "skills": {"score": <number>, "max": 20, "label": "<short label>"},
    "education": {"score": <number>, "max": 15, "label": "<short label>"},
    "certifications": {"score": <number>, "max": 10, "label": "<short label>"},
    "profileCompleteness": {"score": <number>, "max": 10, "label": "<short label>"},
    "presentation": {"score": <number>, "max": 15, "label": "<short label>"}
  },
  "strengths": [
    {"title": "<strength title>", "detail": "<1 sentence explanation specific to their CV>"},
    {"title": "<strength title>", "detail": "<1 sentence explanation specific to their CV>"},
    {"title": "<strength title>", "detail": "<1 sentence explanation specific to their CV>"}
  ],
  "recommendations": [
    {"title": "<recommendation>", "detail": "<1 sentence actionable advice specific to their CV>", "priority": "high|medium|low"},
    {"title": "<recommendation>", "detail": "<1 sentence actionable advice specific to their CV>", "priority": "high|medium|low"},
    {"title": "<recommendation>", "detail": "<1 sentence actionable advice specific to their CV>", "priority": "high|medium|low"},
    {"title": "<recommendation>", "detail": "<1 sentence actionable advice specific to their CV>", "priority": "high|medium|low"}
  ],
  "insights": [
    {"type": "positive|warning|info", "title": "<insight title>", "detail": "<1 sentence insight specific to their profile>"},
    {"type": "positive|warning|info", "title": "<insight title>", "detail": "<1 sentence insight specific to their profile>"},
    {"type": "positive|warning|info", "title": "<insight title>", "detail": "<1 sentence insight specific to their profile>"},
    {"type": "positive|warning|info", "title": "<insight title>", "detail": "<1 sentence insight specific to their profile>"}
  ],
  "marketPosition": "<2-3 sentences about where this candidate stands in the current job market for their role/industry, including any trends or positioning advice>"
}

IMPORTANT RULES:
- Be specific and reference actual details from the CV (real job titles, companies, skills, qualifications they have)
- Do NOT give generic advice — tailor everything to this specific person's profile
- Score honestly based on what the CV contains — do not inflate scores
- The overallScore should equal the sum of all breakdown scores
- Strengths should highlight what makes this specific candidate stand out
- Recommendations should be actionable and specific to gaps in THIS CV`;

  const payload = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    messages: [{ role: 'user', content: `Analyse this CV and provide a career readiness score:\n\n${cvText}` }],
    system
  };

  try {
    const upstream = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(payload)
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      return new Response(JSON.stringify({ error: data.error?.message || 'API error' }), { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
    }

    const text = data.content?.[0]?.text || '';

    // Try to parse the JSON response
    let result;
    try {
      // Strip any markdown code fences if present
      const cleaned = text.replace(/```json?\s*/g, '').replace(/```\s*/g, '').trim();
      result = JSON.parse(cleaned);
    } catch {
      return new Response(JSON.stringify({ error: 'Failed to parse AI response', raw: text }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Request failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const config = { path: '/api/career-score' };
