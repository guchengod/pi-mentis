import { mkdir } from "node:fs/promises";
import path from "node:path";

import { runCommand, writeJson } from "./common.mjs";

function parseEvents(output) {
  const events = [];
  for (const line of output.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Pi may interleave a diagnostic line; the raw log remains authoritative.
    }
  }
  return events;
}

function toolEvents(events) {
  return events.filter((event) =>
    ["tool_execution_start", "tool_execution_end", "tool_call", "tool_result"].includes(event.type),
  );
}

export class PiAcceptanceDriver {
  constructor(options) {
    this.options = options;
    this.sequence = 0;
  }

  async sendMessage({ prompt, sessionId, cwd, name, fork, timeoutMs = 5 * 60_000 }) {
    this.sequence++;
    await mkdir(this.options.sessionDir, { recursive: true, mode: 0o700 });
    const args = [
      "--mode",
      "json",
      "--print",
      "--session-dir",
      this.options.sessionDir,
      ...(fork === undefined ? ["--session-id", sessionId] : ["--fork", fork]),
      "--provider",
      this.options.provider,
      "--model",
      this.options.model,
      "--thinking",
      "low",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-builtin-tools",
      "--tools",
      "commit_memory,search_memory",
      ...(name === undefined ? [] : ["--name", name]),
      prompt,
    ];
    const stem = `${this.options.label ?? "pi"}-pi-cli-${String(this.sequence).padStart(3, "0")}`;
    const logFile = path.join(this.options.logs, `${stem}.jsonl`);
    const result = await runCommand("pi", args, {
      cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: this.options.piHome },
      timeoutMs,
      logFile,
      allowFailure: true,
      captureLimit: 32 * 1024 * 1024,
    });
    const events = parseEvents(result.output);
    const response = {
      sessionId,
      fork,
      prompt,
      cwd,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      logFile,
      events,
      toolEvents: toolEvents(events),
    };
    await writeJson(path.join(this.options.state, `${stem}.json`), response);
    return response;
  }
}
