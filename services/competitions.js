// The 12 competitions football-data.org exposes on its free tier, mapped
// to the odds-api "sport key" that covers the same league (when The Odds
// API has a market for it) and to display metadata used by the frontend.
module.exports = [
  { code: 'PL', country: 'Angleterre', league: 'Premier League', oddsSportKey: 'soccer_epl' },
  { code: 'PD', country: 'Espagne', league: 'La Liga', oddsSportKey: 'soccer_spain_la_liga' },
  { code: 'SA', country: 'Italie', league: 'Serie A', oddsSportKey: 'soccer_italy_serie_a' },
  { code: 'BL1', country: 'Allemagne', league: 'Bundesliga', oddsSportKey: 'soccer_germany_bundesliga' },
  { code: 'FL1', country: 'France', league: 'Ligue 1', oddsSportKey: 'soccer_france_ligue_one' },
  { code: 'DED', country: 'Pays-Bas', league: 'Eredivisie', oddsSportKey: 'soccer_netherlands_eredivisie' },
  { code: 'PPL', country: 'Portugal', league: 'Primeira Liga', oddsSportKey: 'soccer_portugal_primeira_liga' },
  { code: 'CL', country: 'Europe', league: 'Champions League', oddsSportKey: 'soccer_uefa_champs_league' },
];
