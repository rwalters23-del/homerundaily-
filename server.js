require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const webpush = require('web-push');
const { v4: uuidv4 } = require('uuid');
const db = require('./database');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || 'UUxI4O8-FbRouAf7-7OTt9GH4v5T7FhY3kU6zBcQX5Y';

webpush.setVapidDetails(
  'mailto:admin@homerundaily.com',
  vapidPublicKey,
  vapidPrivateKey
);

const MLB_API = 'https://statsapi.mlb.com/api/v1';

async function getLiveGames() {
  try {
    const response = await fetch(`${MLB_API}/schedule?sportId=1&date=${new Date().toISOString().split('T')[0]}&gameType=R&state=Live`);
    const data = await response.json();
    return data.dates?.[0]?.games || [];
  } catch (err) {
    console.error('Error fetching MLB games:', err.message);
    return [];
  }
}

async function getGamePlays(gamePk) {
  try {
    const response = await fetch(`${MLB_API}/game/${gamePk}/play-by-play`);
    const data = await response.json();
    return data.allPlays || [];
  } catch (err) {
    console.error('Error fetching plays:', err.message);
    return [];
  }
}

function extractHomeRuns(plays) {
  const hrs = [];
  for (const play of plays) {
    if (play.event === 'Home Run') {
      const hr = {
        eventId: `${play.gamePk}-${play.atBatIndex}`,
        playerName: play.matchup?.batter?.fullName || 'Unknown',
        playerId: play.matchup?.batter?.id?.toString(),
        teamName: play.team?.name || 'Unknown',
        teamId: play.team?.id?.toString(),
        inning: play.about?.inning,
        inningOrdinal: play.about?.inningOrdinal,
        awayTeam: play.about?.awayTeam?.name,
        homeTeam: play.about?.homeTeam?.name
      };
      hrs.push(hr);
    }
  }
  return hrs;
}

async function sendPushNotification(subscription, payload) {
  try {
    await webpush.sendNotification(JSON.parse(subscription.subscription_json), payload);
    return true;
  } catch (err) {
    console.error('Push error:', err.message);
    if (err.statusCode === 410) {
      const deleteStmt = db.prepare('DELETE FROM push_subscriptions WHERE id = ?');
      deleteStmt.run(subscription.id);
    }
    return false;
  }
}

async function checkAndAlert() {
  console.log(`[${new Date().toISOString()}] Checking for home runs...`);
  
  const games = await getLiveGames();
  console.log(`Found ${games.length} live games`);
  
  for (const game of games) {
    const plays = await getGamePlays(game.gamePk);
    const hrs = extractHomeRuns(plays);
    
    for (const hr of hrs) {
      const existing = db.prepare('SELECT id FROM sent_events WHERE event_id = ?').get(hr.eventId);
      if (existing) continue;
      
      const subscriptions = db.prepare(`
        SELECT DISTINCT s.*, p.subscription_json, p.id as push_id
        FROM subscriptions s
        JOIN push_subscriptions p ON s.user_id = p.user_id
        WHERE (s.type = 'team' AND s.entity_id = ?)
           OR (s.type = 'player' AND s.entity_id = ?)
      `).all(hr.teamId, hr.playerId);
      
      if (subscriptions.length > 0) {
        console.log(`📢 Sending ${subscriptions.length} alerts for ${hr.playerName} HR`);
        
        const payload = JSON.stringify({
          title: `🚀 HOME RUN (${hr.teamName})`,
          body: `${hr.playerName} – ${hr.inningOrdinal} vs ${hr.awayTeam}`,
          icon: '/icon.png',
          tag: hr.eventId
        });
        
        for (const sub of subscriptions) {
          await sendPushNotification({ ...sub, id: sub.push_id }, payload);
        }
      }
      
      db.prepare('INSERT INTO sent_events (event_id) VALUES (?)').run(hr.eventId);
    }
  }
}

setInterval(checkAndAlert, 3 * 60 * 1000);

app.get('/api/teams', async (req, res) => {
  try {
    const response = await fetch(`${MLB_API}/teams?sportId=1`);
    const data = await response.json();
    const teams = data.teams.filter(t => t.active).map(t => ({ id: t.id.toString(), name: t.name, abbrev: t.abbreviation }));
    res.json(teams);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/players', async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json([]);
  try {
    const response = await fetch(`${MLB_API}/players?search=${q}&sportId=1`);
    const data = await response.json();
    const players = data.people?.slice(0, 10).map(p => ({ id: p.id.toString(), name: p.fullName, team: p.currentTeam?.name })) || [];
    res.json(players);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/register', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const userId = uuidv4();
  try {
    db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(userId, email);
    db.prepare('INSERT INTO user_tier (user_id, tier) VALUES (?, ?)').run(userId, 'free');
    res.json({ userId, email });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      return res.json({ userId: existing.id, email, existing: true });
    }
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/subscriptions/:userId', (req, res) => {
  const subs = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').all(req.params.userId);
  res.json(subs);
});

app.post('/api/subscriptions', (req, res) => {
  const { userId, type, entityId, entityName } = req.body;
  if (!userId || !type || !entityId || !entityName) return res.status(400).json({ error: 'Missing required fields' });
  try {
    db.prepare('INSERT OR IGNORE INTO subscriptions (user_id, type, entity_id, entity_name) VALUES (?, ?, ?, ?)').run(userId, type, entityId, entityName);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/subscriptions/:userId/:type/:entityId', (req, res) => {
  const { userId, type, entityId } = req.params;
  db.prepare('DELETE FROM subscriptions WHERE user_id = ? AND type = ? AND entity_id = ?').run(userId, type, entityId);
  res.json({ success: true });
});

app.post('/api/push', (req, res) => {
  const { userId, subscription } = req.body;
  if (!userId || !subscription) return res.status(400).json({ error: 'Missing required fields' });
  try {
    db.prepare('INSERT INTO push_subscriptions (user_id, subscription_json) VALUES (?, ?)').run(userId, JSON.stringify(subscription));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/vapid-key', (req, res) => {
  res.json({ publicKey: vapidPublicKey });
});

app.post('/api/test-notify/:userId', async (req, res) => {
  const { userId } = req.params;
  const pushSubs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  if (pushSubs.length === 0) return res.status(400).json({ error: 'No push subscriptions found' });
  const payload = JSON.stringify({ title: '🧪 Test Alert', body: 'Home Run alerts are working!', icon: '/icon.png' });
  for (const sub of pushSubs) await sendPushNotification(sub, payload);
  res.json({ success: true, sent: pushSubs.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🏠 HomeRunDaily running on port ${PORT}`);
  checkAndAlert();
});
