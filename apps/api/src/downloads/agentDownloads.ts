export type AgentDownloadPlatform = 'mac' | 'windows';

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

export interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease?: boolean;
  published_at?: string | null;
  assets: GitHubAsset[];
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prereleaseName: string | null;
  prereleaseNumber: number | null;
}

const RELEASES_URL = 'https://api.github.com/repos/RelicWave-Technologies/grind/releases?per_page=50';
const CACHE_TTL_MS = 5 * 60_000;

const ASSET_MATCHERS: Record<AgentDownloadPlatform, RegExp[]> = {
  mac: [
    /^Timo-\d+\.\d+\.\d+(?:-[a-z]+(?:\.\d+)?)?-universal\.dmg$/iu,
    /^Timo-.*\.dmg$/iu,
  ],
  windows: [
    /^Timo-\d+\.\d+\.\d+(?:-[a-z]+(?:\.\d+)?)?-x64-setup\.exe$/iu,
    /^Timo-.*setup\.exe$/iu,
  ],
};

let releaseCache: { expiresAt: number; releases: GitHubRelease[] } | null = null;

export function isAgentDownloadPlatform(value: string): value is AgentDownloadPlatform {
  return value === 'mac' || value === 'windows';
}

function parseVersion(tagName: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([a-z][a-z0-9-]*)(?:\.(\d+))?)?$/iu.exec(tagName.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prereleaseName: match[4]?.toLowerCase() ?? null,
    prereleaseNumber: match[5] ? Number(match[5]) : null,
  };
}

function compareNumberDesc(a: number, b: number): number {
  return b - a;
}

function compareVersionDesc(a: ParsedVersion, b: ParsedVersion): number {
  const base =
    compareNumberDesc(a.major, b.major) ||
    compareNumberDesc(a.minor, b.minor) ||
    compareNumberDesc(a.patch, b.patch);
  if (base !== 0) return base;

  if (a.prereleaseName === null && b.prereleaseName !== null) return -1;
  if (a.prereleaseName !== null && b.prereleaseName === null) return 1;
  if (a.prereleaseName !== b.prereleaseName) {
    return (a.prereleaseName ?? '').localeCompare(b.prereleaseName ?? '');
  }
  return compareNumberDesc(a.prereleaseNumber ?? -1, b.prereleaseNumber ?? -1);
}

function compareReleaseDesc(a: GitHubRelease, b: GitHubRelease): number {
  const aVersion = parseVersion(a.tag_name);
  const bVersion = parseVersion(b.tag_name);
  if (aVersion && bVersion) {
    const versionOrder = compareVersionDesc(aVersion, bVersion);
    if (versionOrder !== 0) return versionOrder;
  } else if (aVersion) {
    return -1;
  } else if (bVersion) {
    return 1;
  }

  return compareNumberDesc(
    Date.parse(a.published_at ?? '') || 0,
    Date.parse(b.published_at ?? '') || 0,
  );
}

export function pickLatestAgentAsset(
  releases: GitHubRelease[],
  platform: AgentDownloadPlatform,
): GitHubAsset | null {
  const matchers = ASSET_MATCHERS[platform];
  const candidates = releases
    .filter((release) => !release.draft)
    .map((release) => ({
      release,
      asset: release.assets.find((asset) => matchers.some((matcher) => matcher.test(asset.name))),
    }))
    .filter((item): item is { release: GitHubRelease; asset: GitHubAsset } => Boolean(item.asset));

  candidates.sort((a, b) => compareReleaseDesc(a.release, b.release));
  return candidates[0]?.asset ?? null;
}

async function fetchReleases(): Promise<GitHubRelease[]> {
  const now = Date.now();
  if (releaseCache && releaseCache.expiresAt > now) return releaseCache.releases;

  const response = await fetch(RELEASES_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'timo-api-download-redirect',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`github_releases_${response.status}`);
  }

  const releases = (await response.json()) as GitHubRelease[];
  releaseCache = { expiresAt: now + CACHE_TTL_MS, releases };
  return releases;
}

export async function getLatestAgentDownloadUrl(platform: AgentDownloadPlatform): Promise<string | null> {
  const asset = pickLatestAgentAsset(await fetchReleases(), platform);
  return asset?.browser_download_url ?? null;
}

export function clearAgentDownloadCacheForTests(): void {
  releaseCache = null;
}
