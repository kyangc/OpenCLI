import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const composeSmoke = fileURLToPath(new URL('../scripts/smoke-compose.sh', import.meta.url));

test('compose smoke starts tagged images with provider checks disabled and runs deployment smoke', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencli-compose-smoke-'));
  const fakeBin = path.join(directory, 'bin');
  const callLog = path.join(directory, 'calls.log');
  const environmentCopy = path.join(directory, 'smoke.env');
  await mkdir(fakeBin);
  await writeFile(path.join(fakeBin, 'docker'), `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$SMOKE_CALL_LOG"
if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then exit 1; fi
previous=
for argument in "$@"; do
  if [ "$previous" = "--env-file" ]; then cp "$argument" "$SMOKE_ENV_COPY"; fi
  previous=$argument
done
case "$*" in
  *" up -d --no-build"*)
    runtime_root=$(sed -n 's/^OPENCLI_RUNTIME_ROOT=//p' "$SMOKE_ENV_COPY")
    ls -ld "$runtime_root/data" "$runtime_root/opencli-state" >> "$SMOKE_CALL_LOG" 2>&1 || true
    ;;
esac
`);
  await writeFile(path.join(fakeBin, 'node'), `#!/bin/sh
printf 'node %s\\n' "$*" >> "$SMOKE_CALL_LOG"
`);
  await chmod(path.join(fakeBin, 'docker'), 0o755);
  await chmod(path.join(fakeBin, 'node'), 0o755);

  try {
    await execFileAsync('/bin/sh', [composeSmoke, '2.0.3', '2.0.0'], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        SMOKE_CALL_LOG: callLog,
        SMOKE_ENV_COPY: environmentCopy,
      },
    });

    const [calls, environment] = await Promise.all([
      readFile(callLog, 'utf8'),
      readFile(environmentCopy, 'utf8'),
    ]);
    assert.match(calls, /docker compose .* up -d --no-build/);
    assert.match(calls, /node .*smoke-deployment\.mjs --base-url http:\/\/127\.0\.0\.1:28080 --expected-daemon-version 2\.0\.3 --expected-extension-version 2\.0\.0/);
    assert.match(calls, /docker exec --user 0 opencli-backend chmod -R a\+rwX \/data \/home\/node\/\.opencli/);
    assert.match(calls, /docker compose .* down --volumes --remove-orphans/);
    assert.match(calls, /drwxrwxrwx@? .*\/data/);
    assert.match(calls, /drwxrwxrwx@? .*\/opencli-state/);
    assert.match(environment, /^OPENCLI_SESSION_CHECK_SITES=disabled$/m);
    assert.doesNotMatch(environment, /xiaohongshu|twitter/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('compose smoke refuses to reuse production container names', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencli-compose-smoke-conflict-'));
  const fakeBin = path.join(directory, 'bin');
  const callLog = path.join(directory, 'calls.log');
  await mkdir(fakeBin);
  await writeFile(path.join(fakeBin, 'docker'), `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$SMOKE_CALL_LOG"
`);
  await writeFile(path.join(fakeBin, 'node'), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(fakeBin, 'docker'), 0o755);
  await chmod(path.join(fakeBin, 'node'), 0o755);

  try {
    await assert.rejects(
      execFileAsync('/bin/sh', [composeSmoke, '2.0.3', '2.0.0'], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          SMOKE_CALL_LOG: callLog,
        },
      }),
      /refusing to run Compose smoke while opencli production containers exist/,
    );
    const calls = await readFile(callLog, 'utf8');
    assert.doesNotMatch(calls, /compose .* (?:up|down)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
