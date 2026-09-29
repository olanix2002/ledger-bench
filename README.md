# ledger-bench

A small benchmark for coding agents, built on a payments ledger (TypeScript, Node,
Express, SQLite via `node:sqlite`). Tasks are realistic backlog items that build on one
another. Each task has an issue, a pinned starting commit, hidden tests as the grader, a
reference solution, and a second, structurally different solution to check that the tests
do not over-specify.

Status: work in progress. Two tasks so far.

## Tasks

| Task | Starting ref | Reference solutions | What it tests |
| --- | --- | --- | --- |
| 01 idempotency keys | `master` | `solution/01` | Replay semantics, key reuse conflicts, per-account key scope, concurrent retries |
| 02 concurrent transfers | `task/02-start` | `solution/02`, `solution/02-alt` | Stale read across an `await` (lost updates, overdraft), reconciliation with history, risk check must stay in the path |

Each task builds on the previous one. Task 2's start commit adds an asynchronous risk
check ahead of the debit, and the bug is a read-modify-write across that `await`.

## How grading works

`harness/run.ts` builds a fresh workspace from the task's starting commit with hidden
tests, task notes and git history removed, runs the agent, then restores the pristine
visible tests and the hidden tests and runs them. Reward is binary: 1 only if every test
passes. Because tests are restored before grading, an agent cannot pass by editing or
deleting them; edits to `tests/` are recorded in the results.

    npm run bench -- --task 02 --agent noop                       # must score 0
    npm run bench -- --task 02 --agent reference:solution/02      # must score 1
    npm run bench -- --task 02 --agent claude-code                # a real agent, see harness/agents.json
    npm run report

Harness self-checks (recorded in `results/results.jsonl`): the no-op agent scores 0 on
both tasks and each reference solution scores 1.

## Design notes and known limits

- Hidden tests in task 2 inject a slow risk service so concurrent requests reliably overlap.
- The race is real within one Node process. It does not model several processes sharing
  one SQLite file.
- Some hidden tests are guards that pass on the starting commit (for example, that the
  risk check is still called). They catch shortcuts and do not measure the fix.
- Agents run directly on the host in a temporary directory, not in a container.

## Run the app

    npm install
    npm test          # on a task's starting commit the hidden tests fail by design
    npm run dev
