## What and why

<!-- What does this change, and what problem does it solve? Link an issue if there is one. -->

## Checks

<!-- See CONTRIBUTING.md#checks for how to run these locally. -->

- [ ] `npm run lint` and `npm run typecheck` pass
- [ ] `npm test` passes
- [ ] `npm run build` and `npm run lint:publish` pass (if you touched `src/` or `package.json`)
- [ ] `npm run docs:commands:check` passes, or `npm run docs:commands` was run and the diff is included (if you changed a command's flags, description, or examples)
- [ ] `CHANGELOG.md` has an entry under `## [Unreleased]` (if user-facing)
- [ ] Tests were added or updated for the behavioural change

## Non-negotiables

<!-- If this touches order placement, secrets, or write retries, confirm the invariant still holds: -->

- [ ] Safety defaults are unchanged or strengthened (kill switch / value cap still fail closed; no new way to bypass confirmation)
- [ ] No new secret shape reaches a log/error/stack trace without going through `src/core/redact.ts` (with a `test/redact.test.ts` case)
- [ ] No new automatic retry of a `POST`/`PUT`/`DELETE` write

## Screenshots / output

<!-- For CLI output or table-formatting changes, paste a terminal snippet. -->
