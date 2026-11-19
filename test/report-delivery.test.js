import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { runReportDelivery, reportDeliveryStatus } from '../src/cloudflare/report-delivery.js';
import { buildReportEmail } from '../src/core/report-email.js';

const now = Date.parse('2026-11-19T01:00:00Z');
const iso = time => new Date(time).toISOString();
async function environment() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON');
  for (const name of (await readdir(new URL('../worker/migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(await readFile(new URL(`../worker/migrations/${name}`, import.meta.url), 'utf8'));
  }
  const statement = (sql, values = []) => ({ bind: (...args) => statement(sql, args),
    all: () => Promise.resolve({ results: sqlite.prepare(sql).all(...values) }),
    run: () => Promise.resolve(sqlite.prepare(sql).run(...values)) });
  const sent = [];
  const env = { sqlite, sent, HOSTED_CHECKS_ENABLED: 'true', HOSTED_CHECK_SKIP_DATES: '[]',
    SOURCE_CONNECTIONS_ENABLED: 'true', SCHOOLOGY_CONNECTIONS_ENABLED: 'true', REPORT_EMAIL_ENABLED: 'true',
    REPORT_EMAIL_FROM: 'reports@example.com', REPORT_EMAIL_START_DATE: '2026-11-18',
    DB: { prepare: sql => statement(sql) }, REPORT_EMAIL: { send: message => { assert.ok([message.to, message.cc, message.bcc].some(value => Array.isArray(value) ? value.length : Boolean(value)), 'Workers API requires at least one to/cc/bcc recipient'); sent.push(message); return Promise.resolve({ messageId: `message-${sent.length}` }); } } };
  for (const family of ['one', 'two']) {
    sqlite.prepare('INSERT INTO pilot_families VALUES (?,?,NULL)').run(family, iso(now));
    for (const child of ['first', 'second']) {
      sqlite.prepare('INSERT INTO pilot_children VALUES (?,?,?)').run(family, child, `${family} ${child}`);
      sqlite.prepare('INSERT INTO pilot_report_recipients VALUES (?,?,?,?,?)').run(family, child, JSON.stringify([`${family}-${child}@example.com`]), 'revision', iso(now));
    }
    for (const provider of ['source', 'schoology']) {
      const connection = `${family}-${provider}`;
      sqlite.prepare("INSERT INTO pilot_connections VALUES (?,?,?,'revision',NULL,'ready',NULL,?,?)").run(connection, family, provider, iso(now), iso(now));
      const children = ['first', 'second'].map(id => ({ id, providers: { [provider]: { remoteId: `${family}-${id}` } } }));
      for (const child of children) sqlite.prepare('INSERT INTO pilot_child_providers VALUES (?,?,?,?,?,?,?)')
        .run(family, child.id, provider, connection, 'revision', `${family}-${child.id}`, JSON.stringify(child.providers[provider]));
      sqlite.prepare("INSERT INTO pilot_check_jobs (id,connection_id,revision,slot,children,state,created_at,expires_at,attempted_at) VALUES (?,?,'revision',?,?,'done',?,?,?)")
        .run(connection, connection, '2026-11-18:fingerprint', JSON.stringify(children), iso(now), iso(now + 3600000), iso(now));
      for (const child of children) {
        const observation = { version: 1, provider, childId: child.id, observedAt: iso(now),
          ...(provider === 'source' ? { term: null, courses: [{ course: `${family} French`, period: '1', semester: 'B', missing: null, rows: null }], attendance: { absences: [], tardies: [] } }
            : { overdue: [], upcoming: [], recentlyCompleted: [], events: [], overdueCoverage: 'complete' }) };
        sqlite.prepare("INSERT INTO provider_checks VALUES (?,?,?,?,?,'ok',NULL,?,?,?,?)")
          .run(connection, family, child.id, provider, 'synthetic', iso(now), iso(now), JSON.stringify(observation), iso(now));
      }
    }
  }
  return env;
}
const deliveries = env => env.sqlite.prepare('SELECT * FROM pilot_report_deliveries').all();

test('one report per child and day, isolated across siblings/families, BCC protects recipient privacy', async () => {
  const env = await environment();
  await Promise.all([runReportDelivery(env, now + 1000), runReportDelivery(env, now + 1000)]);
  assert.equal(env.sent.length, 4);
  assert.equal(deliveries(env).filter(row => row.state === 'sent').length, 4);
  for (const message of env.sent) {
    assert.equal(message.bcc.length, 1); assert.ok(!Object.hasOwn(message, 'to'));
    const [family, child] = message.bcc[0].split('@')[0].split('-');
    assert.match(message.text, new RegExp(`School check-in for ${family} ${child}`));
    assert.doesNotMatch(message.text, new RegExp(`${family === 'one' ? 'two' : 'one'} French`));
    assert.doesNotMatch(message.text, /0 marked missing/);
    assert.match(message.text, /missing work unknown/);
  }
  await runReportDelivery(env, now + 60000); assert.equal(env.sent.length, 4);
  const status = await reportDeliveryStatus(env, 'one', 'first');
  assert.equal(status.latest.state, 'sent'); assert.ok(!Object.hasOwn(status.latest, 'message_id'));
});

test('weekends, pre-five, excluded days, activation date and disabled feature never send', async () => {
  for (const change of [env => { env.REPORT_EMAIL_ENABLED = 'false'; }, env => { env.HOSTED_CHECK_SKIP_DATES = '["2026-11-18"]'; },
    env => { env.REPORT_EMAIL_START_DATE = '2026-11-19'; }, env => { env.REPORT_EMAIL_FROM = 'invalid'; }, env => { env.REPORT_EMAIL_START_DATE = '2026-99-99'; }]) {
    const env = await environment(); change(env); await runReportDelivery(env, now); assert.equal(env.sent.length, 0);
  }
  const env = await environment(); await runReportDelivery(env, now - 1);
  await runReportDelivery(env, Date.parse('2026-11-22T01:00:00Z')); assert.equal(env.sent.length, 0);
});

test('wait for Source, then send; never infer clear work from null or missing provider data', async () => {
  const env = await environment(); env.sqlite.prepare("DELETE FROM provider_checks WHERE provider='source'").run();
  await runReportDelivery(env, now + 1000); assert.equal(env.sent.length, 0);
  await runReportDelivery(env, now + 3600000); assert.equal(env.sent.length, 4);
  assert.ok(env.sent.every(message => /The Source: current check unavailable/.test(message.text)));
  assert.ok(env.sent.every(message => /Missing work and grades are unknown/.test(message.text)));
});

test('a failed current check dates older verified context; reconnect mappings cannot reuse old records', async () => {
  const env = await environment();
  env.sqlite.prepare("UPDATE provider_checks SET attempted_at=?, observed_at=?, received_at=? WHERE provider='source'")
    .run(iso(now - 86400000), iso(now - 86400000), iso(now - 86400000));
  env.sqlite.prepare("UPDATE pilot_connections SET status='attention' WHERE provider='source'").run();
  await runReportDelivery(env, now + 1000);
  assert.ok(env.sent.every(message => /older context/.test(message.text)));
  assert.ok(env.sent.every(message => /Nov 17, 2026/.test(message.text)));
  const changed = await environment();
  changed.sqlite.prepare("UPDATE pilot_child_providers SET mapping='{}' WHERE provider='source'").run();
  await runReportDelivery(changed, now + 3600000);
  assert.ok(changed.sent.every(message => !message.text.includes('French')));
});

test('empty lists, revocation and removal before transport prevent delivery', async () => {
  const env = await environment(); env.sqlite.prepare("UPDATE pilot_report_recipients SET recipients='[]' WHERE family_id='one'").run();
  env.sqlite.prepare("UPDATE pilot_families SET revoked_at=? WHERE id='two'").run(iso(now));
  await runReportDelivery(env, now); assert.equal(env.sent.length, 0);
  const race = await environment(); const original = race.DB.prepare;
  race.DB.prepare = sql => {
    if (sql.startsWith('INSERT INTO pilot_report_deliveries')) {
      const stmt = original(sql); return { bind: (...args) => { const bound = stmt.bind(...args); return { all: async () => {
        const result = await bound.all(); race.sqlite.prepare("UPDATE pilot_report_recipients SET revision=?").run(crypto.randomUUID()); return result;
      } }; } };
    }
    return original(sql);
  };
  await runReportDelivery(race, now); assert.equal(race.sent.length, 0);
});

test('only definite quota rejection retries; ambiguous errors and crashes never resend', async () => {
  const env = await environment(); let calls = 0;
  env.REPORT_EMAIL.send = () => { calls++; return Promise.reject(Object.assign(new Error('do not log'), { code: 'E_RATE_LIMIT_EXCEEDED' })); };
  await runReportDelivery(env, now); assert.equal(calls, 4);
  await runReportDelivery(env, now + 60000); assert.equal(calls, 4);
  env.REPORT_EMAIL.send = message => { env.sent.push(message); return Promise.resolve({ messageId: 'accepted' }); };
  await runReportDelivery(env, now + 300000); assert.equal(env.sent.length, 4);
  const ambiguous = await environment();
  ambiguous.REPORT_EMAIL.send = () => Promise.reject(new Error('timeout; might have sent'));
  await runReportDelivery(ambiguous, now); assert.ok(deliveries(ambiguous).every(row => row.state === 'unknown'));
  ambiguous.REPORT_EMAIL.send = env.REPORT_EMAIL.send;
  await runReportDelivery(ambiguous, now + 600000); assert.equal(env.sent.length, 4);
  const crashed = await environment();
  crashed.sqlite.prepare("INSERT INTO pilot_report_deliveries (family_id,child_id,check_date,recipient_revision,state,cutoff,updated_at) VALUES ('one','first','2026-11-18','revision','sending',?,?)")
    .run(iso(now - 360000), iso(now - 360000));
  await runReportDelivery(crashed, now); assert.equal(crashed.sent.length, 3);
  assert.equal(deliveries(crashed).find(row => row.family_id === 'one' && row.child_id === 'first').state, 'unknown');
});

test('recipient changes cancel retries; a later edit never resends a sent daily report', async () => {
  const env = await environment(); env.REPORT_EMAIL.send = () => Promise.reject(Object.assign(new Error('rate'), { code: 'E_RATE_LIMIT_EXCEEDED' }));
  await runReportDelivery(env, now);
  env.sqlite.prepare("UPDATE pilot_report_recipients SET revision='changed',recipients=?").run(JSON.stringify(['new@example.com']));
  await runReportDelivery(env, now + 300000); assert.ok(deliveries(env).every(row => row.state === 'skipped'));
});

test('email formatting preserves evidence, actual due dates and submission conflicts, and escapes portal text', () => {
  const item = { course: 'Literature', assignment: '<img src=x> Essay', url: 'https://app.schoology.com/assignment/123', scheduledAt: '2026-11-19T07:59:00Z', dateLabel: null, description: 'Due Wednesday, November 18, 2026 at 11:59 pm' };
  const schoology = { version: 1, childId: 'first', provider: 'schoology', observedAt: iso(now), overdueCoverage: 'complete', overdue: [item], upcoming: [item], events: null,
    recentlyCompleted: [{ course: item.course, assignment: item.assignment, url: item.url, scheduledAt: null, submissionStatus: 'This material has been submitted but not yet graded' }] };
  const message = buildReportEmail({ child: { id: 'first', display_name: '<Alex>\nBcc: fake' }, date: '2026-11-18', cutoff: iso(now),
    providers: [{ provider: 'schoology', observation: schoology, current: true, observedAt: iso(now) }] });
  assert.match(message.text, /Schoology confirms submitted/); assert.match(message.text, /Also listed overdue/);
  assert.match(message.text, /Due Wednesday, November 18, 2026 at 11:59 pm/);
  assert.doesNotMatch(message.html, /<img/); assert.match(message.html, /&lt;img/);
  assert.doesNotMatch(message.subject, /[\r\n]/);
  assert.equal(message.text.split('  • ').length - 1, 1, 'submitted assignment is not duplicated into a next-actions list');
});


test('readiness is bounded and rotates waiting children so a later ready child is not starved', async () => {
  const env = await environment();
  for (let index = 0; index < 25; index++) {
    const id = `aaa-${String(index).padStart(2, '0')}`;
    env.sqlite.prepare('INSERT INTO pilot_children VALUES (?,?,?)').run('one', id, id);
    env.sqlite.prepare('INSERT INTO pilot_report_recipients VALUES (?,?,?,?,?)').run('one', id, JSON.stringify(['parent@example.com']), 'revision', iso(now));
    env.sqlite.prepare('INSERT INTO pilot_child_providers VALUES (?,?,?,?,?,?,?)').run('one', id, 'source', 'one-source', 'revision', id, '{}');
  }
  let queries = 0; const prepare = env.DB.prepare;
  env.DB.prepare = sql => { queries++; return prepare(sql); };
  for (let tick = 0; tick < 3; tick++) {
    queries = 0; await runReportDelivery(env, now + tick * 1000);
    assert.ok(queries < 200, `readiness and sends must leave room for collection: ${queries}`);
  }
  assert.equal(env.sent.length, 4, 'ready siblings after 25 waiting children are eventually reached');
});
