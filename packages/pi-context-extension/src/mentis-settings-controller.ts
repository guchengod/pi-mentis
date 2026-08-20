import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PiMentisConfig } from "@pi-mentis/pi-mentis-core";

import { MaskedSecretInput } from "./secret-input.js";
import {
  ProviderConfigStore,
  ProviderRegistry,
  SILICONFLOW_PROVIDER,
  resolveCredential,
  type ProviderConfigDraft,
  type SecretStore,
} from "./provider-settings.js";

export interface ProviderRuntimeStatus {
  readonly ready: boolean;
  readonly providerId: string;
  readonly providerName: string;
  readonly credentialSource: "secure" | "environment" | "missing";
  readonly configured: boolean;
  readonly endpoint: string;
  readonly embeddingModel: string;
  readonly rerankEnabled: boolean;
  readonly rerankModel: string;
}

export interface ProviderTestResult {
  readonly providerId: string;
  readonly providerName: string;
  readonly authentication: "passed" | "failed" | "missing";
  readonly embedding: "passed" | "failed" | "not-run";
  readonly rerank: "passed" | "failed" | "disabled" | "not-run";
  readonly embeddingModel: string;
  readonly rerankModel?: string;
  readonly latencyMs: number;
  readonly error?: {
    readonly category: string;
    readonly message: string;
    readonly httpStatus?: number;
  };
}

export interface ProviderReloadResult {
  readonly activated: boolean;
  readonly revision?: number;
  readonly error?: { readonly category: string; readonly message: string };
}

export interface MentisProviderRuntimeControl {
  status(): Promise<ProviderRuntimeStatus>;
  reload(): Promise<ProviderReloadResult>;
  test(): Promise<ProviderTestResult>;
}

function sourceLabel(source: ProviderRuntimeStatus["credentialSource"]): string {
  if (source === "secure") return "Secure settings";
  if (source === "environment") return "Environment variable";
  return "Missing";
}

function formatStatus(status: ProviderRuntimeStatus, environmentOverridden = false): string {
  return [
    "Mentis",
    "",
    `Memory             ${status.ready ? "ready" : "degraded / setup required"}`,
    `Provider           ${status.providerName}`,
    `API key            ${status.configured ? "configured" : "not configured"}`,
    `Credential source  ${sourceLabel(status.credentialSource)}`,
    ...(environmentOverridden ? ["Environment key    present, overridden"] : []),
    `Embedding          ${status.embeddingModel}`,
    `Reranker           ${status.rerankEnabled ? status.rerankModel : "disabled"}`,
    `Endpoint           ${status.endpoint}`,
    `Provider health    ${status.ready && status.configured ? "ready" : "setup required"}`,
  ].join("\n");
}

