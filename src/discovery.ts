/**
 * CLI discovery: finds JS CLI definitions and registers them.
 *
 * Supports two modes:
 * 1. FAST PATH (manifest): If a pre-compiled cli-manifest.json exists,
 *    registers commands instantly. JS modules are loaded lazily only
 *    when their command is executed.
 * 2. FALLBACK (filesystem scan): Traditional runtime discovery for development.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { type CliCommand, type InternalCliCommand, Strategy, getRegistry, registerCommand } from './registry.js';
import { getErrorMessage } from './errors.js';
import { log } from './logger.js';
import type { ManifestEntry } from './manifest-types.js';
import { findPackageRoot, getCliManifestPath } from './package-paths.js';
import { linkHostOpencli, resolveHostOpencliRoot } from './plugin-runtime.js';
import { PKG_VERSION } from './version.js';

/** User runtime directory: ~/.opencli */
export const USER_OPENCLI_DIR = path.join(os.homedir(), '.opencli');
/** User CLIs directory: ~/.opencli/clis */
export const USER_CLIS_DIR = path.join(USER_OPENCLI_DIR, 'clis');
/** Plugins directory: ~/.opencli/plugins/ */
export const PLUGINS_DIR = path.join(USER_OPENCLI_DIR, 'plugins');
/** Matches files that register commands via cli() or lifecycle hooks */
const PLUGIN_MODULE_PATTERN = /\b(?:cli|registerSiteAuthCommands|onStartup|onBeforeExecute|onAfterExecute)\s*\(/;
const EAGER_HOOK_PATTERN = /\b(?:onStartup|onBeforeExecute|onAfterExecute)\s*\(/;
const RELATIVE_REEXPORT_OR_IMPORT_RE = /\b(?:import|export)\b[^;'"]*?\bfrom\s*['"](\.[^'"]+)['"]/g;
const YAML_ADAPTER_EXT_RE = /\.ya?ml$/i;
const warnedYamlAdapterPaths = new Set<string>();
const cliModuleLoadResults = new Map<string, Promise<boolean>>();

export interface DiscoverClisOptions {
  skipYamlWarnings?: boolean;
  cacheFile?: string;
}

interface UserCliCacheFile {
  version: 1;
  pkgVersion: string;
  fingerprint: string;
  entries: ManifestEntry[];
  eagerFiles: string[];
}

function parseStrategy(rawStrategy: string | undefined, fallback: Strategy = Strategy.COOKIE): Strategy {
  if (!rawStrategy) return fallback;
  const key = rawStrategy.toUpperCase() as keyof typeof Strategy;
  return Strategy[key] ?? fallback;
}

const PACKAGE_ROOT = findPackageRoot(fileURLToPath(import.meta.url));

/**
 * Ensure ~/.opencli/node_modules/@jackwener/opencli symlink exists so that
 * user CLIs in ~/.opencli/clis/ can `import { cli } from '@jackwener/opencli/registry'`.
 *
 * This is the sole resolution mechanism — adapters use package exports
 * (e.g. `@jackwener/opencli/registry`, `@jackwener/opencli/errors`) and
 * Node.js resolves them through this symlink.
 */
export async function ensureUserCliCompatShims(baseDir: string = USER_OPENCLI_DIR): Promise<void> {
  await fs.promises.mkdir(baseDir, { recursive: true });

  // package.json for ESM resolution in ~/.opencli/
  const pkgJsonPath = path.join(baseDir, 'package.json');
  const pkgJsonContent = `${JSON.stringify({ name: 'opencli-user-runtime', private: true, type: 'module' }, null, 2)}\n`;
  try {
    const existing = await fs.promises.readFile(pkgJsonPath, 'utf-8');
    if (existing !== pkgJsonContent) await fs.promises.writeFile(pkgJsonPath, pkgJsonContent, 'utf-8');
  } catch {
    await fs.promises.writeFile(pkgJsonPath, pkgJsonContent, 'utf-8');
  }

  // Create node_modules/@jackwener/opencli symlink pointing to the installed package root.
  const opencliRoot = PACKAGE_ROOT;
  const symlinkDir = path.join(baseDir, 'node_modules', '@jackwener');
  const symlinkPath = path.join(symlinkDir, 'opencli');
  try {
    let needsUpdate = true;
    try {
      const existing = await fs.promises.readlink(symlinkPath);
      if (existing === opencliRoot) needsUpdate = false;
    } catch { /* doesn't exist */ }
    if (needsUpdate) {
      await fs.promises.mkdir(symlinkDir, { recursive: true });
      try { await fs.promises.rm(symlinkPath, { recursive: true, force: true }); } catch { /* doesn't exist */ }
      const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
      await fs.promises.symlink(opencliRoot, symlinkPath, symlinkType);
    }
  } catch (err) {
    log.warn(`Could not create symlink at ${symlinkPath}: ${getErrorMessage(err)}`);
  }
}

/**
 * Ensure the user adapters directory exists.
 *
 * With smart sync, ~/.opencli/clis/ only holds files that differ from the
 * package baseline (upstream-synced cache + autofix output + user overrides).
 * Built-in adapters are loaded directly from the installed package.
 */
export async function ensureUserAdapters(): Promise<void> {
  await fs.promises.mkdir(USER_CLIS_DIR, { recursive: true });
}

/**
 * Discover and register CLI commands.
 * Uses pre-compiled manifest when available for instant startup.
 */
export async function discoverClis(...dirs: string[]): Promise<void> {
  return discoverClisWithOptions(dirs);
}

export async function discoverClisWithOptions(
  dirs: string[],
  opts: DiscoverClisOptions = {},
): Promise<void> {
  // Fast path: try manifest first (production / post-build)
  for (const dir of dirs) {
    const manifestPath = getCliManifestPath(dir);
    try {
      await fs.promises.access(manifestPath);
      const loaded = await loadFromManifest(manifestPath, dir);
      if (loaded) {
        if (!opts.skipYamlWarnings) {
          await warnIgnoredYamlAdaptersInCliRoot(dir, loaded.manifestFiles);
        }
        continue; // Skip filesystem scan only when manifest is usable
      }
    } catch {
      // Fall through to filesystem scan
    }
    await discoverClisFromFs(dir, opts);
  }
}

function registerManifestEntry(entry: ManifestEntry, clisDir: string): string {
  const modulePath = path.resolve(clisDir, entry.modulePath!);
  const cmd: InternalCliCommand = {
    site: entry.site,
    name: entry.name,
    aliases: entry.aliases,
    description: entry.description ?? '',
    access: entry.access,
    example: entry.example,
    domain: entry.domain,
    strategy: parseStrategy(entry.strategy),
    browser: entry.browser,
    args: entry.args ?? [],
    columns: entry.columns,
    defaultFormat: entry.defaultFormat,
    pipeline: entry.pipeline,
    source: entry.sourceFile ? path.resolve(clisDir, entry.sourceFile) : modulePath,
    navigateBefore: entry.navigateBefore,
    siteSession: entry.siteSession,
    defaultWindowMode: entry.defaultWindowMode,
    _lazy: true,
    _modulePath: modulePath,
  };
  // normalizeCommand inside registerCommand handles strategy → browser/navigateBefore
  registerCommand(cmd);
  return modulePath;
}

/**
 * Fast-path: register commands from pre-compiled manifest.
 * TS modules are deferred — loaded lazily on first execution.
 */
async function loadFromManifest(manifestPath: string, clisDir: string): Promise<{ manifestFiles: Set<string> } | null> {
  try {
    const raw = await fs.promises.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as ManifestEntry[];
    const manifestFiles = new Set<string>();
    for (const entry of manifest) {
      if (!entry.modulePath) continue;
      const modulePath = registerManifestEntry(entry, clisDir);
      manifestFiles.add(modulePath);
      if (entry.sourceFile) manifestFiles.add(path.resolve(clisDir, entry.sourceFile));
    }
    return { manifestFiles };
  } catch (err) {
    log.warn(`Failed to load manifest ${manifestPath}: ${getErrorMessage(err)}`);
    return null;
  }
}

function toUserCacheManifestEntry(cmd: CliCommand, relPath: string): ManifestEntry {
  return {
    site: cmd.site,
    name: cmd.name,
    aliases: cmd.aliases,
    description: cmd.description ?? '',
    access: cmd.access,
    example: cmd.example,
    domain: cmd.domain,
    strategy: (cmd.strategy ?? Strategy.COOKIE).toString().toLowerCase(),
    browser: cmd.browser ?? true,
    args: cmd.args.map((arg) => ({
      name: arg.name,
      type: arg.type ?? 'str',
      default: arg.default,
      required: !!arg.required,
      valueRequired: !!arg.valueRequired || undefined,
      positional: arg.positional || undefined,
      help: arg.help ?? '',
      choices: arg.choices,
    })),
    columns: cmd.columns,
    pipeline: cmd.pipeline,
    defaultFormat: cmd.defaultFormat,
    type: 'js',
    modulePath: relPath,
    sourceFile: relPath,
    navigateBefore: cmd.navigateBefore,
    siteSession: cmd.siteSession,
    defaultWindowMode: cmd.defaultWindowMode,
  };
}

interface ScannedJsCandidate {
  relPath: string;
  filePath: string;
  mtimeMs: number;
  size: number;
  source?: string;
  isCli: boolean;
  deps: Array<[string, number, number]>;
}

async function collectRelativeImportDeps(baseDir: string, source: string): Promise<Array<[string, number, number]>> {
  const deps: Array<[string, number, number]> = [];
  for (const match of source.matchAll(RELATIVE_REEXPORT_OR_IMPORT_RE)) {
    const targetPath = path.resolve(baseDir, match[1]);
    try {
      const depStat = await fs.promises.stat(targetPath);
      deps.push([targetPath, depStat.mtimeMs, depStat.size]);
    } catch {
      deps.push([targetPath, -1, -1]);
    }
  }
  deps.sort((a, b) => a[0].localeCompare(b[0]));
  return deps;
}

async function scanUserJsCandidates(dir: string, entries: fs.Dirent[]): Promise<ScannedJsCandidate[]> {
  const siteDirs = entries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const candidates: ScannedJsCandidate[] = [];
  await Promise.all(siteDirs.map(async (entry) => {
    const siteDir = path.join(dir, entry.name);
    const files = (await fs.promises.readdir(siteDir)).sort();
    await Promise.all(files.map(async (file) => {
      if (!file.endsWith('.js') || file.endsWith('.d.js') || file.endsWith('.test.js')) return;
      const filePath = path.join(siteDir, file);
      const relPath = `${entry.name}/${file}`;
      try {
        const [stat, source] = await Promise.all([
          fs.promises.stat(filePath),
          fs.promises.readFile(filePath, 'utf-8'),
        ]);
        const isCli = PLUGIN_MODULE_PATTERN.test(source);
        const deps = isCli ? await collectRelativeImportDeps(siteDir, source) : [];
        candidates.push({ relPath, filePath, mtimeMs: stat.mtimeMs, size: stat.size, source, isCli, deps });
      } catch {
        // Ignore transient/unreadable files; regular scan handles errors.
      }
    }));
  }));
  candidates.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return candidates;
}

function buildUserCacheFingerprint(candidates: readonly ScannedJsCandidate[]): string {
  return JSON.stringify(candidates.map((c) => [c.relPath, c.mtimeMs, c.size, c.isCli ? 1 : 0, c.deps]));
}

async function readValidUserCliCache(cacheFile: string, fingerprint: string): Promise<UserCliCacheFile | null> {
  try {
    const raw = await fs.promises.readFile(cacheFile, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<UserCliCacheFile>;
    if (
      parsed
      && parsed.version === 1
      && parsed.pkgVersion === PKG_VERSION
      && parsed.fingerprint === fingerprint
      && Array.isArray(parsed.entries)
      && Array.isArray(parsed.eagerFiles)
    ) {
      return parsed as UserCliCacheFile;
    }
  } catch {
    // Cache miss or corrupt cache
  }
  return null;
}

async function writeUserCliCache(cacheFile: string, cache: UserCliCacheFile): Promise<void> {
  try {
    const dir = path.dirname(cacheFile);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmpFile = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tmpFile, JSON.stringify(cache), { encoding: 'utf-8', mode: 0o600 });
    await fs.promises.rename(tmpFile, cacheFile);
  } catch {
    // Best-effort cache write
  }
}

/**
 * Fallback: traditional filesystem scan (used during development with tsx, or user clis).
 */
async function discoverClisFromFs(dir: string, opts: DiscoverClisOptions = {}): Promise<void> {
  try { await fs.promises.access(dir); } catch { return; }
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  if (!opts.skipYamlWarnings) {
    await warnIgnoredYamlAdaptersInCliRoot(dir);
  }

  if (opts.cacheFile) {
    const candidates = await scanUserJsCandidates(dir, entries);
    if (candidates.length === 0) return;
    const fingerprint = buildUserCacheFingerprint(candidates);
    const cached = await readValidUserCliCache(opts.cacheFile, fingerprint);
    if (cached) {
      for (const entry of cached.entries) {
        if (!entry.modulePath) continue;
        registerManifestEntry(entry, dir);
      }
      await Promise.all(cached.eagerFiles.map((relPath) =>
        import(pathToFileURL(path.resolve(dir, relPath)).href).catch((err) => {
          log.warn(`Failed to load module ${path.resolve(dir, relPath)}: ${getErrorMessage(err)}`);
        }),
      ));
      return;
    }

    const cacheEntries: ManifestEntry[] = [];
    const eagerFiles: string[] = [];
    let hadLoadError = false;
    const registry = getRegistry();
    for (const candidate of candidates) {
      if (!candidate.isCli) continue;
      const before = new Map(registry.entries());
      let importedOk = true;
      await import(pathToFileURL(candidate.filePath).href).catch((err) => {
        importedOk = false;
        hadLoadError = true;
        log.warn(`Failed to load module ${candidate.filePath}: ${getErrorMessage(err)}`);
      });
      if (!importedOk) continue;

      const addedCmds: CliCommand[] = [];
      const seenCmds = new Set<CliCommand>();
      for (const [key, cmd] of registry.entries()) {
        if (seenCmds.has(cmd)) continue;
        const prev = before.get(key);
        if (!prev || prev !== cmd) {
          seenCmds.add(cmd);
          addedCmds.push(cmd);
        }
      }
      const isEager = EAGER_HOOK_PATTERN.test(candidate.source ?? '')
        || addedCmds.some((cmd) => (
          typeof cmd.validateArgs === 'function'
          || typeof cmd.footerExtra === 'function'
          || cmd.authStatus !== undefined
        ));
      if (isEager) {
        eagerFiles.push(candidate.relPath);
      } else {
        for (const cmd of addedCmds) {
          cacheEntries.push(toUserCacheManifestEntry(cmd, candidate.relPath));
        }
      }
    }
    if (!hadLoadError) {
      await writeUserCliCache(opts.cacheFile, {
        version: 1,
        pkgVersion: PKG_VERSION,
        fingerprint,
        entries: cacheEntries,
        eagerFiles,
      });
    }
    return;
  }

  const sitePromises = entries
    .filter(entry => entry.isDirectory())
    .map(async (entry) => {
      const site = entry.name;
      const siteDir = path.join(dir, site);
      const files = await fs.promises.readdir(siteDir);
      await Promise.all(files.map(async (file) => {
        const filePath = path.join(siteDir, file);
        if (isYamlAdapterFile(file)) {
          return;
        }
        if (file.endsWith('.ts') && !file.endsWith('.d.ts') && !file.endsWith('.test.ts')) {
          log.warn(`Ignoring TypeScript adapter ${filePath} — .ts adapters are no longer loaded. Rename to .js or convert to JavaScript.`);
          return;
        }
        if (file.endsWith('.js') && !file.endsWith('.d.js') && !file.endsWith('.test.js')) {
          if (!(await isCliModule(filePath))) return;
          await import(pathToFileURL(filePath).href).catch((err) => {
            log.warn(`Failed to load module ${filePath}: ${getErrorMessage(err)}`);
          });
        }
      }));
    });
  await Promise.all(sitePromises);
}

/**
 * Discover and register plugins from ~/.opencli/plugins/.
 * Each subdirectory is treated as a plugin (site = directory name).
 * Files inside are scanned flat (no nested site subdirs).
 */
export async function discoverPlugins(
  pluginRoot: string = PLUGINS_DIR,
  opts: { cacheFile?: string } = {},
): Promise<void> {
  try { await fs.promises.access(pluginRoot); } catch { return; }
  const entries = (await fs.promises.readdir(pluginRoot, { withFileTypes: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const discoverable = (await Promise.all(entries.map(async (entry) => {
    const pluginDir = path.join(pluginRoot, entry.name);
    return (await isDiscoverablePluginDir(entry, pluginDir)) ? { entry, pluginDir } : null;
  }))).filter((item): item is { entry: fs.Dirent; pluginDir: string } => item !== null);

  const yamlWarnings = await Promise.all(discoverable.map(({ entry, pluginDir }) =>
    collectIgnoredYamlAdaptersWarning(pluginDir, { owner: `plugin ${entry.name}`, pluginMode: true }),
  ));
  for (const warning of yamlWarnings) {
    if (warning) log.warn(warning);
  }

  if (opts.cacheFile) {
    const pluginFilesByDir = await Promise.all(discoverable.map(async ({ entry, pluginDir }) => {
      const files = (await fs.promises.readdir(pluginDir)).sort();
      const fileSet = new Set(files);
      const jsCandidates: ScannedJsCandidate[] = [];
      await Promise.all(files.map(async (file) => {
        if (isYamlAdapterFile(file)) return;
        if (file.endsWith('.ts') && !file.endsWith('.d.ts') && !file.endsWith('.test.ts')) {
          const jsFile = file.replace(/\.ts$/, '.js');
          if (!fileSet.has(jsFile)) {
            log.warn(
              `Plugin ${entry.name}/${file}: no compiled .js found. ` +
              `Run "opencli plugin update ${entry.name}" to re-transpile, or install esbuild.`,
            );
          }
          return;
        }
        if (!file.endsWith('.js') || file.endsWith('.d.js')) return;
        const filePath = path.join(pluginDir, file);
        const relPath = `${entry.name}/${file}`;
        try {
          const [stat, source] = await Promise.all([
            fs.promises.stat(filePath),
            fs.promises.readFile(filePath, 'utf-8'),
          ]);
          const isCli = PLUGIN_MODULE_PATTERN.test(source);
          const deps = isCli ? await collectRelativeImportDeps(pluginDir, source) : [];
          jsCandidates.push({ relPath, filePath, mtimeMs: stat.mtimeMs, size: stat.size, source, isCli, deps });
        } catch {
          // Ignore transient/unreadable files
        }
      }));
      jsCandidates.sort((a, b) => a.relPath.localeCompare(b.relPath));
      return { entry, pluginDir, jsCandidates };
    }));

    const allCandidates = pluginFilesByDir.flatMap((d) => d.jsCandidates);
    if (allCandidates.length === 0) return;

    let hostRoot = PACKAGE_ROOT;
    try { hostRoot = resolveHostOpencliRoot(); } catch { /* fallback */ }
    const fingerprint = JSON.stringify({
      hostRoot,
      files: allCandidates.map((c) => [c.relPath, c.mtimeMs, c.size, c.isCli ? 1 : 0, c.deps]),
    });
    const cached = await readValidUserCliCache(opts.cacheFile, fingerprint);
    if (cached) {
      for (const entry of cached.entries) {
        if (!entry.modulePath) continue;
        registerManifestEntry(entry, pluginRoot);
      }
      if (cached.eagerFiles.length > 0) {
        const linkedDirs = new Set<string>();
        await Promise.all(cached.eagerFiles.map(async (relPath) => {
          const pluginName = relPath.split('/')[0];
          const pluginDir = path.join(pluginRoot, pluginName);
          if (!linkedDirs.has(pluginDir)) {
            linkedDirs.add(pluginDir);
            if (!linkHostOpencli(pluginDir)) {
              log.warn(`Skipping plugin ${pluginName} because its host package could not be linked.`);
              return;
            }
          }
          await import(pathToFileURL(path.resolve(pluginRoot, relPath)).href).catch((err) => {
            log.warn(`Plugin ${relPath}: ${getErrorMessage(err)}`);
          });
        }));
      }
      return;
    }

    const cacheEntries: ManifestEntry[] = [];
    const eagerFiles: string[] = [];
    let hadLoadError = false;
    const registry = getRegistry();

    for (const { entry, pluginDir, jsCandidates } of pluginFilesByDir) {
      const cliCandidates = jsCandidates.filter((c) => c.isCli);
      if (cliCandidates.length === 0) continue;
      if (!linkHostOpencli(pluginDir)) {
        log.warn(`Skipping plugin ${entry.name} because its host package could not be linked.`);
        hadLoadError = true;
        continue;
      }
      for (const candidate of cliCandidates) {
        const before = new Map(registry.entries());
        let importedOk = true;
        await import(pathToFileURL(candidate.filePath).href).catch((err) => {
          importedOk = false;
          hadLoadError = true;
          log.warn(`Plugin ${candidate.relPath}: ${getErrorMessage(err)}`);
        });
        if (!importedOk) continue;

        const addedCmds: CliCommand[] = [];
        const seenCmds = new Set<CliCommand>();
        for (const [key, cmd] of registry.entries()) {
          if (seenCmds.has(cmd)) continue;
          const prev = before.get(key);
          if (!prev || prev !== cmd) {
            seenCmds.add(cmd);
            addedCmds.push(cmd);
          }
        }
        const isEager = EAGER_HOOK_PATTERN.test(candidate.source ?? '')
          || addedCmds.some((cmd) => (
            typeof cmd.validateArgs === 'function'
            || typeof cmd.footerExtra === 'function'
            || cmd.authStatus !== undefined
          ));
        if (isEager) {
          eagerFiles.push(candidate.relPath);
        } else {
          for (const cmd of addedCmds) {
            cacheEntries.push(toUserCacheManifestEntry(cmd, candidate.relPath));
          }
        }
      }
    }

    if (!hadLoadError) {
      await writeUserCliCache(opts.cacheFile, {
        version: 1,
        pkgVersion: PKG_VERSION,
        fingerprint,
        entries: cacheEntries,
        eagerFiles,
      });
    }
    return;
  }

  await Promise.all(discoverable.map(async ({ entry, pluginDir }) => {
    if (!linkHostOpencli(pluginDir)) {
      log.warn(`Skipping plugin ${entry.name} because its host package could not be linked.`);
      return;
    }
    await discoverPluginDir(pluginDir, entry.name);
  }));
}

/**
 * Flat scan: read ts/js files directly in a plugin directory.
 * Unlike discoverClisFromFs, this does NOT expect nested site subdirectories.
 */
async function discoverPluginDir(dir: string, site: string): Promise<void> {
  const files = await fs.promises.readdir(dir);
  const fileSet = new Set(files);
  await Promise.all(files.map(async (file) => {
    const filePath = path.join(dir, file);
    if (isYamlAdapterFile(file)) {
      return;
    }
    if (file.endsWith('.js') && !file.endsWith('.d.js')) {
      if (!(await isCliModule(filePath))) return;
      await import(pathToFileURL(filePath).href).catch((err) => {
        log.warn(`Plugin ${site}/${file}: ${getErrorMessage(err)}`);
      });
    } else if (
      file.endsWith('.ts') && !file.endsWith('.d.ts') && !file.endsWith('.test.ts')
    ) {
      const jsFile = file.replace(/\.ts$/, '.js');
      // Prefer compiled .js — skip the .ts source file
      if (fileSet.has(jsFile)) return;
      // No compiled .js found — cannot import raw .ts in production Node.js.
      // This typically means esbuild transpilation failed during plugin install.
      log.warn(
        `Plugin ${site}/${file}: no compiled .js found. ` +
        `Run "opencli plugin update ${site}" to re-transpile, or install esbuild.`
      );
    }
  }));
}

async function warnIgnoredYamlAdaptersInCliRoot(dir: string, manifestFiles?: Set<string>): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const dirs = entries
    .filter((candidate) => candidate.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const messages = await Promise.all(dirs.map(async (entry) => {
    const siteDir = path.join(dir, entry.name);
    return collectIgnoredYamlAdaptersWarning(siteDir, { owner: `site ${entry.name}`, manifestFiles });
  }));
  for (const message of messages) {
    if (message) log.warn(message);
  }
}

async function warnIgnoredYamlAdaptersInFlatDir(
  dir: string,
  options: { owner: string; manifestFiles?: Set<string>; pluginMode?: boolean },
): Promise<void> {
  const message = await collectIgnoredYamlAdaptersWarning(dir, options);
  if (message) log.warn(message);
}

async function collectIgnoredYamlAdaptersWarning(
  dir: string,
  options: { owner: string; manifestFiles?: Set<string>; pluginMode?: boolean },
): Promise<string | null> {
  let files: string[];
  try {
    files = await fs.promises.readdir(dir);
  } catch (err) {
    log.warn(`Could not inspect YAML adapters for ${options.owner}: ${getErrorMessage(err)}`);
    return null;
  }

  const fileSet = new Set(files);
  const ignored: string[] = [];
  for (const file of files.filter(isYamlAdapterFile).sort()) {
    const filePath = path.join(dir, file);
    if (!(await isLikelyYamlAdapter(filePath, options.pluginMode === true))) continue;
    if (await hasUsableJsReplacement(dir, file, fileSet, options.manifestFiles)) continue;
    const warningKey = await stableWarningKey(filePath);
    if (warnedYamlAdapterPaths.has(warningKey)) continue;
    warnedYamlAdapterPaths.add(warningKey);
    ignored.push(file);
  }

  if (ignored.length === 0) return null;
  return (
    `Ignoring ${ignored.length} YAML adapter${ignored.length === 1 ? '' : 's'} for ${options.owner}: `
    + `${ignored.join(', ')}. .yaml/.yml adapters are no longer loaded; convert them to .js with the cli() API.`
  );
}

function isYamlAdapterFile(file: string): boolean {
  return YAML_ADAPTER_EXT_RE.test(file);
}

async function hasUsableJsReplacement(
  dir: string,
  yamlFile: string,
  fileSet: Set<string>,
  manifestFiles?: Set<string>,
): Promise<boolean> {
  const jsFile = yamlFile.replace(YAML_ADAPTER_EXT_RE, '.js');
  if (!fileSet.has(jsFile)) return false;

  const jsPath = path.resolve(dir, jsFile);
  if (manifestFiles) return manifestFiles.has(jsPath);
  return loadCliModule(jsPath);
}

async function isLikelyYamlAdapter(filePath: string, pluginMode: boolean): Promise<boolean> {
  let source: string;
  try {
    source = await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    return !pluginMode;
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(source);
  } catch {
    return !pluginMode;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  if (typeof record.name !== 'string' || !record.name.trim()) return false;

  const adapterKeys = [
    'site', 'description', 'access', 'strategy', 'browser', 'domain',
    'args', 'columns', 'pipeline', 'url', 'request', 'steps', 'extract',
    'output', 'func', 'method', 'headers',
  ];
  return adapterKeys.some((key) => key in record);
}

async function stableWarningKey(filePath: string): Promise<string> {
  try {
    return await fs.promises.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

async function cliModuleCacheKey(filePath: string): Promise<string> {
  const resolved = await stableWarningKey(filePath);
  try {
    const stat = await fs.promises.stat(filePath);
    return `${resolved}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return resolved;
  }
}

async function loadCliModule(filePath: string): Promise<boolean> {
  const key = await cliModuleCacheKey(filePath);
  let result = cliModuleLoadResults.get(key);
  if (!result) {
    result = (async () => {
      if (!(await isCliModule(filePath))) return false;
      try {
        await import(pathToFileURL(filePath).href);
        return true;
      } catch (err) {
        log.warn(`Failed to load module ${filePath}: ${getErrorMessage(err)}`);
        return false;
      }
    })();
    cliModuleLoadResults.set(key, result);
  }
  return result;
}

async function isCliModule(filePath: string): Promise<boolean> {
  try {
    const source = await fs.promises.readFile(filePath, 'utf-8');
    return PLUGIN_MODULE_PATTERN.test(source);
  } catch (err) {
    log.warn(`Failed to inspect module ${filePath}: ${getErrorMessage(err)}`);
    return false;
  }
}

async function isDiscoverablePluginDir(entry: fs.Dirent, pluginDir: string): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;

  try {
    return (await fs.promises.stat(pluginDir)).isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      log.warn(`Failed to inspect plugin link ${pluginDir}: ${getErrorMessage(err)}`);
    }
    return false;
  }
}
