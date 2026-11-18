import { handleLatestChecks, handleSourceIngest } from './ingest.js';
import { handlePilot, privateHeaders } from './pilot.js';
import { pilotHtml, pilotCss, pilotClient } from './pilot-ui.js';

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/pilot/')) return handlePilot(request, env);
    const assets = { '/app': [pilotHtml, 'text/html'], '/app.css': [pilotCss, 'text/css'],
      '/app.js': [`(${pilotClient.toString()})();`, 'text/javascript'] };
    if (request.method === 'GET' && Object.hasOwn(assets, pathname)) {
      const [body, type] = assets[pathname];
      return new Response(body, { headers: { ...privateHeaders, 'Content-Type': `${type}; charset=utf-8`,
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" } });
    }
    if (request.method === 'POST' && pathname === '/v1/ingest/source') return handleSourceIngest(request, env);
    if (request.method === 'GET' && pathname === '/v1/checks/latest') return handleLatestChecks(request, env);
    return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  },
};
