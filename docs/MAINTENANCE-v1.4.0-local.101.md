# Chat2API Windows maintenance fork — local.101

Published source snapshot: `1.4.0-local.101` (2026-11-15). Upstream: [`xiaoY233/Chat2API`](https://github.com/xiaoY233/Chat2API), with the upstream GPL-3.0 license preserved.

## Security-focused maintenance

- Hardened local proxy request admission and fail-closed preflight behavior; rejected authenticated requests are recorded as failures without contacting a remote provider or leaking private request content.
- Improved API-key generation using trusted main-process cryptographic randomness and explicit failure handling.
- Improved separation of sensitive configuration/credentials from renderer-side persisted preferences, imports/exports, and diagnostic logging.
- Protected GUI state against stale settings fetches, rejected mutations, and misleading success indicators.
- Added regression coverage for provider transport/error boundaries, request history and tool-call consistency, model/account configuration, and Windows desktop behavior.

## Verification and boundaries

- **3,789 offline/security tests passed, 0 failed**, according to the local.101 test run on 2026-11-15. The source files and corresponding regression tests are included for independent inspection.
- The Windows Electron build and unsigned setup/portable packaging completed; compiled outputs were checked against the build manifest. **No executables or private profiles are published.**
- The tests include synthetic fixtures and offline HTTP mocks; they do not prove that every website/provider integration currently works. End-to-end service verification is incomplete.
- This is defensive maintenance and compatibility work, **not** a claim of a formally disclosed CVE, a completed external audit, or a vulnerability-free product.

## Source-only reproduction

```sh
npm ci
npm run typecheck
npm run build
node --experimental-vm-modules --test 'tests/security/*.test.mjs'
```

The full security regression suite is located under `tests/security/` and is designed to run offline with Node.js's test runner. No account credentials are required for the offline tests.