import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { cli, getRegistry, Strategy } from '../registry.js';
import { registerListCommand } from './list.js';

const registry = getRegistry();
let saved: Map<string, ReturnType<typeof cli>>;

beforeEach(() => {
  saved = new Map(registry);
  registry.clear();
});
afterEach(() => {
  registry.clear();
  for (const [key, command] of saved) registry.set(key, command);
  vi.restoreAllMocks();
});

async function list(...args: string[]) {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const program = new Command().exitOverride();
  registerListCommand(program);
  await program.parseAsync(['node', 'opencli', 'list', ...args]);
  return JSON.parse(String(output.mock.calls.at(-1)?.[0]));
}

describe('list --full catalog export', () => {
  it('exports every unique adapter and complete argument metadata beyond the default page', async () => {
    for (let index = 0; index < 30; index++) {
      cli({
        site: 'catalog', name: `read-${index}`, aliases: [`alias-${index}`],
        description: 'Read catalog data', access: 'read', browser: true,
        strategy: Strategy.PUBLIC, siteSession: 'persistent', domain: 'catalog.test',
        args: [{ name: 'query', positional: true, required: true, help: 'Search query' }],
        columns: ['title'],
      });
    }
    const result = await list('--full', '-f', 'json');
    expect(result.ok).toBe(true);
    expect(result.data).toHaveLength(30);
    expect(result.data[0]).toMatchObject({
      command: 'catalog/read-0', site: 'catalog', name: 'read-0', aliases: ['alias-0'],
      access: 'read', browser: true, domain: 'catalog.test', siteSession: 'persistent',
      args: [{ name: 'query', type: 'string', positional: true, required: true, help: 'Search query' }],
      columns: ['title'],
    });
    expect(result.data.some((row: { command: string }) => row.command === 'list')).toBe(false);
  });

  it('applies site and text filters while keeping the summary list paginated by default', async () => {
    for (const site of ['first', 'second']) {
      for (const name of ['read', 'write']) {
        cli({ site, name, description: `${name} data`, access: name === 'read' ? 'read' : 'write', strategy: Strategy.PUBLIC });
      }
    }
    expect((await list('read', '--site', 'second', '--full')).data).toEqual([
      expect.objectContaining({ command: 'second/read', site: 'second', args: [] }),
    ]);
    const summary = (await list('--site', 'first', '--limit', '1')).data;
    expect(summary).toEqual({ total: 2, nextOffset: 1, commands: [
      { command: 'first read', description: 'read data', access: 'read' },
    ] });
  });
});
