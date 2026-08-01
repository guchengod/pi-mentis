import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { normalizeRemote, resolvePiProjectIdentity } from "../src/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-mentis-identity-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("faceted workspace identity", () => {
  it.each([
    ["git@github.com:OpenAI/example.git", "github.com/openai/example"],
    ["ssh://git@github.com/OpenAI/example.git", "github.com/openai/example"],
    ["https://github.com/OpenAI/example.git", "github.com/openai/example"],
  ])("normalizes %s", (remote, expected) => {
    expect(normalizeRemote(remote)).toBe(expected);
  });

  it("does not invent repository or project identity in a general-purpose directory", async () => {
    const directory = await temporaryDirectory();
    const identity = await resolvePiProjectIdentity(directory);

    expect(identity).toEqual({ workspacePath: directory, manifestTypes: [] });
  });

  it("uses an explicit project identity before repository metadata", async () => {
    const directory = await temporaryDirectory();
    await mkdir(path.join(directory, ".git"));
    await writeFile(
      path.join(directory, ".git", "config"),
      '[remote "origin"]\n\turl = git@github.com:OpenAI/example.git\n',
    );
    const identity = await resolvePiProjectIdentity(directory, "personal-memory");

    expect(identity.repositoryId).toMatch(/^repo:explicit:/);
    expect(identity.projectId).toMatch(/^project:explicit:/);
    expect(identity.gitRemote).toBe("github.com/openai/example");
  });
});
