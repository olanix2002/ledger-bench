/**
 * Runs one agent attempt on one task and grades it.
 *
 * Automated agents (one command):
 *   npx tsx harness/run.ts --task 02 --agent claude-code
 *   npx tsx harness/run.ts --task 02 --agent reference:solution/02   (harness self-check, must score 1)
 *   npx tsx harness/run.ts --task 02 --agent noop                    (harness self-check, must score 0)
 *
 * Manual agents (two commands, so nothing has to stay open while you work):
 *   npx tsx harness/run.ts --task 01 --agent manual:copilot          prepares a workspace and exits
 *   npx tsx harness/run.ts --grade <printed folder>                  grades it when you are done
 *
 * The agent works in a fresh copy of the task's starting commit with hidden tests, task
 * notes and git history removed. Grading restores the pristine visible tests and the hidden
 * tests, so an agent cannot pass by editing or deleting tests.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

const tasks = JSON.parse(fs.readFileSync(path.join(repo, "harness/tasks.json"), "utf8"));
const agents = JSON.parse(fs.readFileSync(path.join(repo, "harness/agents.json"), "utf8"));

const gradeDir = process.argv.includes("--grade") ? path.resolve(arg("grade")) : null;
let tmp: string;
let taskId: string;
let agentName: string;
let runId: string;
let startedAt: number | null = null;
const worktrees: string[] = [];

function checkout(ref: string, dir: string) {
  git(["worktree", "add", "--detach", dir, ref]);
  worktrees.push(dir);
  return dir;
}

let agentLog = "";
let exitCode: number | null = 0;
let timedOut = false;
let agentSeconds: number | null = 0;

if (gradeDir) {
  // ---- Grade a workspace that was prepared earlier ----
  tmp = gradeDir;
  const metaPath = path.join(tmp, "meta.json");
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : {};
  taskId = arg("task", meta.task);
  agentName = arg("agent", meta.agent);
  runId = meta.runId ?? `${taskId}-${agentName.replace(/[^\w.-]/g, "_")}-${Date.now()}`;
  startedAt = meta.startedAt ?? null;
  agentSeconds = null; // manual runs: wall time includes idle time, so it is not recorded
  agentLog = "manual run";
  if (!fs.existsSync(path.join(tmp, "work")) || !fs.existsSync(path.join(tmp, "pristine")))
    throw new Error(`${tmp} does not contain work/ and pristine/ folders`);
  worktrees.push(path.join(tmp, "pristine"));
} else {
  // ---- Prepare a fresh workspace ----
  taskId = arg("task");
  agentName = arg("agent");
  if (!tasks[taskId]) throw new Error(`unknown task ${taskId}`);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-run-"));
  runId = `${taskId}-${agentName.replace(/[^\w.-]/g, "_")}-${Date.now()}`;
}

const task = tasks[taskId];
if (!task) throw new Error(`unknown task ${taskId}`);
const pristine = path.join(tmp, "pristine");
const work = path.join(tmp, "work");

if (!gradeDir) {
  checkout(task.ref, pristine);
  const issue = fs.readFileSync(path.join(pristine, task.issue), "utf8");

  // Agent workspace: no hidden tests, no task notes, no history.
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

  if (agentName.startsWith("manual")) {
    fs.writeFileSync(path.join(tmp, "meta.json"), JSON.stringify({ runId, task: taskId, agent: agentName, startedAt: Date.now() }));
    console.log(`\nWorkspace prepared. Nothing is running now; take as long as you need.\n`);
    console.log(`  1. Open this folder in a new VS Code window:\n     ${work}`);
    console.log(`  2. Give your agent the contents of:\n     ${promptFile}`);
    console.log(`  3. When it finishes, accept and save all changes, then grade with:\n`);
    console.log(`     npm run bench -- --grade "${tmp}"\n`);
    process.exit(0);
  }

  // ---- Run the agent ----
  const t0 = Date.now();
  if (agentName === "noop") {
    agentLog = "noop agent: no changes";
  } else if (agentName.startsWith("reference:")) {
    const refDir = checkout(agentName.slice("reference:".length), path.join(tmp, "reference"));
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
  agentSeconds = Math.round((Date.now() - t0) / 1000);
}

// ---- Record what the agent changed ----
run("git", ["add", "-A"], work);
const changed = run("git", ["diff", "--cached", "--name-only"], work).stdout.split("\n").filter(Boolean);
const testsTouched = changed.filter((f) => f.startsWith("tests/"));
const diffLines = run("git", ["diff", "--cached", "--shortstat"], work).stdout.trim();
fs.mkdirSync(path.join(repo, "results/patches"), { recursive: true });
fs.writeFileSync(path.join(repo, "results/patches", `${runId}.patch`), run("git", ["diff", "--cached"], work).stdout);

// ---- Grade against pristine visible tests plus hidden tests ----
fs.rmSync(path.join(work, "tests"), { recursive: true, force: true });
copyTree(path.join(pristine, "tests"), path.join(work, "tests"));
for (const h of task.hidden as string[]) {
  fs.rmSync(path.join(work, h), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(path.join(work, h)), { recursive: true });
  copyTree(path.join(pristine, h), path.join(work, h));
}
const outFile = path.join(tmp, "vitest.json");
fs.rmSync(outFile, { force: true });
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

// ---- Save results ----
fs.mkdirSync(path.join(repo, "results/logs"), { recursive: true });
fs.writeFileSync(path.join(repo, "results/logs", `${runId}.log`), agentLog);
const record = {
  runId, task: taskId, agent: agentName, reward, passed, failed, failedNames, graderError,
  agentSeconds, exitCode, timedOut, filesChanged: changed, testsTouched, diff: diffLines,
  at: new Date().toISOString(),
};
fs.appendFileSync(path.join(repo, "results/results.jsonl"), JSON.stringify(record) + "\n");

console.log(`\n${runId}\n  reward: ${reward}   tests: ${passed} passed, ${failed} failed` + (agentSeconds !== null ? `   agent time: ${agentSeconds}s` : ""));
if (failedNames.length) console.log("  failing:\n   - " + failedNames.join("\n   - "));
if (graderError) console.log("  grader error: " + graderError);
console.log(`  files changed: ${changed.length ? changed.join(", ") : "none"}`);
if (changed.length === 0 && agentName.startsWith("manual"))
  console.log("  warning: the workspace has no changes. The agent probably edited a different folder, so this run does not measure the agent.");

// ---- Clean up ----
if (!keep) {
  for (const w of worktrees) {
    try { git(["worktree", "remove", "--force", w]); } catch { /* already gone */ }
  }
  git(["worktree", "prune"]);
  fs.rmSync(tmp, { recursive: true, force: true });
} else console.log(`  kept workspace: ${work}`);
