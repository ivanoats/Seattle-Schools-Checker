import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const checker=fileURLToPath(new URL('../build/checker',import.meta.url));
for(const service of ['source','sugarmate']) {
  const result=spawnSync(checker,['setup',service],{stdio:'inherit'});
  if(result.status!==0)process.exit(result.status||1);
}
