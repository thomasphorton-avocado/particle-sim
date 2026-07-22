export type VersionSource = "github-actions" | "local";

export interface BuildMetadata {
  loadedCodeId: string;
  shortCommitSha: string;
  displayVersion: string;
  source: VersionSource;
  commitSha: string;
  githubRepository?: string;
  githubRef?: string;
  githubRunId?: string;
  githubRunNumber?: string;
  githubWorkflow?: string;
  buildTimestamp: string;
}

export interface BuildMetadataOptions {
  buildTimestamp?: string;
  commitSha?: string;
  shortCommitSha?: string;
  source?: VersionSource;
}

export interface VersionBadgeDetails {
  sourceLabel: string;
  commitLabel: string;
  commitHref?: string;
  runLabel?: string;
  runHref?: string;
  timestamp: string;
}

declare const __APP_BUILD_METADATA__: string | undefined;

export function createBuildMetadata(
  env: Record<string, string | undefined> = {},
  options: BuildMetadataOptions = {},
): BuildMetadata {
  const commitSha = (options.commitSha ?? env["GITHUB_SHA"] ?? env["VITE_GITHUB_SHA"] ?? "").trim();
  const source = options.source ?? (env["GITHUB_ACTIONS"] === "true" ? "github-actions" : "local");
  const shortCommitSha = (options.shortCommitSha ?? (commitSha ? commitSha.slice(0, 7) : "local")).trim();
  const loadedCodeId = commitSha || "local";
  const buildTimestamp = options.buildTimestamp ?? new Date().toISOString();

  return {
    loadedCodeId,
    shortCommitSha,
    displayVersion: commitSha ? `build-${shortCommitSha}` : "local",
    source,
    commitSha,
    githubRepository: env["GITHUB_REPOSITORY"]?.trim() || undefined,
    githubRef: env["GITHUB_REF"]?.trim() || undefined,
    githubRunId: env["GITHUB_RUN_ID"]?.trim() || undefined,
    githubRunNumber: env["GITHUB_RUN_NUMBER"]?.trim() || undefined,
    githubWorkflow: env["GITHUB_WORKFLOW"]?.trim() || undefined,
    buildTimestamp,
  };
}

export function parseBuildMetadata(rawMetadata: string | undefined): BuildMetadata {
  if (!rawMetadata) {
    return createBuildMetadata();
  }

  try {
    const parsed = JSON.parse(rawMetadata) as Partial<BuildMetadata>;
    const commitSha = (parsed.commitSha ?? parsed.loadedCodeId ?? "").trim();
    const shortCommitSha = (parsed.shortCommitSha ?? (commitSha ? commitSha.slice(0, 7) : "local")).trim();
    const source = parsed.source === "github-actions" ? "github-actions" : "local";

    return {
      loadedCodeId: commitSha || "local",
      shortCommitSha,
      displayVersion: commitSha ? `build-${shortCommitSha}` : "local",
      source,
      commitSha,
      githubRepository: parsed.githubRepository,
      githubRef: parsed.githubRef,
      githubRunId: parsed.githubRunId,
      githubRunNumber: parsed.githubRunNumber,
      githubWorkflow: parsed.githubWorkflow,
      buildTimestamp: parsed.buildTimestamp ?? new Date().toISOString(),
    };
  } catch {
    return createBuildMetadata();
  }
}

export function createVersionJson(metadata: BuildMetadata): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

export function formatBuildTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}Z`;
}

export function getVersionBadgeDetails(metadata: BuildMetadata): VersionBadgeDetails {
  const shortCommitSha = metadata.shortCommitSha || metadata.loadedCodeId;
  const sourceLabel = metadata.source === "github-actions" ? "Build" : "Local";
  const commitLabel = shortCommitSha || metadata.loadedCodeId;
  const commitHref = metadata.githubRepository && metadata.commitSha
    ? `https://github.com/${metadata.githubRepository}/commit/${metadata.commitSha}`
    : undefined;
  const runLabel = metadata.githubRunNumber ? `run #${metadata.githubRunNumber}` : undefined;
  const runHref = metadata.githubRunId && metadata.githubRepository
    ? `https://github.com/${metadata.githubRepository}/actions/runs/${metadata.githubRunId}`
    : undefined;

  return {
    sourceLabel,
    commitLabel,
    commitHref,
    runLabel,
    runHref,
    timestamp: formatBuildTimestamp(metadata.buildTimestamp),
  };
}

export const buildMetadata = parseBuildMetadata(
  typeof __APP_BUILD_METADATA__ === "string" ? __APP_BUILD_METADATA__ : undefined,
);
