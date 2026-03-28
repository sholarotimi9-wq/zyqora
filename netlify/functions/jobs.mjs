export default async (req) => {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });

  const url = new URL(req.url);
  const what = url.searchParams.get('what') || '';
  const where = url.searchParams.get('where') || '';
  const page = url.searchParams.get('page') || '1';
  const resultsPerPage = url.searchParams.get('results_per_page') || '12';

  const appId = 'b2d4280f';
  const appKey = '9cfffb7290080d07576e83edf59ac39e';

  // Country-based search support
  const country = url.searchParams.get('country') || 'gb';
  const adzunaUrl = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/${page}`);
  adzunaUrl.searchParams.set('app_id', appId);
  adzunaUrl.searchParams.set('app_key', appKey);
  adzunaUrl.searchParams.set('results_per_page', resultsPerPage);
  if (what) adzunaUrl.searchParams.set('what', what);
  if (where) adzunaUrl.searchParams.set('where', where);
  adzunaUrl.searchParams.set('content-type', 'application/json');

  // Salary range filters
  const salaryMin = url.searchParams.get('salary_min');
  const salaryMax = url.searchParams.get('salary_max');
  if (salaryMin) adzunaUrl.searchParams.set('salary_min', salaryMin);
  if (salaryMax) adzunaUrl.searchParams.set('salary_max', salaryMax);

  // Full-time / part-time / contract filter
  const contractType = url.searchParams.get('contract_type');
  if (contractType === 'full_time') adzunaUrl.searchParams.set('full_time', '1');
  else if (contractType === 'part_time') adzunaUrl.searchParams.set('part_time', '1');
  else if (contractType === 'contract') adzunaUrl.searchParams.set('contract', '1');
  else if (contractType === 'permanent') adzunaUrl.searchParams.set('permanent', '1');

  // Sort by salary, date, or relevance
  const sort = url.searchParams.get('sort');
  if (sort === 'salary') adzunaUrl.searchParams.set('sort_by', 'salary');
  else if (sort === 'date') adzunaUrl.searchParams.set('sort_by', 'date');

  try {
    const response = await fetch(adzunaUrl.toString());
    if (!response.ok) {
      const errText = await response.text();
      return new Response(JSON.stringify({ error: 'Adzuna API error', details: errText }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const data = await response.json();

    // Normalize job data into consistent structure
    const normalized = (data.results || []).map(j => ({
      id: j.id || String(Math.random()).slice(2),
      title: j.title || 'Untitled',
      company: j.company?.display_name || 'Company not listed',
      location: j.location?.display_name || '',
      country: country.toUpperCase(),
      description: j.description || '',
      salary_min: j.salary_min || null,
      salary_max: j.salary_max || null,
      contract_type: j.contract_type || j.contract_time || '',
      redirect_url: j.redirect_url || '',
      created: j.created || '',
      category: j.category?.label || ''
    }));

    return new Response(JSON.stringify({
      results: normalized,
      count: data.count || 0,
      mean: data.mean || null
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Failed to fetch jobs', details: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const config = { path: '/api/jobs' };
