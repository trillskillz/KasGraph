import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Resolve graphql to its CJS entry so vitest doesn't end up
// holding both `graphql/index.mjs` (loaded by our ESM tests) and
// `graphql/index.js` (loaded by graphql-yoga's CJS bundle) in
// the same process. Yoga errors with
//   "Cannot use GraphQLSchema from another module or realm"
// when the schema was built from the other instance.
const graphqlCjs = fileURLToPath(new URL('./node_modules/graphql/index.js', import.meta.url));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    server: {
      deps: {
        inline: ['graphql', 'graphql-yoga'],
      },
    },
  },
  resolve: {
    dedupe: ['graphql', 'graphql-yoga'],
    alias: [
      { find: /^graphql$/, replacement: graphqlCjs },
    ],
  },
});
