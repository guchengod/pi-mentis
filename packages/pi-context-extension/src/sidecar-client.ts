import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiPairwiseRelationshipReasoner } from "@pi-mentis/pi-mentis-pi-extension-support";

import {
  SIDECAR_PROTOCOL_VERSION,
  type MemoryCapsule,
  type PiScopeContext,
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

export interface MentisSidecarClientOptions {
  readonly requestTimeoutMs?: number;
  readonly onCapsule?: (capsule: MemoryCapsule) => void;
  readonly onWarning?: (message: string) => void;
  readonly onScopeContext?: (scopeContext: PiScopeContext) => void;
}

export class MentisSidecarClient {
  readonly #requestTimeoutMs: number;
  readonly #onCapsule: (capsule: MemoryCapsule) => void;
  readonly #onWarning: (message: string) => void;
  readonly #onScopeContext: (scopeContext: PiScopeContext) => void;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #notificationBacklog: SidecarNotification[] = [];
  readonly #reasonControllers = new Map<string, AbortController>();
  #child: ChildProcess | undefined;
  #sequence = 0;
  #ready = false;
  #initialized = false;
  #closed = false;
  #initialization: { readonly cwd: string; readonly piPackageRoot: string } | undefined;
  #initializing: Promise<void> | undefined;
  #sessionOpen: Extract<SidecarRequest, { readonly method: "session.open" }>["params"] | undefined;
  #reasonContext: Pick<ExtensionContext, "model" | "modelRegistry"> | undefined;

  constructor(options: MentisSidecarClientOptions = {}) {
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.#onCapsule = options.onCapsule ?? (() => undefined);
    this.#onWarning = options.onWarning ?? (() => undefined);
    this.#onScopeContext = options.onScopeContext ?? (() => undefined);
  }

  setReasonContext(context: Pick<ExtensionContext, "model" | "modelRegistry"> | undefined): void {
    this.#reasonContext = context;
  }

  cancelReasoning(): void {
    for (const controller of this.#reasonControllers.values()) controller.abort();
    this.#reasonControllers.clear();
  }

  async start(cwd: string, piPackageRoot: string): Promise<void> {
    if (this.#closed) throw new Error("Mentis sidecar client is closed");
    this.#initialization = { cwd, piPackageRoot };
    await this.#ensureInitialized();
  }

  async call<M extends SidecarRequest["method"]>(
    method: M,
    params: Extract<SidecarRequest, { readonly method: M }>["params"],
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<SidecarMethodResult<M>> {
    if (this.#closed) throw new Error("Mentis sidecar client is closed");
    if (method !== "initialize") await this.#ensureInitialized();
    const result = await this.#request({ method, params } as SidecarRequest, timeoutMs);
    if (method === "session.open") {
      this.#sessionOpen = params as Extract<
        SidecarRequest,
        { readonly method: "session.open" }
      >["params"];
    }
    return result as SidecarMethodResult<M>;
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
      this.#pending.set(id, {
        resolve,
        reject,
        timer,
      });
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

  notify(notification: SidecarNotification): void {
    if (this.#closed) return;
    if (notification.method === "input.activity") this.cancelReasoning();
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
    this.cancelReasoning();
    if (this.#child?.connected === true) {
      this.#send({
        type: "notification",
        protocolVersion: SIDECAR_PROTOCOL_VERSION,
        notification: { method: "shutdown", params: {} },
      });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        this.#child?.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.#child?.kill();
    this.#child = undefined;
    this.#rejectPending(new Error("Mentis sidecar closed"));
  }

  #spawn(): void {
    const entry = fileURLToPath(new URL("./sidecar.js", import.meta.url));
    const child = fork(entry, [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, PI_MENTIS_SIDECAR: "1" },
      // Pi may run with loader/debug/input flags that are valid only for its
      // own entrypoint. The sidecar is a compiled standalone program.
      execArgv: [],
      serialization: "advanced",
    });
    this.#child = child;
    this.#ready = false;
    this.#initialized = false;
    child.on("message", (value) => this.#handle(value as SidecarInboundMessage));
    child.on("error", (error) => this.#onWarning(`Mentis sidecar error: ${error.message}`));
    child.on("exit", (code, signal) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      this.#ready = false;
      this.#initialized = false;
      this.#initializing = undefined;
      this.#rejectPending(
        new Error(`Mentis sidecar exited (${code ?? "signal"}${signal ? `:${signal}` : ""})`),
      );
      if (!this.#closed) this.#onWarning("Mentis sidecar stopped; it will restart on demand.");
    });
  }

  #send(message: SidecarOutboundMessage, onError?: (error?: Error) => void): void {
    const child = this.#child;
    if (child?.connected !== true) {
      onError?.(new Error("Mentis sidecar is not connected"));
      return;
    }
    child.send(message, (error) => onError?.(error ?? undefined));
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
    if (message.event.name === "ready") {
      this.#ready = true;
      const queued = this.#notificationBacklog.splice(0);
      for (const notification of queued) this.notify(notification);
      return;
    }
    if (message.event.name === "capsule.updated") {
      this.#onCapsule(message.event.capsule);
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
    void this.#reason(message.event);
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

  async #ensureInitialized(): Promise<void> {
    if (this.#initialized) return;
    if (this.#initializing !== undefined) return this.#initializing;
    const initialization = this.#initialization;
    if (initialization === undefined) {
      throw new Error("Mentis sidecar initialization is unavailable");
    }
    if (this.#child === undefined) this.#spawn();
    this.#initializing = this.#request({ method: "initialize", params: initialization }, 30_000)
      .then(async () => {
        this.#initialized = true;
        if (this.#sessionOpen !== undefined) {
          await this.#request({ method: "session.open", params: this.#sessionOpen }, 30_000);
        }
      })
      .finally(() => {
        this.#initializing = undefined;
      });
    return this.#initializing;
  }
}
