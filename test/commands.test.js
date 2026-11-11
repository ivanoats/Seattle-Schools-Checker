import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trustedCommand } from '../scripts/browser-run/commands.js';

test('tools resolve to an absolute path in a fixed system directory', () => {
  assert.match(trustedCommand('sh'), /^\/(?:opt\/homebrew\/bin|usr\/local\/bin|usr\/bin|bin)\/sh$/);
});

test('unknown or path-like tool names are refused', () => {
  assert.throws(() => trustedCommand('no-such-tool-for-this-test'), /_not_found$/);
  assert.throws(() => trustedCommand('../bin/sh'), /command_name_invalid/);
  assert.throws(() => trustedCommand('/bin/sh'), /command_name_invalid/);
});
