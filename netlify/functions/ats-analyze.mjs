export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  let body;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: 'Bad JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return new Response(JSON.stringify({ error: 'No API key configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } });

  const baseUrl = (Netlify.env.get('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com').replace(/\/+$/, '');
  const { cvData, jobDescription, mode } = body;

  if (!cvData) return new Response(JSON.stringify({ error: 'No CV data provided' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  // Build CV text from either raw text or structured object
  const isRawText = typeof cvData === 'string';
  let cvText;
  if (isRawText) {
    cvText = cvData;
  } else {
    const parts = [];
    if (cvData.name) parts.push(`Name: ${cvData.name}`);
    if (cvData.title) parts.push(`Title: ${cvData.title}`);
    if (cvData.email) parts.push(`Email: ${cvData.email}`);
    if (cvData.phone) parts.push(`Phone: ${cvData.phone}`);
    if (cvData.loc) parts.push(`Location: ${cvData.loc}`);
    if (cvData.linkedin) parts.push(`LinkedIn: ${cvData.linkedin}`);
    if (cvData.summary) parts.push(`Summary: ${cvData.summary}`);
    const skillsList = cvData.tags || cvData.skills;
    if (skillsList) parts.push(`Skills: ${Array.isArray(skillsList) ? skillsList.join(', ') : skillsList}`);
    if (cvData.exps && cvData.exps.length) {
      parts.push('Experience:');
      cvData.exps.forEach(e => {
        const period = e.period || (e.from ? (e.from + ' - ' + (e.to || 'Present')) : '');
        parts.push(`- ${e.role || ''} at ${e.co || ''} (${period})`);
        if (e.desc) parts.push(`  ${e.desc}`);
      });
    }
    if (cvData.edus && cvData.edus.length) {
      parts.push('Education:');
      cvData.edus.forEach(e => parts.push(`- ${e.deg || ''} from ${e.inst || ''} (${e.yr || ''})${e.grade ? ' — ' + e.grade : ''}`));
    }
    if (cvData.certs && cvData.certs.length) {
      parts.push('Certifications:');
      cvData.certs.forEach(c => {
        if (typeof c === 'string') { parts.push(`- ${c}`); }
        else { parts.push(`- ${c.name || ''}${c.issuer ? ' — ' + c.issuer : ''}${c.yr ? ' (' + c.yr + ')' : ''}`); }
      });
    }
    if (cvData.awards && cvData.awards.length) {
      parts.push('Awards:');
      cvData.awards.forEach(a => {
        if (typeof a === 'string') { parts.push(`- ${a}`); }
        else { parts.push(`- ${a.title || a.name || ''}${a.org ? ' — ' + a.org : ''}${a.yr ? ' (' + a.yr + ')' : ''}`); }
      });
    }
    cvText = parts.join('\n');
  }

  if (!cvText || cvText.trim().length < 10) {
    return new Response(JSON.stringify({ error: 'CV content is too short or empty' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const hasJD = jobDescription && jobDescription.trim().length > 0;

  let systemPrompt, userPrompt;

  if (mode === 'optimize') {
    systemPrompt = `You are an expert ATS (Applicant Tracking System) CV optimizer. Your job is to rewrite and optimize a CV to score higher with ATS systems${hasJD ? ' and match the provided job description' : ''}.

You MUST respond with ONLY valid JSON, no markdown, no code fences, no explanation. The JSON must have this exact structure:
{
  "parsedCV": {
    "name": "Full Name from CV",
    "title": "Professional Title from CV",
    "email": "email from CV",
    "phone": "phone from CV",
    "loc": "location from CV",
    "linkedin": "linkedin URL if present",
    "tags": ["skill1", "skill2"],
    "edus": [{ "inst": "Institution", "deg": "Degree", "yr": "Year", "grade": "Grade/Classification e.g. First Class Honours, 2:1, Distinction" }],
    "certs": [{ "name": "Cert Name", "issuer": "Issuing Org", "yr": "Year" }],
    "awards": [{ "title": "Award Title", "org": "Organization", "yr": "Year" }]
  },
  "optimizedSummary": "improved professional summary text",
  "optimizedExperience": [
    { "role": "Job Title", "co": "Company", "period": "Start - End", "desc": "• First achievement or responsibility\\n• Second achievement or responsibility\\n• Third achievement or responsibility" }
  ],
  "optimizedSkills": ["skill1", "skill2"],
  "optimizedEducation": [
    { "inst": "Institution", "deg": "Degree", "yr": "Year", "grade": "Grade/Classification e.g. First Class Honours, 2:1, Distinction" }
  ],
  "optimizedCertifications": [
    { "name": "Certification Name", "issuer": "Issuing Organization", "yr": "Year" }
  ],
  "optimizedAwards": [
    { "title": "Award Title", "org": "Organization", "yr": "Year" }
  ],
  "skillsToAdd": ["additional skill1", "additional skill2"],
  "keyChanges": ["change 1 description", "change 2 description"],
  "expectedScoreImprovement": 15
}

Guidelines:
- The "parsedCV" field MUST contain ALL personal info and structured data extracted from the original CV text — this is critical for populating the CV builder
- Read the actual CV content carefully to extract name, email, phone, location, education, certifications, and awards — do NOT guess or fabricate information

CRITICAL FORMATTING RULE FOR EXPERIENCE DESCRIPTIONS:
- Each "desc" field in optimizedExperience MUST contain bullet points separated by newline characters (\\n)
- Each bullet point MUST start with "• " (the bullet character • followed by a space)
- Each bullet point MUST be a SEPARATE line — NEVER combine multiple responsibilities into one long paragraph or one bullet
- CORRECT format: "• Led migration of ERP platforms\\n• Directed large-scale system upgrades\\n• Drove initiatives to optimise database performance"
- WRONG format: "• Supported enterprise ERP platforms, analyzing system performance, identifying inefficiencies. Performed comprehensive network analysis and troubleshooting across TCP/IP."
- If the original CV has 5 separate bullet points for a role, the optimized version MUST also have individual separate bullet points (at least as many)
- Preserve the granularity of the original bullet structure — do NOT merge multiple distinct responsibilities into fewer bullets

CRITICAL — Correctly classify items into the RIGHT section:
- EDUCATION (edus/optimizedEducation): Academic degrees and qualifications from universities, colleges, or schools. Examples: BSc, BA, MSc, MA, MBA, PhD, Diploma, HND, HNC, NVQ, BTEC, A-Levels, GCSEs, Associate Degree, Foundation Degree, Postgraduate Certificate/Diploma. If it was studied at a university, college, or school, it belongs in EDUCATION.
- CERTIFICATIONS (certs/optimizedCertifications): Professional certifications, licenses, and accreditations from professional bodies or training providers. Examples: PMP, PRINCE2, CCNA, AWS Certified, CompTIA, Google Certified, Microsoft Certified, CIPD, First Aid Certificate, DBS Check, Manual Handling, Food Hygiene. If it was awarded by a professional body or training provider (NOT a university degree), it belongs in CERTIFICATIONS.
- AWARDS (awards/optimizedAwards): Honors, prizes, recognitions, and achievements. Examples: Employee of the Month, Dean's List, Scholarship, Best Paper Award, Industry Recognition Award. If it is a prize, honor, or recognition, it belongs in AWARDS.
- NEVER put a university degree in certifications or awards
- NEVER put a professional certification in education or awards
- NEVER put an award/honor in education or certifications

- optimizedCertifications MUST be objects with {name, issuer, yr}, NOT strings
- optimizedAwards MUST be objects with {title, org, yr}, NOT strings
- optimizedEducation MUST be objects with {inst, deg, yr, grade}, NOT strings
- Incorporate relevant ATS keywords naturally
- Use action verbs and quantifiable achievements
- Ensure proper formatting for ATS parsing
- Keep content truthful - enhance presentation, don't fabricate
- CRITICAL: Preserve the user's original employment dates EXACTLY as they appear in the CV. Do NOT change, guess, or fabricate date ranges. If the CV says "Jan 2020 - Present", the optimized version MUST also say "Jan 2020 - Present". Never replace dates with "undefined", empty strings, or made-up dates.
- Return ALL sections even if unchanged — if the CV has certifications, education, or awards, they MUST appear in both parsedCV and the optimized fields
- skillsToAdd should list important skills from the job description that are missing from the CV
- REMINDER: Each experience "desc" MUST have each bullet on its own line separated by \\n. Never merge bullets into a single paragraph.`;

    userPrompt = `Optimize this CV for ATS systems${hasJD ? ' and the following job description' : ''}:

CV:
${cvText}${hasJD ? `

Job Description:
${jobDescription}` : ''}`;
  } else {
    // analyze mode
    if (hasJD) {
      systemPrompt = `You are an expert ATS (Applicant Tracking System) analyzer. Analyze the provided CV against the job description and provide a detailed scoring.

You MUST respond with ONLY valid JSON, no markdown, no code fences, no explanation. The JSON must have this exact structure:
{
  "overallScore": 72,
  "grade": "Good",
  "gradeSummary": "Brief one-line summary of the score",
  "scores": {
    "keyword": { "score": 70, "explanation": "brief explanation" },
    "skills": { "score": 75, "explanation": "brief explanation" },
    "experience": { "score": 80, "explanation": "brief explanation" },
    "formatting": { "score": 65, "explanation": "brief explanation" },
    "completeness": { "score": 70, "explanation": "brief explanation" }
  },
  "keywords": {
    "matched": ["keyword1", "keyword2"],
    "missing": ["keyword3", "keyword4"],
    "suggested": ["keyword5", "keyword6"]
  },
  "experienceFeedback": ["feedback item 1", "feedback item 2"],
  "formattingWarnings": ["warning 1", "warning 2"],
  "completeness": [
    { "section": "Contact Info", "status": "present", "feedback": "Complete" },
    { "section": "Summary", "status": "present", "feedback": "Good professional summary" },
    { "section": "Skills", "status": "weak", "feedback": "Could include more relevant skills" },
    { "section": "Experience", "status": "present", "feedback": "Well documented" },
    { "section": "Education", "status": "missing", "feedback": "No education section found" }
  ],
  "recommendations": ["recommendation 1", "recommendation 2", "recommendation 3"]
}

Scoring guidelines:
- overallScore: 0-100 weighted average
- grade: "Excellent" (90-100), "Very Good" (80-89), "Good" (70-79), "Fair" (60-69), "Needs Work" (40-59), "Poor" (0-39)
- Each sub-score: 0-100
- keyword: How well the CV keywords match the job description requirements
- skills: How well the CV skills align with job requirements
- experience: How well the experience matches what the job is asking for
- status values: "present", "weak", or "missing"
- Be specific and actionable in feedback
- "matched" keywords are those found in both the CV and the job description
- "missing" keywords are important ones from the job description not found in the CV
- "suggested" keywords are additional relevant terms that would strengthen the match`;
    } else {
      systemPrompt = `You are an expert ATS (Applicant Tracking System) analyzer. Analyze the provided CV purely on its own merits for general ATS readability, quality, and best practices. There is NO job description to compare against — do NOT assume or invent any target role or job requirements.

You MUST respond with ONLY valid JSON, no markdown, no code fences, no explanation. The JSON must have this exact structure:
{
  "overallScore": 72,
  "grade": "Good",
  "gradeSummary": "Brief one-line summary of the CV quality",
  "scores": {
    "keyword": { "score": 70, "explanation": "brief explanation of how strong the CV's industry keywords and terminology are" },
    "skills": { "score": 75, "explanation": "brief explanation of how well skills are presented and organized" },
    "experience": { "score": 80, "explanation": "brief explanation of experience presentation quality — action verbs, quantified achievements, clarity" },
    "formatting": { "score": 65, "explanation": "brief explanation of ATS-friendly formatting" },
    "completeness": { "score": 70, "explanation": "brief explanation of section completeness" }
  },
  "keywords": {
    "found": ["keyword1", "keyword2"],
    "suggested": ["keyword5", "keyword6"]
  },
  "experienceFeedback": ["feedback item 1", "feedback item 2"],
  "formattingWarnings": ["warning 1", "warning 2"],
  "completeness": [
    { "section": "Contact Info", "status": "present", "feedback": "Complete" },
    { "section": "Summary", "status": "present", "feedback": "Good professional summary" },
    { "section": "Skills", "status": "weak", "feedback": "Could include more relevant skills" },
    { "section": "Experience", "status": "present", "feedback": "Well documented" },
    { "section": "Education", "status": "missing", "feedback": "No education section found" }
  ],
  "recommendations": ["recommendation 1", "recommendation 2", "recommendation 3"]
}

CRITICAL — This is a GENERAL CV quality scan with NO job description:
- Do NOT reference any specific job, role, or job requirements in your analysis
- Do NOT say keywords are "missing from the job description" — there is no job description
- "keyword" score: Evaluate the strength and relevance of industry keywords already present in the CV for the candidate's stated field/role
- "skills" score: Evaluate how well skills are presented, organized, and whether they include a good mix of hard and soft skills for the candidate's field
- "experience" score: Evaluate the quality of experience descriptions — use of action verbs, quantified achievements, clarity, and impact
- "formatting" score: Evaluate ATS-friendly formatting — clean structure, standard headings, no complex tables/graphics
- "completeness" score: Evaluate whether all essential CV sections are present and adequately filled
- "found" keywords: Strong, relevant industry keywords and terms already present in the CV
- "suggested" keywords: Additional industry-relevant keywords the candidate could consider adding based on their stated field and experience — NOT based on any job posting
- All feedback and recommendations should focus on improving the CV's general quality, ATS readability, and professional presentation
- Be specific and actionable in feedback

Scoring guidelines:
- overallScore: 0-100 weighted average
- grade: "Excellent" (90-100), "Very Good" (80-89), "Good" (70-79), "Fair" (60-69), "Needs Work" (40-59), "Poor" (0-39)
- Each sub-score: 0-100
- status values: "present", "weak", or "missing"`;
    }

    userPrompt = hasJD
      ? `Analyze this CV for ATS compatibility against the following job description:

CV:
${cvText}

Job Description:
${jobDescription}`
      : `Analyze this CV for general ATS readability, quality, and best practices. There is no job description — evaluate the CV purely on its own merits:

CV:
${cvText}`;
  }

  try {
    const payload = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: mode === 'optimize' ? 4000 : 2000,
      messages: [{ role: 'user', content: userPrompt }],
      system: systemPrompt
    };

    const upstream = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(payload)
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      return new Response(JSON.stringify({ error: data.error?.message || 'AI analysis failed' }), { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
    }

    const responseText = data.content?.[0]?.text || '';

    // Parse the JSON response from AI
    let result;
    try {
      // Try to extract JSON from the response (handle cases where AI wraps in code fences)
      let cleanText = responseText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');
      result = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      // Retry: try to fix common JSON issues (trailing commas, unescaped newlines)
      try {
        let fixedText = responseText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        const jsonMatch2 = fixedText.match(/\{[\s\S]*\}/);
        if (jsonMatch2) {
          let jsonStr = jsonMatch2[0];
          // Remove trailing commas before } or ]
          jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');
          result = JSON.parse(jsonStr);
        } else {
          throw parseErr;
        }
      } catch {
        return new Response(JSON.stringify({ error: 'Failed to parse AI response. Please try again.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Post-process optimize results to normalize data structures
    if (mode === 'optimize') {
      // Normalize experience description bullet formatting — ensure each bullet is on its own line
      if (result.optimizedExperience && result.optimizedExperience.length) {
        result.optimizedExperience = result.optimizedExperience.map(exp => {
          if (exp.desc && typeof exp.desc === 'string') {
            // Split on inline bullet markers that appear mid-text (AI sometimes puts all on one line)
            let desc = exp.desc;
            // Insert newline before • that appears after text (not at start of string)
            desc = desc.replace(/([.;!?])\s*([•])\s+([A-Z])/g, '$1\n$2 $3');
            desc = desc.replace(/(\S)\s+([•])\s+([A-Z])/g, '$1\n$2 $3');
            // Also split on other bullet chars mid-text
            desc = desc.replace(/([.;!?])\s*([-\*▪▸►–—◦○●◆◇■□▶▷‣⁃])\s+([A-Z])/g, '$1\n$2 $3');
            exp.desc = desc;
          }
          return exp;
        });
      }
      // Ensure optimizedCertifications are objects {name, issuer, yr}
      if (result.optimizedCertifications && result.optimizedCertifications.length) {
        result.optimizedCertifications = result.optimizedCertifications.map(c => {
          if (typeof c === 'string') return { name: c, issuer: '', yr: '' };
          return { name: c.name || c.cert || '', issuer: c.issuer || c.organization || '', yr: c.yr || c.year || '' };
        }).filter(c => c.name);
      }
      // Ensure optimizedAwards are objects {title, org, yr}
      if (result.optimizedAwards && result.optimizedAwards.length) {
        result.optimizedAwards = result.optimizedAwards.map(a => {
          if (typeof a === 'string') return { title: a, org: '', yr: '' };
          return { title: a.title || a.name || '', org: a.org || a.organization || '', yr: a.yr || a.year || '' };
        }).filter(a => a.title);
      }
      // Ensure optimizedEducation are objects {inst, deg, yr, grade}
      if (result.optimizedEducation && result.optimizedEducation.length) {
        result.optimizedEducation = result.optimizedEducation.map(e => {
          if (typeof e === 'string') return { inst: '', deg: e, yr: '', grade: '' };
          return { inst: e.inst || e.institution || '', deg: e.deg || e.degree || '', yr: e.yr || e.year || '', grade: e.grade || e.classification || '' };
        }).filter(e => e.inst || e.deg);
      }
      // Normalize parsedCV fields if present
      if (result.parsedCV) {
        const p = result.parsedCV;
        // Normalize edus
        if (p.edus && p.edus.length) {
          p.edus = p.edus.map(e => {
            if (typeof e === 'string') return { inst: '', deg: e, yr: '', grade: '' };
            return { inst: e.inst || e.institution || '', deg: e.deg || e.degree || '', yr: e.yr || e.year || '', grade: e.grade || e.classification || '' };
          });
        }
        // Normalize certs
        if (p.certs && p.certs.length) {
          p.certs = p.certs.map(c => {
            if (typeof c === 'string') return { name: c, issuer: '', yr: '' };
            return { name: c.name || c.cert || '', issuer: c.issuer || c.organization || '', yr: c.yr || c.year || '' };
          });
        }
        // Normalize awards
        if (p.awards && p.awards.length) {
          p.awards = p.awards.map(a => {
            if (typeof a === 'string') return { title: a, org: '', yr: '' };
            return { title: a.title || a.name || '', org: a.org || a.organization || '', yr: a.yr || a.year || '' };
          });
        }
      }
      // Merge optimizedSkills into skillsToAdd if skillsToAdd is missing
      if (!result.skillsToAdd && result.optimizedSkills && result.optimizedSkills.length) {
        result.skillsToAdd = result.optimizedSkills;
      }
    }

    return new Response(JSON.stringify({ result }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Internal server error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const config = { path: '/api/ats-analyze' };
