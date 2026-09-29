/**
 * Runs one agent attempt on one task and grades it.
 *
 *   npx tsx harness/run.ts --task 02 --agent claude-code
 *   npx tsx harness/run.ts --task 02 --agent reference:solution/02   (harness self-check)
 *   npx tsx harness/run.ts --task 02 --agent noop                    (must score 0)
 *
 * The agent works in a fresh copy of the task's starting commit with all hidden tests,
 * task notes and git history removed. Grading restores the pristine visible tests and
 * the hidden tests, so an agent cannot pass by editing or deleting tests.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

const repo = process.cwd();
const GIT_ID = ["-c", "user.name=harness", "-c", "user.email=harness@example.com"];

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}
const keep = process.argv.includes("--keep");

function run(cmd: string, args: string[], cwd: string, extra: Record<string, unknown> = {}) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8", shell: cmd === "npm" || cmd === "npx", maxBuffer: 64 * 1024 * 1024, ...extra });
}
function git(args: string[], cwd = repo) {
  const r = run("git", args, cwd);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}
function copyTree(from: string, to: string) {
  fs.cpSync(from, to, { recursive: true, filter: (s) => path.basename(s) !== ".git" && path.basename(s) !== "node_modules" });
}

const taskId = arg("task");
const agentName = arg("agent");
const tasks = JSON.parse(fs.readFileSync(path.join(repo, "harness/tasks.json"), "utf8"));
const agents = JSON.parse(fs.readFileSync(path.join(repo, "harness/agents.json"), "utf8"));
const task = tasks[taskId];
if (!task) throw new Error(`unknown task ${taskId}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-run-"));
const worktrees: string[] = [];
function checkout(ref: string, name: string) {
  const dir = path.join(tmp, name);
  git(["worktree", "add", "--detach", dir, ref]);
  worktrees.push(dir);
  return dir;
}

const runId = `${taskId}-${agentName.replace(/[^\w.-]/g, "_")}-${Date.now()}`;
const pristine = checkout(task.ref, "pristine");
const issue = fs.readFileSync(path.join(pristine, task.issue), "utf8");

// 1. Build the agent's workspace: no hidden tests, no task notes, no history.
const work = path.join(tmp, "work");
copyTree(pristine, work);
for (const d of ["tasks", "harness", "results"]) fs.rmSync(path.join(work, d), { recursive: true, force: true });
run("git", ["init", "-q"], work);
run("git", [...GIT_ID, "add", "-A"], work);
run("git", [...GIT_ID, "commit", "-qm", "start"], work);
const install = run("npm", ["install", "--no-audit", "--no-fund"], work);
if (install.status !== 0) throw new Error(`npm install failed:\n${install.stderr}`);

const prompt = [
  "You are working in a TypeScript/Node repository: a payments ledger API (Express, Node's built-in SQLite).",
  "Resolve the issue below by changing the code, and add tests for your change.",
  "Run `npm test` to check your work. Do not edit existing tests to make them pass.",
  "",
  "ISSUE",
  "-----",
  issue,
].join("\n");
const promptFile = path.join(tmp, "prompt.txt");
fs.writeFileSync(promptFile, prompt);

// 2. Run the agent.
const t0 = Date.now();
let exitCode: number | null = 0;
let timedOut = false;
let agentLog = "";
if (agentName === "noop") {
  agentLog = "noop agent: no changes";
} else if (agentName.startsWith("manual")) {
  console.log(`\nWorkspace: ${work}\nPrompt:    ${promptFile}`);
  console.log("Open the workspace folder in your editor or agent, give it the prompt, let it finish,");
  console.log("then come back here and press Enter to grade.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("Press Enter when the agent is done: ");
  rl.close();
  agentLog = "manual run";
} else if (agentName.startsWith("reference:")) {
  const refDir = checkout(agentName.slice("reference:".length), "reference");
  fs.rmSync(path.join(work, "src"), { recursive: true, force: true });
  copyTree(path.join(refDir, "src"), path.join(work, "src"));
  agentLog = `reference solution copied from ${agentName}`;
} else {
  const cfg = agents[agentName];
  if (!cfg) throw new Error(`unknown agent ${agentName} (see harness/agents.json)`);
  const cmd = String(cfg.cmd).replace("{promptFile}", JSON.stringify(promptFile));
  const r = spawnSync(cmd, {
    cwd: work,
    shell: true,
    encoding: "utf8",
    input: cfg.stdin ? prompt : undefined,
    timeout: (cfg.timeoutMin ?? 20) * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  exitCode = r.status;
  timedOut = r.error?.message.includes("ETIMEDOUT") ?? false;
  agentLog = `${r.stdout ?? ""}\n--- stderr ---\n${r.stderr ?? ""}`;
}
const agentSeconds = Math.round((Date.now() - t0) / 1000);

// 3. Record what the agent changed.
run("git", ["add", "-A"], work);
const changed = run("git", ["diff", "--cached", "--name-only"], work).stdout.split("\n").filter(Boolean);
const testsTouched = changed.filter((f) => f.startsWith("tests/"));
const diffLines = run("git", ["diff", "--cached", "--shortstat"], work).stdout.trim();
fs.mkdirSync(path.join(repo, "results/patches"), { recursive: true });
fs.writeFileSync(path.join(repo, "results/patches", `${runId}.patch`), run("git", ["diff", "--cached"], work).stdout);

// 4. Grade against pristine visible tests plus hidden tests.
fs.rmSync(path.join(work, "tests"), { recursive: true, force: true });
copyTree(path.join(pristine, "tests"), path.join(work, "tests"));
for (const h of task.hidden as string[]) {
  fs.rmSync(path.join(work, h), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(path.join(work, h)), { recursive: true });
  copyTree(path.join(pristine, h), path.join(work, h));
}
const outFile = path.join(tmp, "vitest.json");
const grade = run("npx", ["vitest", "run", "tests", ...(task.hidden as string[]), "--reporter=json", `--outputFile=${outFile}`], work);

let passed = 0, failed = 0, failedNames: string[] = [], graderError = "";
if (fs.existsSync(outFile)) {
  const j = JSON.parse(fs.readFileSync(outFile, "utf8"));
  passed = j.numPassedTests;
  failed = j.numFailedTests;
  for (const f of j.testResults)
    for (const a of f.assertionResults ?? []) if (a.status === "failed") failedNames.push(a.fullName);
  if (j.numFailedTestSuites > 0 && failed === 0) graderError = "a test suite failed to load (compile or import error)";
} else {
  graderError = `grader produced no report: ${grade.stderr?.slice(-400)}`;
}
const reward = !graderError && failed === 0 && passed > 0 ? 1 : 0;

// 5. Save results.
fs.mkdirSync(path.join(repo, "results/logs"), { recursive: true });
fs.writeFileSync(path.join(repo, "results/logs", `${runId}.log`), agentLog);
const record = {
  runId, task: taskId, agent: agentName, reward, passed, failed, failedNames, graderError,
  agentSeconds, exitCode, timedOut, filesChanged: changed, testsTouched, diff: diffLines,
  at: new Date().toISOString(),
};
fs.appendFileSync(path.join(repo, "results/results.jsonl"), JSON.stringify(record) + "\n");

console.log(`\n${runId}\n  reward: ${reward}   tests: ${passed} passed, ${failed} failed   agent time: ${agentSeconds}s`);
if (failedNames.length) console.log("  failing:\n   - " + failedNames.join("\n   - "));
if (graderError) console.log("  grader error: " + graderError);
console.log(`  files changed: ${changed.length ? changed.join(", ") : "none"}`);

// 6. Clean up.
if (!keep) {
  for (const w of worktrees) git(["worktree", "remove", "--force", w]);
  fs.rmSync(tmp, { recursive: true, force: true });
} else console.log(`  kept workspace: ${work}`);
