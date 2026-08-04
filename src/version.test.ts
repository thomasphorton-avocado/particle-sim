import { describe, expect, it } from "vitest";
import { createBuildMetadata, createVersionJson, formatBuildTimestamp, getVersionBadgeDetails, parseBuildMetadata } from "./version";

describe("build metadata", () => {
  it("prefers GitHub Actions metadata when available", () => {
    const metadata = createBuildMetadata({
      GITHUB_ACTIONS: "true",
      GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
      GITHUB_REPOSITORY: "octo/particle-sim",
      GITHUB_REF: "refs/heads/main",
      GITHUB_RUN_ID: "12345",
      GITHUB_RUN_NUMBER: "7",
      GITHUB_WORKFLOW: "deploy",
    });

    expect(metadata.loadedCodeId).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(metadata.shortCommitSha).toBe("0123456");
    expect(metadata.displayVersion).toBe("build-0123456");
    expect(metadata.source).toBe("github-actions");
    expect(metadata.githubRepository).toBe("octo/particle-sim");
    expect(metadata.githubRunNumber).toBe("7");
  });

  it("falls back to local defaults when no build metadata is present", () => {
    const metadata = createBuildMetadata({});

    expect(metadata.loadedCodeId).toBe("local");
    expect(metadata.shortCommitSha).toBe("local");
    expect(metadata.displayVersion).toBe("local");
    expect(metadata.source).toBe("local");
    expect(metadata.commitSha).toBe("");
  });

  it("preserves CI metadata during runtime round trips", () => {
    const raw = JSON.stringify({
      loadedCodeId: "0123456789abcdef0123456789abcdef01234567",
      shortCommitSha: "0123456",
      displayVersion: "build-0123456",
      source: "github-actions",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      githubRepository: "octo/particle-sim",
      githubRunId: "12345",
      githubRunNumber: "7",
      githubWorkflow: "deploy",
      buildTimestamp: "2024-01-02T03:04:05.000Z",
    });

    const metadata = parseBuildMetadata(raw);

    expect(metadata.source).toBe("github-actions");
    expect(metadata.githubRepository).toBe("octo/particle-sim");
    expect(metadata.githubRunNumber).toBe("7");
  });

  it("formats a machine-readable version payload", () => {
    const metadata = createBuildMetadata({}, { buildTimestamp: "2024-01-02T03:04:05.000Z" });

    expect(createVersionJson(metadata)).toContain('"loadedCodeId": "local"');
    expect(createVersionJson(metadata)).toContain('"buildTimestamp": "2024-01-02T03:04:05.000Z"');
  });

  it("renders compact UI details with commit and run links", () => {
    const metadata = createBuildMetadata(
      {
        GITHUB_ACTIONS: "true",
        GITHUB_SHA: "abcdef1234567890",
        GITHUB_REPOSITORY: "octo/particle-sim",
        GITHUB_RUN_ID: "4242",
        GITHUB_RUN_NUMBER: "13",
      },
      { buildTimestamp: "2024-01-02T03:04:05.000Z" },
    );

    const details = getVersionBadgeDetails(metadata);

    expect(details.sourceLabel).toBe("Build");
    expect(details.commitLabel).toBe("abcdef1");
    expect(details.commitHref).toBe("https://github.com/octo/particle-sim/commit/abcdef1234567890");
    expect(details.runLabel).toBe("run #13");
    expect(details.runHref).toBe("https://github.com/octo/particle-sim/actions/runs/4242");
    expect(formatBuildTimestamp(metadata.buildTimestamp)).toBe("2024-01-02 03:04Z");
  });

  it("returns no links for local metadata", () => {
    const details = getVersionBadgeDetails(createBuildMetadata({}, { buildTimestamp: "2024-01-02T03:04:05.000Z" }));

    expect(details.commitHref).toBeUndefined();
    expect(details.runHref).toBeUndefined();
    expect(details.runLabel).toBeUndefined();
  });

  it("does not create a run link when a run number exists without repository or run id", () => {
    const metadata = createBuildMetadata(
      {
        GITHUB_ACTIONS: "true",
        GITHUB_SHA: "abcdef1234567890",
        GITHUB_RUN_NUMBER: "13",
      },
      { buildTimestamp: "2024-01-02T03:04:05.000Z" },
    );

    const details = getVersionBadgeDetails(metadata);

    expect(details.commitHref).toBeUndefined();
    expect(details.runHref).toBeUndefined();
    expect(details.runLabel).toBe("run #13");
  });
});

describe("parseBuildMetadata", () => {
  it("falls back to local defaults when rawMetadata is undefined", () => {
    const metadata = parseBuildMetadata(undefined);
    expect(metadata.loadedCodeId).toBe("local");
    expect(metadata.displayVersion).toBe("local");
    expect(metadata.source).toBe("local");
  });

  it("falls back to local defaults when rawMetadata is invalid JSON", () => {
    const metadata = parseBuildMetadata("not-valid-json{{");
    expect(metadata.loadedCodeId).toBe("local");
    expect(metadata.source).toBe("local");
  });

  it("treats an unknown source value as local", () => {
    const raw = JSON.stringify({ source: "unknown-source", commitSha: "", buildTimestamp: "2024-01-01T00:00:00.000Z" });
    const metadata = parseBuildMetadata(raw);
    expect(metadata.source).toBe("local");
  });

  it("derives shortCommitSha from commitSha when shortCommitSha is absent in payload", () => {
    const sha = "aabbccdd11223344aabbccdd11223344aabbccdd";
    const raw = JSON.stringify({ commitSha: sha, source: "github-actions", buildTimestamp: "2024-01-01T00:00:00.000Z" });
    const metadata = parseBuildMetadata(raw);
    expect(metadata.shortCommitSha).toBe(sha.slice(0, 7));
    expect(metadata.displayVersion).toBe(`build-${sha.slice(0, 7)}`);
  });

  it("uses a provided buildTimestamp from the payload", () => {
    const ts = "2025-06-15T12:34:56.000Z";
    const raw = JSON.stringify({ buildTimestamp: ts });
    const metadata = parseBuildMetadata(raw);
    expect(metadata.buildTimestamp).toBe(ts);
  });
});

describe("formatBuildTimestamp", () => {
  it("returns unknown for an invalid timestamp string", () => {
    expect(formatBuildTimestamp("not-a-date")).toBe("unknown");
  });

  it("formats a valid ISO timestamp to date and time", () => {
    expect(formatBuildTimestamp("2024-03-14T09:26:53.000Z")).toBe("2024-03-14 09:26Z");
  });
});

describe("createBuildMetadata options", () => {
  it("accepts an explicit source option overriding the env", () => {
    const metadata = createBuildMetadata({ GITHUB_ACTIONS: "true" }, { source: "local" });
    expect(metadata.source).toBe("local");
  });

  it("accepts an explicit commitSha option overriding the env", () => {
    const sha = "deadbeef00000000deadbeef00000000deadbeef";
    const metadata = createBuildMetadata({}, { commitSha: sha });
    expect(metadata.commitSha).toBe(sha);
    expect(metadata.shortCommitSha).toBe(sha.slice(0, 7));
  });

  it("trims whitespace from GITHUB_SHA", () => {
    const metadata = createBuildMetadata({ GITHUB_SHA: "  abc1234  " });
    expect(metadata.commitSha).toBe("abc1234");
  });
});
