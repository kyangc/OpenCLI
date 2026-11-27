import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJsonOutput, runCli } from './helpers.js';

describe('offline adapter CLI contracts', () => {
  it('paperreview submit dry-run validates a local PDF without remote upload', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencli-paperreview-'));
    try {
      const pdfPath = path.join(tempDir, 'sample.pdf');
      await fs.writeFile(pdfPath, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(256, 1)]));

      const { stdout, code } = await runCli([
        'paperreview',
        'submit',
        pdfPath,
        '--email',
        'test@example.com',
        '--venue',
        'RAL',
        '--dry-run',
        'true',
        '-f',
        'json',
      ]);

      expect(code).toBe(0);
      const data = parseJsonOutput(stdout);
      expect(data).toMatchObject({
        status: 'dry-run',
        file: 'sample.pdf',
        email: 'test@example.com',
        venue: 'RAL',
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('yollomi models returns model list with all types', async () => {
    const { stdout, code } = await runCli(['yollomi', 'models', '-f', 'json']);
    expect(code).toBe(0);
    const data = parseJsonOutput(stdout);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(10);
    expect(data[0]).toHaveProperty('type');
    expect(data[0]).toHaveProperty('model');
    expect(data[0]).toHaveProperty('credits');
    expect(data[0]).toHaveProperty('description');
    const types = new Set(data.map((d: any) => d.type));
    expect(types.has('image')).toBe(true);
    expect(types.has('video')).toBe(true);
    expect(types.has('tool')).toBe(true);
  }, 30_000);

  it('yollomi models --type image filters correctly', async () => {
    const { stdout, code } = await runCli(['yollomi', 'models', '--type', 'image', '-f', 'json']);
    expect(code).toBe(0);
    const data = parseJsonOutput(stdout);
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((d: any) => d.type === 'image')).toBe(true);
  }, 30_000);

  it('hot-reloads a modified lazy user adapter inside a real Node ESM process', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencli-e2e-hot-reload-'));
    try {
      const siteDir = path.join(tempDir, 'demo');
      const modulePath = path.join(siteDir, 'ping.js');
      await fs.mkdir(siteDir, { recursive: true });
      const registryUrl = pathToFileURL(path.resolve('dist/src/registry.js')).href;
      const executionUrl = pathToFileURL(path.resolve('dist/src/execution.js')).href;

      await fs.writeFile(modulePath, `
import { cli, Strategy } from ${JSON.stringify(registryUrl)};
export default cli({
  site: 'e2e-hot',
  name: 'ping',
  access: 'read',
  browser: false,
  strategy: Strategy.PUBLIC,
  func: async () => [{ version: 1 }],
});
`);

      const script = `
import * as fs from 'node:fs/promises';
import { executeCommand } from ${JSON.stringify(executionUrl)};
import { Strategy } from ${JSON.stringify(registryUrl)};

const lazyCmd = {
  site: 'e2e-hot',
  name: 'ping',
  access: 'read',
  description: 'hot reload e2e',
  browser: false,
  strategy: Strategy.PUBLIC,
  args: [],
  _lazy: true,
  _modulePath: ${JSON.stringify(modulePath)},
};

const first = await executeCommand(lazyCmd, {});
await fs.writeFile(${JSON.stringify(modulePath)}, \`
import { cli, Strategy } from ${JSON.stringify(registryUrl)};
export default cli({
  site: 'e2e-hot',
  name: 'ping',
  access: 'read',
  browser: false,
  strategy: Strategy.PUBLIC,
  func: async () => [{ version: 2 }],
});
\`);
const next = new Date(Date.now() + 5000);
await fs.utimes(${JSON.stringify(modulePath)}, next, next);
const second = await executeCommand(lazyCmd, {});
console.log(JSON.stringify({ first, second }));
`;

      const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, OPENCLI_USER_CLIS_DIR: tempDir },
        encoding: 'utf-8',
      });
      expect(JSON.parse(raw)).toEqual({
        first: [{ version: 1 }],
        second: [{ version: 2 }],
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
});
