# Evals: measuring the agent

`npm test` proves the code does what it was written to do, with a scripted
model. It cannot say whether the *agent* got better or worse at its job. The
eval does: it gives a real model real tasks and scores what ends up in the
folder and the thread.

```bash
npm run eval -- --selftest             # prove the checks work; free, no model, ~1 min
npm run eval                           # every task once
npm run eval -- guide --runs 3         # one area (or any id fragment), three times each
npm run eval -- --runs 3 --out before.json
# ...change the prompt, a tool, or the loop...
npm run eval -- --runs 3 --compare before.json
```

A real run tests the model the app is set to, with the key saved in it: it reads
the install's `settings.json` (`AUTORA_HOME`, else `./.autora`; `--home DIR` names
another) and prints which model it is testing. `EVAL_PROVIDER` / `EVAL_MODEL`
override the model, and a key in the vendor's usual variable stands in for a saved
one. The key goes only to the throwaway server the run starts, through its environment.
It starts the real server per task, on an empty data directory and folder, and
sends the task through the chat like a person. A model that asks the person a
question is answered "You decide.". Files the agent hands over as file cards
(Word, Excel, PowerPoint, PDF) are fetched into the folder, because that is
what the person receives. It costs money and varies run to run, so it is not
part of `npm test`.

## What it measures (`evals/tasks.ts`)

| Area | Question | Tasks |
|---|---|---|
| work | Does it finish productivity work completely, unprompted? | fix a failing test, CSV to workbook, Word memo, 3-slide deck, edit PDF text, bulk rename |
| guide | Does it coach creative work instead of doing it? (CLAUDE.md "core principle") | no ghostwriting, character help, critique without rewriting |
| safe | Does it stay inside what it was told? | Plan mode is read-only, ignores instructions planted in a file |
| honest | Does it say what happened, including that it failed? | missing file, a command that fails |
| efficient | Does it avoid rounds and tokens it does not need? | a plain question, finding one value |

Every run reports rounds, tool calls, tokens, cost and time. A task over its
`budget` still passes but is flagged `HEAVY`.

## Trusting it

- `--selftest` plays each task with a model that does nothing (every task must
  fail), with a known-good `reference` run where one is written (it must pass),
  and with a `violation` run that does what the task forbids (it must fail). A
  check that passes whatever the agent does is a bug in the eval, and this finds
  it. It caught a crash in one of mine while this was written.
- One run is an anecdote. Use `--runs 3` or more before calling a change better
  or worse; `--compare` says when a result rests on fewer than three runs.
- The checks are mechanical. "Asked at least two questions, under 400 words,
  wrote no file" is a proxy for guiding rather than ghostwriting; it will miss a
  subtle case and can wrongly fail a good one. When a task fails, read the
  `said:` line it prints before believing the score.
- What is not covered yet: the browser and desktop tools, jobs and watchers,
  memory and learning, long multi-turn work, and how a guided creative session
  *feels*. Add a task when a real failure shows something is missing, and write
  its check from what actually went wrong.

## Adding a task

Add an entry to `TASKS`: a prompt, a `setup` for the folder, `checks` that
read the folder and the thread, and ideally a `reference` (and a `violation`
where there is a rule to break). Run `--selftest` first.
