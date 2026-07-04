import { describe, expect, it } from 'vitest';
import { pickLatestAgentAsset, type GitHubRelease } from './agentDownloads';

function release(tag: string, assets: string[], draft = false): GitHubRelease {
  return {
    tag_name: tag,
    draft,
    prerelease: tag.includes('-'),
    published_at: '2026-07-04T00:00:00Z',
    assets: assets.map((name) => ({
      name,
      browser_download_url: `https://github.example/${tag}/${name}`,
    })),
  };
}

describe('pickLatestAgentAsset', () => {
  it('selects the newest beta macOS DMG instead of updater metadata', () => {
    const asset = pickLatestAgentAsset([
      release('v0.0.2-beta.20', ['Timo-0.0.2-beta.20-universal.dmg', 'beta-mac.yml']),
      release('v0.0.2-beta.21', ['beta-mac.yml', 'Timo-0.0.2-beta.21-universal.dmg.blockmap', 'Timo-0.0.2-beta.21-universal.dmg']),
    ], 'mac');

    expect(asset?.name).toBe('Timo-0.0.2-beta.21-universal.dmg');
    expect(asset?.browser_download_url).toContain('/v0.0.2-beta.21/');
  });

  it('selects the newest Windows setup exe and skips draft releases', () => {
    const asset = pickLatestAgentAsset([
      release('v0.0.2-beta.22', ['Timo-0.0.2-beta.22-x64-setup.exe'], true),
      release('v0.0.2-beta.21', ['Timo-0.0.2-beta.21-x64-setup.exe.blockmap', 'Timo-0.0.2-beta.21-x64-setup.exe']),
      release('v0.0.2-beta.20', ['Timo-0.0.2-beta.20-x64-setup.exe']),
    ], 'windows');

    expect(asset?.name).toBe('Timo-0.0.2-beta.21-x64-setup.exe');
  });

  it('prefers a newer stable release when one exists', () => {
    const asset = pickLatestAgentAsset([
      release('v0.0.3-beta.3', ['Timo-0.0.3-beta.3-universal.dmg']),
      release('v0.0.3', ['Timo-0.0.3-universal.dmg']),
      release('v0.0.2-beta.99', ['Timo-0.0.2-beta.99-universal.dmg']),
    ], 'mac');

    expect(asset?.name).toBe('Timo-0.0.3-universal.dmg');
  });
});
