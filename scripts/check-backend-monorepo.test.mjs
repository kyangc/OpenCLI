import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const backendCatalogModule = path.join(
  repositoryRoot,
  'services/opencli-backend/src/command-catalog.mjs',
);
const opencliBinary = path.join(repositoryRoot, 'dist/src/main.js');

test('backend consumes the OpenCLI catalog from the same checkout through the CLI interface', async () => {
  await access(opencliBinary);
  const { loadCommandCatalog } = await import(pathToFileURL(backendCatalogModule));

  const catalog = await loadCommandCatalog(opencliBinary);

  assert.ok(catalog.size > 0);
  assert.equal(catalog.hasWriteCommands, false);
  assert.equal(catalog.describe('hackernews', 'top')?.access, 'read');
});

test('backend images build from the current checkout without a second OpenCLI source authority', async () => {
  const backendRoot = path.join(repositoryRoot, 'services/opencli-backend');
  const [dockerfile, compose] = await Promise.all([
    readFile(path.join(backendRoot, 'Dockerfile'), 'utf8'),
    readFile(path.join(backendRoot, 'compose.yaml'), 'utf8'),
  ]);

  assert.doesNotMatch(dockerfile, /OPENCLI_(?:REPOSITORY|COMMIT)|git fetch/);
  assert.match(dockerfile, /COPY services\/opencli-backend\/package\.json/);
  assert.match(dockerfile, /COPY services\/opencli-backend\/src \/app\/src/);
  assert.match(dockerfile, /COPY services\/opencli-backend\/scripts\/smoke-deployment\.mjs \/app\/scripts\/smoke-deployment\.mjs/);
  assert.match(compose, /context: \.\.\/\.\./);
  assert.doesNotMatch(compose, /OPENCLI_(?:REPOSITORY|COMMIT)/);
});

test('backend runtime state has one explicit persistent root after relocation', async () => {
  const backendRoot = path.join(repositoryRoot, 'services/opencli-backend');
  const [compose, exampleEnvironment] = await Promise.all([
    readFile(path.join(backendRoot, 'compose.yaml'), 'utf8'),
    readFile(path.join(backendRoot, '.env.example'), 'utf8'),
  ]);

  assert.match(compose, /\$\{OPENCLI_RUNTIME_ROOT:\?/);
  assert.match(exampleEnvironment, /^OPENCLI_RUNTIME_ROOT=\.$/m);
  assert.doesNotMatch(exampleEnvironment, /OPENCLI_(?:REPOSITORY|COMMIT)/);
});

test('the CLI release package excludes the backend module', async () => {
  const { stdout } = await execFileAsync(
    'npm',
    ['pack', '--dry-run', '--ignore-scripts', '--json'],
    { cwd: repositoryRoot, maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout);
  const packResult = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  const paths = packResult.files.map((file) => file.path);

  assert.ok(paths.includes('dist/src/main.js'));
  assert.equal(paths.some((file) => file.startsWith('services/opencli-backend/')), false);
});

test('backend image verification and fork release both gate on the provider-neutral Compose smoke', async () => {
  const [backendWorkflow, releaseWorkflow] = await Promise.all([
    readFile(path.join(repositoryRoot, '.github/workflows/backend.yml'), 'utf8'),
    readFile(path.join(repositoryRoot, '.github/workflows/kyangc-release.yml'), 'utf8'),
  ]);

  for (const workflow of [backendWorkflow, releaseWorkflow]) {
    assert.match(workflow, /--target backend --tag local\/opencli-backend:2\.0\.1\.1/);
    assert.match(workflow, /--target chromium --tag local\/opencli-chromium:2\.0\.0\.1/);
    assert.match(workflow, /services\/opencli-backend\/scripts\/smoke-compose\.sh 2\.0\.1 2\.0\.0/);
  }
});
