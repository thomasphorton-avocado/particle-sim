import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { createBuildMetadata, createVersionJson } from "./src/version";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

function getGitShaFallback(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const buildMetadata = createBuildMetadata(process.env, {
  commitSha: process.env.GITHUB_SHA?.trim() || getGitShaFallback() || undefined,
});

export default defineConfig({
  base: "/particle-sim/",
  define: {
    __APP_BUILD_METADATA__: JSON.stringify(buildMetadata),
  },
  resolve: {
    alias: {
      "@particle-sim/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
    },
  },
  plugins: [
    {
      name: "emit-version-json",
      writeBundle() {
        writeFileSync(resolve(rootDir, "dist", "version.json"), createVersionJson(buildMetadata));
      },
    },
  ],
});
