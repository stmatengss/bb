# Kimi Code prototype validation

Implementation: [`9a7f4e520cf9518e76f62ed18fc3190b9481d19d`](https://github.com/stmatengss/bb/commit/9a7f4e520cf9518e76f62ed18fc3190b9481d19d).
Upstream baseline: [`a6fff60f53c615a109103075328bf7017431e792`](https://github.com/get-bb/bb/commit/a6fff60f53c615a109103075328bf7017431e792).
Validated locally on 2026-10-25, macOS 26.5.1 arm64, Node 24.18.0, pnpm 9.15.0, Kimi Code 2.2.0, ACP SDK 1.7.0.

This is a prototype for maintainer discussion, not a release or a hosted CI result. The implementation commit is separate from this evidence commit.

## Scope

- Add an installed-only `acp-kimi` provider using `kimi acp`, terminal login guidance, and the existing Kimi registry icon.
- Reuse ACP model discovery and text/tool/session handling; index npm CLI native user/project skills and configured extra directories.
- Preserve an existing custom `id: "kimi"` launch configuration and inherit the shipped Kimi dialect unless explicitly overridden.
- In bb `accept-edits` mode, reset Kimi's hidden configured `yolo` default and reject native `auto`/`yolo` selections. Those native modes require Full Access.
- Wait for Kimi's advertised `session/close` before terminating the process, allowing pending history writes to finish. A close failure or 5-second timeout warns and still cleans up the process.

Code: [provider declaration](https://github.com/stmatengss/bb/blob/9a7f4e520cf9518e76f62ed18fc3190b9481d19d/plugins/provider-acp/src/known-agents.ts#L202-L219), [permission handling](https://github.com/stmatengss/bb/blob/9a7f4e520cf9518e76f62ed18fc3190b9481d19d/packages/provider-bridge-acp/src/bridge/bridge.ts#L2781-L2855), [close handling](https://github.com/stmatengss/bb/blob/9a7f4e520cf9518e76f62ed18fc3190b9481d19d/packages/provider-bridge-acp/src/bridge/bridge.ts#L2593-L2616), [native roots](https://github.com/stmatengss/bb/blob/9a7f4e520cf9518e76f62ed18fc3190b9481d19d/plugins/provider-acp/src/native-roots/kimi.ts#L19-L60).

## Automated checks

| Suite | Files | Passed | Skipped |
| --- | ---: | ---: | ---: |
| ACP provider plugin | 9 | 95 | 0 |
| ACP bridge | 25 | 554 | 4 |
| Templates | 6 | 46 | 0 |
| Five selected server integration files | 5 | 95 | 0 |
| Total | 45 | 790 | 4 |

These totals include existing tests in the relevant suites; they are not 790 new Kimi tests or a full-monorepo test run.

Relevant typechecks, lint, actual ACP plugin bundling, changed-file formatting, `git diff --check`, the source-NUL check (8,060 tracked files), and the provider-literal ratchet passed. There is no pre-commit configuration in this checkout.

Repository-wide `pnpm run format:check` failed on 208 files. All 208 were unchanged from the baseline; no implementation file was among them. No unrelated formatting changes were made.

Commands from the repository root:

```sh
pnpm exec turbo run lint typecheck test --filter=bb-plugin-provider-acp --filter=@bb/templates --concurrency=3
pnpm exec turbo run lint typecheck test --filter=@bb/provider-bridge-acp --concurrency=3
pnpm exec turbo run test --filter=@bb/server -- \
  test/providers/plugin-provider-registration.test.ts \
  test/services/plugins/first-party-provider-plugins.test.ts \
  test/system/execution-options.test.ts \
  test/system/provider-states.test.ts \
  test/threads/thread-default-policy.test.ts
pnpm exec turbo run typecheck --filter=@bb/server
pnpm exec turbo run prepare:bundled --filter=bb-plugin-provider-acp --output-logs=errors-only
node scripts/check-source-nul.mjs
node scripts/check-provider-literal-ratchet.mjs --base origin/main
pnpm run format:check
```

## Actual CLI smoke test

[Portable script](./smoke.mjs) · [sanitized final result](./runtime-result.json) · [check summary](./checks.json).

The script starts the real bb ACP bridge worker and real Kimi CLI, with temporary configuration/workspace directories and a deterministic OpenAI-compatible server bound to `127.0.0.1`. It does not use an external model account. The only requested shell actions write harmless marker files in the temporary workspace.

After fixing close/persistence ordering, four consecutive runs passed. Each run made 6 localhost HTTP requests, received 2 approval requests, and made 0 remote model calls. The final source passed all 12 assertions:

- Text streams through the bb bridge.
- Denial reaches bb and prevents the denied marker write.
- Approval reaches bb and permits the allowed marker write.
- Immediate release/resume keeps the same session and nonempty history.
- The resumed model request contains all three earlier assistant results and both denied/allowed tool results.

The test intentionally closes immediately after turn completion; it has no blind persistence delay. Before the close fix, a repeated run restored the same session ID with missing history. Kimi's prompt completion could precede asynchronous durable-log writes; explicit `session/close` drains that work before process termination.

To reproduce, install this checkout's dependencies and Kimi Code 2.2.0, then run from the validation branch:

```sh
node docs/kimi-code-validation/smoke.mjs "$PWD" "$(command -v kimi)" /tmp/bb-kimi-runtime-result.json
```

No login or real model credential is needed for this local mock test. The result records `dirty: true` because the run preceded the implementation commit; its bridge SHA256 matches the subsequently committed bridge source exactly:

```text
2fe301c0e67433c6c7e42962f39e3f310307104ff680d33ecdf423f843469296
```

## Boundaries

- Not validated: live model inference, the full bb UI, hosted CI, or Windows/Linux execution.
- Kimi fork is disabled: the tested ACP implementation ignores the destination cwd and MCP overrides.
- Native skill roots target the npm CLI 2+; legacy Python CLI locations are not included.
- Native skill indexing reads the host daemon environment, independently of custom launch-only env overrides.
- Restoring a restricted session or leaving Full Access resets native mode to `default`; an explicit Plan selection is preserved across live restricted turns.
- No server/daemon protocol fields changed. The updated ACP bridge is shipped inside the content-addressed provider host artifact; existing daemons load that artifact.

> AGENT GENERATED
