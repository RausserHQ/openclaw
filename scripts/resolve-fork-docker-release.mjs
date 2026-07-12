#!/usr/bin/env node
// Resolves the fork's immutable Docker release metadata from an exact SemVer Git tag.
import { appendFileSync, readFileSync } from "node:fs";

const SEMVER_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function resolveForkDockerRelease(params) {
  const packageVersion = requireSemver(params.packageVersion, "package version");
  const expectedTag = `v${packageVersion}`;
  if (typeof params.imageName !== "string" || !params.imageName.startsWith("ghcr.io/rausserhq/")) {
    throw new Error("Fork image name must be under ghcr.io/rausserhq/.");
  }

  if (params.sourceRef !== `refs/tags/${expectedTag}` || params.sourceRefName !== expectedTag) {
    throw new Error(
      `Fork image publishing requires the exact release tag ${expectedTag}; received ${params.sourceRef}.`,
    );
  }
  if (!/^[0-9a-f]{40}$/iu.test(params.revision)) {
    throw new Error("Git revision must be a full 40-character SHA.");
  }

  return {
    imageTag: `${params.imageName}:${expectedTag}`,
    labels: [
      `org.opencontainers.image.revision=${params.revision}`,
      `org.opencontainers.image.version=${packageVersion}`,
      `org.opencontainers.image.created=${params.created}`,
    ],
    releaseTag: expectedTag,
  };
}

function requireSemver(value, label) {
  if (typeof value !== "string" || !SEMVER_VERSION.test(value)) {
    throw new Error(`${label} must be a valid SemVer version; received ${JSON.stringify(value)}.`);
  }
  return value;
}

function writeGitHubOutput(outputPath, release) {
  const output = [
    `image_tag=${release.imageTag}`,
    "labels<<EOF",
    ...release.labels,
    "EOF",
    `release_tag=${release.releaseTag}`,
    "",
  ].join("\n");
  if (outputPath) {
    appendFileSync(outputPath, output, "utf8");
    return;
  }
  process.stdout.write(output);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const packageVersion = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).version;
  const release = resolveForkDockerRelease({
    created: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
    imageName: process.env.IMAGE_NAME,
    packageVersion,
    revision: process.env.GITHUB_SHA,
    sourceRef: process.env.SOURCE_REF,
    sourceRefName: process.env.SOURCE_REF_NAME,
  });
  writeGitHubOutput(
    process.argv[2] === "--github-output" ? process.env.GITHUB_OUTPUT : undefined,
    release,
  );
}
