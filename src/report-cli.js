import { buildFamilyReport } from './core/family-report.js';

try {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const report = buildFamilyReport(JSON.parse(input));
  process.stdout.write(JSON.stringify({ status: 'ok', report }) + '\n');
} catch {
  process.stdout.write('{"status":"invalid_family_report_input"}\n');
  process.exitCode = 1;
}
