# mend
[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/vidovizio/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/vidovizio/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models get diffs wrong — stale line
numbers, mangled indentation, a stray prose sentence wrapped around a code fence — and `mend` is the part that
reads the edit the way the model meant it and either lands it cleanly or refuses to touch anything.

No dependencies. Node 22, standard library only, one file: `node main.ts [options] [PATCH]`.

## Four formats

- **Unified diff** — `diff --git` / `---` / `+++` sections with `@@` hunks. Wrong `@@` offsets are survivable:
  a hunk goes to the occurrence nearest the number the header claims, so a patch written against a slightly
  older file still applies. Handles creation, deletion, moves and `\ No newline at end of file`.
- **SEARCH/REPLACE** — `<path>` then `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` blocks. The path is taken
  from the nearest preceding non-blank line, so blocks may share one header.
- **V4A** — `*** Begin Patch` sections: `Add File`, `Delete File`, `Update File`, `Move to`, `@@ <anchor>`
  chunks with a moving cursor, and `*** End of File` for edits pinned to the tail.
- **JSON edits** — a `create` / `str_replace` / `insert` tool call, as a JSON array or as JSON Lines.

## Three matching tiers

Lines the patch claims to replace are looked up at the first tier that finds them: exact, then ignoring
trailing spaces and tabs, then ignoring both leading and trailing ones. When a tier other than exact is used,
new lines are re-indented to the file's own leading whitespace instead of the patch's, and context lines are
written from the file rather than from the patch — so a model that guessed the indentation does not get to
reflow the file. `--strict` disables the loose tiers entirely.

## All or nothing

Every edit is applied to an in-memory tree. If any edit fails, nothing is written: exit 1, one `error: <code>
<path>` line per failure in patch order, then `failed: k of n edits`. Edits after a failure still run, so a
single run reports every problem instead of one per attempt. Exit 2 is for usage, unreadable patch, undetectable
format and parse faults; exit 0 lists the changed paths as `A` / `D` / `M` / `R` lines plus `ok: n files`.

## Run it

```sh
node main.ts patch.diff                  # apply a patch file
node main.ts --check patch.diff          # report what would change, write nothing
git diff | node main.ts -                # patch from standard input
node main.ts --strict --format=unified patch.diff
```

There is no `--help` flag. The option surface is deliberately tiny — `--format`, `--check`, `--strict` and
`--` — and SPEC.md section 1 defines it as closed: anything else starting with `-` is a usage error, so
`node main.ts --help` prints `error: usage` and exits 2. That is the tool being strict, not broken.

Apply a patch and see what landed:

```sh
$ node main.ts patch.diff
M src/app.ts
ok: 1 file
```

Run the bundled practice checks:

```sh
node check.ts path/to/practice.json
```

`SPEC.md` in this repository is the full contract — every sentence in it is a requirement, and the reading of
each format is defined there rather than here.

<sub>Entered on [make.fun](https://make.fun/?ref=ynfr7a93&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
