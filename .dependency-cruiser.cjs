/**
 * Architecture boundaries (00-overview §3) and the MiCA read-only guarantee
 * (ADR-011), enforced in CI. Run after `pnpm build`: cross-package imports
 * resolve through each package's dist entrypoint.
 *
 *   apps/*  →  mcp-tools  →  { ledger, recon, exporters, pricing }  →  db  →  core
 *                    ingestion  →  db, core          (worker-only)
 *   core imports nothing internal. Nothing imports apps.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-signing-libraries',
      severity: 'error',
      comment:
        'Read-only by construction (P8, ADR-011): no signing or key material anywhere in the dependency tree.',
      from: {},
      to: {
        path: [
          'node_modules/(ethers|viem|web3|web3-eth-accounts|@ethereumjs/(tx|wallet)|ethereumjs-wallet|ethereumjs-tx|bip39|bip32|hdkey|elliptic|secp256k1|tiny-secp256k1|@noble/(secp256k1|curves)|@scure/(bip32|bip39)|eth-crypto|@metamask/eth-sig-util)(/|$)',
        ],
      },
    },
    {
      name: 'core-imports-nothing-internal',
      severity: 'error',
      comment: 'packages/core is the shared kernel: no internal imports, no I/O.',
      from: { path: '^packages/core/' },
      to: { path: '^(packages|apps)/', pathNot: '^packages/core/' },
    },
    {
      name: 'db-depends-only-on-core',
      severity: 'error',
      from: { path: '^packages/db/' },
      to: { path: '^(packages|apps)/', pathNot: '^packages/(db|core)/' },
    },
    {
      name: 'domain-depends-only-on-db-core',
      severity: 'error',
      comment:
        'No cross-imports within the domain layer; composition happens in mcp-tools.',
      from: { path: '^packages/(ingestion|pricing|ledger|recon|exporters)/' },
      to: {
        path: '^(packages|apps)/',
        pathNot: ['^packages/$1/', '^packages/(db|core)/'],
      },
    },
    {
      name: 'mcp-tools-layer',
      severity: 'error',
      from: { path: '^packages/mcp-tools/' },
      to: {
        path: '^(packages|apps)/',
        pathNot: '^packages/(mcp-tools|ledger|recon|exporters|pricing|db|core)/',
      },
    },
    {
      name: 'evals-layer',
      severity: 'error',
      comment:
        'Evals bind tools in-process (mcp-tools) and compose ingestion + ledger for the ' +
        'golden-wallet reconciliation harness (04-testing.md §2). ingestion is still barred ' +
        'from the read-only MCP server runtime by mcp-tools-layer + nothing-imports-apps — the ' +
        'server never imports evals, so this edge does not weaken the MiCA guarantee (ADR-011).',
      from: { path: '^packages/evals/' },
      to: {
        path: '^(packages|apps)/',
        pathNot:
          '^packages/(evals|mcp-tools|ingestion|ledger|recon|exporters|pricing|db|core)/',
      },
    },
    {
      name: 'nothing-imports-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-cross-app-imports',
      severity: 'error',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/', pathNot: '^apps/$1/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment:
        'Every import must resolve (undeclared workspace deps show up here).',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules', 'dist'] },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'node', 'default', 'types'],
    },
  },
};
