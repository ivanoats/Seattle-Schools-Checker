import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';

// Command-line tools are resolved from fixed system directories, never
// from the caller's PATH, so a writable PATH entry cannot substitute them.
const trustedDirectories = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

export function trustedCommand(name) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('command_name_invalid');
  for (const directory of trustedDirectories) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* Try the next fixed directory. */ }
  }
  throw new Error(`${name}_not_found`);
}
