# Contributing

Realife welcomes focused fixes, documentation improvements, tests, and
provider abstractions.

1. Fork the repository and create a branch from the default branch.
2. Install the locked dependency graph with `npm ci`.
3. Keep secrets in `.env`; never commit credentials or private keys.
4. Run `npm run verify` before opening a pull request.
5. Explain the user-visible behavior, test coverage, and security impact in the
   pull request.

Avoid combining dependency upgrades, API changes, and large formatting
rewrites in one pull request. Changes to contract selection or transaction
metadata must include explicit Base Sepolia test cases and must not silently
change existing mint behavior.

By contributing, you agree that your contribution is licensed under Apache-2.0.
