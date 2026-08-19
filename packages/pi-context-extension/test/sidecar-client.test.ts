import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({ fork: vi.fn() }));

vi.mock("node:child_process", () => ({ fork: childProcessMock.fork }));

import { MentisSidecarClient } from "../src/sidecar-client.js";
import type { SidecarOutboundMessage } from "../src/sidecar-protocol.js";

class FakeChild extends EventEmitter {
  readonly messages: SidecarOutboundMessage[] = [];
  readonly pid: number;
  connected = true;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  send(message: SidecarOutboundMessage, callback?: (error: Error | null) => void): void {
    this.messages.push(message);
    callback?.(null);
    if (message.type !== "request") return;
    const result =
      message.request.method === "initialize"
        ? { ready: true, protocolVersion: 1 }
        : message.request.method === "session.open"
          ? {
              scopeContext: {
                tenantId: "local",
                userId: "local",
                appId: "pi",
                agentId: "pi-mentis",
                sessionId: message.request.params.clientSessionId,
                branchId: message.request.params.branchId,
              },
            }
          : { ready: true };
    queueMicrotask(() => {
      this.emit("message", {
        type: "response",
        id: message.id,
        protocolVersion: 1,
        result,
      });
    });
  }

  kill(): boolean {
    if (!this.connected) return false;
    this.exit(0, "SIGTERM");
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.connected = false;
    this.emit("exit", code, signal);
  }
}

const session = {
  clientSessionId: "session-1",
  cwd: "/workspace",
  branchId: "root",
  sessionMode: "persistent" as const,
};

async function eventually(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe("Mentis Sidecar lifecycle", () => {
  it("accepts immutable active-context snapshots without requesting foreground I/O", async () => {
    const child = new FakeChild(9_999);
    childProcessMock.fork.mockReturnValue(child);
    const snapshots: unknown[] = [];
    const client = new MentisSidecarClient({
      onActiveContext: (_sessionId, snapshot) => snapshots.push(snapshot),
    });
    await client.start(session.cwd, "/pi", session);
    child.emit("message", {
      type: "event",
      protocolVersion: 1,
      event: {
        name: "active-context.updated",
        clientSessionId: "session-1",
        snapshot: {
          version: 1,
          stateId: "working-1",
          namespace: "local:local:pi:pi-mentis",
          sessionId: "session-1",
          branchId: "root",
          revision: 2,
          generatedAt: 10,
          content: "<pi-mentis-active-context />",
          estimatedTokens: 12,
          recalledMemoryIds: [],
          artifactRefs: [],
        },
      },
    });
    expect(snapshots).toEqual([expect.objectContaining({ stateId: "working-1", revision: 2 })]);
    await client.close();
  });

  it("single-flights concurrent starts and opens the session once", async () => {
    const children: FakeChild[] = [];
    childProcessMock.fork.mockImplementation(() => {
      const child = new FakeChild(10_000 + children.length);
      children.push(child);
      return child;
    });
    const states: string[] = [];
    const client = new MentisSidecarClient({ onStateChange: (state) => states.push(state) });

    const [left, right] = await Promise.all([
      client.start(session.cwd, "/pi", session),
      client.start(session.cwd, "/pi", session),
    ]);

    expect(left?.scopeContext.branchId).toBe("root");
    expect(right?.scopeContext.branchId).toBe("root");
    expect(children).toHaveLength(1);
    expect(
      children[0]?.messages.filter(
        (message) => message.type === "request" && message.request.method === "session.open",
      ),
    ).toHaveLength(1);
    expect(client.state).toBe("ready");
    expect(states).toEqual(["starting", "ready"]);

    await client.close();
    expect(client.state).toBe("closed");
  });

  it("automatically restarts, restores the latest branch, then flushes notifications", async () => {
    const children: FakeChild[] = [];
    childProcessMock.fork.mockImplementation(() => {
      const child = new FakeChild(20_000 + children.length);
      children.push(child);
      return child;
    });
    const client = new MentisSidecarClient({
      restartBaseDelayMs: 10,
      restartMaxDelayMs: 20,
    });
    await client.start(session.cwd, "/pi", session);

    children[0]?.exit(1);
    client.notify({
      method: "session.branch",
      params: { clientSessionId: session.clientSessionId, branchId: "feature" },
    });
    client.notify({
      method: "input.activity",
      params: { clientSessionId: session.clientSessionId },
    });

    await eventually(() => children.length === 2 && client.state === "ready");
    const restarted = children[1];
    expect(restarted).toBeDefined();
    const openIndex = restarted?.messages.findIndex(
      (message) => message.type === "request" && message.request.method === "session.open",
    );
    const activityIndex = restarted?.messages.findIndex(
      (message) =>
        message.type === "notification" && message.notification.method === "input.activity",
    );
    const openMessage = restarted?.messages[openIndex ?? -1];
    expect(openMessage?.type).toBe("request");
    if (openMessage?.type === "request" && openMessage.request.method === "session.open") {
      expect(openMessage.request.params.branchId).toBe("feature");
    }
    expect(openIndex).toBeGreaterThanOrEqual(0);
    expect(activityIndex).toBeGreaterThan(openIndex ?? -1);
    expect(children).toHaveLength(2);

    await client.close();
  });
});
