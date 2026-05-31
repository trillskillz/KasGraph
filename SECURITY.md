# Security Policy

KasGraph is pre-1.0 infrastructure. We take security seriously, especially
because an indexer sits between on-chain data and the dApps, wallets, and agents
that trust its answers.

## Reporting a vulnerability

Please **do not** open a public issue for a security vulnerability.

Instead, report it privately via GitHub's
[private vulnerability reporting](https://github.com/trillskillz/KasGraph/security/advisories/new)
("Report a vulnerability" on the repository's Security tab). Include:

- a description of the issue and its impact,
- steps to reproduce (a manifest/schema/query or a failing test is ideal),
- the affected component (node, RPC, store, detectors, API, MCP, CLI) and version/commit.

We will acknowledge the report, work with you on a fix, and credit you in the
release notes unless you prefer to remain anonymous.

## Scope

In scope: correctness and integrity of indexed data and Proof of Indexing,
reorg handling, SQL injection / schema-name handling, the deploy registry and
HTTP deploy endpoint, and the GraphQL/MCP query surfaces.

Out of scope: vulnerabilities in upstream Kaspa nodes, third-party RPC
providers, or PostgreSQL itself (report those to their respective projects).

## Supported versions

The project is pre-release; security fixes land on `main`. There is no
long-term-support branch yet.
