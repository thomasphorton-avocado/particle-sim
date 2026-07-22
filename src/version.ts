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
}

declare const __APP_BUILD_METADATA__: string | undefined;

export function createBuildMetadata(
  env: Record<string, string | undefined> = {},
  options: BuildMetadataOptions = {},
): BuildMetadata {
  const commitSha = (options.commitSha ?? env["GITHUB_SHA"] ?? env["VITE_GITHUB_SHA"] ?? "").trim();
  const source = env["GITHUB_ACTIONS"] === "true" ? "github-actions" : "local";
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
    const metadata = createBuildMetadata(
      {},
      {
        buildTimestamp: parsed.buildTimestamp ?? new Date().toISOString(),
        commitSha: parsed.commitSha ?? parsed.loadedCodeId,
        shortCommitSha: parsed.shortCommitSha,
      },
    );

    return {
      ...metadata,
      githubRepository: parsed.githubRepository ?? metadata.githubRepository,
      githubRef: parsed.githubRef ?? metadata.githubRef,
      githubRunId: parsed.githubRunId ?? metadata.githubRunId,
      githubRunNumber: parsed.githubRunNumber ?? metadata.githubRunNumber,
      githubWorkflow: parsed.githubWorkflow ?? metadata.githubWorkflow,
    };
  } catch {
    return createBuildMetadata();
  }
}

export function createVersionJson(metadata: BuildMetadata): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

export function getVersionLabel(metadata: BuildMetadata): string {
  if (metadata.source === "github-actions") {
    return `Build ${metadata.shortCommitSha}`;
  }
  return metadata.commitSha ? `Local ${metadata.shortCommitSha}` : "Local build";
}

export const buildMetadata = parseBuildMetadata(
  typeof __APP_BUILD_METADATA__ === "string" ? __APP_BUILD_METADATA__ : undefined,
);
