import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkingMemorySnapshot } from "@pi-mentis/pi-mentis-memory-core";
import {
  createPiCognitionReasoner,
  createPiPairwiseRelationshipReasoner,
} from "@pi-mentis/pi-mentis-pi-extension-support";

import {
  SIDECAR_PROTOCOL_VERSION,
  type MemoryCapsule,
  type PiScopeContext,
  type SessionOpenResult,
  type SidecarEventMessage,
  type SidecarInboundMessage,
  type SidecarMethodResult,
  type SidecarNotification,
  type SidecarOutboundMessage,
  type SidecarRequest,
} from "./sidecar-protocol.js";

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

type SessionOpenParams = Extract<SidecarRequest, { readonly method: "session.open" }>["params"];

export type MentisSidecarLifecycleState =
  "stopped" | "starting" | "ready" | "restarting" | "stopping" | "closed";

export interface MentisSidecarClientOptions {
  readonly requestTimeoutMs?: number;
  readonly restartBaseDelayMs?: number;
  readonly restartMaxDelayMs?: number;
  readonly onCapsule?: (capsule: MemoryCapsule) => void;
  readonly onActiveContext?: (clientSessionId: string, snapshot: WorkingMemorySnapshot) => void;
  readonly onWarning?: (message: string) => void;
  readonly onScopeContext?: (scopeContext: PiScopeContext) => void;
  readonly onStateChange?: (state: MentisSidecarLifecycleState) => void;
}

function sessionKey(input: SessionOpenParams | undefined): string | undefined {
  if (input === undefined) return undefined;
  return JSON.stringify([
    input.clientSessionId,
    input.cwd,
    input.branchId,
    input.parentBranchId ?? "",
    input.sessionMode,
  ]);
}

export class MentisSidecarClient {
  readonly #requestTimeoutMs: number;
  readonly #restartBaseDelayMs: number;
  readonly #restartMaxDelayMs: number;
  readonly #onCapsule: (capsule: MemoryCapsule) => void;
  readonly #onActiveContext: (clientSessionId: string, snapshot: WorkingMemorySnapshot) => void;
  readonly #onWarning: (message: string) => void;
  readonly #onScopeContext: (scopeContext: PiScopeContext) => void;
  readonly #onStateChange: (state: MentisSidecarLifecycleState) => void;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #notificationBacklog: SidecarNotification[] = [];
  readonly #reasonControllers = new Map<string, AbortController>();
  #child: ChildProcess | undefined;
  #sequence = 0;
  #ready = false;
  #initialized = false;
  #closed = false;
  #desiredRunning = false;
  #restartAttempt = 0;
  #restartTimer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<SessionOpenResult | undefined> | undefined;
  #state: MentisSidecarLifecycleState = "stopped";
  #initialization: { readonly cwd: string; readonly piPackageRoot: string } | undefined;
  #sessionOpen: SessionOpenParams | undefined;
  #activeSessionKey: string | undefined;
  #lastSessionOpenResult: SessionOpenResult | undefined;
  #reasonContext: Pick<ExtensionContext, "model" | "modelRegistry"> | undefined;

