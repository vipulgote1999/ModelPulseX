import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** specs/execution-status.yaml is a DERIVED view, not a ledger of its own.
 *  Source of truth: the epic capsules at specs/epics/<id>-<slug>/epic.yaml.
 *  Epic ids and order come from specs/release-plan.yaml, whose status must agree
 *  with the capsule. This test fails whenever those three files disagree.
 *
 *  No YAML dependency: only the handful of keys this ledger uses are parsed, and
 *  a capsule missing epic/slug/status or a story status throws instead of
 *  silently producing a false match. */

const SPECS = fileURLToPath(new URL("../specs", import.meta.url));

const HEADER = [
  "# DERIVED VIEW — do not edit by hand.",
  "# Source of truth: specs/epics/<id>-<slug>/epic.yaml (epic status + story ids/statuses).",
  "# Epic ids and order come from specs/release-plan.yaml; an epic without a capsule is pending.",
  "# Kept in sync by test/spec-status-consistency.test.ts — npm test fails on any disagreement.",
];

interface CapsuleStory {
  id: string;
  status: string;
}

interface Capsule {
  id: string;
  slug: string;
  status: string;
  stories: CapsuleStory[];
  dir: string;
}

interface PlannedEpic {
  id: string;
  status: string;
}

function specFile(relative: string): string {
  return readFileSync(join(SPECS, relative), "utf8").replace(/\r\n/g, "\n");
}

function readCapsules(): Capsule[] {
  const root = join(SPECS, "epics");
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return dirs.map((dir) => {
    const text = specFile(join("epics", dir, "epic.yaml"));
    let id = "";
    let slug = "";
    let status = "";
    const stories: CapsuleStory[] = [];
    let story: CapsuleStory | null = null;
    for (const line of text.split("\n")) {
      const top = /^(epic|slug|status): (\S+)$/.exec(line);
      if (top) {
        if (top[1] === "epic") id = top[2];
        else if (top[1] === "slug") slug = top[2];
        else status = top[2];
        continue;
      }
      const opened = /^ {2}- id: (\S+)$/.exec(line);
      if (opened) {
        story = { id: opened[1], status: "" };
        stories.push(story);
        continue;
      }
      const closed = /^ {4}status: (\S+)$/.exec(line);
      if (closed && story) story.status = closed[1];
    }
    if (!id || !slug || !status) {
      throw new Error(
        `specs/epics/${dir}/epic.yaml: epic/slug/status must be top-level scalars`,
      );
    }
    for (const s of stories) {
      if (!s.status) {
        throw new Error(
          `specs/epics/${dir}/epic.yaml: story ${s.id} has no 4-space-indented status`,
        );
      }
    }
    return { id, slug, status, stories, dir };
  });
}

function readReleasePlan(): PlannedEpic[] {
  const epics: PlannedEpic[] = [];
  let current: PlannedEpic | null = null;
  for (const line of specFile("release-plan.yaml").split("\n")) {
    const opened = /^ {2}- id: (\S+)$/.exec(line);
    if (opened) {
      current = { id: opened[1], status: "" };
      epics.push(current);
      continue;
    }
    const closed = /^ {4}status: (\S+)$/.exec(line);
    if (closed && current) current.status = closed[1];
  }
  if (epics.length === 0) {
    throw new Error("specs/release-plan.yaml: no epics found at 2-space indent");
  }
  for (const epic of epics) {
    if (!epic.status) {
      throw new Error(`specs/release-plan.yaml: epic ${epic.id} has no status`);
    }
  }
  return epics;
}

function renderExecutionStatus(
  release: PlannedEpic[],
  capsules: Capsule[],
): string {
  const byId = new Map(capsules.map((capsule) => [capsule.id, capsule]));
  const lines = [...HEADER, "epics:"];
  for (const epic of release) {
    const capsule = byId.get(epic.id);
    lines.push(`  ${epic.id}:`);
    lines.push(`    status: ${capsule ? capsule.status : epic.status}`);
    if (!capsule || capsule.stories.length === 0) {
      lines.push("    stories: {}");
      continue;
    }
    lines.push("    stories:");
    for (const story of capsule.stories) {
      lines.push(`      ${story.id}: ${story.status}`);
    }
  }
  return lines.join("\n") + "\n";
}

describe("spec status ledger", () => {
  const capsules = readCapsules();
  const release = readReleasePlan();

  it("execution-status.yaml matches the epic capsules", () => {
    const derived = renderExecutionStatus(release, capsules);
    expect(
      specFile("execution-status.yaml"),
      "specs/execution-status.yaml disagrees with specs/epics/*/epic.yaml",
    ).toBe(derived);
  });

  it("release-plan status mirrors the epic capsule", () => {
    const byId = new Map(capsules.map((capsule) => [capsule.id, capsule]));
    for (const epic of release) {
      const capsule = byId.get(epic.id);
      expect(
        capsule?.status ?? epic.status,
        `specs/release-plan.yaml epic ${epic.id} status vs its capsule`,
      ).toBe(epic.status);
    }
  });

  it("wires every capsule to a release-plan epic in <id>-<slug> form", () => {
    const planned = new Set(release.map((epic) => epic.id));
    for (const capsule of capsules) {
      expect(planned.has(capsule.id), `capsule ${capsule.id} is not in the release plan`).toBe(true);
      expect(capsule.dir, `capsule directory for ${capsule.id}`).toBe(
        `${capsule.id}-${capsule.slug}`,
      );
    }
  });

  it("only marks a capsule-less epic pending", () => {
    const withCapsule = new Set(capsules.map((capsule) => capsule.id));
    for (const epic of release) {
      if (!withCapsule.has(epic.id)) {
        expect(epic.status, `capsule-less epic ${epic.id} must stay pending`).toBe("pending");
      }
    }
  });
});
