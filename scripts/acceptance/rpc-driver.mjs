import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { clearTimeout, setTimeout } from "node:timers";

import { writeJson } from "./common.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export class PiRpcAcceptanceDriver {
  constructor(options) {
    this.options = options;
    this.events = [];
    this.stderr = "";
    this.pending = new Map();
    this.sequence = 0;
    this.waiters = new Set();
  }

  async start() {
    await mkdir(this.options.sessionDir, { recursive: true, mode: 0o700 });
    const args = [
      "--mode",
      "rpc",
      "--session-dir",
      this.options.sessionDir,
      "--session-id",
      this.options.sessionId,
      "--provider",
      this.options.provider,
      "--model",
      this.options.model,
      "--thinking",
      "low",
      "--no-context-files",
      "--no-prompt-templates",
      "--no-themes",
      "--no-builtin-tools",
      ...(this.options.noExtensions === true
        ? ["--no-extensions"]
        : [
            "--tools",
            (this.options.tools ?? ["bash", "commit_memory", "search_memory"]).join(","),
          ]),
      ...(this.options.discoverSkills === true
        ? []
        : this.options.skill === undefined
          ? ["--no-skills"]
          : ["--skill", this.options.skill]),
      ...(this.options.name === undefined ? [] : ["--name", this.options.name]),
    ];
    this.startedAt = Date.now();
    this.process = spawn("pi", args, {
      cwd: this.options.cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: this.options.piHome },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exit = deferred();
    this.process.once("error", (error) => this.exit.reject(error));
    this.process.once("exit", (code, signal) => {
      const result = { code, signal };
      this.exit.resolve(result);
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`Pi RPC exited before response: ${JSON.stringify(result)}`));
      }
      this.pending.clear();
      this.#notifyWaiters();
    });
    this.#attachReader(this.process.stdout);
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    await this.command({ type: "get_state" }, 30_000);
    return this;
  }

  #attachReader(stream) {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    const acceptLine = (raw) => {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line.trim() === "") return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        event = { type: "rpc_unparsed_output", line };
      }
      event.acceptanceObservedAt = new Date().toISOString();
      this.events.push(event);
      if (event.type === "response" && typeof event.id === "string") {
        const pending = this.pending.get(event.id);
        if (pending !== undefined) {
          this.pending.delete(event.id);
          if (event.success === false)
            pending.reject(new Error(event.error ?? JSON.stringify(event)));
          else pending.resolve(event);
        }
      }
      this.#notifyWaiters();
    };
    stream.on("data", (chunk) => {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        acceptLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    stream.on("end", () => {
      buffer += decoder.end();
      if (buffer !== "") acceptLine(buffer);
    });
  }

  #notifyWaiters() {
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }

  async command(command, timeoutMs = 5 * 60_000) {
    if (this.process === undefined || this.process.exitCode !== null) {
      throw new Error("Pi RPC process is not running");
    }
    const id = command.id ?? `acceptance-rpc-${++this.sequence}`;
    const pending = deferred();
    this.pending.set(id, pending);
    this.process.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    let timer;
    try {
      return await Promise.race([
        pending.promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Pi RPC command timed out: ${command.type}`)),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  async waitForEvent(predicate, { from = 0, timeoutMs = 5 * 60_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.events.findIndex(
        (event, eventIndex) => eventIndex >= from && predicate(event),
      );
      if (index >= 0) return { event: this.events[index], index };
      if (this.process?.exitCode !== null) throw new Error("Pi RPC exited while waiting for event");
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Timed out waiting for Pi RPC event");
      await new Promise((resolve) => {
        const timer = setTimeout(
          () => {
            this.waiters.delete(wake);
            resolve();
          },
          Math.min(remaining, 1_000),
        );
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        this.waiters.add(wake);
      });
    }
  }

  async prompt(message, timeoutMs = 5 * 60_000) {
    const from = this.events.length;
    const response = await this.command({ type: "prompt", message }, 30_000);
    const settled = await this.waitForEvent((event) => event.type === "agent_settled", {
      from,
      timeoutMs,
    });
    return { response, settled, events: this.events.slice(from) };
  }

  async stop() {
    if (this.process === undefined) return;
    if (this.process.exitCode === null) this.process.stdin.end();
    let timer;
    let exit;
    try {
      exit = await Promise.race([
        this.exit.promise,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(undefined), 10_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (exit === undefined && this.process.exitCode === null) {
      this.process.kill("SIGTERM");
      exit = await this.exit.promise;
    }
    const evidence = {
      startedAt: new Date(this.startedAt).toISOString(),
      stoppedAt: new Date().toISOString(),
      args: this.process.spawnargs.map((value) =>
        value.includes("API_KEY") ? "[REDACTED]" : value,
      ),
      exit,
      stderr: this.stderr,
      events: this.events,
    };
    await writeJson(this.options.evidenceFile, evidence);
    await writeFile(
      this.options.logFile,
      `${this.events.map((event) => JSON.stringify(event)).join("\n")}\n${this.stderr}`,
      { mode: 0o600 },
    );
    return evidence;
  }
}
