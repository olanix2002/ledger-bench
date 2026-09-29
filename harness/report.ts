import fs from "node:fs";

const file = "results/results.jsonl";
if (!fs.existsSync(file)) {
  console.log("no results yet");
  process.exit(0);
}
const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const groups = new Map<string, { runs: number; passes: number; secs: number }>();
for (const r of rows) {
  if (r.agent === "noop" || String(r.agent).startsWith("reference:") || String(r.agent).startsWith("selfcheck")) continue;
  const k = `${r.task}\t${r.agent}`;
  const g = groups.get(k) ?? { runs: 0, passes: 0, secs: 0 };
  g.runs++;
  g.passes += r.reward;
  g.secs += r.agentSeconds;
  groups.set(k, g);
}
console.log("task  agent            runs  passed  pass rate  avg time");
for (const [k, g] of [...groups].sort()) {
  const [task, agent] = k.split("\t");
  console.log(`${task.padEnd(6)}${agent.padEnd(17)}${String(g.runs).padEnd(6)}${String(g.passes).padEnd(8)}${((100 * g.passes) / g.runs).toFixed(0).padStart(4)}%      ${Math.round(g.secs / g.runs)}s`);
}
