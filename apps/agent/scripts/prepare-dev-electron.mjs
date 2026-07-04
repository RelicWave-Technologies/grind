import { execFileSync } from 'node:child_process';
import path from 'node:path';
import electronPath from 'electron';

if (process.platform !== 'darwin') process.exit(0);

const appDir = path.dirname(path.dirname(path.dirname(electronPath)));
const infoPlist = path.join(appDir, 'Contents', 'Info.plist');
const bundleId = 'com.relicwave.timo.dev';

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
      CFBundleURLSchemes: ['timo'],
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
  `import CoreServices; import Foundation; LSSetDefaultHandlerForURLScheme("timo" as CFString, "${bundleId}" as CFString)`,
]);
