import { handleLatestChecks, handleSourceIngest } from './ingest.js';

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === 'POST' && pathname === '/v1/ingest/source') return handleSourceIngest(request, env);
    if (request.method === 'GET' && pathname === '/v1/checks/latest') return handleLatestChecks(request, env);
    return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  },
};
