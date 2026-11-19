import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReportRecipients } from '../src/core/report-recipients.js';

test('recipient addresses allow personal tags, trim whitespace and deduplicate', () => {
  assert.deepEqual(normalizeReportRecipients([' Child+School@Example.COM ', 'child+school@example.com', 'partner@example.net']),
    ['Child+School@example.com', 'partner@example.net']);
  assert.deepEqual(normalizeReportRecipients([]), []);
});
test('recipient lists reject malformed addresses, headers and oversized lists', () => {
  for (const value of ['child', 'Child <child@example.com>', 'child@example.com\r\nBcc:outsider@example.net',
    '.child@example.com', 'child..name@example.com', 'child@example', 'child@-example.com', 'child@example..com', null,
    `${'a'.repeat(65)}@example.com`, 'child@example.com,outsider@example.net']) {
    assert.throws(() => normalizeReportRecipients([value]), /invalid_email_address/);
  }
  assert.throws(() => normalizeReportRecipients(Array(11).fill('child@example.com')), /too_many_recipients/);
  assert.throws(() => normalizeReportRecipients('child@example.com'));
});
