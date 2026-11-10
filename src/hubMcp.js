// The hub as a Claude connector: the WordPress-sites hub's reads and everyday actions as tools on
// the MCP endpoint mcpConnector.js serves at /mcp. In Claude: Settings → Connectors → Add custom
// connector → https://<this app>/mcp, sign in with the dashboard's admin login, Approve.
//
//   list_sites       every site, the published plugins, the destinations          (reads)
//   site_status      one site with its details and last commands                 (reads)
//   add_site         checks a WordPress site and gives the link to connect it     (reads; the
//                    connection itself is approved by an admin in WordPress, as on /sites)
//   update_plugins   asks outdated sites to install the published plugin now
//   set_up_site      queues the schedule plugin's set-up (look, homepage table, sport pages, menu)
//
// Left to the /sites page on purpose: removing a site, uninstalling the plugin, destinations and
// rotation, keys and tokens. A site is usually added from ABS3 instead ("add site … zhibo882"),
// which installs the plugin, connects here and writes the content.
//
// mcpConnector.js is the same file as ABS3's lib/mcpConnector.js. State (the registered clients
// and the SHA-256 of each token) is claude-connector.json in the data dir. The API token for
// scripts works on /mcp as a Bearer token too.
const fs = require('fs');
const path = require('path');
const { dataPath } = require('./dataDir');
const auth = require('./auth');
const hub = require('./hub');
const hubConnect = require('./hubConnect');
const { createConnector } = require('./mcpConnector');

const STORE_PATH = dataPath('claude-connector.json');

