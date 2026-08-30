// Populate the predictions store with sample data so the app looks alive
// out of the box. Run with: npm run seed
const { readPredictions } = require('./db');
const Prediction = require('./models/Prediction');

function isoDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

const TODAY = isoDate(0);
const TOMORROW = isoDate(1);

const MATCHES_TODAY = [
  { country: 'Angleterre', league: 'Premier League', flag: 'gb-eng', home_team: 'Liverpool', away_team: 'Nottingham Forest', match_time: '16:00', status: 'FT', score_home: 2, score_away: 2, market: 'Nombre de buts', pick: '+1.5', probability: 81, odd: 1.14 },
  { country: 'Angleterre', league: 'Premier League', flag: 'gb-eng', home_team: 'Coventry City', away_team: 'Hull City', match_time: '14:00', status: 'FT', score_home: 0, score_away: 1, market: 'Double chance', pick: '1X', probability: 76, odd: 1.18 },
  { country: 'Angleterre', league: 'Premier League', flag: 'gb-eng', home_team: 'AFC Bournemouth', away_team: 'Everton', match_time: '14:00', status: 'FT', score_home: 1, score_away: 1, market: 'Nombre de buts', pick: '+1.5', probability: 76, odd: 1.28 },
  { country: 'Angleterre', league: 'Premier League', flag: 'gb-eng', home_team: 'Tottenham Hotspur', away_team: 'Arsenal', match_time: '17:30', status: 'FT', score_home: 0, score_away: 0, market: 'Nombre de buts', pick: '+1.5', probability: 78, odd: 1.20 },
  { country: 'Espagne', league: 'La Liga', flag: 'es', home_team: 'Real Madrid', away_team: 'Real Sociedad', match_time: '21:00', status: 'upcoming', market: '1X2', pick: '1', probability: 68, odd: 1.45 },
  { country: 'Italie', league: 'Serie A', flag: 'it', home_team: 'Inter Milan', away_team: 'Torino', match_time: '18:00', status: 'upcoming', market: 'Nombre de buts', pick: '+2.5', probability: 64, odd: 1.75, is_vip: true },
];

const MATCHES_TOMORROW_TICKETS = [
  { country: 'Danemark', league: 'Superliga', flag: 'dk', home_team: 'Randers FC', away_team: 'AGF', match_time: '10:00', status: 'upcoming', market: 'Number of goals', pick: '+2.5', odd: 1.66, ticket_group: 'double-1', ticket_type: 'Double', featured: true },
  { country: 'Allemagne', league: 'Bundesliga', flag: 'de', home_team: 'FC Augsburg', away_team: 'Schalke 04', match_time: '11:30', status: 'upcoming', market: 'Number of goals', pick: '+1.5', odd: 1.22, ticket_group: 'double-1', ticket_type: 'Double', featured: true },
  { country: 'Luxembourg', league: 'National Division', flag: 'lu', home_team: 'Hostert', away_team: 'Differdange 03', match_time: '10:00', status: 'upcoming', market: 'Number of goals', pick: '+2.5', odd: 1.57, ticket_group: 'risk-1', ticket_type: 'Risk', featured: true, is_vip: true },
  { country: 'Suisse', league: 'Super League', flag: 'ch', home_team: 'Vaduz', away_team: 'Grasshopper', match_time: '10:30', status: 'upcoming', market: 'Number of goals', pick: '+2.5', odd: 1.50, ticket_group: 'risk-1', ticket_type: 'Risk', featured: true, is_vip: true },
  { country: 'Slovénie', league: '1. SNL', flag: 'si', home_team: 'Grosuplje', away_team: 'Celje', match_time: '12:00', status: 'upcoming', market: 'Number of goals', pick: '+2.5', odd: 1.57, ticket_group: 'risk-1', ticket_type: 'Risk', featured: true, is_vip: true },
];

function run() {
  const existing = readPredictions();
  if (existing.length > 0) {
    console.log(`[seed] ${existing.length} pronostics déjà présents — seed ignoré.`);
    return;
  }

  for (const m of MATCHES_TODAY) {
    Prediction.createPrediction({ ...m, match_date: TODAY }, 'seed', 'PeguyTbn');
  }
  for (const m of MATCHES_TOMORROW_TICKETS) {
    Prediction.createPrediction({ ...m, match_date: TOMORROW }, 'seed', 'PeguyTbn');
  }
  console.log(`[seed] ${MATCHES_TODAY.length + MATCHES_TOMORROW_TICKETS.length} pronostics insérés.`);
}

run();
