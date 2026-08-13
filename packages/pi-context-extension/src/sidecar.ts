import {
  SIDECAR_PROTOCOL_VERSION,
  type SidecarEventMessage,
  type SidecarNotificationMessage,
  type SidecarRequestMessage,
  type SidecarResponseMessage,
} from "./sidecar-protocol.js";
import { MentisSidecarRuntime } from "./sidecar-runtime.js";

function send(message: SidecarResponseMessage | SidecarEventMessage): void {
  if (process.connected) process.send?.(message);
}

const runtime = new MentisSidecarRuntime((event) => {
  send({ type: "event", protocolVersion: SIDECAR_PROTOCOL_VERSION, event });
});

process.on("message", (value: SidecarRequestMessage | SidecarNotificationMessage) => {
  if (value.protocolVersion !== SIDECAR_PROTOCOL_VERSION) return;
  if (value.type === "notification") {
    if (value.notification.method === "shutdown") {
      void runtime.close().finally(() => {
        process.disconnect?.();
      });
      return;
    }
    runtime.notify(value.notification);
    return;
  }
  void runtime.request(value.request).then(
    (result) => {
      send({
        type: "response",
        id: value.id,
        protocolVersion: SIDECAR_PROTOCOL_VERSION,
        result,
      });
      if (value.request.method === "initialize") {
        send({
          type: "event",
          protocolVersion: SIDECAR_PROTOCOL_VERSION,
          event: { name: "ready", version: String(SIDECAR_PROTOCOL_VERSION) },
        });
      }
    },
    (error) => {
      send({
        type: "response",
        id: value.id,
        protocolVersion: SIDECAR_PROTOCOL_VERSION,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
});

process.on("disconnect", () => {
  void runtime.close().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void runtime.close().finally(() => process.exit(0));
});
