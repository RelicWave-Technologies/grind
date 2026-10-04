import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import electronPath from 'electron';

if (process.platform !== 'darwin') process.exit(0);

const appDir = path.dirname(path.dirname(path.dirname(electronPath)));
const infoPlist = path.join(appDir, 'Contents', 'Info.plist');
const callbackScheme = String(process.env.AGENT_CALLBACK_SCHEME ?? 'timo').toLowerCase() === 'grind'
  ? 'grind'
  : 'timo';
const worktreeId = createHash('sha256').update(appDir).digest('hex').slice(0, 10);
const bundleId = `com.relicwave.timo.dev.${worktreeId}`;

function run(command, args, opts = {}) {
  execFileSync(command, args, { stdio: 'ignore', ...opts });
}

run('plutil', ['-replace', 'CFBundleIdentifier', '-string', bundleId, infoPlist]);
run('plutil', ['-replace', 'CFBundleDisplayName', '-string', 'Timo Dev', infoPlist]);
run('plutil', ['-replace', 'CFBundleName', '-string', 'Timo Dev', infoPlist]);
run('plutil', [
  '-replace',
  'CFBundleURLTypes',
  '-json',
  JSON.stringify([
    {
      CFBundleTypeRole: 'Editor',
      CFBundleURLName: 'Timo Dev',
      CFBundleURLSchemes: [callbackScheme],
    },
  ]),
  infoPlist,
]);

run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', [
  '-f',
  appDir,
]);

run('swift', [
  '-e',
  `import CoreServices; import Foundation; LSSetDefaultHandlerForURLScheme("${callbackScheme}" as CFString, "${bundleId}" as CFString)`,
]);
