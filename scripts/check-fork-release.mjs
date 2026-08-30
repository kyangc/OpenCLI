#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), 'utf8'));
}

function fail(message) {
  console.error(`[kyangc-release] ${message}`);
  process.exitCode = 1;
}

const cliPackage = readJson('package.json');
const extensionPackage = readJson('extension/package.json');
const extensionManifest = readJson('extension/manifest.json');
const cliVersion = cliPackage.version;
const release = cliPackage.opencliFork?.release;
const upstreamCliVersion = cliPackage.opencliFork?.upstreamVersion;
const extensionVersion = extensionPackage.version;
const extensionRelease = extensionPackage.opencliFork?.release;
const upstreamExtensionVersion = extensionPackage.opencliFork?.upstreamVersion;
const stableSemver = /^\d+\.\d+\.\d+$/;

if (typeof cliVersion !== 'string' || !stableSemver.test(cliVersion)) {
  fail('CLI version must be an independent stable semver such as 2.0.0');
} else if (release !== `kyangc-v${cliVersion}`) {
  fail(`package.json opencliFork.release must be kyangc-v${cliVersion}`);
} else {
  const cliMajor = Number(cliVersion.split('.')[0]);
  const expectedCompatRange = `>=${cliMajor}.0.0 <${cliMajor + 1}.0.0`;
  if (extensionPackage.opencli?.compatRange !== expectedCompatRange) {
    fail(`extension opencli.compatRange must be ${expectedCompatRange}`);
  }
}
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== release) {
  fail(`pushed tag ${process.env.GITHUB_REF_NAME} must match ${release}`);
}
if (typeof upstreamCliVersion !== 'string' || !stableSemver.test(upstreamCliVersion)) {
  fail('package.json opencliFork.upstreamVersion must record a stable upstream semver');
} else if (upstreamCliVersion === cliVersion) {
  fail('CLI fork version must not be derived from or equal to the upstream version');
}

if (typeof extensionVersion !== 'string' || !stableSemver.test(extensionVersion)) {
  fail('extension package version must be an independent stable semver such as 2.0.0');
} else {
  if (extensionRelease !== `kyangc-ext-v${extensionVersion}`) {
    fail(`extension package opencliFork.release must be kyangc-ext-v${extensionVersion}`);
  }
  if (extensionManifest.version !== extensionVersion) {
    fail(`extension manifest version ${extensionManifest.version} must be ${extensionVersion}`);
  }
  const expectedServiceWorker = `dist/background-${extensionVersion}.js`;
  if (extensionManifest.background?.service_worker !== expectedServiceWorker) {
    fail(`extension service worker must be ${expectedServiceWorker}`);
  }
  if (extensionManifest.version_name !== extensionRelease) {
    fail('extension manifest version_name must match the extension package release');
  }
}
if (typeof upstreamExtensionVersion !== 'string' || !stableSemver.test(upstreamExtensionVersion)) {
  fail('extension opencliFork.upstreamVersion must record a stable upstream semver');
} else if (upstreamExtensionVersion === extensionVersion) {
  fail('extension fork version must not be derived from or equal to the upstream version');
}

if (process.exitCode) process.exit(process.exitCode);

console.log(
  `[kyangc-release] CLI ${release} (upstream ${upstreamCliVersion}), `
    + `extension ${extensionRelease} (upstream ${upstreamExtensionVersion})`,
);
