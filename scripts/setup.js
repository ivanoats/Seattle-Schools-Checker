import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const checker=fileURLToPath(new URL('../build/checker',import.meta.url));
const services=process.argv.slice(2);
if(services.some(s=>!['source','sugarmate','schoology'].includes(s))) {console.error('Unknown service.');process.exit(2);}
for(const service of services.length ? services : ['source','sugarmate']) {
  const result=spawnSync(checker,['setup',service],{stdio:'inherit'});
  if(result.status!==0)process.exit(result.status||1);
}