const store = {
  read() {
    try { return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); } catch { return null; }
  },
  write(state) {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const tmp = `${STORE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STORE_PATH);
  },
};

const ago = (iso) => {
  if (!iso) return 'never';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 2) return 'just now';
  if (min < 120) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
};

// api: { stateJson, siteJson, findSiteHost, queueSetup, updateSites } from hubRoutes.js
function buildTools(api) {
  const findHost = (site) => api.findSiteHost(site, String(site || '').replace(/^www\./, ''), `www.${hub.cleanHost(site)}`);
  return [
    {
      name: 'list_sites',
      title: 'List the streaming network\'s sites',
      description: 'Every WordPress site connected to the ISS hub (the zhibo streaming network): schedule sites (zhibo882 plugin: a live-schedule table on the homepage and one page per sport) and player sites (zhibo82 plugin: where visitors watch), each with its plugin version, whether an update is waiting, its last check-in and whether ABS3 manages its content. Also the published plugin versions and the destination sites matches open on. Changes nothing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'List the streaming network\'s sites', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: () => {
        const s = api.stateJson();
        const lines = [`${s.sites.filter((x) => !x.removed).length} site(s):`];
        for (const x of s.sites) {
          lines.push(`- ${x.host}  ${x.role}  ${x.plugin} ${x.version || '?'}${x.outdated ? ` (update to ${x.latest} waiting)` : ''}  last check-in ${ago(x.lastSeen)}${x.managedBy ? `  content by ${x.managedBy}` : ''}${x.removed ? '  REMOVED' : ''}`);
        }
        lines.push('', 'Published plugins:');
        for (const [slug, r] of Object.entries(s.releases)) lines.push(`- ${slug} ${r.version} (${String(r.uploadedAt || '').slice(0, 10)})`);
        if (!Object.keys(s.releases).length) lines.push('- none yet');
        lines.push('', `Destinations (rotation ${s.rotation ? 'on' : 'off'}):`);
        for (const d of s.destinations) lines.push(`- ${d.host}${d.main ? '  main' : ''}  group ${d.group == null ? '-' : d.group}  ${d.up === null ? 'not checked yet' : d.up ? 'up' : 'DOWN'}${d.active ? '  in use' : ''}${d.connected ? '' : '  (not a connected player site)'}`);
        if (!s.destinations.length) lines.push('- none');
        return lines.join('\n');
      },
    },
    {
      name: 'site_status',
      title: 'One site on the hub',
      description: 'One site as the hub sees it: role, plugin version and the latest published one, last check-in, where its matches open, its sport pages, the details it reported (theme, pages, bridge version) and its last 10 commands with their status and log. Use it after set_up_site to see whether the set-up finished. Changes nothing.',
      inputSchema: { type: 'object', properties: { site: { type: 'string', description: 'The site\'s domain, e.g. example.com' } }, required: ['site'], additionalProperties: false },
      annotations: { title: 'One site on the hub', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: (args) => {
        const host = findHost(args.site);
        if (!host) return { text: `The hub has no site ${hub.cleanHost(args.site)}. list_sites shows them all; add_site explains how to connect one.`, isError: true };
        return JSON.stringify(api.siteJson(host), null, 2);
      },
    },
    {
      name: 'add_site',
      title: 'Check a site and get its connect link',
      description: 'The first step of adding a WordPress site to the hub: looks at the site from outside (is it WordPress, which zhibo plugin does it run, can it approve applications) and answers with the link where an admin finishes the connection: the hub\'s "Add a site" page, then Approve in the site\'s own WordPress. Nothing is changed by this call; give the link to the user. A site that runs neither plugin is better added from ABS3 (add site https://example.com topic "…" zhibo882), which installs the plugin, connects it here and writes its content.',
      inputSchema: { type: 'object', properties: { domain: { type: 'string', description: 'The site\'s address, e.g. example.com or https://example.com' } }, required: ['domain'], additionalProperties: false },
      annotations: { title: 'Check a site and get its connect link', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (args, ctx) => {
        const domain = String(args.domain || '').trim().slice(0, 300);
        if (!domain) return { text: 'Give the site\'s domain.', isError: true };
        const probe = await hubConnect.probeSite(domain);
        if (probe.error) return { text: probe.error, isError: true };
        const known = findHost(probe.host);
        const site = known && hub.getState().sites[known];
        if (site && !site.removed) return `${known} is already connected (${site.role || 'schedule'} site, plugin ${site.version || '?'}, last check-in ${ago(site.lastSeen)}). site_status shows the rest.`;
        const link = `${ctx.baseUrl}/sites/add?domain=${encodeURIComponent(probe.origin)}`;
        if (!probe.plugins.length) {
          return [
            `${probe.host} is a WordPress site${probe.name ? ` ("${probe.name}")` : ''}, but it runs neither zhibo plugin, so the hub cannot connect it yet.`,
            'Two ways to go on:',
            `1. From ABS3 (does everything): add site ${probe.origin} topic "<topic>" zhibo882   (or zhibo82 for a player site). ABS3 installs the plugin from the hub, connects the site here and writes its content.`,
            `2. By hand: install the plugin zip on the site (download: ${ctx.baseUrl}/sites/download?plugin=${hub.PLUGIN_SLUG} for a schedule site, ${ctx.baseUrl}/sites/download?plugin=${hub.PLAYER_SLUG} for a player site), activate it, then run add_site again.`,
          ].join('\n');
        }
        return [
          `${probe.host}${probe.name ? ` ("${probe.name}")` : ''} runs ${probe.plugins.map((p) => hub.PLUGINS[p].label).join(' and ')} and is ready to connect.`,
          `Open this link, sign in to the hub, choose the options and click "Approve in WordPress": ${link}`,
          probe.authUrl
            ? 'WordPress then asks an administrator of the site to approve; the hub uses that approval once and deletes it again. Afterwards site_status shows the site.'
            : 'Note: this site has Application Passwords turned off, so the one-click approval will not work; turn them on (WordPress needs HTTPS for them) or connect it by hand from the plugin\'s settings.',
        ].join('\n');
      },
    },
    {
      name: 'update_plugins',
      title: 'Update the plugin on outdated sites now',
      description: 'Asks sites whose zhibo plugin is older than the published version to install it right away (they would otherwise update by themselves within a day). Without "site" every outdated site is asked. Answers per site: up to date, asked to update, or unreachable.',
      inputSchema: { type: 'object', properties: { site: { type: 'string', description: 'One site\'s domain, or "all" (the default)' }, plugin: { type: 'string', description: 'Only sites running this plugin slug (optional)' } }, additionalProperties: false },
      annotations: { title: 'Update the plugin on outdated sites now', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (args) => {
        const out = await api.updateSites(args.site || 'all', args.plugin);
        if (out.error) return { text: out.error, isError: true };
        if (!out.results.length) return 'No site matches.';
        return out.results.map((r) => `- ${r.host}: ${r.action}${r.version ? ` (has ${r.version}${r.latest ? `, published ${r.latest}` : ''})` : ''}`).join('\n');
      },
    },
    {
      name: 'set_up_site',
      title: 'Run the schedule plugin\'s set-up on a site',
      description: 'Queues the zhibo882 plugin\'s set-up on a connected schedule site and asks the site to run it now: the zhibo look (switches the site to GeneratePress with the hub\'s theme), the live-schedule table on the homepage (replaces what the homepage shows), one page per sport and the header menu. This changes how the site looks, so use it only when the user asked to set that site up. Each part can be left out. Follow it with site_status: the command\'s status goes from queued/running to done.',
      inputSchema: {
        type: 'object',
        properties: {
          site: { type: 'string', description: 'The connected schedule site\'s domain' },
          sports: { type: 'array', items: { type: 'string' }, description: 'Sport pages to make, English names as the feed has them, e.g. ["Football", "Basketball", "Tennis"]. Left out: the hub\'s default set.' },
          brand: { type: 'string', description: 'The name shown in the table (optional)' },
          theme: { type: 'boolean', description: 'Apply the zhibo look (default true)' },
          homepage: { type: 'boolean', description: 'Put the table on the homepage (default true)' },
          menu: { type: 'boolean', description: 'Build the header menu (default true)' },
        },
        required: ['site'],
        additionalProperties: false,
      },
      annotations: { title: 'Run the schedule plugin\'s set-up on a site', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      handler: async (args) => {
        const setup = { theme: args.theme !== false, homepage: args.homepage !== false, menu: args.menu !== false };
        if (args.brand) setup.brand = String(args.brand);
        if (Array.isArray(args.sports) && args.sports.length) setup.sports = args.sports.map(String);
        const out = await api.queueSetup(args.site, setup);
        if (out.error) return { text: out.error, isError: true };
        return `Set-up ${out.command.status} on ${out.host} (command ${out.command.id}): ${JSON.stringify(out.command.args)}. The site ${out.poke === 'answered' ? 'answered and is running it now' : `did not answer just now (${out.poke}); it picks the command up within 5 minutes`}. site_status shows the result.`;
      },
    },
  ];
}

// requireAuth: the dashboard's Basic-auth guard (server.js); baseUrl(req): the hub's public address.
function mountHubMcp(app, { requireAuth, baseUrl, api }) {
  const admin = (username) => {
    const user = auth.findUser(auth.getAllUsers(), username);
    return auth.hasRole(user, 'admin') ? { username: user.username, role: user.role } : null;
  };
  const connector = createConnector({
    name: 'iss-hub',
    title: 'ISS hub',
    version: require('../package.json').version,
    instructions: 'The ISS hub runs the zhibo streaming network\'s WordPress plugins: schedule sites (zhibo882) and player sites (zhibo82). Use list_sites and site_status to read, add_site to check a new site and get its connect link, update_plugins to push a plugin update, and set_up_site only when the user asked to set a site up. Content for these sites is written by ABS3, a separate connector.',
    consentLines: ['Read the network\'s sites, plugin versions and destinations', 'Check a new site and give you its connect link', 'Ask sites to update their plugin, and run a site\'s set-up when you ask'],
    tools: buildTools(api),
    store,
    baseUrl,
    // The browser's Basic login: requireAuth answers 401 itself when it is missing or wrong.
    signIn: (req, res) => {
      let ok = false;
      requireAuth('admin')(req, res, () => { ok = true; });
      if (!ok) return null;
      const decoded = Buffer.from(String(req.headers.authorization || '').split(' ')[1] || '', 'base64').toString('utf8');
      const username = decoded.includes(':') ? decoded.slice(0, decoded.indexOf(':')) : decoded;
      const user = admin(username);
      return user ? { id: user.username, name: user.username } : null;
    },
    resolveUser: (identity) => admin(identity && identity.id),
    staticBearer: (token) => (hub.tokenMatches(token) ? { username: 'api-token', role: 'admin' } : null),
  });
  connector.mount(app);
  return connector;
}

module.exports = { mountHubMcp, buildTools, STORE_PATH };
