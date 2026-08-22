import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PiMentisConfig } from "@pi-mentis/pi-mentis-core";

import { MaskedSecretInput } from "./secret-input.js";
import {
  ProviderConfigStore,
  ProviderRegistry,
  SILICONFLOW_PROVIDER,
  providerDraft,
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

export interface ProviderModelCatalogResult {
  readonly providerId: string;
  readonly providerName: string;
  readonly embeddingModels: readonly string[];
  readonly rerankModels: readonly string[];
  readonly source: "remote" | "verified-fallback";
  readonly error?: { readonly category: string; readonly message: string };
}

export interface MentisProviderRuntimeControl {
  status(): Promise<ProviderRuntimeStatus>;
  reload(): Promise<ProviderReloadResult>;
  test(): Promise<ProviderTestResult>;
  models(): Promise<ProviderModelCatalogResult>;
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
    if (action === "" || action === "provider") return await this.#selectProvider(context);
    if (action === "status") {
      await this.#showStatus(context);
      return undefined;
    }
    if (action === "config") return await this.#providerSettings(context);
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

  async #selectProvider(context: ExtensionCommandContext): Promise<PiMentisConfig | undefined> {
    const definitions = this.#registry.list();
    const choice = await context.ui.select(
      "Select Provider",
      definitions.map((definition) => definition.displayName),
    );
    if (choice === undefined) return undefined;
    const definition = definitions.find((candidate) => candidate.displayName === choice);
    if (definition === undefined) return undefined;
    return await this.#providerSettings(context);
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

  async #providerSettings(context: ExtensionCommandContext): Promise<PiMentisConfig | undefined> {
    let latestConfig: PiMentisConfig | undefined;
    const initialStatus = await this.#runtime.status();
    if (!initialStatus.configured && !(await this.#credential(context))) return undefined;
    while (true) {
      const status = await this.#runtime.status();
      const definition = this.#registry.get(status.providerId) ?? SILICONFLOW_PROVIDER;
      const resolution = await resolveCredential(
        definition,
        this.#secretStore,
        this.#environment,
        false,
      );
      const choice = await context.ui.select(definition.displayName, [
        `API Key — ${status.configured ? `Configured (${sourceLabel(status.credentialSource)})` : "Missing"}`,
        `Embedding Model — ${status.embeddingModel}`,
        `Rerank Model — ${status.rerankEnabled ? status.rerankModel : "Disabled"}`,
        "Test Connection",
        ...(resolution.securePresent ? ["Remove Stored API Key"] : []),
        "Back",
      ]);
      if (choice === undefined || choice === "Back") return latestConfig;
      if (choice.startsWith("API Key")) {
        await this.#credential(context);
        continue;
      }
      if (choice.startsWith("Embedding Model")) {
        latestConfig = (await this.#selectModel(context, "embedding")) ?? latestConfig;
        continue;
      }
      if (choice.startsWith("Rerank Model")) {
        latestConfig = (await this.#selectModel(context, "rerank")) ?? latestConfig;
        continue;
      }
      if (choice === "Test Connection") {
        await this.#test(context);
        continue;
      }
      if (choice === "Remove Stored API Key") {
        await this.#removeCredential(context, definition);
        return latestConfig;
      }
    }
  }

  async #credential(context: ExtensionCommandContext): Promise<boolean> {
    const runtimeStatus = await this.#runtime.status();
    const definition = this.#registry.get(runtimeStatus.providerId) ?? SILICONFLOW_PROVIDER;
    if (!this.#secretStore.available) {
      context.ui.notify(
        "Secure storage is not available on this platform. Configure SILICONFLOW_API_KEY in the environment.",
        "warning",
      );
      return false;
    }
    const secret = await context.ui.custom<string | undefined>(
      (tui, theme, keybindings, done) =>
        new MaskedSecretInput(tui, theme, keybindings, done, definition.displayName),
      { overlay: true, overlayOptions: { width: 56, maxHeight: 10, anchor: "center" } },
    );
    if (secret === undefined) return false;
    try {
      await this.#secretStore.set(definition.credential.secretId, secret);
    } catch {
      context.ui.notify("Failed to store credential securely.", "error");
      return false;
    }
    const reload = await this.#runtime.reload();
    context.ui.notify(
      reload.activated
        ? `${definition.displayName} API Key saved and activated.`
        : "API Key was stored, but provider activation failed.",
      reload.activated ? "info" : "warning",
    );
    return reload.activated;
  }

  async #removeCredential(
    context: ExtensionCommandContext,
    definition: typeof SILICONFLOW_PROVIDER,
  ): Promise<void> {
    const resolution = await resolveCredential(
      definition,
      this.#secretStore,
      this.#environment,
      false,
    );
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

  async #selectModel(
    context: ExtensionCommandContext,
    kind: "embedding" | "rerank",
  ): Promise<PiMentisConfig | undefined> {
    const current = await this.#configStore.load(context.cwd, this.#environment);
    const currentModel =
      kind === "embedding"
        ? current.inference.siliconflow.embedding.model
        : current.inference.siliconflow.rerank.model;
    const catalog = await this.#runtime.models();
    if (catalog.error !== undefined) {
      context.ui.notify(`Using verified model list: ${catalog.error.message}`, "warning");
    }
    const models = kind === "embedding" ? catalog.embeddingModels : catalog.rerankModels;
    if (models.length === 0) {
      context.ui.notify(`No compatible ${kind} models are available.`, "warning");
      return undefined;
    }
    const labels = models.map((model) => (model === currentModel ? `${model} — Current` : model));
    const choice = await context.ui.select(
      kind === "embedding" ? "Select Embedding Model" : "Select Rerank Model",
      labels,
    );
    if (choice === undefined) return undefined;
    const selected = models[labels.indexOf(choice)];
    if (selected === undefined || selected === currentModel) return undefined;
    const draft = providerDraft(current);
    return await this.#saveAndActivate(
      context,
      {
        ...draft,
        ...(kind === "embedding" ? { embeddingModel: selected } : { rerankModel: selected }),
      },
      `${kind === "embedding" ? "Embedding" : "Rerank"} model changed to ${selected}.`,
    );
  }

  async #saveAndActivate(
    context: ExtensionCommandContext,
    draft: ProviderConfigDraft,
    successMessage: string,
  ): Promise<PiMentisConfig | undefined> {
    const previous = await this.#configStore.load(context.cwd, this.#environment);
    const previousDraft = providerDraft(previous);
    try {
      const saved = await this.#configStore.save(context.cwd, draft, this.#environment);
      const reload = await this.#runtime.reload();
      if (reload.activated) {
        context.ui.notify(successMessage, "info");
        return saved.config;
      }
      const restored = await this.#configStore.save(context.cwd, previousDraft, this.#environment);
      const restoredRuntime = await this.#runtime.reload();
      if (!restoredRuntime.activated) {
        context.ui.notify(
          "Provider activation failed and the previous runtime could not be confirmed. Mentis is degraded.",
          "error",
        );
        return restored.config;
      }
      context.ui.notify(
        `Model was not changed; the previous configuration was restored: ${reload.error?.message ?? "reload failed"}`,
        "warning",
      );
      return restored.config;
    } catch (error) {
      context.ui.notify(
        error instanceof Error ? error.message : "Unable to update provider model",
        "error",
      );
      return undefined;
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
