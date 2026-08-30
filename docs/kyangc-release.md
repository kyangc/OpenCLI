# Kyangc fork release

This fork tests the CLI, daemon, and unpacked Chrome extension together, while
versioning the CLI and extension independently. `main` mirrors
`upstream/main`; it is never a runtime source.

## Branches and versions

- `main`: fast-forward mirror of upstream.
- `stable`: the production source of truth.
- `codex/*`: upgrade and fork feature branches targeting `stable`.
- Fork CLI release tag: `kyangc-v<fork-version>`.
- Fork CLI package version: `<fork-version>`.
- `opencliFork.upstreamVersion` records provenance only; it never determines
  the fork version.
- Extension release label: `kyangc-ext-v<extension-version>`.
- Extension package and Chrome manifest version: `<extension-version>`.
- The extension's own `opencliFork.upstreamVersion` records its upstream base.

CLI and extension versions are independent stable semver lines. The root
package and tag must agree on the CLI release. The extension package, manifest
`version`, manifest `version_name`, and service-worker filename must agree on
the extension release. An upstream sync may change only the recorded upstream
base; it must not reset or derive either fork version.

The npm package name and plugin import surface remain
`@jackwener/opencli` for compatibility with built-in and installed adapters.
That legacy name is not a release authority. Renaming it requires a separate
plugin API migration and is intentionally outside a version-line change.

## Local runtime layout

```text
~/.local/bin/opencli -> ~/.local/share/opencli/releases/<release>/runtime/bin/opencli

~/.local/share/opencli/
├── browser-extension/
│   └── current/                  # fixed Chrome "Load unpacked" path
└── releases/
    └── <release>/
        ├── runtime/              # release-specific npm prefix for the CLI
        ├── extension-unpacked/   # immutable rollback source
        ├── *.tgz                 # CLI package
        ├── SHA256SUMS
        └── RELEASE.md
```

Do not load `extension/` from the Git checkout into Chrome. A fast-forward of
`main` must not mutate the running extension.

Do not install the fork tarball into npm's default global prefix. The fork
intentionally retains the upstream package name, so `npm update -g` can replace
it with the registry's `latest` version. Install each release into its own
`runtime/` prefix and expose it through `~/.local/bin/opencli`; keep
`~/.local/bin` ahead of normal npm global bin directories in `PATH`.

## Upstream sync SOP

Never pull `upstream/main` directly while on `stable`. Mirror upstream into
`main`, then merge that exact commit into a candidate branch from `stable`.

1. Start from a clean worktree and refresh both remotes:

   ```bash
   git status --short --branch
   git fetch --prune upstream
   git fetch --prune origin
   ```

2. Fast-forward the fork mirror and verify all three refs agree:

   ```bash
   git switch main
   git merge --ff-only upstream/main
   git push origin main
   git rev-parse main upstream/main origin/main
   ```

3. Create the production candidate from the current `stable`, not from
   `main`, and merge the already-verified upstream ref:

   ```bash
   git switch stable
   git pull --ff-only origin stable
   git switch -c codex/sync-upstream-main-YYYYMMDD
   git merge --no-ff upstream/main -m "chore: sync upstream main"
   ```

4. Bump the independent CLI fork version in `package.json` and
   `package-lock.json` according to semver, then record the merged upstream CLI
   version in `opencliFork.upstreamVersion`. Do not copy the upstream version
   into the fork version. Before touching extension metadata, check whether the
   merge changed the extension:

   ```bash
   git diff --quiet origin/stable...HEAD -- extension/
   ```

   If the command exits successfully, leave `extension/package.json`,
   `extension/package-lock.json`, and `extension/manifest.json` unchanged. Do
   not deploy or ask the user to reload the extension. If it reports changes,
   bump the extension's independent semver in those three files, update its
   recorded upstream extension base, and include the extension deployment and
   manual reload in the promotion. Finish with `npm run check:fork-release`.

5. Run the promotion gate below, push the candidate branch, and open a PR
   targeting `stable`. Do not tag or update the local runtime from `main`.

If the upstream merge conflicts with fork release files or runtime behavior,
resolve and validate it on the candidate branch. Do not force-push `main` or
rewrite `stable`.

## Promotion gate

1. Merge or cherry-pick the desired upstream changes into a branch from
   `stable`.
2. Update the CLI release identifiers. Update the extension identifiers only
   when the candidate contains extension changes.
3. Run the reproducible local checks:

   ```bash
   npm ci
   npm ci --prefix extension
   TZ=Asia/Shanghai npm run verify:fork-release
   npm audit --omit=dev --audit-level=high
   npm audit --omit=dev --audit-level=high --prefix extension
   ```

4. Temporarily disable the unpacked Browser Bridge in
   `chrome://extensions`, stop the installed daemon, and wait until port
   19825 is actually released before running the fixed-port contract:

   ```bash
   opencli daemon stop
   lsof -nP -iTCP:19825 -sTCP:LISTEN
   TZ=Asia/Shanghai npx vitest run --project e2e-fixed-port \
     tests/e2e/daemon-transport.test.ts --reporter=verbose
   ```

   `opencli daemon stop` can return before the listener disappears. A live
   unpacked extension also reconnects automatically to any daemon on the fixed
   port and invalidates the fake-extension isolation, so an empty `lsof`
   result alone is insufficient unless the real extension is disabled.

5. Build the CLI tarball. Build an immutable unpacked extension artifact only
   when the extension changed.
6. Install the candidate CLI tarball into the release-specific `runtime/` npm
   prefix, then repoint `~/.local/bin/opencli` to that runtime. Do not use a
   bare `npm install -g` for the fork. Deploy to the fixed
   `browser-extension/current` directory only when the extension changed.
7. When the extension changed, explicitly remind the user that updating files
   does not update Chrome's loaded manifest. Ask them to open
   `chrome://extensions`, re-enable the unpacked extension if needed, and click
   **Reload**. Do not treat the extension upgrade as complete until the user
   confirms this manual step. When the extension did not change, skip this
   reminder and do not ask the user to touch the extension.
8. Restart the daemon and run `opencli doctor`. Require it to report the
   candidate daemon version and a healthy compatible extension version. When
   the extension changed, require the candidate extension version as well.
   Then execute one low-cost real browser command plus the consuming
   application's read-only health checks.
9. Push the candidate branch and open a PR targeting `stable`. Require the
   CLI, extension, and headed-browser checks to pass before merging.
10. Merge to `stable`, tag the resulting commit, and publish the GitHub release.

PRs to `stable` run the CLI, extension, and headed-browser workflows. Tags named
`kyangc-v*` create a GitHub release containing the CLI tarball, the compatible
extension ZIP, and checksums without publishing the upstream npm package name.

## Rollback

Repoint `~/.local/bin/opencli` to the previous release's `runtime/bin/opencli`.
If that immutable runtime is missing, reinstall the previous release tarball
with that release's `runtime/` as the explicit npm prefix first. Restore its
`extension-unpacked` contents to the fixed `browser-extension/current`
directory, reload the extension, and restart the daemon. Finish with
`opencli doctor` and the same real browser smoke used during promotion.
