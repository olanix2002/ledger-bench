# ledger-bench

A small benchmark for coding agents, built on a payments ledger (TypeScript, Node, Express, SQLite via node:sqlite). Tasks are realistic backlog items that build on one another. Each task has an issue, a pinned starting commit, hidden tests as the grader, a reference solution, and (for task 2) a second, structurally different solution to check that the tests do not over-specify.

**Status:** work in progress. Two tasks so far, one agent tested.

## Tasks

| Task | Starting ref | Reference solutions | What it tests |
|---|---|---|---|
| 01 idempotency keys | `master` (tag `base`) | `solution/01` | Replay semantics, key reuse conflicts, per-account key scope, concurrent retries |
| 02 concurrent transfers | `task/02-start` | `solution/02`, `solution/02-alt` | Stale read across an await (lost updates, overdraft), reconciliation with history, risk check must stay in the path |

Each task builds on the previous one. Task 2's start commit adds an asynchronous risk check ahead of the debit, and the bug is a read-modify-write across that await.

## How grading works

`harness/run.ts` builds a fresh workspace from the task's starting commit with hidden tests, task notes and git history removed, lets the agent work, then restores the pristine visible tests and the hidden tests and runs them. Reward is binary: 1 only if every test passes. Because tests are restored before grading, an agent cannot pass by editing or deleting them; edits to `tests/` are recorded in the results.

```
npm run bench -- --task 02 --agent noop                        # must score 0
npm run bench -- --task 02 --agent reference:solution/02       # must score 1
npm run bench -- --task 02 --agent manual:<label>              # prepare a workspace for any agent
npm run bench -- --grade "<workspace dir>"                     # grade it afterwards
npm run report
```

Manual mode is how the Copilot runs below were done: the harness prepares a workspace and prompt, I run the agent in a separate editor window, then grade the folder. `harness/agents.json` also has entries for command-line agents; those are untested.

## Results

Harness self-checks (in `results/results.jsonl`): the no-op agent scores 0 on both tasks, and each reference solution scores 1.

Agent runs (patches in `results/patches/`):

| Task | Agent | Attempts | Result |
|---|---|---|---|
| 01 | Copilot agent mode ([model]) | 1 | Pass (13/13) |
| 02 | Copilot agent mode ([model]) | 1 | Pass (22/22) |

One attempt per task is not a pass rate. The main finding so far is that both tasks are too easy for this agent, so harder tasks are next. Agent time was not recorded for manual runs.

## Design notes and known limits

- On the starting commits, 4 of 7 hidden tests fail for task 1 and 6 of 9 for task 2. The rest are guards that pass on the start commit (for example, that the risk check is still called). They catch shortcuts and do not measure the fix.
- Task 1's concurrent-retry test cannot fail for a naive solution: `node:sqlite` is synchronous, so requests never interleave inside one process.
- Task 2's hidden tests inject a slow risk service so concurrent requests reliably overlap. The race is real within one Node process. It does not model several processes sharing one SQLite file.
- Agents run directly on the host in a temporary directory, not in a container.
- Manual runs depend on the person running the agent working in the right folder. The harness warns when the workspace has no changes.

## Run the app

```
npm install
npm test          # on a task's starting commit the hidden tests fail by design
npm run dev
```