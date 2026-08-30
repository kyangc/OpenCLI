import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const execFileAsync = promisify(execFile);

function publicCommand(command, sessionCheckAvailable) {
  return {
    site: command.site,
    command: command.name,
    description: command.description ?? '',
    access: command.access,
    browser: command.browser,
    siteSession: command.siteSession,
    strategy: command.strategy ?? null,
    domain: command.domain ?? null,
    example: command.example ?? null,
    columns: Array.isArray(command.columns) ? command.columns : [],
    sessionCheckAvailable,
    args: command.args,
  };
}

function searchScore(command, query) {
  const tokens = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return 0;
  const name = command.name.toLocaleLowerCase();
  const site = command.site.toLocaleLowerCase();
  const description = (command.description ?? '').toLocaleLowerCase();
  const domain = (command.domain ?? '').toLocaleLowerCase();
  const searchable = `${site} ${name} ${description} ${domain}`;
  if (!tokens.every((token) => searchable.includes(token))) return -1;
  let score = 0;
  for (const token of tokens) {
    if (name === token) score += 100;
    else if (name.startsWith(token)) score += 50;
    else if (name.includes(token)) score += 30;
    if (site === token) score += 40;
    else if (site.includes(token)) score += 20;
    if (description.includes(token)) score += 10;
    if (domain.includes(token)) score += 5;
  }
  return score;
}

export class CommandCatalog {
  constructor(commands, { autoAllowReads = true, explicitAllowedCommands = new Set() } = {}) {
    if (!Array.isArray(commands)) throw new Error('OpenCLI command catalog must be an array');
    this.commands = new Map();
    for (const command of commands) {
      const name = typeof command?.name === 'string'
        && typeof command?.site === 'string'
        && command.name.startsWith(`${command.site}/`)
        ? command.name.slice(command.site.length + 1)
        : command?.name;
      if (
        !command
        || !NAME_PATTERN.test(command.site)
        || !NAME_PATTERN.test(name)
        || !['read', 'write'].includes(command.access)
      ) continue;
      const key = `${command.site}.${name}`;
      if (!autoAllowReads && !explicitAllowedCommands.has(key)) continue;
      if (command.access !== 'read' && !explicitAllowedCommands.has(key)) continue;
      this.commands.set(key, {
        ...command,
        name,
        browser: command.browser === true,
        siteSession: command.siteSession ?? null,
        args: Array.isArray(command.args) ? command.args : [],
      });
    }
  }

  get size() {
    return this.commands.size;
  }

  get hasWriteCommands() {
    return [...this.commands.values()].some((command) => command.access === 'write');
  }

  get(site, command) {
    return this.commands.get(`${site}.${command}`) ?? null;
  }

  list({ site = null, query = '', offset = 0, limit = 100 } = {}) {
    const commands = [...this.commands.values()]
      .filter((command) => site === null || command.site === site)
      .map((command) => ({ command, score: searchScore(command, query) }))
      .filter(({ score }) => score >= 0)
      .sort((left, right) => (
        right.score - left.score
        || `${left.command.site}.${left.command.name}`.localeCompare(
          `${right.command.site}.${right.command.name}`,
        )
      ));
    return {
      total: commands.length,
      query,
      offset,
      limit,
      commands: commands.slice(offset, offset + limit).map(({ command }) => publicCommand(
        command,
        this.commands.has(`${command.site}.whoami`),
      )),
    };
  }

  describe(site, command) {
    const definition = this.get(site, command);
    return definition ? publicCommand(definition, this.commands.has(`${site}.whoami`)) : null;
  }

  schedulingFor(request) {
    const definition = this.get(request.site, request.command);
    if (!definition || definition.access !== 'read') {
      return { resourceKey: null, exclusive: true };
    }
    if (!definition.browser || definition.siteSession === null || definition.siteSession === 'ephemeral') {
      return { resourceKey: null, exclusive: false };
    }
    if (definition.siteSession === 'persistent') {
      const profile = request.profile ?? 'default';
      return { resourceKey: `profile:${profile}:site:${definition.site}`, exclusive: false };
    }
    return { resourceKey: null, exclusive: true };
  }
}

export async function loadCommandCatalog(binary, {
  run = execFileAsync,
  autoAllowReads = true,
  explicitAllowedCommands = new Set(),
} = {}) {
  let stdout;
  try {
    ({ stdout } = await run(binary, ['list', '-f', 'json'], {
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
    }));
  } catch (error) {
    throw new Error(`failed to load OpenCLI command catalog: ${error instanceof Error ? error.message : String(error)}`);
  }
  let commands;
  try {
    commands = JSON.parse(stdout);
  } catch {
    throw new Error('OpenCLI command catalog is not valid JSON');
  }
  return new CommandCatalog(commands, { autoAllowReads, explicitAllowedCommands });
}
