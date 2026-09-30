/**
 * Architectural boundaries for the real repository.
 *
 * The rules themselves live in tools/boundary-rules.cjs so that the same set can be
 * replayed against a deliberately-violating fixture tree (see tools/boundaries.test.ts).
 * That keeps "the rules are enforced" from being an untested claim.
 */
const { buildForbidden, sharedOptions } = require('./tools/boundary-rules.cjs');

module.exports = {
  forbidden: buildForbidden(''),
  options: {
    ...sharedOptions,
    exclude: { path: ['/coverage/', '/dist/', '/out/', '^tools/boundary-fixtures/'] },
  },
};
