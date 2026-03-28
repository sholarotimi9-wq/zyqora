// AI-powered job description analysis and CV matching
export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const headers = { 'Content-Type': 'application/json' };

  let body;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: 'Bad JSON' }), { status: 400, headers }); }

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return new Response(JSON.stringify({ error: 'No API key configured' }), { status: 500, headers });

  const baseUrl = (Netlify.env.get('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com').replace(/\/+$/, '');
  const { mode } = body;

  if (mode === 'analyze-description') {
    // Analyze job description for visa/sponsorship mentions
    const { description } = body;
    if (!description) return new Response(JSON.stringify({ error: 'No description provided' }), { status: 400, headers });

    const result = analyzeDescription(description);
    return new Response(JSON.stringify({ result }), { headers });
  }

  if (mode === 'cv-match') {
    // AI-powered CV to job matching
    const { cvText, jobs } = body;
    if (!cvText || !jobs || !jobs.length) {
      return new Response(JSON.stringify({ error: 'cvText and jobs array are required' }), { status: 400, headers });
    }

    // Batch jobs into groups for efficient AI processing (max 6 per request)
    const batchSize = 6;
    const batches = [];
    for (let i = 0; i < jobs.length; i += batchSize) {
      batches.push(jobs.slice(i, i + batchSize));
    }

    const allResults = [];
    for (const batch of batches) {
      const jobSummaries = batch.map((j, idx) => (
        `JOB ${idx + 1} [ID: ${j.id}]:\nTitle: ${j.title}\nCompany: ${j.company}\nDescription: ${(j.description || '').substring(0, 500)}\n`
      )).join('\n---\n');

      const systemPrompt = `You are a CV-to-job matching engine. For each job, analyze how well the candidate's CV matches.
Respond with ONLY valid JSON array, no markdown or fences. Each element:
{"id":"job_id","matchScore":0-100,"missingSkills":["skill1"],"strengths":["strength1"],"improvementSuggestions":["suggestion1"]}

Scoring:
- 90-100: Excellent match, meets nearly all requirements
- 70-89: Good match, meets most key requirements
- 50-69: Partial match, has relevant transferable skills
- 30-49: Weak match, some overlap
- 0-29: Poor match

Be realistic. Focus on:
- Skill alignment (technical and soft skills)
- Experience level match
- Domain/industry relevance
- Keyword alignment between CV and job description
Keep missingSkills to top 3-5, strengths to top 2-3, suggestions to top 2-3.`;

      const userPrompt = `CANDIDATE CV:\n${cvText.substring(0, 2000)}\n\nJOBS TO MATCH:\n${jobSummaries}`;

      try {
        const upstream = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 2000,
            messages: [{ role: 'user', content: userPrompt }],
            system: systemPrompt
          })
        });

        const data = await upstream.json();
        if (!upstream.ok) {
          console.error('AI error:', data);
          // Fallback: return basic keyword matching scores
          const fallbackResults = batch.map(j => keywordMatch(cvText, j));
          allResults.push(...fallbackResults);
          continue;
        }

        const text = data.content?.[0]?.text || '';
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          allResults.push(...parsed);
        } else {
          const fallbackResults = batch.map(j => keywordMatch(cvText, j));
          allResults.push(...fallbackResults);
        }
      } catch (err) {
        console.error('CV match error:', err);
        const fallbackResults = batch.map(j => keywordMatch(cvText, j));
        allResults.push(...fallbackResults);
      }
    }

    return new Response(JSON.stringify({ results: allResults }), { headers });
  }

  return new Response(JSON.stringify({ error: 'Invalid mode. Use analyze-description or cv-match' }), { status: 400, headers });
};

// Local keyword-based job description analysis (no AI needed)
function analyzeDescription(description) {
  const text = description.toLowerCase();

  const sponsorshipPhrases = [
    'visa sponsorship', 'sponsor visa', 'we sponsor', 'will sponsor',
    'sponsorship available', 'sponsorship provided', 'offer sponsorship',
    'skilled worker visa', 'tier 2', 'sponsor skilled worker',
    'sponsoring visa', 'sponsor international', 'willing to sponsor',
    'can sponsor', 'sponsorship is available', 'sponsorship for',
    'visa sponsor'
  ];

  const rightToWorkPhrases = [
    'right to work', 'eligible to work', 'work permit required',
    'must have the right to work', 'authorised to work', 'authorized to work',
    'no sponsorship', 'unable to sponsor', 'cannot sponsor', 'will not sponsor',
    'not able to sponsor', 'do not sponsor', 'without requiring sponsorship',
    'existing right to work', 'proof of right to work', 'pre-existing right'
  ];

  let sponsorshipMentioned = false;
  let requiresRightToWork = false;
  let sponsorshipConfidence = 0;

  for (const phrase of sponsorshipPhrases) {
    if (text.includes(phrase)) {
      sponsorshipMentioned = true;
      sponsorshipConfidence = Math.max(sponsorshipConfidence, 85);
    }
  }

  for (const phrase of rightToWorkPhrases) {
    if (text.includes(phrase)) {
      requiresRightToWork = true;
      // "no sponsorship" / "cannot sponsor" style phrases override positive sponsorship
      if (['no sponsorship', 'unable to sponsor', 'cannot sponsor', 'will not sponsor',
           'not able to sponsor', 'do not sponsor', 'without requiring sponsorship'].includes(phrase)) {
        if (text.includes(phrase)) {
          sponsorshipMentioned = false;
          sponsorshipConfidence = 0;
        }
      }
    }
  }

  return {
    sponsorshipMentioned,
    requiresRightToWork,
    confidenceScore: sponsorshipMentioned ? sponsorshipConfidence : (requiresRightToWork ? 80 : 0)
  };
}

// Fallback keyword matching when AI is unavailable
function keywordMatch(cvText, job) {
  const cv = cvText.toLowerCase();
  const jobText = `${job.title || ''} ${job.description || ''}`.toLowerCase();

  // Extract keywords from job
  const words = jobText.split(/[^a-z0-9+#]+/).filter(w => w.length > 2);
  const uniqueWords = [...new Set(words)];
  const stopWords = new Set(['the', 'and', 'for', 'with', 'you', 'are', 'will', 'that', 'this', 'have', 'from', 'our', 'your', 'about', 'been', 'would', 'could', 'should', 'their', 'they', 'what', 'when', 'where', 'which', 'who', 'whom', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'than', 'too', 'very', 'can', 'just', 'also', 'into', 'over', 'after', 'before', 'between']);
  const keywords = uniqueWords.filter(w => !stopWords.has(w));

  let matches = 0;
  const matched = [];
  const missing = [];
  for (const kw of keywords.slice(0, 30)) {
    if (cv.includes(kw)) { matches++; matched.push(kw); }
    else missing.push(kw);
  }

  const score = keywords.length > 0 ? Math.min(95, Math.round((matches / Math.min(keywords.length, 30)) * 100)) : 30;

  return {
    id: job.id,
    matchScore: score,
    missingSkills: missing.slice(0, 5),
    strengths: matched.slice(0, 3).map(k => `Experience with ${k}`),
    improvementSuggestions: missing.length > 0 ? [`Consider adding experience with: ${missing.slice(0, 3).join(', ')}`] : []
  };
}

export const config = { path: '/api/job-analysis' };
