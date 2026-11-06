import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedCredentialDestination } from '../src/auth.js';
import { summarize, windowsFor, seattleTime } from '../src/glucose.js';
import { parseAttendance } from '../src/source.js';

test('credentials can only go to the exact approved HTTPS service', () => {
  assert.equal(allowedCredentialDestination('source','https://ps.seattleschools.org/public/'),true);
  for(const url of ['http://ps.seattleschools.org/public/','https://ps.seattleschools.org.evil.test/','https://evil.test/','https://ps.seattleschools.org:9000/']) assert.equal(allowedCredentialDestination('source',url),false);
  assert.equal(allowedCredentialDestination('sugarmate','https://api.sugarmate.io/oauth/token'),true);
  assert.equal(allowedCredentialDestination('sugarmate','https://api.sugarmate.io/other'),false);
});
test('missing CGM samples remain gaps, and endpoints are not classified as low/high', () => {
  const result=summarize([{t:0,v:70},{t:300000,v:180},{t:900000,v:50}],0,1200000);
  assert.equal(result.readings,3); assert.equal(result.coveragePct,75);
  assert.equal(result.events.length,1); assert.equal(result.events[0].type,'low');
});
test('a normal sample breaks a high interval even when it is brief', () => {
  const result=summarize([{t:0,v:190},{t:1000,v:170},{t:2000,v:200}],0,900000);
  assert.equal(result.events.length,2);
});
test('night-before windows respect the Seattle daylight-saving offset', () => {
  const w=windowsFor('2026-11-02');
  assert.equal(new Date(w.evening.start).toISOString(),'2026-11-02T02:00:00.000Z');
  assert.equal(new Date(w.overnight.end).toISOString(),'2026-11-02T16:50:00.000Z');
  assert.equal(new Date(seattleTime('2026-10-30','08:50')).toISOString(),'2026-10-30T15:50:00.000Z');
});
test('Geometry stays ambiguous and the October 8 special rotation overrides the standard', () => {
  assert.ok(windowsFor('2026-11-03').P4_A); assert.ok(windowsFor('2026-11-03').P4_B);
  assert.equal(new Date(windowsFor('2026-10-08').P5.start).toISOString(),'2026-10-08T21:45:00.000Z');
  assert.equal(windowsFor('2026-10-08').P4_A,undefined);
});
test('attendance preserves unspecified and explicitly unexcused codes', () => {
  assert.deepEqual(parseAttendance('3(A) - 11/02/2026 - A\n1(A) - 10/21/2026 - UA'),[
    {period:'3(A)',date:'2026-11-02',code:'A'}, {period:'1(A)',date:'2026-10-21',code:'UA'}]);
});
