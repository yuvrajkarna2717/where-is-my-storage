/**
 * The same boundary rules as the real repository, shifted onto this fixture tree.
 *
 * Every file under ./packages and ./apps deliberately breaks exactly one rule so that
 * tools/boundaries.test.ts can assert the rule fires. Nothing here is real product code;
 * it is excluded from tsconfig and ESLint on purpose, because some fixtures must import
 * modules that do not exist.
 */
const { buildForbidden, sharedOptions } = require('../boundary-rules.cjs');

module.exports = {
  forbidden: buildForbidden('tools/boundary-fixtures/'),
  options: { ...sharedOptions, exclude: { path: ['/coverage/', '/dist/', '/out/'] } },
};
