export const site = {
  name: 'KasGraph',
  title: 'KasGraph - Structured indexing for Kaspa applications',
  url: 'https://www.kasgraph.com',
  description:
    'KasGraph turns Kaspa blocks, UTXOs, Covenant IDs, KRC assets, and BlockDAG activity into queryable data for applications and AI agents.',
  github: 'https://github.com/trillskillz/KasGraph',
  docs: 'https://github.com/trillskillz/KasGraph#readme',
  license: 'MIT',
};

export const navItems = [
  { href: '/docs', label: 'Docs' },
  { href: '/architecture', label: 'Architecture' },
  { href: '/quickstart', label: 'Quickstart' },
  { href: '/status', label: 'Status' },
];

export const hostedEnvVars = [
  'DATABASE_URL',
  'KASGRAPH_INGEST_MODE',
  'KASGRAPH_NOTIFICATION_WS_URL',
  'KASGRAPH_RPC_PRIMARY_URL',
  'KASGRAPH_RPC_BACKUP_URLS',
  'KASGRAPH_RELOAD_INTERVAL_SECS',
  'KASGRAPH_WORK_DIR',
  'KASGRAPH_DEPLOY_TOKEN',
  'KASGRAPH_NODE_URL',
];
