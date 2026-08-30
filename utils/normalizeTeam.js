// Shared "loose" team-name normalizer used everywhere we have to match
// the same club across two data sources that spell it differently
// (e.g. "Paris Saint-Germain" vs "PSG", "1. FC Köln" vs "FC Koln").
const DIACRITICS_RE = new RegExp('[\\u0300-\\u036f]', 'g');

function normalizeTeam(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(DIACRITICS_RE, '')
    .replace(/[^a-z0-9]/g, '');
}

function teamsLooselyMatch(a, b) {
  const na = normalizeTeam(a);
  const nb = normalizeTeam(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

module.exports = { normalizeTeam, teamsLooselyMatch };
