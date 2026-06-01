import type { NextConfig } from 'next';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.resolve(dirname, '../..'),
  poweredByHeader: false,
  redirects: async () => [
    {
      source: '/github',
      destination: 'https://github.com/trillskillz/KasGraph',
      permanent: false,
    },
  ],
};

export default nextConfig;
