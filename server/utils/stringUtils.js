/**
 * String normalization and matching utilities
 */

/**
 * Normalize strings for approximate matching (retain spaces, alphanum only, collapse whitespace)
 */
function normalizeForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalization for cache keys / query components (tokenized & rejoined)
 */
function normalizeKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

/**
 * Tokenize string for matching
 */
function tokens(s) {
  return normalizeForMatch(s)
    .split(' ')
    .filter(Boolean)
    .filter(t => t.length > 1);
}

/**
 * Count intersection between two arrays
 */
function intersectionCount(a, b) {
  const setB = new Set(b);
  let c = 0;
  for (const x of a) if (setB.has(x)) c++;
  return c;
}

/**
 * Simple Levenshtein distance (iterative DP) for fuzzy fallback
 */
function levenshtein(a, b) {
  a = String(a || '');
  b = String(b || '');
  const n = a.length, m = b.length;
  if (!n) return m; 
  if (!m) return n;
  
  const dp = Array(m + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= n; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1,        // deletion
        dp[j - 1] + 1,    // insertion
        prev + cost       // substitution
      );
      prev = tmp;
    }
  }
  return dp[m];
}

module.exports = {
  normalizeForMatch,
  normalizeKey,
  tokens,
  intersectionCount,
  levenshtein
};
