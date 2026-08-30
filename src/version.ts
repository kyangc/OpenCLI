/**
 * Single source of truth for package version.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dev: __dirname is src/ (one level to root).
// Prod: __dirname is dist/src/ (two levels to root).
let _pkgDir = path.resolve(__dirname, '..');
if (!fs.existsSync(path.join(_pkgDir, 'package.json'))) {
  _pkgDir = path.resolve(_pkgDir, '..');
}
const pkgJsonPath = path.join(_pkgDir, 'package.json');

interface PackageMetadata {
  version?: unknown;
  opencliFork?: {
    release?: unknown;
  };
}

const packageMetadata: PackageMetadata = (() => {
  try {
    return JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as PackageMetadata;
  } catch {
    return {};
  }
})();

export const PKG_VERSION = typeof packageMetadata.version === 'string'
  ? packageMetadata.version
  : '0.0.0';

export const IS_FORK_BUILD = typeof packageMetadata.opencliFork?.release === 'string';
