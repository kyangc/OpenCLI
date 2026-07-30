# Kyangc fork release

This fork treats the CLI, daemon, and unpacked Chrome extension as one tested
release. `main` mirrors `upstream/main`; it is never a runtime source.

## Branches and versions

- `main`: fast-forward mirror of upstream.
- `stable`: the production source of truth.
- `codex/*`: upgrade and fork feature branches targeting `stable`.
- Release tag: `kyangc-v<upstream-cli-version>.<fork-revision>`.
- CLI package version: `<upstream-cli-version>-kyangc.<fork-revision>`.
- Chrome manifest version: `<upstream-extension-version>.<fork-revision>`.

The release identifier in the root package, extension package, Chrome manifest
`version_name`, tag, and artifact manifest must agree.

## Local runtime layout

```text
~/.local/share/opencli/
├── browser-extension/
│   └── current/                  # fixed Chrome "Load unpacked" path
└── releases/
    └── <release>/
        ├── extension-unpacked/   # immutable rollback source
        ├── *.tgz                 # CLI package
        ├── SHA256SUMS
        └── RELEASE.md
```

Do not load `extension/` from the Git checkout into Chrome. A fast-forward of
`main` must not mutate the running extension.

## Promotion gate

1. Merge or cherry-pick the desired upstream changes into a branch from
   `stable`.
2. Update the fork release identifiers.
3. Run `npm ci`, `npm run verify:fork-release`, and both production audits.
4. Run daemon transport E2E with port 19825 free.
5. Build the CLI tarball and immutable unpacked extension artifact.
6. Install the candidate CLI tarball and deploy the extension artifact to the
   fixed `browser-extension/current` directory.
7. In `chrome://extensions`, reload the unpacked extension.
8. Restart the daemon, run `opencli doctor`, and execute one low-cost real
   browser command.
9. Merge to `stable`, tag the resulting commit, and publish the GitHub release.

PRs to `stable` run the CLI, extension, and headed-browser workflows. Tags named
`kyangc-v*` create a GitHub release containing the CLI tarball, extension ZIP,
and checksums without publishing the upstream npm package name.

## Rollback

Install the previous release tarball, restore its `extension-unpacked` contents
to the fixed `browser-extension/current` directory, reload the extension, and
restart the daemon. Finish with `opencli doctor` and the same real browser
smoke used during promotion.
