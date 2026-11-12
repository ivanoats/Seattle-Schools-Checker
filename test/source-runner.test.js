import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createSourceServer } from '../scripts/source-runner/server.js';
import { fetchSourceObservation } from '../src/cloudflare/source-client.js';

const token = 'a'.repeat(64);
const env = {
  SOURCE_RUNNER_URL: 'https://runner.example/v1/source/check', SOURCE_RUNNER_TOKEN: token,
  SOURCE_ACCESS_CLIENT_ID: 'test-access-id', SOURCE_ACCESS_CLIENT_SECRET: 'test-access-secret',
};
const child = { id: 'child-one', providers: { source: {} } };
const observation = {
  version: 1, provider: 'source', childId: child.id, observedAt: '2026-11-11T21:34:43Z',
  courses: [{ course: 'Sample course', missing: [] }, { course: 'Support', missing: null }],
  attendance: { absences: [], tardies: [] },
};

test('Worker sends only the authorized child ID and receives a partial Source observation', async t => {
  let reads = 0;
  const server = createSourceServer({
    token, child, credentials: { username: 'test-user', password: 'test-password' },
    read: async () => { reads++; return observation; },
  }).listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const transport = (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['CF-Access-Client-Id'], env.SOURCE_ACCESS_CLIENT_ID);
    assert.deepEqual(JSON.parse(options.body), { version: 1, childId: child.id });
    return fetch(origin + url.pathname, options);
  };
  assert.deepEqual(await fetchSourceObservation(env, child.id, transport), { status: 'ok', observation });
  assert.equal((await fetchSourceObservation({ ...env, SOURCE_RUNNER_TOKEN: 'b'.repeat(64) },
    child.id, transport)).status, 'unavailable');
  const post = body => fetch(origin + '/v1/source/check', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body,
  });
  assert.equal((await post(JSON.stringify({ version: 1, childId: 'child-two' }))).status, 400);
  assert.equal((await post('x'.repeat(2048))).status, 413);
  assert.equal(reads, 1);
});

test('Worker rejects a response for another child', async () => {
  const wrong = { ...observation, childId: 'child-two' };
  assert.deepEqual(await fetchSourceObservation(env, child.id,
    async () => Response.json({ status: 'ok', observation: wrong })),
  { status: 'unavailable', reason: 'invalid_runner_response' });
});
