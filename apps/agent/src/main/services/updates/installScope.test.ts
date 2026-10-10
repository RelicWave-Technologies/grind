import { describe, expect, it } from 'vitest';
import { detectInstallScope } from './installScope';

const env = {
  SystemDrive: 'C:',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramW6432: 'C:\\Program Files',
  LOCALAPPDATA: 'C:\\Users\\asha\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\asha',
};

describe('detectInstallScope', () => {
  it.each([
    ['per-machine x64', 'C:\\Program Files\\Timo\\Timo.exe'],
    ['per-machine 32-bit view', 'C:\\Program Files (x86)\\Timo\\Timo.exe'],
    ['legacy Grind folder from the rebrand', 'C:\\Program Files\\Grind\\Timo\\Timo.exe'],
    ['legacy Grind exe', 'C:\\Program Files\\Grind\\Grind.exe'],
    ['different case', 'c:\\PROGRAM FILES\\timo\\TIMO.EXE'],
    ['forward slashes', 'C:/Program Files/Timo/Timo.exe'],
    ['long-path prefix', '\\\\?\\C:\\Program Files\\Timo\\Timo.exe'],
    ['8.3 short name', 'C:\\PROGRA~1\\Timo\\Timo.exe'],
  ])('reports a %s install as machine', (_label, execPath) => {
    expect(detectInstallScope(execPath, env, 'win32')).toBe('machine');
  });

  it('follows Program Files on another drive', () => {
    const dEnv = { ...env, ProgramFiles: 'D:\\Program Files\\' };
    expect(detectInstallScope('D:\\Program Files\\Timo\\Timo.exe', dEnv, 'win32')).toBe('machine');
  });

  it('still recognises Program Files when the environment is stripped', () => {
    expect(detectInstallScope('C:\\Program Files\\Timo\\Timo.exe', {}, 'win32')).toBe('machine');
    expect(detectInstallScope('C:\\Program Files (x86)\\Timo\\Timo.exe', {}, 'win32')).toBe('machine');
  });

  it.each([
    ['default per-user', 'C:\\Users\\asha\\AppData\\Local\\Programs\\Timo\\Timo.exe'],
    ['legacy Grind per-user folder', 'C:\\Users\\asha\\AppData\\Local\\Programs\\Grind\\Timo.exe'],
    ['different case', 'c:\\users\\ASHA\\appdata\\local\\programs\\timo\\timo.exe'],
  ])('reports a %s install as user', (_label, execPath) => {
    expect(detectInstallScope(execPath, env, 'win32')).toBe('user');
  });

  it('falls back to the profile path when LOCALAPPDATA is missing', () => {
    const noLocal = { ...env, LOCALAPPDATA: undefined };
    expect(detectInstallScope('C:\\Users\\asha\\AppData\\Local\\Programs\\Timo\\Timo.exe', noLocal, 'win32')).toBe('user');
  });

  it('does not match a sibling folder that merely starts with the same name', () => {
    expect(detectInstallScope('C:\\Program Files Custom\\Timo\\Timo.exe', env, 'win32')).toBe('unknown');
    expect(detectInstallScope('C:\\Users\\asha\\AppData\\LocalLow\\Timo\\Timo.exe', env, 'win32')).toBe('unknown');
  });

  it('calls a hand-picked directory unknown', () => {
    expect(detectInstallScope('D:\\Apps\\Timo\\Timo.exe', env, 'win32')).toBe('unknown');
  });

  it('is unknown off Windows', () => {
    expect(detectInstallScope('/Applications/Timo.app/Contents/MacOS/Timo', env, 'darwin')).toBe('unknown');
    expect(detectInstallScope('C:\\Program Files\\Timo\\Timo.exe', env, 'linux')).toBe('unknown');
  });

  it('is unknown without an executable path', () => {
    expect(detectInstallScope('', env, 'win32')).toBe('unknown');
  });
});
