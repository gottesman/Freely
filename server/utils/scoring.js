const { 
  normalizeForMatch, 
  tokens, 
  intersectionCount, 
  levenshtein 
} = require('./stringUtils');

/**
 * Compute a composite score (0..100) representing similarity of candidate to query
 */
function computeMatchScore(queryTitle, queryArtist, candidateTitle, candidateArtist) {
  const qTitleNorm = normalizeForMatch(queryTitle || '');
  const qArtistNorm = normalizeForMatch(queryArtist || '');
  const cTitleNorm = normalizeForMatch(candidateTitle || '');
  const cArtistNorm = normalizeForMatch(candidateArtist || '');

  const qTokens = tokens(qTitleNorm);
  const cTokens = tokens(cTitleNorm);
  const tkMatch = qTokens.length ? (intersectionCount(qTokens, cTokens) / qTokens.length) : 0;

  const exactTitleBonus = qTitleNorm && cTitleNorm.includes(qTitleNorm) ? 1 : 0;
  const artistMatch = qArtistNorm && cArtistNorm ? (
    cArtistNorm.includes(qArtistNorm) ||
    intersectionCount(tokens(qArtistNorm), tokens(cArtistNorm)) > 0 ? 1 : 0
  ) : 0;

  const yearRe = /\b(19|20)\d{2}\b/;
  const yearMatch = (
    yearRe.test(qTitleNorm) &&
    yearRe.test(cTitleNorm) &&
    qTitleNorm.match(yearRe)[0] === cTitleNorm.match(yearRe)[0]
  ) ? 1 : 0;

  let editSim = 0;
  try {
    const d = levenshtein(qTitleNorm, cTitleNorm);
    const maxL = Math.max(1, qTitleNorm.length, cTitleNorm.length);
    editSim = 1 - (d / maxL);
    if (editSim < 0) editSim = 0;
  } catch (_) { /* ignore */ }

  const score = Math.round(100 * (
    0.55 * tkMatch +
    0.20 * exactTitleBonus +
    0.15 * artistMatch +
    0.05 * yearMatch +
    0.05 * editSim
  ));
  return Math.max(0, Math.min(100, score));
}

/**
 * Score torrent results based on query relevance
 */
function scoreTorrentResults(results, queryTitle, artist, minScore = 40) {
  if (!Array.isArray(results)) return [];
  
  const out = [];
  for (const t of results) {
    const titleCandidate = String(t.title || t.name || '');
    const artistCandidate = String(t.artist || t.uploader || '');
    const score = computeMatchScore(queryTitle || '', artist || '', titleCandidate, artistCandidate || '');
    
    // Only include results above minimum score threshold
    if (score >= minScore) {
      out.push(Object.assign({}, t, { _score: score }));
    }
  }
  
  out.sort((a, b) => (b._score || 0) - (a._score || 0));
  return out;
}

module.exports = {
  computeMatchScore,
  scoreTorrentResults
};
