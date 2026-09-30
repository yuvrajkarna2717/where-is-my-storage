/**
 * Vite ships these declarations in `vite/client`, but the DOM type-check program sets
 * `types: []` so that @types/node cannot leak into renderer code. Declaring the handful of
 * asset imports we actually use is a smaller price than loosening that.
 */
declare module '*.css';
