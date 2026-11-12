import { runScenarios, runTimeline } from '../src/demo/scenarios.js';

const reports = runScenarios();
for (const report of reports) {
  console.log(`\n=== ${report.title} ===`);
  for (const line of report.lines) console.log(line);
}
console.log('');
for (const line of runTimeline()) console.log(line);
