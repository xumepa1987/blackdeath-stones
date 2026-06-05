const express  = require('express');
const webpush  = require('web-push');
const cron     = require('node-cron');
const fs       = require('fs');
const path     = require('path');
const cors     = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data.json');

app.use(express.json({ limit: '1mb' }));
app.use(cors());

// ── VAPID ──────────────────────────────────────────────
webpush.setVapidDetails(
  'mailto:' + (process.env.CONTACT_EMAIL || 'admin@example.com'),
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ── DATA HELPERS ───────────────────────────────────────
function load() {
  try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); }
  catch { return { subscriptions: {}, timers: {}, notified: {} }; }
}
function save(d) { fs.writeFileSync(DATA, JSON.stringify(d)); }

// ── API ────────────────────────────────────────────────

// Сохранить/обновить подписку на push
app.post('/subscribe', (req, res) => {
  const { userId, subscription } = req.body;
  if (!userId || !subscription) return res.status(400).json({ error: 'missing fields' });
  const d = load();
  d.subscriptions[userId] = subscription;
  save(d);
  res.json({ ok: true });
});

// Синхронизировать таймеры с сервером
app.post('/timers', (req, res) => {
  const { userId, items } = req.body;
  if (!userId) return res.status(400).json({ error: 'missing userId' });
  const d = load();
  d.timers[userId] = items || [];
  save(d);
  res.json({ ok: true });
});

// Получить таймеры (для восстановления на новом устройстве)
app.get('/timers', (req, res) => {
  const { userId } = req.query;
  const d = load();
  res.json(d.timers[userId] || []);
});

// Keepalive (используется внешним cron-job.org для предотвращения spin-down)
app.get('/ping', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ── PUSH HELPER ────────────────────────────────────────
async function sendPush(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (e) {
    if (e.statusCode === 410 || e.statusCode === 404) {
      // Подписка устарела — удаляем
      const d = load();
      for (const uid in d.subscriptions) {
        if (JSON.stringify(d.subscriptions[uid]) === JSON.stringify(subscription)) {
          delete d.subscriptions[uid];
        }
      }
      save(d);
    } else {
      console.error('[push error]', e.statusCode, e.body);
    }
  }
}

// ── SLOT HELPERS (дублируем с фронта) ─────────────────
const SLOT_EM = {
  helmet:'🪖',amulet1:'📿',amulet2:'📿',bracers:'🦾',gloves:'🧤',
  chest:'🥋',belt:'🎗️',
  ring1:'💍',ring2:'💍',ring3:'💍',ring4:'💍',
  ring5:'💍',ring6:'💍',ring7:'💍',ring8:'💍',
  greaves:'🦵',cloak:'🧥',pants:'👖',weapon1:'⚔️',weapon2:'⚔️'
};
const SLOT_NM = {
  helmet:'Шлем',amulet1:'Амулет I',amulet2:'Амулет II',
  bracers:'Наручи',gloves:'Перчатки',chest:'Латы',belt:'Пояс',
  ring1:'Кольцо I',ring2:'Кольцо II',ring3:'Кольцо III',ring4:'Кольцо IV',
  ring5:'Кольцо V',ring6:'Кольцо VI',ring7:'Кольцо VII',ring8:'Кольцо VIII',
  greaves:'Поножи',cloak:'Плащ',pants:'Штаны',
  weapon1:'Оружие I',weapon2:'Оружие II'
};

function fmtLeft(ms) {
  const abs = Math.abs(ms);
  const m = Math.floor(abs/60000)%60;
  const h = Math.floor(abs/3600000)%24;
  const d = Math.floor(abs/86400000);
  if (d > 0) return `${d}д ${String(h).padStart(2,'0')}ч`;
  if (h > 0) return `${String(h).padStart(2,'0')}ч ${String(m).padStart(2,'0')}м`;
  return `${m}м`;
}

// ── CRON: каждую минуту ────────────────────────────────
const FIVE_DAYS = 5 * 86400000;

cron.schedule('* * * * *', async () => {
  const d    = load();
  const now  = Date.now();
  let changed = false;

  for (const [userId, items] of Object.entries(d.timers)) {
    const sub = d.subscriptions[userId];
    if (!sub || !items?.length) continue;

    for (const item of items) {
      for (const [idx, stone] of [item.stone1, item.stone2].entries()) {
        if (!stone) continue;
        const ml = stone.startedAt + stone.durationMs - now;
        const em = SLOT_EM[item.slot] || '◆';
        const sn = SLOT_NM[item.slot] || 'Слот';

        // 1. Истёк — одноразовое уведомление (ключ включает startedAt)
        if (ml <= 0) {
          const k = `exp_${item.id}_s${idx+1}_${stone.startedAt}`;
          if (!d.notified[k]) {
            await sendPush(sub, {
              title: '⚗ Камень истёк! · BlackDeath',
              body:  `${em} ${sn}: «${stone.name}» — срок истёк. Замени камень!`,
              tag:   k,
              requireInteraction: true
            });
            d.notified[k] = true;
            changed = true;
          }
        }

        // 2. Предупреждение — раз в день, пока ≤ 5 дней
        if (ml > 0 && ml <= FIVE_DAYS) {
          const today     = new Date().toDateString();
          const daysLeft  = Math.ceil(ml / 86400000);
          const k = `warn_${item.id}_s${idx+1}_${daysLeft}`;
          if (d.notified[k] !== today) {
            await sendPush(sub, {
              title: '⚗ Хранитель Камней · BlackDeath',
              body:  `${em} ${sn}: «${stone.name}» — осталось ${fmtLeft(ml)}`,
              tag:   k
            });
            d.notified[k] = today;
            changed = true;
          }
        }
      }
    }
  }

  if (changed) save(d);
});

// ── START ──────────────────────────────────────────────
app.listen(PORT, () => console.log(`⚗ BlackDeath server · port ${PORT}`));
