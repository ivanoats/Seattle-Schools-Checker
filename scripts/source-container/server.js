import { execFile } from 'node:child_process';
import { createServer } from 'node:http';

let running = false;

createServer((request, response) => {
  const reply = (status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  if (request.method === 'GET' && request.url === '/health') return reply(200, { ready: true });
  if (request.method !== 'POST' || request.url !== '/probe') return reply(404, { result: 'not_found' });
  if (running) return reply(409, { result: 'probe_already_running' });

  running = true;
  execFile(process.execPath, ['scripts/browser-run/source-probe.js', '--label', 'stock-chrome-container'],
    { timeout: 50000, maxBuffer: 8192 },
    (_error, stdout) => {
      running = false;
      // The probe exits nonzero for a portal rejection, but still returns a result.
      try {
        const result = JSON.parse(stdout);
        if (typeof result.result !== 'string') throw new Error('invalid_probe_output');
        reply(200, result);
      } catch {
        reply(502, { result: 'probe_process_failed' });
      }
    });
}).listen(8080, '0.0.0.0');
