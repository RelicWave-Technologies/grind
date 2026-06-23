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

  if (appBundle && fs.existsSync(appBundle)) {
    try {
      execFileSync('xattr', ['-cr', appBundle], { stdio: 'ignore' });
      console.log('  afterPack: cleared macOS extended attributes');
    } catch (err) {
      console.warn(`  afterPack: xattr cleanup failed (${err && err.message ? err.message : err})`);
    }
  }
};
