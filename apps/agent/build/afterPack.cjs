// electron-builder afterPack hook.
//
// pnpm's hoisted workspace tree confuses electron-builder's dependency
// collector: it nests `color-name` under `color/node_modules/` but leaves the
// top-level `color-convert` (which sharp loads) unable to resolve it, so the
// packaged app dies with "Cannot find module 'color-name'". We run with
// asar:false so node_modules ships as plain files, then hoist a copy of
// color-name (and any other known-misplaced transitive) to the top level here.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** Ensure `name` exists at the top level of the app's node_modules, copying it
 *  up from any nested location if electron-builder buried it. */
function hoist(nodeModules, name) {
  const dest = path.join(nodeModules, name);
  if (fs.existsSync(dest)) return true;
  // Search one or two levels of <pkg>/node_modules/<name> for a copy.
  for (const entry of fs.readdirSync(nodeModules)) {
    const nested = path.join(nodeModules, entry, 'node_modules', name);
    if (fs.existsSync(nested)) {
      fs.cpSync(nested, dest, { recursive: true });
      console.log(`  afterPack: hoisted ${name} ← ${entry}/node_modules/${name}`);
      return true;
    }
  }
  console.warn(`  afterPack: could not find a ${name} to hoist`);
  return false;
}

function removeIfPresent(targetPath, label) {
  if (!fs.existsSync(targetPath)) return;
  fs.rmSync(targetPath, { recursive: true, force: true });
  console.log(`  afterPack: removed ${label}`);
}

function currentMacArch(context) {
  if (context.arch === 'x64' || context.arch === 1) return 'x64';
  if (context.arch === 'arm64' || context.arch === 3) return 'arm64';
  return null;
}

function mirrorGetWindowsBindings(nodeModules, arch) {
  if (arch !== 'x64' && arch !== 'arm64') return;
  const other = arch === 'x64' ? 'arm64' : 'x64';
  const bindingRoot = path.join(nodeModules, 'get-windows', 'lib', 'binding');
  const bindings = [
    { abi: 'napi-6', file: 'node-active-win.node' },
    { abi: 'napi-9', file: 'node-get-windows.node' },
  ];

  for (const binding of bindings) {
    const source = path.join(bindingRoot, `${binding.abi}-darwin-unknown-${arch}`, binding.file);
    const dest = path.join(bindingRoot, `${binding.abi}-darwin-unknown-${other}`, binding.file);
    if (!fs.existsSync(source) || !fs.existsSync(dest)) continue;
    fs.copyFileSync(source, dest);
    console.log(`  afterPack: mirrored get-windows ${binding.abi} ${arch} binding`);
  }
}

exports.default = async function afterPack(context) {
  const product = context.packager.appInfo.productFilename; // "Grind"
  const appBundle =
    context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, `${product}.app`)
      : null;
  const nodeModules =
    context.electronPlatformName === 'darwin'
      ? path.join(
          context.appOutDir,
          `${product}.app`,
          'Contents',
          'Resources',
          'app',
          'node_modules',
        )
      : path.join(context.appOutDir, 'resources', 'app', 'node_modules');
  if (!fs.existsSync(nodeModules)) {
    console.warn(`afterPack: ${nodeModules} not found — skipping hoist`);
    return;
  }
  console.log('afterPack: normalizing hoisted transitive deps');
  // color-convert (top-level, loaded by sharp) needs a sibling color-name.
  hoist(nodeModules, 'color-name');

  // uiohook-napi loads from prebuilds/* via node-gyp-build. electron-builder's
  // rebuild can leave a transient build/Release binary in only one architecture,
  // which prevents @electron/universal from merging the two macOS apps.
  removeIfPresent(path.join(nodeModules, 'uiohook-napi', 'build'), 'uiohook-napi/build');
  removeIfPresent(
    path.join(nodeModules, 'better-sqlite3', 'build', 'Release', 'test_extension.node'),
    'better-sqlite3 test extension',
  );
  removeIfPresent(path.join(nodeModules, 'get-windows', 'build'), 'get-windows/build');
  mirrorGetWindowsBindings(nodeModules, currentMacArch(context));

  if (appBundle && fs.existsSync(appBundle)) {
    try {
      execFileSync('xattr', ['-cr', appBundle], { stdio: 'ignore' });
      console.log('  afterPack: cleared macOS extended attributes');
    } catch (err) {
      console.warn(`  afterPack: xattr cleanup failed (${err && err.message ? err.message : err})`);
    }
  }
};
