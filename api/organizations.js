const { requireUser } = require('../lib/auth');
const { listOrganizations } = require('../lib/jira');
const { normalizeDomains, globalAllowedDomains } = require('../lib/recipients');
const db = require('../lib/db');
const { sendJson, readBody, handleError, HttpError } = require('../lib/http');

// GET /api/organizations[?refresh=1]       -> Organizations de JSM (cache 24 h)
// GET /api/organizations?domains=<orgId>   -> dominios permitidos para destinatarios
// PUT /api/organizations?domains=<orgId> { domains: [...] }
module.exports = async (req, res) => {
  try {
    const user = await requireUser(req);
    const { domains: domainsOrgId, refresh } = req.query || {};

    if (domainsOrgId) {
      const organizationId = String(domainsOrgId);

      if (req.method === 'GET') {
        sendJson(res, 200, { global: globalAllowedDomains(), domains: await db.getOrganizationDomains(organizationId) });
        return;
      }

      if (req.method === 'PUT') {
        const { organizations } = await listOrganizations();
        if (!organizations.some((o) => o.id === organizationId)) throw new HttpError(404, 'Organization inexistente');

        const { domains, invalid } = normalizeDomains(readBody(req).domains);
        if (invalid.length) throw new HttpError(400, `Dominios inválidos: ${invalid.join(', ')}`);

        const previous = await db.getOrganizationDomains(organizationId);
        await db.setOrganizationDomains(organizationId, domains, user.email);
        await db.addAudit('organization_domains', organizationId, 'update', user.email, { domains: { from: previous, to: domains } });
        sendJson(res, 200, { global: globalAllowedDomains(), domains });
        return;
      }

      throw new HttpError(405, 'Method not allowed');
    }

    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    sendJson(res, 200, await listOrganizations({ refresh: refresh === '1' }));
  } catch (error) {
    handleError(res, error);
  }
};
