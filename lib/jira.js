const { withRetry } = require('./retry');
const { getCache, setCache } = require('./db');

// Cliente de Jira Cloud / JSM con cuenta de servicio (JIRA_EMAIL +
// JIRA_API_TOKEN, ambos en las variables de entorno del despliegue, nunca
// en el repo).
const ORGANIZATIONS_CACHE_KEY = 'jira-organizations';
const ORGANIZATIONS_TTL_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_ISSUES = 5000;

class JiraError extends Error {
  constructor(message, status, details = []) {
    super(message);
    this.name = 'JiraError';
    this.status = status;
    this.details = details;
  }

  // 429 y 5xx (o sin status = error de red) se reintentan; 4xx no.
  get transient() {
    return !this.status || this.status === 429 || this.status >= 500;
  }
}

function baseUrl() {
  return (process.env.JIRA_BASE_URL || 'https://janiscommerce.atlassian.net').replace(/\/+$/, '');
}

function browseUrl(key) {
  return `${baseUrl()}/browse/${encodeURIComponent(key)}`;
}

function authHeader() {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (!email || !token) throw new Error('Faltan JIRA_EMAIL / JIRA_API_TOKEN');
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
}

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  return withRetry(async () => {
    let response;
    try {
      response = await fetch(`${baseUrl()}${path}`, {
        method,
        headers: {
          Authorization: authHeader(),
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      throw new JiraError(`No se pudo conectar con Jira: ${error.message}`);
    }

    if (!response.ok) {
      let details = [];
      try {
        const payload = await response.json();
        details = [...(payload.errorMessages || []), ...Object.values(payload.errors || {})];
      } catch {
        // respuesta sin JSON
      }
      throw new JiraError(details[0] || `Jira respondió ${response.status}`, response.status, details);
    }
    return response.json();
  }, { label: `Jira ${method} ${path.split('?')[0]}`, isTransient: (error) => error instanceof JiraError && error.transient });
}

// ---- Organizations (JSM) ----

async function fetchAllOrganizations() {
  const organizations = [];
  let start = 0;
  for (;;) {
    const page = await request(`/rest/servicedeskapi/organization?start=${start}&limit=50`, {
      headers: { 'X-ExperimentalApi': 'opt-in' },
    });
    for (const org of page.values || []) organizations.push({ id: String(org.id), name: org.name });
    if (page.isLastPage || !(page.values || []).length) break;
    start += page.values.length;
  }
  return organizations.sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

async function listOrganizations({ refresh = false } = {}) {
  const cached = await getCache(ORGANIZATIONS_CACHE_KEY);
  if (!refresh && cached && Date.now() - new Date(cached.fetchedAt) < ORGANIZATIONS_TTL_MS) {
    return { organizations: cached.data, fetchedAt: cached.fetchedAt };
  }
  const organizations = await fetchAllOrganizations();
  await setCache(ORGANIZATIONS_CACHE_KEY, organizations);
  return { organizations, fetchedAt: new Date().toISOString() };
}

// ---- Búsqueda ----

async function searchPage(jql, { fields, maxResults = PAGE_SIZE, nextPageToken } = {}) {
  return request('/rest/api/3/search/jql', {
    method: 'POST',
    body: { jql, fields, maxResults, ...(nextPageToken ? { nextPageToken } : {}) },
  });
}

// Pagina hasta traer todo (con tope de seguridad MAX_ISSUES).
async function searchAll(jql, fields) {
  const issues = [];
  let nextPageToken;
  do {
    const page = await searchPage(jql, { fields, nextPageToken });
    issues.push(...(page.issues || []));
    nextPageToken = page.isLast ? undefined : page.nextPageToken;
  } while (nextPageToken && issues.length < MAX_ISSUES);

  if (nextPageToken) {
    throw new JiraError(`El JQL devuelve más de ${MAX_ISSUES} tickets; acotá la búsqueda`, 400);
  }
  return issues;
}

// Validación al guardar: consulta con maxResults=1. Devuelve null si es
// válido o el mensaje de error de Jira.
async function validateJql(jql) {
  try {
    await searchPage(jql, { fields: ['summary'], maxResults: 1 });
    return null;
  } catch (error) {
    if (error instanceof JiraError && error.status === 400) return error.details.join(' · ') || error.message;
    throw error;
  }
}

module.exports = { JiraError, listOrganizations, searchAll, validateJql, browseUrl };
