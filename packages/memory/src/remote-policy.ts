export interface RemoteExecutionPolicy {
  readonly timeoutMs: number;
  readonly maxRetries: number;
}

export interface RemotePolicyConfig {
  readonly foreground: RemoteExecutionPolicy;
  readonly background: RemoteExecutionPolicy;
}

export interface RemotePolicyOverrides {
  readonly foreground?: Partial<RemoteExecutionPolicy>;
  readonly background?: Partial<RemoteExecutionPolicy>;
}

export const DEFAULT_REMOTE_POLICY: RemotePolicyConfig = {
  foreground: {
    timeoutMs: 1500,
    maxRetries: 1,
  },
  background: {
    timeoutMs: 30_000,
    maxRetries: 3,
  },
};

export function remotePolicy(config?: RemotePolicyOverrides): RemotePolicyConfig {
  return {
    foreground: { ...DEFAULT_REMOTE_POLICY.foreground, ...config?.foreground },
    background: { ...DEFAULT_REMOTE_POLICY.background, ...config?.background },
  };
}
