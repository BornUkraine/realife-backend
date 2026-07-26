# Security policy

## Supported scope

The default branch is the only supported development line. The public
deployment is a Base Sepolia testnet MVP and has not received an independent
security audit.

## Report a vulnerability

Do not open a public issue for an unpatched vulnerability, leaked credential,
or exploit path. Use GitHub's private vulnerability reporting for this
repository. If that option is unavailable, contact the maintainer through the
verified contact shown on the GitHub profile and ask for a private reporting
channel before sharing details.

Include the affected commit, reproduction steps, expected impact, and any safe
mitigation you tested. Please do not access other users' data, spend funds, or
degrade the public service while testing.

## Trust boundaries

- The service never needs a wallet private key.
- `OPENAI_API_KEY` and `PINATA_JWT` are server-only secrets.
- Uploaded files are held in memory and may be sent to configured third-party
  AI and IPFS providers.
- Contract addresses and RPC responses are untrusted configuration/input.
- The repository contains read interfaces and addresses, not audited Solidity
  source or a guarantee about deployed bytecode.

For production, add authentication and rate limiting to mutation endpoints,
restrict CORS, enforce MIME signatures in addition to client-provided content
types, cap concurrent media work, and commission independent application and
contract audits.

## Dependency audit snapshot

After a clean `npm ci` on 2026-07-26, `npm audit --omit=dev` reported 0 known
vulnerabilities. CI blocks critical/high regressions, and Dependabot is
configured for weekly updates. Always inspect the current report because
advisories change after publication.
