/**
 * Server-side tests are run via `tsc -p server/tsconfig.json && node --test`,
 * not Jest — the files use Node 20's native test runner. Ignore them here so
 * Jest's default-preset Babel parser doesn't false-flag TypeScript syntax.
 */
module.exports = {
  testPathIgnorePatterns: [
    '/node_modules/',
    '/packages/dashboard/server/',
    '/packages/dashboard/src/',
    '/packages/cli/dist/',
    '/packages/cli/src/__fixtures__/',
  ],
};
