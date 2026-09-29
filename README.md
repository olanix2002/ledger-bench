# ledger-bench

A small benchmark for coding agents, built on a payments ledger (TypeScript, Node,
Express, SQLite). Tasks are realistic backlog items that build on one another. Each
task has an issue, a pinned starting commit, hidden tests as the grader, a reference
solution, and a second valid solution to check that the tests do not over-specify.

Status: work in progress.

## Layout

- `src/` the ledger app
- `tests/` visible regression tests
- `tasks/` one folder per task (issue, notes); hidden tests are kept out of the agent's workspace
- `harness/` (planned) resets the repo to a task commit, runs an agent, then runs hidden tests

## Grading

Binary reward. A run passes only if the hidden tests pass and the regression suite
still passes.

## Run

    npm install
    npm test
    npm run dev
