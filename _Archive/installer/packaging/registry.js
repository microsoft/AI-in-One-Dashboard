// @ts-check
// No imports on purpose: CI runs packaging/public-registry.js before `npm ci`, so this module
// must load without the installer's dependencies.

/** Rewritten in the lock files so CI installs from the public registry, not Microsoft's mirror of it. */
export const MIRROR_REGISTRY = 'https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/';
export const PUBLIC_REGISTRY = 'https://registry.npmjs.org/';

/**
 * Points a lock file at the public npm registry.
 * @param {string} lock
 */
export function publicRegistry(lock) {
  return lock.replaceAll(MIRROR_REGISTRY, PUBLIC_REGISTRY);
}
