import { withPortalSession } from './discover-account.js';
import { configuredChild } from './core/children.js';
import { observeSchool } from './core/observations.js';
import { readSource } from './source.js';
import { readSchoology } from './schoology.js';
import { CheckError } from './auth.js';

const safeReason = error => error instanceof CheckError && /^[a-z_]{1,64}$/.test(error.status) ? error.status : 'check_failed';

// Each job uses one isolated parent session. Only confirmed child mappings are read.
export async function collectAccount(provider, credentials, children, launch, options = {}) {
  try {
    if (!Array.isArray(children) || !children.length || children.length > 20) throw new Error('invalid_children');
    const config = { defaultChild: children[0].id, children };
    for (const child of children) configuredChild(config, child.id);
  } catch {
    credentials.username = ''; credentials.password = '';
    return { status: 'unavailable', reason: 'child_mapping_invalid' };
  }
  const readers = options.readers ?? { source: readSource, schoology: readSchoology };
  const results = [];
  const output = await withPortalSession(provider, credentials, launch, async page => {
    for (const child of children) {
      try {
        const report = await readers[provider](page, child); // NOSONAR: child selection mutates this shared family session; reads must stay sequential.
        results.push({ childId: child.id, status: 'ok', observation: observeSchool({ provider, child, report,
          observedAt: new Date().toISOString(), assignmentRows: report.assignmentRows }) });
      } catch (error) { results.push({ childId: child.id, status: 'unavailable', reason: safeReason(error) }); }
    }
    return { status: 'ok', results };
  }, options.timeoutMs ?? 240000);
  if (output.status === 'attention') {
    const reason = output.reason === 'discovery_expired' ? 'check_expired' : output.reason;
    if (!results.length) return { status: 'unavailable', reason };
    return { status: 'ok', results: children.map(child => {
      const completed = results.find(result => result.childId === child.id && result.status === 'ok');
      return completed ?? { childId: child.id, status: 'unavailable', reason };
    }) };
  }
  return output;
}
