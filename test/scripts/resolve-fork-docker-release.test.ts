// Fork Docker release tests lock release tags and image output to the package SemVer version.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveForkDockerRelease } from "../../scripts/resolve-fork-docker-release.mjs";

const revision = "a".repeat(40);

function resolveRelease(overrides: Record<string, string> = {}) {
  return resolveForkDockerRelease({
    created: "2026-07-12T13:40:00Z",
    imageName: "ghcr.io/rausserhq/openclaw",
    packageVersion: "2026.6.11",
    revision,
    sourceRef: "refs/tags/v2026.6.11",
    sourceRefName: "v2026.6.11",
    ...overrides,
  });
}

describe("resolveForkDockerRelease", () => {
  it("publishes one immutable vSemVer image tag with OCI version and revision labels", () => {
    expect(resolveRelease()).toEqual({
      imageTag: "ghcr.io/rausserhq/openclaw:v2026.6.11",
      labels: [
        `org.opencontainers.image.revision=${revision}`,
        "org.opencontainers.image.version=2026.6.11",
        "org.opencontainers.image.created=2026-07-12T13:40:00Z",
      ],
      releaseTag: "v2026.6.11",
    });
  });

  it("accepts SemVer prereleases when the package and tag match exactly", () => {
    const release = resolveRelease({
      packageVersion: "2026.6.15-alpha.1",
      sourceRef: "refs/tags/v2026.6.15-alpha.1",
      sourceRefName: "v2026.6.15-alpha.1",
    });

    expect(release.imageTag).toBe("ghcr.io/rausserhq/openclaw:v2026.6.15-alpha.1");
    expect(release.labels).toContain("org.opencontainers.image.version=2026.6.15-alpha.1");
  });

  it.each([
    ["main", "refs/heads/main", "main"],
    ["legacy fork tag", "refs/tags/rausser-2026.6.11", "rausser-2026.6.11"],
    ["mismatched version", "refs/tags/v2026.6.12", "v2026.6.12"],
  ])(
    "rejects %s instead of publishing mutable branch or legacy tags",
    (_case, sourceRef, sourceRefName) => {
      expect(() => resolveRelease({ sourceRef, sourceRefName })).toThrow(
        "Fork image publishing requires the exact release tag v2026.6.11",
      );
    },
  );

  it("rejects non-SemVer package versions and abbreviated revisions", () => {
    expect(() => resolveRelease({ packageVersion: "main" })).toThrow(
      "package version must be a valid SemVer",
    );
    expect(() => resolveRelease({ revision: "a".repeat(12) })).toThrow(
      "Git revision must be a full 40-character SHA",
    );
  });

  it("keeps the workflow tag-gated and collision-safe", () => {
    const workflow = readFileSync(".github/workflows/docker-publish.yml", "utf8");

    expect(workflow).toContain('- "v*"');
    expect(workflow).toContain("node scripts/resolve-fork-docker-release.mjs --github-output");
    expect(workflow).toContain('docker buildx imagetools inspect "${IMAGE_TAG}"');
    expect(workflow).toContain("Refusing to replace existing immutable release image");
    expect(workflow).toContain("Unable to confirm whether ${IMAGE_TAG} already exists");
    expect(workflow).not.toContain(":sha-");
    expect(workflow).not.toContain(":main");
    expect(workflow).not.toContain(":baseline");
  });
});
