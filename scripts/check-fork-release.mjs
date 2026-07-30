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
const release = cliPackage.opencliFork?.release;

const releaseMatch = typeof release === 'string'
  ? release.match(/^kyangc-v(\d+\.\d+\.\d+)\.(\d+)$/)
  : null;

if (!releaseMatch) {
  fail('package.json opencliFork.release must match kyangc-v<major.minor.patch>.<revision>');
} else {
  const [, upstreamCliVersion, revision] = releaseMatch;
  const expectedCliVersion = `${upstreamCliVersion}-kyangc.${revision}`;
  if (cliPackage.version !== expectedCliVersion) {
    fail(`CLI version ${cliPackage.version} must be ${expectedCliVersion}`);
  }
  if (cliPackage.opencliFork?.upstreamVersion !== upstreamCliVersion) {
    fail(`opencliFork.upstreamVersion must be ${upstreamCliVersion}`);
  }

  const extensionMatch = extensionPackage.version?.match(/^(\d+\.\d+\.\d+)-kyangc\.(\d+)$/);
  if (!extensionMatch) {
    fail('extension package version must match <major.minor.patch>-kyangc.<revision>');
  } else {
    const [, upstreamExtensionVersion, extensionRevision] = extensionMatch;
    if (extensionRevision !== revision) {
      fail(`extension revision ${extensionRevision} must match CLI revision ${revision}`);
    }
    const expectedManifestVersion = `${upstreamExtensionVersion}.${revision}`;
    if (extensionManifest.version !== expectedManifestVersion) {
      fail(`extension manifest version ${extensionManifest.version} must be ${expectedManifestVersion}`);
    }
  }

  if (extensionPackage.opencliFork?.release !== release) {
    fail('extension package release must match the root package release');
  }
  if (extensionManifest.version_name !== release) {
    fail('extension manifest version_name must match the root package release');
  }
}

if (process.exitCode) process.exit(process.exitCode);

console.log(
  `[kyangc-release] ${release}: CLI ${cliPackage.version}, extension ${extensionManifest.version}`,
);