  constructor(options: MentisSidecarClientOptions = {}) {
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.#restartBaseDelayMs = Math.max(10, options.restartBaseDelayMs ?? 250);
    this.#restartMaxDelayMs = Math.max(
      this.#restartBaseDelayMs,
      options.restartMaxDelayMs ?? 5_000,
    );
    this.#onCapsule = options.onCapsule ?? (() => undefined);
    this.#onActiveContext = options.onActiveContext ?? (() => undefined);
    this.#onWarning = options.onWarning ?? (() => undefined);
    this.#onScopeContext = options.onScopeContext ?? (() => undefined);
    this.#onStateChange = options.onStateChange ?? (() => undefined);
  }

  get state(): MentisSidecarLifecycleState {
    return this.#state;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  setReasonContext(context: Pick<ExtensionContext, "model" | "modelRegistry"> | undefined): void {
    this.#reasonContext = context;
  }

  cancelReasoning(): void {
    for (const controller of this.#reasonControllers.values()) controller.abort();
    this.#reasonControllers.clear();
  }

  /**
   * Start one Sidecar for this extension instance and open its current Pi session.
   * Concurrent callers share the same start/restart promise, so they cannot fork duplicates.
   */
  async start(
    cwd: string,
    piPackageRoot: string,
    sessionOpen?: SessionOpenParams,
  ): Promise<SessionOpenResult | undefined> {
    if (this.#closed) throw new Error("Mentis sidecar client is closed");
    this.#desiredRunning = true;
    this.#initialization = { cwd, piPackageRoot };
    if (sessionOpen !== undefined) this.#sessionOpen = sessionOpen;
    this.#clearRestartTimer();
    return await this.#ensureRunning();
  }

  async call<M extends SidecarRequest["method"]>(
    method: M,
    params: Extract<SidecarRequest, { readonly method: M }>["params"],
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<SidecarMethodResult<M>> {
    if (this.#closed) throw new Error("Mentis sidecar client is closed");
    if (method === "session.open") {
      this.#sessionOpen = params as SessionOpenParams;
    }
    if (method !== "initialize") {
      this.#desiredRunning = true;
      await this.#ensureRunning();
    }
    if (method === "session.open") {
      const result = await this.#ensureSessionOpen();
      return result as SidecarMethodResult<M>;
    }
    return (await this.#request(
      { method, params } as SidecarRequest,
      timeoutMs,
    )) as SidecarMethodResult<M>;
  }

  notify(notification: SidecarNotification): void {
    if (this.#closed) return;
    if (notification.method === "input.activity") this.cancelReasoning();
    if (
      notification.method === "session.branch" &&
      this.#sessionOpen?.clientSessionId === notification.params.clientSessionId
    ) {
      this.#sessionOpen = {
        clientSessionId: this.#sessionOpen.clientSessionId,
        cwd: this.#sessionOpen.cwd,
        sessionMode: this.#sessionOpen.sessionMode,
        branchId: notification.params.branchId,
        ...(notification.params.parentBranchId === undefined
          ? {}
          : { parentBranchId: notification.params.parentBranchId }),
      };
      if (this.#ready) this.#activeSessionKey = sessionKey(this.#sessionOpen);
    }
    if (this.#child === undefined || !this.#ready) {
      this.#notificationBacklog.push(notification);
      if (this.#notificationBacklog.length > 512) this.#notificationBacklog.shift();
      return;
    }
    this.#send({
      type: "notification",
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      notification,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#desiredRunning = false;
    this.#setState("stopping");
    this.#clearRestartTimer();
    this.cancelReasoning();
    const child = this.#child;
    if (child?.connected === true) {
      this.#send({
        type: "notification",
        protocolVersion: SIDECAR_PROTOCOL_VERSION,
        notification: { method: "shutdown", params: {} },
      });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    child?.kill();
    this.#child = undefined;
    this.#ready = false;
    this.#initialized = false;
    this.#activeSessionKey = undefined;
    this.#notificationBacklog.length = 0;
    this.#rejectPending(new Error("Mentis sidecar closed"));
    this.#setState("closed");
  }

  async #ensureRunning(): Promise<SessionOpenResult | undefined> {
    const desiredSessionKey = sessionKey(this.#sessionOpen);
    if (
      this.#ready &&
      this.#initialized &&
      this.#child?.connected === true &&
      this.#activeSessionKey === desiredSessionKey
    ) {
      return this.#lastSessionOpenResult;
    }
    if (this.#running !== undefined) {
      await this.#running;
      if (this.#activeSessionKey !== sessionKey(this.#sessionOpen)) {
        return await this.#ensureRunning();
      }
      return this.#lastSessionOpenResult;
    }
    const initialization = this.#initialization;
    if (initialization === undefined) {
      throw new Error("Mentis sidecar initialization is unavailable");
    }
    this.#setState(this.#restartAttempt > 0 ? "restarting" : "starting");
    this.#running = (async () => {
      if (this.#child === undefined) this.#spawn();
      if (!this.#initialized) {
        await this.#request({ method: "initialize", params: initialization }, 30_000);
        this.#initialized = true;
      }
      const opened = await this.#ensureSessionOpen();
      this.#ready = true;
      this.#restartAttempt = 0;
      this.#setState("ready");
      this.#flushNotifications();
      return opened;
    })().finally(() => {
      this.#running = undefined;
    });
    try {
      const opened = await this.#running;
      if (this.#activeSessionKey !== sessionKey(this.#sessionOpen)) {
        return await this.#ensureRunning();
      }
      return opened;
    } catch (error) {
      this.#ready = false;
      throw error;
    }
  }

  async #ensureSessionOpen(): Promise<SessionOpenResult | undefined> {
    const input = this.#sessionOpen;
    const key = sessionKey(input);
    if (input === undefined || key === undefined) return undefined;
    if (this.#activeSessionKey === key) return this.#lastSessionOpenResult;
    const result = (await this.#request(
      { method: "session.open", params: input },
      30_000,
    )) as SessionOpenResult;
    if (sessionKey(this.#sessionOpen) === key) {
      this.#activeSessionKey = key;
      this.#lastSessionOpenResult = result;
      this.#onScopeContext(result.scopeContext);
      if (result.capsule !== undefined) this.#onCapsule(result.capsule);
    }
    return result;
  }

  async #request(request: SidecarRequest, timeoutMs: number): Promise<unknown> {
    if (this.#child === undefined) this.#spawn();
    const id = `rpc:${process.pid}:${++this.#sequence}`;
    const method = request.method;
    const message: SidecarOutboundMessage = {
      type: "request",
      id,
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      request,
    };
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Mentis sidecar ${method} exceeded ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      this.#send(message, (error) => {
        if (error === undefined) return;
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending.reject(error);
      });
    });
  }

  #spawn(): void {
    if (this.#child !== undefined) return;
    const entry = fileURLToPath(new URL("./sidecar.js", import.meta.url));
    let stderr = "";
    const child = fork(entry, [], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, PI_MENTIS_SIDECAR: "1" },
      // Pi may run with loader/debug/input flags that are valid only for its
      // own entrypoint. The Sidecar is a compiled standalone program.
      execArgv: [],
      serialization: "advanced",
    });
    this.#child = child;
    this.#ready = false;
    this.#initialized = false;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 4_096) stderr = `${stderr}${chunk}`.slice(0, 4_096);
    });
    child.on("message", (value) => this.#handle(value as SidecarInboundMessage));
    child.on("error", (error) => this.#onWarning(`Mentis sidecar error: ${error.message}`));
    child.on("exit", (code, signal) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      this.#ready = false;
      this.#initialized = false;
      this.#activeSessionKey = undefined;
      this.#lastSessionOpenResult = undefined;
      const diagnostic = stderr.trim().replaceAll(/\s+/gu, " ").slice(0, 800);
      this.#rejectPending(
        new Error(
          `Mentis sidecar exited (${code ?? "signal"}${signal ? `:${signal}` : ""})${
            diagnostic === "" ? "" : `: ${diagnostic}`
          }`,
        ),
      );
      if (!this.#closed && this.#desiredRunning) {
        this.#onWarning("Mentis sidecar stopped unexpectedly; automatic restart is scheduled.");
        this.#scheduleRestart();
      }
    });
  }

  #scheduleRestart(): void {
    if (this.#closed || !this.#desiredRunning || this.#restartTimer !== undefined) return;
    this.#restartAttempt++;
    this.#setState("restarting");
    const delay = Math.min(
      this.#restartMaxDelayMs,
      this.#restartBaseDelayMs * 2 ** Math.min(6, this.#restartAttempt - 1),
    );
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      void this.#ensureRunning().catch((error) => {
        if (this.#closed || !this.#desiredRunning) return;
        this.#onWarning(
          `Mentis sidecar restart failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.#scheduleRestart();
      });
    }, delay);
    this.#restartTimer.unref?.();
  }

  #clearRestartTimer(): void {
    if (this.#restartTimer !== undefined) clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
  }

  #flushNotifications(): void {
    if (!this.#ready) return;
    const queued = this.#notificationBacklog.splice(0);
    for (const notification of queued) this.notify(notification);
  }

  #send(message: SidecarOutboundMessage, onError?: (error?: Error) => void): void {
    const child = this.#child;
    if (child?.connected !== true) {
      onError?.(new Error("Mentis sidecar is not connected"));
      return;
    }
    try {
      child.send(message, (error) => onError?.(error ?? undefined));
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #handle(message: SidecarInboundMessage): void {
    if (message.protocolVersion !== SIDECAR_PROTOCOL_VERSION) {
      this.#onWarning("Mentis sidecar protocol mismatch");
      return;
    }
    if (message.type === "response") {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error === undefined) pending.resolve(message.result);
      else pending.reject(new Error(message.error));
      return;
    }
    this.#handleEvent(message);
  }

  #handleEvent(message: SidecarEventMessage): void {
    if (message.event.name === "ready") return;
    if (message.event.name === "capsule.updated") {
      this.#onCapsule(message.event.capsule);
      return;
    }
    if (message.event.name === "active-context.updated") {
      this.#onActiveContext(message.event.clientSessionId, message.event.snapshot);
      return;
    }
    if (message.event.name === "context.updated") {
      this.#onScopeContext(message.event.scopeContext);
      return;
    }
    if (message.event.name === "warning") {
      this.#onWarning(message.event.message);
      return;
    }
    if (message.event.name === "cognition.cancel") {
      this.#reasonControllers.get(message.event.requestId)?.abort("Sidecar cognition cancelled");
      return;
    }
    if (message.event.name === "reason.request") void this.#reason(message.event);
    else void this.#cognition(message.event);
  }

  async #cognition(
    event: Extract<SidecarEventMessage["event"], { name: "cognition.request" }>,
  ): Promise<void> {
    const context = this.#reasonContext;
    const reasoner = context === undefined ? undefined : createPiCognitionReasoner(context);
    if (reasoner === undefined) {
      this.notify({
        method: "cognition.response",
        params: { requestId: event.requestId, error: "Pi model unavailable" },
      });
      return;
    }
    const controller = new AbortController();
    this.#reasonControllers.set(event.requestId, controller);
    try {
      const result = await reasoner.complete(
        { task: event.task, payload: event.payload, maxOutputTokens: event.maxOutputTokens },
        controller.signal,
      );
      this.notify({ method: "cognition.response", params: { requestId: event.requestId, result } });
    } catch (error) {
      this.notify({
        method: "cognition.response",
        params: {
          requestId: event.requestId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      this.#reasonControllers.delete(event.requestId);
    }
  }

  async #reason(event: Extract<SidecarEventMessage["event"], { name: "reason.request" }>) {
    const context = this.#reasonContext;
    const reasoner =
      context === undefined ? undefined : createPiPairwiseRelationshipReasoner(context);
    if (reasoner === undefined) {
      this.notify({
        method: "reason.response",
        params: { requestId: event.requestId, error: "Pi model unavailable" },
      });
      return;
    }
    const controller = new AbortController();
    this.#reasonControllers.set(event.requestId, controller);
    try {
      const result = await reasoner.judge(
        event.incomingContent,
        event.candidate,
        controller.signal,
      );
      this.notify({
        method: "reason.response",
        params: { requestId: event.requestId, result },
      });
    } catch (error) {
      this.notify({
        method: "reason.response",
        params: {
          requestId: event.requestId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      this.#reasonControllers.delete(event.requestId);
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #setState(state: MentisSidecarLifecycleState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#onStateChange(state);
  }
}
