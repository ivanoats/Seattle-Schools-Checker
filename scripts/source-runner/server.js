import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { ensureLogin } from '../../src/auth.js';
import { configuredChild } from '../../src/core/children.js';
import { observeSchool } from '../../src/core/observations.js';
import { readSource } from '../../src/source.js';

async function readObservation(child, credentials) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 15000 });
  const deadline = setTimeout(() => { void browser.close().catch(() => {}); }, 65000);
  try {
    const page = await browser.newPage({
      timezoneId: 'America/Los_Angeles', locale: 'en-US', acceptDownloads: false, serviceWorkers: 'block',
    });
    page.setDefaultTimeout(15000);
    await ensureLogin(page, 'source', credentials);
    const { assignmentRows, ...report } = await readSource(page, child);
    if (report.courses.length === 0) throw new Error('source_courses_unavailable');
    return observeSchool({ provider: 'source', child, report, assignmentRows, observedAt: report.checkedAt });
  } finally {
    clearTimeout(deadline);
    await browser.close();
  }
}

export function createSourceServer({ token, child, credentials, read = readObservation }) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !child?.providers?.source ||
      !credentials?.username || !credentials?.password) throw new Error('invalid_runner_config');
  const expected = Buffer.from(`Bearer ${token}`);
  let running = false;

  return createServer({ requestTimeout: 10000, headersTimeout: 5000 }, async (request, response) => {
    const reply = (code, body) => {
      response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (request.method !== 'POST' || request.url !== '/v1/source/check' ||
        supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      request.resume();
      return reply(404, { status: 'not_found' });
    }

    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > 1024) {
          // Keep the response socket alive while discarding the remainder.
          request.resume();
          return reply(413, { status: 'invalid_request' });
        }
        chunks.push(chunk);
      }
      const job = JSON.parse(Buffer.concat(chunks));
      if (job?.version !== 1 || job.childId !== child.id || Object.keys(job).length !== 2) {
        return reply(400, { status: 'invalid_request' });
      }
    } catch {
      return reply(400, { status: 'invalid_request' });
    }
    if (running) return reply(409, { status: 'runner_busy' });
    running = true;
    try {
      const observation = await read(child, credentials);
      return reply(200, { status: 'ok', observation });
    } catch {
      return reply(502, { status: 'source_check_failed' });
    } finally {
      running = false;
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { SOURCE_RUNNER_TOKEN, SOURCE_CHILD_CONFIG, SOURCE_USERNAME, SOURCE_PASSWORD } = process.env;
    const child = configuredChild(JSON.parse(await readFile(SOURCE_CHILD_CONFIG, 'utf8')));
    const server = createSourceServer({
      token: SOURCE_RUNNER_TOKEN, child, credentials: { username: SOURCE_USERNAME, password: SOURCE_PASSWORD },
    });
    server.listen(8080, '127.0.0.1');
  } catch {
    console.error('source_runner_config_required');
    process.exitCode = 1;
  }
}
