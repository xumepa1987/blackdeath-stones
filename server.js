const express   = require('express');
const webpush   = require('web-push');
const cron      = require('node-cron');
const cors      = require('cors');
const mongoose  = require('mongoose');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(cors());

// ── MONGODB ────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✓ MongoDB connected'))
  .catch(e  => console.error('✗ MongoDB error:', e.message));

// ── MODELS ─────────────────────────────────────────────
const User = mongoose.model('User', new mongoose.Schema({
  username:  { type: String, unique: true, required: true, lowercase: true, trim: true },
  password:  { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
}));

const TimerData = mongoose.model('TimerData', new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true },
  items:     { type: Array, default: [] },
  updatedAt: { type: Date, default: Date.now }
}));

const Subscription = mongoose.model('Subscription', new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  subscription: Object,
  createdAt:    { type: Date, default: Date.now }
}));

const NotifLog = mongoose.model('NotifLog', new mongoose.Schema({
  key:   { type: String, unique: true },
  value: String
}));

// ── VAPID ──────────────────────────────────────────────
webpush.setVapidDetails(
  'mailto:' + (process.env.CONTACT_EMAIL || 'admin@example.com'),
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ── AUTH MIDDLEWARE ────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'blackdeath-secret');
    next();
  } catch { res.status(401).json({ error: 'invalid token' }); }
}

// ── AUTH ROUTES ────────────────────────────────────────
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)     return res.status(400).json({ error: 'Заполни все поля' });
  if (username.length < 3)        return res.status(400).json({ error: 'Логин минимум 3 символа' });
  if (password.length < 4)        return res.status(400).json({ error: 'Пароль минимум 4 символа' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ username, password: hash });
    const token = jwt.sign(
      { id: user._id, username: user.username },
      process.env.JWT_SECRET || 'blackdeath-secret',
      { expiresIn: '100y' }
    );
    res.json({ token, username: user.username });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'Логин уже занят' });
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username: username?.toLowerCase().trim() });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  const token = jwt.sign(
    { id: user._id, username: user.username },
    process.env.JWT_SECRET || 'blackdeath-secret',
    { expiresIn: '100y' }
  );
  res.json({ token, username: user.username });
});

// ── PUSH SUBSCRIBE ─────────────────────────────────────
app.post('/subscribe', auth, async (req, res) => {
  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ error: 'missing subscription' });
  const str = JSON.stringify(subscription);
  const all = await Subscription.find({ userId: req.user.id });
  if (!all.some(s => JSON.stringify(s.subscription) === str)) {
    await Subscription.create({ userId: req.user.id, subscription });
  }
  res.json({ ok: true, devices: all.length + 1 });
});

// ── TIMERS ─────────────────────────────────────────────
app.post('/timers', auth, async (req, res) => {
  const { items } = req.body;
  await TimerData.findOneAndUpdate(
    { userId: req.user.id },
    { items: items || [], updatedAt: new Date() },
    { upsert: true, new: true }
  );
  res.json({ ok: true });
});

app.get('/timers', auth, async (req, res) => {
  const data = await TimerData.findOne({ userId: req.user.id });
  res.json(data?.items || []);
});

// ── KEEPALIVE ──────────────────────────────────────────
app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── PUSH HELPER ────────────────────────────────────────
async function sendPush(sub, payload) {
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
    console.log('[push] sent ok');
  } catch (e) {
    console.error('[push] error', e.statusCode, e.message);
    if (e.statusCode === 410 || e.statusCode === 404) {
      const str = JSON.stringify(sub);
      await Subscription.deleteOne({ subscription: { $exists: true } });
      // Точечное удаление по строке
      const all = await Subscription.find({});
      for (const s of all) {
        if (JSON.stringify(s.subscription) === str) await s.deleteOne();
      }
    }
  }
}

// ── SLOT HELPERS ───────────────────────────────────────
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
  const m = Math.floor(Math.abs(ms)/60000)%60;
  const h = Math.floor(Math.abs(ms)/3600000)%24;
  const d = Math.floor(Math.abs(ms)/86400000);
  if (d > 0) return `${d}д ${String(h).padStart(2,'0')}ч`;
  if (h > 0) return `${String(h).padStart(2,'0')}ч ${String(m).padStart(2,'0')}м`;
  return `${m}м`;
}

// ── CRON: каждую минуту ────────────────────────────────
const FIVE_DAYS = 5 * 86400000;

cron.schedule('* * * * *', async () => {
  try {
    const now      = Date.now();
    const allData  = await TimerData.find({});

    for (const timerDoc of allData) {
      const subs = await Subscription.find({ userId: timerDoc.userId });
      if (!subs.length || !timerDoc.items?.length) continue;

      for (const item of timerDoc.items) {
        for (const [idx, stone] of [item.stone1, item.stone2].entries()) {
          if (!stone) continue;
          const ml = stone.startedAt + stone.durationMs - now;
          const em = SLOT_EM[item.slot] || '◆';
          const sn = SLOT_NM[item.slot] || 'Слот';

          // Камень истёк
          if (ml <= 0) {
            const k = `exp_${item.id}_s${idx+1}_${stone.startedAt}`;
            const exists = await NotifLog.findOne({ key: k });
            if (!exists) {
              for (const s of subs) {
                await sendPush(s.subscription, {
                  title: '⚗ Камень истёк! · BlackDeath',
                  body:  `${em} ${sn}: «${stone.name}» — срок истёк. Замени камень!`,
                  tag: k, requireInteraction: true
                });
              }
              await NotifLog.create({ key: k, value: '1' });
            }
          }

          // Предупреждение ≤ 5 дней
          if (ml > 0 && ml <= FIVE_DAYS) {
            const today    = new Date().toDateString();
            const daysLeft = Math.ceil(ml / 86400000);
            const k = `warn_${item.id}_s${idx+1}_${daysLeft}`;
            const log = await NotifLog.findOne({ key: k });
            if (!log || log.value !== today) {
              for (const s of subs) {
                await sendPush(s.subscription, {
                  title: '⚗ Хранитель Камней · BlackDeath',
                  body:  `${em} ${sn}: «${stone.name}» — осталось ${fmtLeft(ml)}`,
                  tag: k
                });
              }
              await NotifLog.findOneAndUpdate({ key: k }, { value: today }, { upsert: true });
            }
          }
        }
      }
    }
  } catch (e) { console.error('[cron]', e.message); }
});

app.listen(PORT, () => console.log(`⚗ BlackDeath · port ${PORT}`));
