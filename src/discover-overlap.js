// src/discover-overlap.js
// Pure overlap-detection logic for source discovery. Pulled out of
// discover.js so it can be tested without importing the Anthropic SDK.
//
// Use case: when Discovery proposes adding `greenhouse:skadden` but the
// user already has Skadden's careers page as a smartfetch source, we want
// to warn them so they can disable the smartfetch (which would otherwise
// double-fetch the same listings every day).

/**
 * Find a smartfetch source whose URL appears to overlap with a given
 * Greenhouse/Lever candidate.
 *
 * @param {object} candidate - { kind, config: { slug } }
 * @param {object[]} smartfetchSources - existing enabled smartfetch sources
 * @returns {object|null} { id, name, url } of the overlapping source, or null
 */
export function findOverlap(candidate, smartfetchSources) {
  if (candidate.kind !== 'greenhouse' && candidate.kind !== 'lever') return null;
  const slug = String(candidate.config?.slug || '').toLowerCase();
  if (!slug) return null;
  // Match if the slug appears as a substring in any smartfetch URL's hostname
  // or path. Loose on purpose — false positives just produce a dismissible
  // warning, not a hard block.
  for (const sf of smartfetchSources) {
    if (!sf.config?.url) continue;
    try {
      const u = new URL(sf.config.url);
      const haystack = (u.hostname + u.pathname).toLowerCase();
      if (haystack.includes(slug)) {
        return { id: sf.id, name: sf.name, url: sf.config.url };
      }
    } catch {
      // invalid URL, skip
    }
  }
  return null;
}

/**
 * Filter the existing source list to enabled smartfetch sources only.
 * Convenience helper used both by Discovery and the test suite.
 */
export function smartfetchSources(allSources) {
  return allSources.filter((s) => s.kind === 'smartfetch' && s.enabled && s.config?.url);
}
