# Contributing

Use Node.js 22.19 or newer and pnpm 10.20.0. Install dependencies with `pnpm install`.

Before opening a pull request, run:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm pack:extensions
```

Keep Pi-specific event types inside the adapter extensions. Domain packages must remain independent
of Pi and provider implementations. Do not include credentials, generated Zvec data, artifacts, or
live-test output in commits.

By contributing, you agree that your contributions are licensed under the MIT License.