export class MentisSettingsController {
  readonly #registry: ProviderRegistry;
  readonly #configStore: ProviderConfigStore;
  readonly #secretStore: SecretStore;
  readonly #runtime: MentisProviderRuntimeControl;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: {
    readonly configStore: ProviderConfigStore;
    readonly secretStore: SecretStore;
    readonly runtime: MentisProviderRuntimeControl;
    readonly registry?: ProviderRegistry;
    readonly environment?: NodeJS.ProcessEnv;
  }) {
    this.#configStore = options.configStore;
    this.#secretStore = options.secretStore;
    this.#runtime = options.runtime;
    this.#registry = options.registry ?? new ProviderRegistry();
    this.#environment = options.environment ?? process.env;
  }

  async handle(
    rawArguments: string,
    context: ExtensionCommandContext,
  ): Promise<PiMentisConfig | undefined> {
    const action = rawArguments.trim().toLowerCase();
    if (action === "" || action === "provider") {
      await this.#main(context);
      return undefined;
    }
    if (action === "status") {
      await this.#showStatus(context);
      return undefined;
    }
    if (action === "config") return await this.#configure(context);
    if (action === "key") {
      await this.#credential(context);
      return undefined;
    }
    if (action === "test") {
      await this.#test(context);
      return undefined;
    }
    context.ui.notify(
      "Available commands:\n  /mentis\n  /mentis status\n  /mentis config\n  /mentis key\n  /mentis test",
      "error",
    );
    return undefined;
  }

  async #main(context: ExtensionCommandContext): Promise<void> {
    while (true) {
      const status = await this.#runtime.status();
      const choice = await context.ui.select("Mentis Settings", [
        `Status — ${status.ready ? "Ready" : "Setup required"}`,
        `Provider — ${status.providerName} (current)`,
        `API Key — ${status.configured ? "Configured" : "Missing"}`,
        `Endpoint — ${status.endpoint}`,
        `Embedding Model — ${status.embeddingModel}`,
        `Rerank Model — ${status.rerankEnabled ? status.rerankModel : "Disabled"}`,
        "Test Connection",
        "Close",
      ]);
      if (choice === undefined || choice === "Close") return;
      if (choice.startsWith("Status")) await this.#showStatus(context);
      else if (choice.startsWith("Provider")) {
        await context.ui.select(
          "Provider",
          this.#registry
            .list()
            .map((definition) =>
              definition.id === status.providerId
                ? `${definition.displayName} — Current provider`
                : definition.displayName,
            ),
        );
      } else if (choice.startsWith("API Key")) await this.#credential(context);
      else if (choice === "Test Connection") await this.#test(context);
      else await this.#configure(context);
    }
  }

  async #showStatus(context: ExtensionCommandContext): Promise<void> {
    const status = await this.#runtime.status();
    const definition = this.#registry.get(status.providerId) ?? SILICONFLOW_PROVIDER;
    const credential = await resolveCredential(
      definition,
      this.#secretStore,
      this.#environment,
      false,
    );
    context.ui.notify(
      formatStatus(status, credential.source === "secure" && credential.environmentPresent),
      status.ready ? "info" : "warning",
    );
  }

  async #configure(context: ExtensionCommandContext): Promise<PiMentisConfig | undefined> {
    const current = await this.#configStore.load(context.cwd, this.#environment);
    const definition = this.#registry.get(current.inference.provider) ?? SILICONFLOW_PROVIDER;
    let draft: ProviderConfigDraft = {
      endpoint: current.inference.siliconflow.baseUrl,
      embeddingModel: current.inference.siliconflow.embedding.model,
      rerankModel: current.inference.siliconflow.rerank.model,
    };
    while (true) {
      const status = await this.#runtime.status();
      const choice = await context.ui.select(`${definition.displayName} Configuration`, [
        `Provider — ${definition.displayName}`,
        `Endpoint — ${draft.endpoint}`,
        `API Key — ${status.configured ? "Configured" : "Missing"}`,
        `Embedding Model — ${draft.embeddingModel}`,
        `Rerank Model — ${draft.rerankModel}`,
        "Test Connection",
        "Save",
        "Cancel",
      ]);
      if (choice === undefined || choice === "Cancel") return undefined;
      if (choice.startsWith("Provider")) continue;
      if (choice.startsWith("API Key")) {
        await this.#credential(context);
        continue;
      }
      if (choice === "Test Connection") {
        await this.#test(context);
        continue;
      }
      if (choice === "Save") {
        try {
          const previousDraft: ProviderConfigDraft = {
            endpoint: current.inference.siliconflow.baseUrl,
            embeddingModel: current.inference.siliconflow.embedding.model,
            rerankModel: current.inference.siliconflow.rerank.model,
          };
          const saved = await this.#configStore.save(context.cwd, draft, this.#environment);
          const reload = await this.#runtime.reload();
          if (!reload.activated) {
            const restored = await this.#configStore.save(
              context.cwd,
              previousDraft,
              this.#environment,
            );
            const restoredRuntime = await this.#runtime.reload();
            if (!restoredRuntime.activated) {
              context.ui.notify(
                "Provider activation failed and the previous runtime could not be confirmed. Mentis is degraded.",
                "error",
              );
              return restored.config;
            }
            context.ui.notify(
              `Settings were not applied; the previous configuration and runtime were restored: ${reload.error?.message ?? "reload failed"}`,
              "warning",
            );
            return restored.config;
          }
          context.ui.notify(`${definition.displayName} settings saved and activated.`, "info");
          return saved.config;
        } catch (error) {
          context.ui.notify(
            error instanceof Error ? error.message : "Unable to save provider settings",
            "error",
          );
          continue;
        }
      }
      const field = choice.startsWith("Endpoint")
        ? "endpoint"
        : choice.startsWith("Embedding")
          ? "embeddingModel"
          : "rerankModel";
      const value = await context.ui.input(
        field === "endpoint"
          ? "SiliconFlow Endpoint"
          : field === "embeddingModel"
            ? "Embedding Model"
            : "Rerank Model",
        draft[field],
      );
      if (value !== undefined && value.trim() !== "") draft = { ...draft, [field]: value.trim() };
    }
  }

  async #credential(context: ExtensionCommandContext): Promise<void> {
    const runtimeStatus = await this.#runtime.status();
    const definition = this.#registry.get(runtimeStatus.providerId) ?? SILICONFLOW_PROVIDER;
    const resolution = await resolveCredential(
      definition,
      this.#secretStore,
      this.#environment,
      false,
    );
    const options = [
      "Replace key",
      ...(resolution.securePresent ? ["Remove stored key"] : []),
      ...(resolution.securePresent ? ["Use environment fallback"] : []),
      "Cancel",
    ];
    const choice = await context.ui.select(
      `${definition.displayName} API Key\nStatus: ${resolution.configured ? "Configured" : "Missing"}\nSource: ${sourceLabel(resolution.source)}`,
      options,
    );
    if (choice === undefined || choice === "Cancel") return;
    if (choice === "Replace key") {
      if (!this.#secretStore.available) {
        context.ui.notify(
          "Secure storage is not available on this platform. Using environment variable fallback.",
          "warning",
        );
        return;
      }
      const secret = await context.ui.custom<string | undefined>(
        (tui, theme, keybindings, done) => new MaskedSecretInput(tui, theme, keybindings, done),
        { overlay: true, overlayOptions: { width: 56, maxHeight: 10, anchor: "center" } },
      );
      if (secret === undefined) return;
      try {
        await this.#secretStore.set(definition.credential.secretId, secret);
      } catch {
        context.ui.notify("Failed to store credential securely.", "error");
        return;
      }
      const reload = await this.#runtime.reload();
      context.ui.notify(
        reload.activated
          ? "SiliconFlow credential stored securely and activated."
          : "Credential was stored, but provider activation failed.",
        reload.activated ? "info" : "warning",
      );
      return;
    }
    if (choice === "Use environment fallback" && !resolution.environmentPresent) {
      context.ui.notify("No environment credential is available.", "warning");
      return;
    }
    const after = resolution.environmentPresent
      ? "Credential source → Environment variable"
      : "Credential status → Missing";
    const confirmed = await context.ui.confirm(
      `Remove stored ${definition.displayName} credential?`,
      `This does not modify your shell environment.\n\nAfter removal: ${after}`,
    );
    if (!confirmed) return;
    try {
      await this.#secretStore.delete(definition.credential.secretId);
      await this.#runtime.reload();
      context.ui.notify(`Stored credential removed. ${after}`, "info");
    } catch {
      context.ui.notify("Failed to remove stored credential securely.", "error");
    }
  }

  async #test(context: ExtensionCommandContext): Promise<void> {
    context.ui.notify("Testing SiliconFlow…", "info");
    const result = await this.#runtime.test();
    const lines = [
      "Provider Test",
      "",
      result.providerName,
      "",
      `Authentication     ${result.authentication === "passed" ? "✓" : result.authentication}`,
      `Embedding          ${result.embedding === "passed" ? `✓ ${result.embeddingModel}` : result.embedding}`,
      `Reranker           ${result.rerank === "passed" ? `✓ ${result.rerankModel ?? ""}` : result.rerank}`,
      `Latency            ${Math.round(result.latencyMs)} ms`,
      "",
      ...(result.error === undefined ? ["Provider ready."] : [result.error.message]),
    ];
    context.ui.notify(lines.join("\n"), result.error === undefined ? "info" : "warning");
  }
}
