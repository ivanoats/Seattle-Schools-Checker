import { handleSesRunner } from './ses-runner.js';
import { handleLatestChecks, handleSourceIngest } from './ingest.js';
import { handlePilot, privateHeaders, readBody } from './pilot.js';
import { pilotHtml, pilotCss, pilotClient } from './pilot-ui.js';
import { handleDiscoveryRunner } from './connections.js';
import { runHostedSchedule } from './hosted-schedule.js';
import { handleHostedRunner } from './hosted-checks.js';

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/pilot/')) return handlePilot(request, env);
    const emailRunner = /^\/v1\/report-email\/(claim|authorize|complete)$/.exec(pathname);
    if (emailRunner) return handleSesRunner(request, env, emailRunner[1], req => readBody(req, 8192));
    const checkRunner = /^\/v1\/collection\/source\/(claim|complete)$/.exec(pathname);
    if (checkRunner) return handleHostedRunner(request, env, checkRunner[1], req => readBody(req, 1048576));
    const runner = pathname.match(/^\/v1\/discovery\/(source|schoology)\/(claim|complete)$/);
    if (runner) return handleDiscoveryRunner(request, env, runner[1], runner[2], req => readBody(req, 65536));
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
  scheduled(event, env, ctx) {
    ctx.waitUntil(runHostedSchedule(env));
  },
};
