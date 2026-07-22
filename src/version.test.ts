import { describe, expect, it } from "vitest";
import { createBuildMetadata, createVersionJson, getVersionLabel } from "./version";

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

  it("formats a machine-readable version payload", () => {
    const metadata = createBuildMetadata({}, { buildTimestamp: "2024-01-02T03:04:05.000Z" });

    expect(createVersionJson(metadata)).toContain('"loadedCodeId": "local"');
    expect(createVersionJson(metadata)).toContain('"buildTimestamp": "2024-01-02T03:04:05.000Z"');
  });

  it("uses the metadata for a compact UI label", () => {
    const metadata = createBuildMetadata({ GITHUB_ACTIONS: "true", GITHUB_SHA: "abcdef1234567890" });

    expect(getVersionLabel(metadata)).toBe("Build abcdef1");
  });
});
