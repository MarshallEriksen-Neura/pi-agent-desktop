// cc-no-brepro.js
//
// Workaround for the MSVC C1056 "cannot update the time-date stamp field" error
// that occurs while building `ring` 0.17.x on Windows.
//
// Root cause: the `cc` crate (1.x) unconditionally passes "-Brepro" to cl.exe on
// MSVC targets. Combined with "/Z7", certain files (e.g. p256.c) trip an MSVC bug
// (C1056). Removing "-Brepro" makes the build succeed.
//
// This script is used as the C/C++ compiler via CC_x86_64-pc-windows-msvc, with
// `node` registered as a known compiler wrapper (CC_KNOWN_WRAPPER_CUSTOM). cc-rs
// therefore forwards the real compiler flags as this script's arguments. The
// script:
//   1. locates the latest Visual Studio VC toolchain via vswhere,
//   2. imports its environment (INCLUDE / LIB / PATH) via vcvarsall.bat,
//   3. strips every "-Brepro" argument injected by cc-rs,
//   4. delegates to the real cl.exe.
//
// Because cl.exe is invoked for the compiler-family probe (-E), cc-rs still
// detects the MSVC toolchain correctly.

const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const pf = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const vswhere = path.join(pf, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
if (!fs.existsSync(vswhere)) {
  process.stderr.write('[cc-no-brepro] vswhere.exe not found at: ' + vswhere + '\n');
  process.exit(1);
}

let vs = '';
try {
  vs = execSync(
    `"${vswhere}" -products * -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`,
    { encoding: 'utf8' }
  ).trim();
} catch (e) { vs = ''; }
if (!vs) {
  process.stderr.write('[cc-no-brepro] Could not locate a Visual Studio install with the VC tools.\n');
  process.exit(1);
}

const vcvars = path.join(vs, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
if (!fs.existsSync(vcvars)) {
  process.stderr.write('[cc-no-brepro] vcvarsall.bat not found at: ' + vcvars + '\n');
  process.exit(1);
}

// Import the VC environment (INCLUDE / LIB / PATH) into this process.
let setOut = '';
try {
  setOut = execSync(`call "${vcvars}" x64 >nul 2>&1 & set`, { encoding: 'utf8', shell: true });
} catch (e) { setOut = ''; }

const env = Object.assign({}, process.env);
for (const line of setOut.split(/\r?\n/)) {
  const m = line.match(/^([^=]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}

// cc-rs forwards the compiler flags as our arguments; strip the "-Brepro" flag.
const ccFlags = process.argv.slice(2).filter((a) => a !== '-Brepro');

const result = spawnSync('cl.exe', ccFlags, { stdio: 'inherit', env: env, shell: false });
process.exit(result.status === null ? 1 : result.status);
