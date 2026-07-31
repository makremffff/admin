// ══════════════════════════════════════════════════════════════════════════════
//  api/index.js  —  RealCash (ريل كاش) · Vercel Serverless Function
//  نفس بنية أمان مشروع BigLeague: initData HMAC + signed ad tokens + Neon Postgres
// ══════════════════════════════════════════════════════════════════════════════

const { neon } = require('@neondatabase/serverless');
const crypto   = require('crypto');

const DATABASE_URL    = process.env.DATABASE_URL;
const BOT_TOKEN       = process.env.BOT_TOKEN;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET; // ← أضفه في Vercel env vars (يستخدمه أدمن بانل + توقيع ad tokens)

// 📢 قناة الاشتراك الإجباري (اختيارية) — اتركها فارغة لتعطيل مهمة "انضم لقناة تيليجرام"
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || 'ReaalCashbot';

// 🎬 Adsgram — بوابة تأكيد server-to-server حقيقية (اختيارية لكن يُنصح بشدة بتفعيلها).
// بدونها، claimAd يعتمد فقط على توقيت التوكن (لا يزال آمناً)، لكن مع ضبط هذا السر
// وربط Reward URL في partner.adsgram.ai (راجع api/adsgram-reward.js) يصير التأكيد
// حقيقياً 100% ولا يمكن لأي سكربت عميل تزويره.
const ADSGRAM_REWARD_SECRET = process.env.ADSGRAM_REWARD_SECRET || '';

if (!DATABASE_URL) {
  throw new Error('[FATAL] DATABASE_URL env var is not set');
}
if (!INTERNAL_SECRET) {
  // 🛡️ بدون هذا السر أي شخص يقدر يزوّر ad tokens أو ينادي endpoints الأدمن — fail-closed
  throw new Error('[FATAL] INTERNAL_SECRET env var is not set — refusing to run with an insecure fallback key');
}

const _db = neon(DATABASE_URL);
async function sql(query, params = []) {
  return await _db(query, params);
}

// ══════════════════════════════════════════════════════════════════════════════
//  إعدادات التطبيق — عدّل هذه القيم بحرية، السيرفر هو مصدر الحقيقة الوحيد لأي رقم
// ══════════════════════════════════════════════════════════════════════════════
const APP_CFG = {
  // 🎬 مهمة "شاهد إعلانات"
  AD_REWARD_USD:        0,      // لا مكافأة نقدية لكل إعلان منفرد — فقط عند إكمال الـ 15 كاملة (تحت)
  AD_REWARD_POINTS:     10,     // نقاط المكافآت لكل إعلان
  AD_BATCH_REQUIRED:    15,     // عدد الإعلانات في المهمة اليومية "شاهد 15 إعلان"
  AD_BATCH_BONUS_USD:   0.02,   // مكافأة إضافية عند إكمال الدفعة كاملة
  AD_DAILY_MAX:         40,     // أقصى عدد إعلانات مسموح بها باليوم لكل مستخدم
  AD_COOLDOWN_SEC:      15,     // أقل فاصل زمني بين مشاهدتين
  AD_TOKEN_GRACE_SEC:   90,     // صلاحية الـ token بعد اكتمال مدة المشاهدة المطلوبة
  AD_TIMING_TOLERANCE_SEC: 2,   // هامش صغير لفروق توقيت الشبكة/الجهاز

  // ⏱️ مدة المشاهدة الحقيقية المطلوبة — لكل شبكة إعلانات مدتها الخاصة (عدّلها حسب شبكتك)
  AD_DURATIONS: { adsgram: 15, monetag: 16, default: 15 },

  // 🎯 مهمة "Task Ads" (Adsgram Block من نوع Task، بصيغة blockId مثل task-40539)
  // حصة منفصلة تمامًا عن حصة إعلانات الفيديو أعلاه — لا تؤثر على AD_DAILY_MAX ولا العكس
  TASK_AD_REWARD_USD:   0.001, // مكافأة كل مهمة Task مكتملة
  TASK_AD_DAILY_MAX:    30,    // أقصى عدد مهام Task مسموح بها باليوم لكل مستخدم — عدّله بحرية
  TASK_AD_COOLDOWN_SEC: 60,    // أقل فاصل زمني بين مطالبتين (دقيقة واحدة)

  // 📢 مهمة الانضمام للقناة
  JOIN_CHANNEL_REWARD_USD:    0.005,
  JOIN_CHANNEL_REWARD_POINTS: 50,

  // 📅 تسجيل الدخول اليومي
  DAILY_LOGIN_REWARD_USD:      0.002857, // 0.02$ مقسّمة على 7 أيام
  DAILY_LOGIN_REWARD_POINTS:   20,
  DAILY_LOGIN_STREAK_DAYS:     7,
  DAILY_LOGIN_STREAK_BONUS_USD: 0,     // لا مكافأة إضافية — المجموع 0.02$ موزّع على الأيام السبعة فقط

  // 👥 الإحالات
  REFERRAL_REWARD_USD:          0,     // لا جائزة فورية — فقط نسبة 10% مدى الحياة (تحت)
  REFERRAL_REWARD_POINTS:       500,   // تُضاف مباشرة لنقاط المسابقة (contest_score) للمُحيل، وليست نقاط المتجر
  REFERRAL_ACTIVATION_ADS:      0,     // 0 = تفعيل فوري بدون أي شروط عند انضمام الصديق عبر رابط الإحالة
  REFERRAL_LIFETIME_PERCENT:    0.10,  // نسبة تُضاف للمُحيل من كل أرباح إعلانات المُحال، مدى الحياة
  REFERRAL_MILESTONE_FRIENDS:   3,     // عدد الأصدقاء المطلوب يوميًا لمهمة "ادعُ 3 أصدقاء" (مهمة يومية تتصفر كل يوم)
  REFERRAL_MILESTONE_REWARD_USD: 0.007,

  // 💰 السحب
  WITHDRAW_MIN_USD:              0.025,
  WITHDRAW_MIN_ACTIVE_REFERRALS: 0,    // 0 = الشرط معطّل، غيّرها لأي رقم لتفعيل شرط الإحالات قبل السحب
  WITHDRAW_REQUIRE_CHANNEL:      false,// true لتفعيل اشتراط الانضمام للقناة قبل السحب

  // 🏆 المسابقة الأسبوعية (نفس نمط "competition" في BigLeague لكن مدتها أسبوع بدل 20 يوم)
  CONTEST_DURATION_DAYS: 7,
  CONTEST_PRIZES_USD: { 1: 0.5, 2: 0.3, 3: 0.2 }, // جوائز المراكز 1/2/3 بالدولار، تُصرف تلقائياً عند انتهاء الأسبوع

  // 🎁 متجر النقاط (صفحة المكافآت) — النقاط عملة منفصلة عن رصيد الدولار
  // ⚠️ ملاحظة أمان: الاستبدال يخصم فقط من عمود points، ولا يمسّ contest_score إطلاقاً —
  // نقاط ترتيب المسابقة الأسبوعية محفوظة بعمود منفصل تماماً ولا تتأثر بالاستبدال هنا
  REWARDS_CATALOG: {
    balance_001usd: { cost: 1000, title: 'رصيد إضافي 0.01$', type: 'balance', amountUsd: 0.01 },
  },
};

// ── Anti-abuse config (نفس نمط BigLeague) ──────────────────────────────────────
const CFG = {
  IP_MAX_REQ_PER_MIN: 120,
  TS_DRIFT_SEC:       300,
};

// ══════════════════════════════════════════════════════════════════════════════
//  Ad Token — موقّع (HMAC) وغير قابل للتزوير، يُنشأ على السيرفر فقط
// ══════════════════════════════════════════════════════════════════════════════
const AD_TOKEN_KEY = crypto
  .createHmac('sha256', 'realcash-ad-token-v1')
  .update(INTERNAL_SECRET)
  .digest();

function signAdToken(payload) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', AD_TOKEN_KEY).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifyAdToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const b64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', AD_TOKEN_KEY).update(b64).digest('base64url');

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Schema
// ══════════════════════════════════════════════════════════════════════════════
async function ensureSchema() {
  await sql(`CREATE TABLE IF NOT EXISTS users (
    id                   SERIAL PRIMARY KEY,
    telegram_id          BIGINT UNIQUE NOT NULL,
    username             TEXT,
    first_name           TEXT,
    photo_url            TEXT,
    balance_usd          NUMERIC(14,6) NOT NULL DEFAULT 0,
    points               BIGINT NOT NULL DEFAULT 0,
    referral_code        TEXT UNIQUE,
    referred_by          BIGINT,
    referral_activated    BOOLEAN NOT NULL DEFAULT FALSE,
    total_ads_watched     INT NOT NULL DEFAULT 0,
    daily_ads            INT NOT NULL DEFAULT 0,
    last_ad_date          DATE,
    last_ad_watch         TIMESTAMPTZ,
    daily_login_streak    INT NOT NULL DEFAULT 0,
    last_daily_login       DATE,
    daily_invites          INT NOT NULL DEFAULT 0,
    last_invite_date        DATE,
    wallet_address        TEXT,
    notify_tasks          BOOLEAN NOT NULL DEFAULT TRUE,
    notify_earnings       BOOLEAN NOT NULL DEFAULT TRUE,
    notify_contest        BOOLEAN NOT NULL DEFAULT FALSE,
    is_elite              BOOLEAN NOT NULL DEFAULT FALSE,
    double_earn_until      TIMESTAMPTZ,
    banned                BOOLEAN NOT NULL DEFAULT FALSE,
    shadow_banned          BOOLEAN NOT NULL DEFAULT FALSE,
    risk_score             INT NOT NULL DEFAULT 0,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at           TIMESTAMPTZ
  )`);
  // Backfill آمن لأي أعمدة أُضيفت لاحقاً على قاعدة بيانات قائمة
  const backfillCols = [
    ['photo_url', 'TEXT'], ['wallet_address', 'TEXT'],
    ['notify_tasks', 'BOOLEAN NOT NULL DEFAULT TRUE'],
    ['notify_earnings', 'BOOLEAN NOT NULL DEFAULT TRUE'],
    ['notify_contest', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['is_elite', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['double_earn_until', 'TIMESTAMPTZ'],
    ['daily_login_streak', 'INT NOT NULL DEFAULT 0'],
    ['last_daily_login', 'DATE'],
    ['referral_activated', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['total_ads_watched', 'INT NOT NULL DEFAULT 0'],
    ['banned', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['shadow_banned', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['risk_score', 'INT NOT NULL DEFAULT 0'],
    ['last_seen_at', 'TIMESTAMPTZ'],
    ['daily_invites', 'INT NOT NULL DEFAULT 0'],
    ['last_invite_date', 'DATE'],
    // 🎯 حصة Task Ads — منفصلة تمامًا عن daily_ads / last_ad_date الخاصة بإعلانات الفيديو
    ['daily_task_ads', 'INT NOT NULL DEFAULT 0'],
    ['last_task_ad_date', 'DATE'],
    ['last_task_ad_watch', 'TIMESTAMPTZ'],
    ['total_task_ads', 'INT NOT NULL DEFAULT 0'],
  ];
  for (const [col, def] of backfillCols) {
    await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col} ${def}`);
  }

  // جلسات الإعلانات — كل إعلان له token مؤقت (موقّع HMAC، غير قابل للتزوير)
  await sql(`CREATE TABLE IF NOT EXISTS ad_sessions (
    token      TEXT PRIMARY KEY,
    user_id    INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ad_type    TEXT NOT NULL DEFAULT 'default',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    used       BOOLEAN NOT NULL DEFAULT FALSE
  )`);
  await sql(`ALTER TABLE ad_sessions ADD COLUMN IF NOT EXISTS ad_type TEXT NOT NULL DEFAULT 'default'`);
  await sql(`CREATE INDEX IF NOT EXISTS idx_ad_sessions_user ON ad_sessions(user_id)`);

  // 🛡️ تأكيدات Adsgram Reward URL — server-to-server، لا تمر من متصفح المستخدم أبداً
  // كل صف يعني "Adsgram أكّد أن هذا المستخدم شاهد إعلاناً فعلياً الآن" (راجع api/adsgram-reward.js)
  await sql(`CREATE TABLE IF NOT EXISTS ad_reward_confirmations (
    id          SERIAL PRIMARY KEY,
    telegram_id BIGINT NOT NULL,
    consumed    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await sql(`CREATE INDEX IF NOT EXISTS idx_arc_lookup ON ad_reward_confirmations (telegram_id, consumed, created_at)`);

  // Rate limiting بالـ IP
  await sql(`CREATE TABLE IF NOT EXISTS ip_limits (
    ip           TEXT NOT NULL,
    window_type  TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    count        INT NOT NULL DEFAULT 0,
    PRIMARY KEY (ip, window_type, window_start)
  )`);

  // مهام لمرة واحدة / تراكمية (انضمام قناة، دعوة 3 أصدقاء...)
  await sql(`CREATE TABLE IF NOT EXISTS user_tasks (
    user_id      INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id      TEXT NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, task_id)
  )`);

  // السحوبات
  await sql(`CREATE TABLE IF NOT EXISTS withdrawals (
    id         SERIAL PRIMARY KEY,
    user_id    INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    address    TEXT NOT NULL,
    amount     NUMERIC(14,6) NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // سجل المعاملات — المصدر الموحّد لصفحتي "السجل" و"المحفظة"
  await sql(`CREATE TABLE IF NOT EXISTS transactions (
    id            SERIAL PRIMARY KEY,
    user_id       INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category      TEXT NOT NULL,   -- earn | withdraw | referral | task | reward
    title         TEXT NOT NULL,   -- نص احتياطي (عربي) — يُستخدم فقط إن ما وُجد title_key
    title_key     TEXT,            -- مفتاح ترجمة للعرض بلغة المستخدم الحالية (i18n.js)
    title_params  JSONB,           -- متغيرات الترجمة، مثال: {"name":"أحمد"}
    amount_usd    NUMERIC(14,6) NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await sql(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS title_key TEXT`);
  await sql(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS title_params JSONB`);
  await sql(`CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, created_at DESC)`);

  // استبدال المكافآت بالنقاط
  await sql(`CREATE TABLE IF NOT EXISTS reward_redemptions (
    id         SERIAL PRIMARY KEY,
    user_id    INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reward_id  TEXT NOT NULL,
    cost       INT  NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await sql(`CREATE INDEX IF NOT EXISTS idx_users_points ON users (points DESC)`);

  // موسم المسابقة الأسبوعية
  await sql(`CREATE TABLE IF NOT EXISTS contest_season (
    id                 SERIAL PRIMARY KEY,
    name               TEXT NOT NULL DEFAULT 'الأسبوع 1',
    start_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    end_at             TIMESTAMPTZ NOT NULL,
    active             BOOLEAN NOT NULL DEFAULT TRUE,
    prize_distributed  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await sql(`
    INSERT INTO contest_season (name, start_at, end_at, active)
    SELECT 'الأسبوع 1', NOW(), NOW() + INTERVAL '${APP_CFG.CONTEST_DURATION_DAYS} days', TRUE
    WHERE NOT EXISTS (SELECT 1 FROM contest_season WHERE active = TRUE)
  `);
  // نقاط المسابقة منفصلة عن نقاط متجر المكافآت — تُصفَّر كل أسبوع
  await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS contest_score BIGINT NOT NULL DEFAULT 0`);

  await sql(`CREATE TABLE IF NOT EXISTS activity_logs (
    id         SERIAL PRIMARY KEY,
    user_id    INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action     TEXT NOT NULL,
    meta       JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

// ══════════════════════════════════════════════════════════════════════════════
//  Telegram initData verification (نفس منطق BigLeague حرفياً)
// ══════════════════════════════════════════════════════════════════════════════
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');
    if (!receivedHash) return null;
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(expectedHash), Buffer.from(receivedHash))) return null;
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (Date.now() / 1000 - authDate > 3600) return null;
    return JSON.parse(params.get('user') || '{}');
  } catch {
    return null;
  }
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// 🛡️ يوحّد قيمة عمود DATE إلى نص "YYYY-MM-DD" بغض النظر هل السائق أرجعها ككائن Date
// أو كنص جاهز — بدون هذا، مقارنة "===" مع تاريخ اليوم قد تفشل بصمت وتفتح ثغرة استلام متكرر
function toDateStr(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

// ══════════════════════════════════════════════════════════════════════════════
//  🛡️ Helpers: IP · Rate limit
// ══════════════════════════════════════════════════════════════════════════════
function getClientIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

async function checkIPLimit(ip) {
  await sql(`DELETE FROM ip_limits WHERE window_start < NOW() - INTERVAL '2 minutes'`);
  const rows = await sql(
    `INSERT INTO ip_limits (ip, window_type, window_start, count)
     VALUES ($1, 'min', DATE_TRUNC('minute', NOW()), 1)
     ON CONFLICT (ip, window_type, window_start)
     DO UPDATE SET count = ip_limits.count + 1
     RETURNING count`,
    [ip]
  );
  return rows[0].count <= CFG.IP_MAX_REQ_PER_MIN;
}

// ══════════════════════════════════════════════════════════════════════════════
//  Users
// ══════════════════════════════════════════════════════════════════════════════
function genReferralCode(telegramId) {
  return 'ref_' + String(telegramId);
}

async function upsertUser(tgUser, startParam) {
  const telegramId = tgUser.id;
  const existingRows = await sql(`SELECT * FROM users WHERE telegram_id = $1`, [telegramId]);

  if (existingRows.length) {
    const rows = await sql(
      `UPDATE users SET username = $2, first_name = $3, photo_url = $4
       WHERE telegram_id = $1 RETURNING *`,
      [telegramId, tgUser.username || null, tgUser.first_name || null, tgUser.photo_url || null]
    );
    return rows[0];
  }

  // مستخدم جديد — نحدد referred_by من رابط الدعوة (start_param = ref_<telegram_id>) لو موجود
  let referredBy = null;
  if (startParam && /^ref_\d+$/.test(startParam)) {
    const refId = BigInt(startParam.slice(4));
    if (refId !== BigInt(telegramId)) {
      const refRows = await sql(`SELECT telegram_id FROM users WHERE telegram_id = $1`, [refId.toString()]);
      if (refRows.length) referredBy = refId.toString();
    }
  }

  const rows = await sql(
    `INSERT INTO users (telegram_id, username, first_name, photo_url, referral_code, referred_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username
     RETURNING *`,
    [telegramId, tgUser.username || null, tgUser.first_name || null, tgUser.photo_url || null,
     genReferralCode(telegramId), referredBy]
  );
  const newUser = rows[0];

  if (referredBy) {
    await sql(`INSERT INTO activity_logs (user_id, action, meta) VALUES ($1, 'referred', $2)`,
      [newUser.id, JSON.stringify({ referred_by: referredBy })]);
    // 🎯 تفعيل فوري بدون شروط — ما في حاجة ننتظر أول إعلان يشاهده الصديق
    await maybeActivateReferral(newUser).catch(err => console.error('[instant referral activation]', err.message));
  }

  return newUser;
}

async function logTx(userId, category, title, amountUsd, titleKey, titleParams) {
  await sql(
    `INSERT INTO transactions (user_id, category, title, amount_usd, title_key, title_params) VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId, category, title, amountUsd, titleKey || null, titleParams ? JSON.stringify(titleParams) : null]
  );
}

// 🛡️ يستهلك تأكيد Adsgram (إن وُجد) لهذا المستخدم — يُستدعى من tasks.claimAd و tasks.claimTaskAd
// يعيد true فقط لو وصل تأكيد server-to-server حقيقي من Adsgram لم يُستهلك بعد
// (الصف يُنشَأ عبر api/adsgram-reward.js — endpoint منفصل تستدعيه سيرفرات Adsgram مباشرة)
// kind: 'reward' لإعلان الفيديو (الافتراضي) أو 'task' لإعلان Task — كل نوع له حوض تأكيدات منفصل
async function consumeAdsgramConfirmation(telegramId, kind = 'reward') {
  await sql(`DELETE FROM ad_reward_confirmations WHERE created_at < NOW() - INTERVAL '10 minutes'`);
  const rows = await sql(`
    UPDATE ad_reward_confirmations
    SET consumed = TRUE
    WHERE id = (
      SELECT id FROM ad_reward_confirmations
      WHERE telegram_id = $1 AND kind = $2 AND consumed = FALSE
      ORDER BY created_at ASC
      LIMIT 1
    )
    RETURNING id
  `, [telegramId, kind]);
  return rows.length > 0;
}

// 👥 يفحص هل تجاوز عدد إعلانات المُحال حد التفعيل، ويمنح مكافأة الإحالة للمُحيل مرة واحدة فقط
async function maybeActivateReferral(dbUser) {
  if (!dbUser.referred_by || dbUser.referral_activated) return;
  if (dbUser.total_ads_watched < APP_CFG.REFERRAL_ACTIVATION_ADS) return;

  const referrerRows = await sql(`SELECT * FROM users WHERE telegram_id = $1`, [dbUser.referred_by]);
  const referrer = referrerRows[0];
  if (!referrer) return;

  // 🛡️ تحديث ذري + شرط WHERE referral_activated=false يمنع أي تكرار عند سباق طلبات
  const claimed = await sql(
    `UPDATE users SET referral_activated = TRUE WHERE id = $1 AND referral_activated = FALSE RETURNING id`,
    [dbUser.id]
  );
  if (!claimed.length) return;

  await sql(`UPDATE users SET balance_usd = balance_usd + $1, contest_score = contest_score + $2 WHERE id = $3`,
    [APP_CFG.REFERRAL_REWARD_USD, APP_CFG.REFERRAL_REWARD_POINTS, referrer.id]);
  await logTx(referrer.id, 'referral', `إحالة جديدة — ${dbUser.first_name || 'صديق'}`, APP_CFG.REFERRAL_REWARD_USD, 'tx.newReferral', { name: dbUser.first_name || '—' });

  // 🎯 مهمة "ادعُ 3 أصدقاء" — يوميّة: تتصفر كل يوم، وتُمنح المكافأة عند وصول 3 إحالات مُفعّلة
  // في نفس اليوم التقويمي (لا علاقة لها بإجمالي الإحالات مدى الحياة — ذاك محسوب بشكل منفصل)
  const today = toDateStr(new Date());
  const inviteRows = await sql(
    `UPDATE users
     SET daily_invites = CASE WHEN last_invite_date = $2 THEN daily_invites + 1 ELSE 1 END,
         last_invite_date = $2
     WHERE id = $1
     RETURNING daily_invites`,
    [referrer.id, today]
  );
  const newDailyCount = inviteRows[0]?.daily_invites ?? 0;
  if (newDailyCount === APP_CFG.REFERRAL_MILESTONE_FRIENDS) {
    await sql(`UPDATE users SET balance_usd = balance_usd + $1 WHERE id = $2`,
      [APP_CFG.REFERRAL_MILESTONE_REWARD_USD, referrer.id]);
    await logTx(referrer.id, 'task', 'مكافأة: دعوة 3 أصدقاء اليوم', APP_CFG.REFERRAL_MILESTONE_REWARD_USD, 'tx.inviteMilestone');
  }

  sendTelegramMessage(
    Number(referrer.telegram_id),
    `🎉 انضم صديقك *${escapeHtml(dbUser.first_name || 'صديقك')}* وستربح 10% من أرباحه مدى الحياة`
  ).catch(e => console.error('[referral notify]', e.message));
}

// 💸 عمولة مدى الحياة 10% للمُحيل — تُستدعى بعد أي ربح فعلي للمُحال (إعلان، مهمة، تسجيل دخول...)
// تُحسب فقط لو كانت الإحالة مُفعَّلة، وتُرسِل إشعاراً فورياً للمُحيل بحصته من هذا الربح تحديداً
async function creditReferralCommission(referredDbUser, earnedAmountUsd) {
  if (!earnedAmountUsd || earnedAmountUsd <= 0) return;
  if (!referredDbUser.referred_by || !referredDbUser.referral_activated) return;

  const commission = earnedAmountUsd * APP_CFG.REFERRAL_LIFETIME_PERCENT;
  if (commission <= 0) return;

  const referrerRows = await sql(`SELECT * FROM users WHERE telegram_id = $1`, [referredDbUser.referred_by]);
  const referrer = referrerRows[0];
  if (!referrer) return;

  await sql(`UPDATE users SET balance_usd = balance_usd + $1 WHERE id = $2`, [commission, referrer.id]);
  const friendName = referredDbUser.first_name || referredDbUser.username || 'صديقك';
  await logTx(referrer.id, 'referral', `حصة من ربح صديقك ${friendName}`, commission, 'tx.referralCommission', { name: friendName });

  if (referrer.notify_earnings) {
    sendTelegramMessage(
      Number(referrer.telegram_id),
      `🎁 لقد حصلت على حصة من ربح صديقك *${escapeHtml(friendName)}*: *${commission.toFixed(5)}$*\n\nتُضاف تلقائياً 10% من أرباح أصدقائك النشطين لرصيدك، مدى الحياة 💰`
    ).catch(e => console.error('[referral commission notify]', e.message));
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Contest / Leaderboard
// ══════════════════════════════════════════════════════════════════════════════
async function getActiveContest() {
  const rows = await sql(`SELECT * FROM contest_season WHERE active = TRUE ORDER BY id DESC LIMIT 1`);
  return rows[0] || null;
}

// 🛡️ نستخدم ROW_NUMBER بدل RANK: بها كل المستخدمين اللي نقاطهم صفر (أو متعادلين) كانوا ياخذوا
// نفس الترتيب (مثلاً الكل "المركز 2")، لأن RANK() يعطي نفس الرقم للمتعادلين بالضبط.
// الحل: عند تعادل النقاط، الفيصل يكون توقيت الدخول (created_at) — الأقدم انضمامًا ياخذ الترتيب الأفضل،
// فيصير كل مستخدم له رقم ترتيب فريد ومتسلسل بدون أي تكرار.
async function getLeaderboard(limit = 20) {
  return await sql(
    `SELECT telegram_id, first_name, photo_url, contest_score,
            ROW_NUMBER() OVER (ORDER BY contest_score DESC, created_at ASC) AS rank
     FROM users WHERE banned = FALSE AND shadow_banned = FALSE
     ORDER BY contest_score DESC, created_at ASC LIMIT $1`,
    [limit]
  );
}

async function getUserRank(userId) {
  const rows = await sql(
    `SELECT rnk FROM (
       SELECT id, ROW_NUMBER() OVER (ORDER BY contest_score DESC, created_at ASC) AS rnk FROM users
       WHERE banned = FALSE AND shadow_banned = FALSE
     ) t WHERE id = $1`,
    [userId]
  );
  return rows[0]?.rnk ?? null;
}

// 🏆 عند انتهاء الأسبوع: يوزّع الجوائز، يصفّر النقاط، ويبدأ موسماً جديداً — best-effort، بدون قفل صريح
async function distributeContestPrizesIfNeeded() {
  const active = await getActiveContest();
  if (!active) return;
  if (new Date(active.end_at).getTime() > Date.now()) return;
  if (active.prize_distributed) return;

  const claimed = await sql(
    `UPDATE contest_season SET active = FALSE, prize_distributed = TRUE
     WHERE id = $1 AND prize_distributed = FALSE RETURNING id`,
    [active.id]
  );
  if (!claimed.length) return; // سباق — سيرفرلس آخر سبقنا بالتوزيع

  const top = await sql(
    `SELECT id, telegram_id, first_name, contest_score,
            ROW_NUMBER() OVER (ORDER BY contest_score DESC, created_at ASC) AS rnk
     FROM users WHERE contest_score > 0
     ORDER BY contest_score DESC, created_at ASC LIMIT 3`
  );

  for (const w of top) {
    const prize = APP_CFG.CONTEST_PRIZES_USD[w.rnk];
    if (!prize) continue;
    await sql(`UPDATE users SET balance_usd = balance_usd + $1 WHERE id = $2`, [prize, w.id]);
    await logTx(w.id, 'earn', `جائزة المسابقة — المركز ${w.rnk}`, prize, 'tx.contestPrize', { rank: w.rnk });
    sendTelegramMessage(
      Number(w.telegram_id),
      `🏆 *انتهت المسابقة الأسبوعية!*\n\nحصلت على المركز *#${w.rnk}* وربحت *${prize.toFixed(2)}$* 🎉\nتمت إضافتها لرصيدك — بالتوفيق بالأسبوع الجديد!`
    ).catch(e => console.error('[contest notify]', e.message));
  }

  await sql(`UPDATE users SET contest_score = 0`);

  const m = /(\d+)\s*$/.exec(active.name || '');
  const nextNum = m ? (parseInt(m[1], 10) + 1) : 2;
  const nextName = m ? active.name.replace(/\d+\s*$/, String(nextNum)) : `الأسبوع ${nextNum}`;
  await sql(
    `INSERT INTO contest_season (name, start_at, end_at, active)
     VALUES ($1, NOW(), NOW() + INTERVAL '${APP_CFG.CONTEST_DURATION_DAYS} days', TRUE)`,
    [nextName]
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  Telegram Bot API
// ══════════════════════════════════════════════════════════════════════════════
async function sendTelegramMessage(chatId, text) {
  if (!BOT_TOKEN) return { ok: false };
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: String(chatId), text, parse_mode: 'Markdown' })
  });
  return await res.json();
}

async function isChannelMember(telegramId) {
  if (!CHANNEL_USERNAME) return true; // المهمة/الشرط معطّل أصلاً لو ما فيه قناة مضبوطة
  if (!BOT_TOKEN) return true;
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=@${CHANNEL_USERNAME}&user_id=${telegramId}`
    );
    const j = await r.json();
    if (!j.ok) return false;
    return ['creator', 'administrator', 'member'].includes(j.result?.status);
  } catch (e) {
    console.error('[channel check]', e.message);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Main Export
// ══════════════════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  // ── CORS — محدود لدومين Telegram WebApp ─────────────────────────────────────
  const allowedOrigins = ['https://web.telegram.org', 'https://webk.telegram.org', 'https://webz.telegram.org'];
  const origin = req.headers['origin'] || '';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigins.includes(origin) ? origin : allowedOrigins[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    await ensureSchema();
  } catch (err) {
    console.error('[Schema error]', err.message);
    return res.status(500).json({ ok: false, error: 'DB schema error: ' + err.message });
  }

  try {
    await distributeContestPrizesIfNeeded();
  } catch (err) {
    console.error('[Contest prize error]', err.message);
  }

  const clientIP = getClientIP(req);
  try {
    const ipOk = await checkIPLimit(clientIP);
    if (!ipOk) return res.status(429).json({ ok: false, error: 'Too many requests' });
  } catch (err) {
    console.error('[IP limit error]', err.message);
  }

  const body               = req.body || {};
  const { type, data = {} } = body;
  const rawInitData        = body.initData || req.headers['x-telegram-init-data'] || '';

  // ── Auth ──────────────────────────────────────────────────────────────────
  let tgUser = null;
  let dbUser = null;

  if (type !== 'admin.sendBotMsg') {
    tgUser = verifyInitData(rawInitData);
    if (!tgUser) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    if (data.ts) {
      const drift = Math.abs(Date.now() / 1000 - parseInt(data.ts, 10));
      if (drift > CFG.TS_DRIFT_SEC) return res.status(400).json({ ok: false, error: 'Request expired' });
    }

    try {
      dbUser = await upsertUser(tgUser, data.startParam || null);
    } catch (err) {
      console.error('[upsertUser error]', err.message);
      return res.status(500).json({ ok: false, error: 'DB error: ' + err.message });
    }

    if (dbUser.banned) {
      return res.status(403).json({ ok: false, error: 'banned' });
    }

    sql(`UPDATE users SET last_seen_at = NOW() WHERE id = $1`, [dbUser.id])
      .catch(err => console.error('[last_seen_at update]', err.message));
  }

  // ── Router ───────────────────────────────────────────────────────────────
  try {
    switch (type) {

      // ═══════════ الرئيسية ═══════════
      case 'init': {
        const [rank, leaderboard, refStats, refList, contest, todayRows, tasksDone] = await Promise.all([
          getUserRank(dbUser.id),
          getLeaderboard(20),
          sql(
            `SELECT COUNT(*)::INT AS ref_count,
                    COUNT(*) FILTER (WHERE referral_activated = TRUE)::INT AS active_count,
                    COUNT(*) FILTER (WHERE referral_activated = FALSE)::INT AS pending_count
             FROM users WHERE referred_by = $1`, [dbUser.telegram_id]),
          sql(
            `SELECT first_name, username, photo_url, referral_activated, total_ads_watched, created_at
             FROM users WHERE referred_by = $1 ORDER BY created_at DESC LIMIT 4`, [dbUser.telegram_id]),
          getActiveContest(),
          sql(
            `SELECT COALESCE(SUM(amount_usd),0)::FLOAT AS today_earn
             FROM transactions WHERE user_id = $1 AND amount_usd > 0 AND created_at >= CURRENT_DATE`,
            [dbUser.id]),
          sql(`SELECT task_id FROM user_tasks WHERE user_id = $1`, [dbUser.id]),
        ]);

        const today = new Date().toISOString().slice(0, 10);
        const doneTaskIds = tasksDone.map(r => r.task_id);
        const watchAdsDoneToday = toDateStr(dbUser.last_ad_date) === today ? dbUser.daily_ads : 0;
        const inviteProgressToday = toDateStr(dbUser.last_invite_date) === today ? dbUser.daily_invites : 0;

        const watchDone = watchAdsDoneToday >= APP_CFG.AD_BATCH_REQUIRED;
        const joinDone = doneTaskIds.includes('join_channel');
        const dailyLoginDone = toDateStr(dbUser.last_daily_login) === today;
        const inviteDone = inviteProgressToday >= APP_CFG.REFERRAL_MILESTONE_FRIENDS;
        const taskAdsDoneToday = toDateStr(dbUser.last_task_ad_date) === today ? dbUser.daily_task_ads : 0;
        const taskAdDone = taskAdsDoneToday >= APP_CFG.TASK_AD_DAILY_MAX;

        return res.json({
          ok: true,
          user: {
            telegram_id:  Number(dbUser.telegram_id),
            name:         dbUser.first_name || dbUser.username || 'مستخدم',
            photo_url:    dbUser.photo_url || null,
            balance_usd:  parseFloat(dbUser.balance_usd),
            points:       Number(dbUser.points),
            referral_code: dbUser.referral_code,
            wallet_address: dbUser.wallet_address || null,
            rank,
            contest_score: Number(dbUser.contest_score),
            is_elite:      dbUser.is_elite,
            double_earn_active: !!(dbUser.double_earn_until && new Date(dbUser.double_earn_until) > new Date()),
            notify_tasks:    dbUser.notify_tasks,
            notify_earnings: dbUser.notify_earnings,
            notify_contest:  dbUser.notify_contest,
          },
          stats: {
            today_earn_usd: todayRows[0]?.today_earn ?? 0,
            referrals_count: refStats[0]?.ref_count ?? 0,
            tasks_done_today: [watchDone, joinDone, dailyLoginDone, inviteDone].filter(Boolean).length,
            tasks_total: 4,
          },
          tasks: {
            watch_ads_5: { progress: watchAdsDoneToday, required: APP_CFG.AD_BATCH_REQUIRED, done: watchDone },
            join_channel: { done: joinDone, enabled: !!CHANNEL_USERNAME },
            invite_3_friends: { progress: inviteProgressToday, required: APP_CFG.REFERRAL_MILESTONE_FRIENDS, done: inviteDone },
            daily_login: { streak: dbUser.daily_login_streak, required: APP_CFG.DAILY_LOGIN_STREAK_DAYS, done: toDateStr(dbUser.last_daily_login) === today },
            task_ad: { progress: taskAdsDoneToday, required: APP_CFG.TASK_AD_DAILY_MAX, done: taskAdDone, enabled: !!ADSGRAM_REWARD_SECRET },
          },
          leaderboard: leaderboard.map(r => ({
            telegram_id: Number(r.telegram_id), name: r.first_name || 'مستخدم', photo_url: r.photo_url || null,
            score: Number(r.contest_score), rank: r.rank,
          })),
          referral: {
            count: refStats[0]?.ref_count ?? 0, active: refStats[0]?.active_count ?? 0, pending: refStats[0]?.pending_count ?? 0,
            list: refList.map(r => ({
              name: r.first_name || r.username || 'مستخدم',
              photo_url: r.photo_url || null,
              activated: r.referral_activated,
              ads_watched: r.total_ads_watched,
              activation_required: APP_CFG.REFERRAL_ACTIVATION_ADS,
              joined_at: r.created_at,
            })),
          },
          contest: contest ? { name: contest.name, end_at: contest.end_at, start_at: contest.start_at } : null,
          config: {
            ad_reward_usd: APP_CFG.AD_REWARD_USD, ad_daily_max: APP_CFG.AD_DAILY_MAX,
            ad_batch_bonus_usd: APP_CFG.AD_BATCH_BONUS_USD,
            task_ad_reward_usd: APP_CFG.TASK_AD_REWARD_USD, task_ad_daily_max: APP_CFG.TASK_AD_DAILY_MAX,
            daily_login_reward_usd: APP_CFG.DAILY_LOGIN_REWARD_USD,
            join_channel_reward_usd: APP_CFG.JOIN_CHANNEL_REWARD_USD,
            invite_milestone_reward_usd: APP_CFG.REFERRAL_MILESTONE_REWARD_USD,
            contest_prizes_usd: APP_CFG.CONTEST_PRIZES_USD,
            withdraw_min_usd: APP_CFG.WITHDRAW_MIN_USD, rewards_catalog: APP_CFG.REWARDS_CATALOG,
            channel_username: CHANNEL_USERNAME || null,
          },
        });
      }

      // ═══════════ المهام: إعلانات (شبكة إعلانات حقيقية — Adsgram) ═══════════
      case 'tasks.startAd': {
        const today = new Date().toISOString().slice(0, 10);
        const dailyCount = toDateStr(dbUser.last_ad_date) === today ? dbUser.daily_ads : 0;
        if (dailyCount >= APP_CFG.AD_DAILY_MAX) {
          return res.status(429).json({ ok: false, error: 'daily_limit_reached' });
        }
        if (dbUser.last_ad_watch) {
          const secsSince = (Date.now() - new Date(dbUser.last_ad_watch).getTime()) / 1000;
          if (secsSince < APP_CFG.AD_COOLDOWN_SEC) {
            return res.status(429).json({ ok: false, error: 'cooldown', retryAfterSec: Math.ceil(APP_CFG.AD_COOLDOWN_SEC - secsSince) });
          }
        }

        // 🛡️ احذف أي token قديم غير مستخدم — يمنع تجميع tokens
        await sql(`DELETE FROM ad_sessions WHERE user_id = $1 AND used = FALSE`, [dbUser.id]);

        // 🛡️ مدة المشاهدة تُحدَّد من السيرفر حسب الشبكة — العميل لا يتحكم بها إطلاقاً
        const adType = (typeof data.adType === 'string' ? data.adType.toLowerCase() : 'default');
        const dur    = APP_CFG.AD_DURATIONS[adType] || APP_CFG.AD_DURATIONS.default;

        // 🔒 Payload موقّع HMAC — لا يمكن للعميل تعديل uid/adType/dur/iat ولا إنشاء token بدون السر
        const token = signAdToken({ uid: dbUser.id, adType, dur, iat: Date.now() });
        await sql(`INSERT INTO ad_sessions (token, user_id, ad_type) VALUES ($1, $2, $3)`, [token, dbUser.id, adType]);
        return res.json({ ok: true, token, watchSeconds: dur });
      }

      case 'tasks.claimAd': {
        const payload = verifyAdToken(data.token);
        if (!payload || payload.uid !== dbUser.id) {
          return res.status(400).json({ ok: false, error: 'invalid_token' });
        }

        const sessions = await sql(`SELECT * FROM ad_sessions WHERE token = $1`, [data.token]);
        if (!sessions.length || sessions[0].user_id !== dbUser.id) {
          return res.status(400).json({ ok: false, error: 'invalid_token' });
        }
        if (sessions[0].used) {
          return res.status(400).json({ ok: false, error: 'token_already_used' });
        }

        // 🛡️ مدة المشاهدة المطلوبة محسوبة من التوكن الموقّع نفسه — لا يتحكم بها العميل
        const requiredDur = APP_CFG.AD_DURATIONS[payload.adType] || APP_CFG.AD_DURATIONS.default;
        const elapsedSec   = (Date.now() - payload.iat) / 1000;

        if (elapsedSec < requiredDur - APP_CFG.AD_TIMING_TOLERANCE_SEC) {
          return res.status(400).json({ ok: false, error: 'watched_too_fast' });
        }
        if (elapsedSec > requiredDur + APP_CFG.AD_TOKEN_GRACE_SEC) {
          await sql(`DELETE FROM ad_sessions WHERE token = $1`, [data.token]);
          return res.status(400).json({ ok: false, error: 'token_expired' });
        }

        // 🛡️ بوابة Adsgram Reward URL — تمنع أي سكربت من تزوير "المشاهدة" بمجرد الانتظار.
        // مفعّلة فقط لـ adType === 'adsgram' وفقط بعد ضبط ADSGRAM_REWARD_SECRET في env.
        // لازم يصل تأكيد server-to-server حقيقي من Adsgram لهذا المستخدم قبل منح أي مكافأة.
        if (payload.adType === 'adsgram' && ADSGRAM_REWARD_SECRET) {
          const confirmed = await consumeAdsgramConfirmation(dbUser.telegram_id);
          if (!confirmed) {
            // قد يكون تأكيد Adsgram لم يصل بعد (تأخير شبكة) — اطلب من العميل إعادة المحاولة بهدوء
            return res.status(202).json({ ok: false, error: 'pending_confirmation', retryAfterMs: 1500 });
          }
        }

        // 🛡️ استهلاك ذري — يمنع استخدام نفس التوكن مرتين حتى مع طلبات متزامنة
        // (يحدث فقط هنا، بعد تأكيد Adsgram، حتى تنجح إعادة المحاولة عند pending_confirmation)
        const claimed = await sql(
          `UPDATE ad_sessions SET used = TRUE WHERE token = $1 AND used = FALSE RETURNING token`,
          [data.token]
        );
        if (!claimed.length) return res.status(400).json({ ok: false, error: 'token_already_used' });

        const today = new Date().toISOString().slice(0, 10);
        const isNewDay = toDateStr(dbUser.last_ad_date) !== today;
        const doubleActive = dbUser.double_earn_until && new Date(dbUser.double_earn_until) > new Date();
        const reward = APP_CFG.AD_REWARD_USD * (doubleActive ? 2 : 1);

        await sql(
          `UPDATE users SET
             balance_usd = balance_usd + $1,
             points = points + $2,
             contest_score = contest_score + 1,
             total_ads_watched = total_ads_watched + 1,
             daily_ads = CASE WHEN last_ad_date = $3 THEN daily_ads + 1 ELSE 1 END,
             last_ad_date = $3,
             last_ad_watch = NOW()
           WHERE id = $4`,
          [reward, APP_CFG.AD_REWARD_POINTS, today, dbUser.id]
        );
        if (reward > 0) await logTx(dbUser.id, 'earn', 'مشاهدة إعلان', reward, 'tx.watchAd');

        const newDailyCount = isNewDay ? 1 : dbUser.daily_ads + 1;
        let batchBonus = 0;
        if (newDailyCount === APP_CFG.AD_BATCH_REQUIRED) {
          batchBonus = APP_CFG.AD_BATCH_BONUS_USD;
          await sql(`UPDATE users SET balance_usd = balance_usd + $1 WHERE id = $2`, [batchBonus, dbUser.id]);
          await logTx(dbUser.id, 'task', 'مكافأة: إكمال 5 إعلانات', batchBonus, 'tx.adBatchBonus');
        }

        const refreshed = (await sql(`SELECT * FROM users WHERE id = $1`, [dbUser.id]))[0];
        await maybeActivateReferral(refreshed);
        await creditReferralCommission(refreshed, reward + batchBonus);

        return res.json({
          ok: true, reward, batchBonus, newBalance: parseFloat(refreshed.balance_usd),
          newPoints: Number(refreshed.points), dailyAdsProgress: newDailyCount,
          batchRequired: APP_CFG.AD_BATCH_REQUIRED,
        });
      }

      // ═══════════ المهام: Task Ads (Adsgram Block من نوع Task) — حصة مستقلة عن إعلانات الفيديو ═══════════
      case 'tasks.claimTaskAd': {
        // 🛡️ إعلانات Task تُنجَز عبر عنصر واجهة من Adsgram (وليس token بتوقيت ثابت مثل الفيديو)،
        // فالتأكيد server-to-server هو الحماية الوحيدة الممكنة هنا — fail-closed بدونه
        if (!ADSGRAM_REWARD_SECRET) {
          return res.status(503).json({ ok: false, error: 'not_configured' });
        }

        const today = new Date().toISOString().slice(0, 10);
        const dailyCount = toDateStr(dbUser.last_task_ad_date) === today ? dbUser.daily_task_ads : 0;
        if (dailyCount >= APP_CFG.TASK_AD_DAILY_MAX) {
          return res.status(429).json({ ok: false, error: 'daily_limit_reached' });
        }
        if (dbUser.last_task_ad_watch) {
          const secsSince = (Date.now() - new Date(dbUser.last_task_ad_watch).getTime()) / 1000;
          if (secsSince < APP_CFG.TASK_AD_COOLDOWN_SEC) {
            return res.status(429).json({ ok: false, error: 'cooldown', retryAfterSec: Math.ceil(APP_CFG.TASK_AD_COOLDOWN_SEC - secsSince) });
          }
        }

        const confirmed = await consumeAdsgramConfirmation(dbUser.telegram_id, 'task');
        if (!confirmed) {
          // قد يكون تأكيد Adsgram لم يصل بعد (تأخير شبكة) — اطلب من العميل إعادة المحاولة بهدوء
          return res.status(202).json({ ok: false, error: 'pending_confirmation', retryAfterMs: 1500 });
        }

        const isNewDay = toDateStr(dbUser.last_task_ad_date) !== today;
        const doubleActive = dbUser.double_earn_until && new Date(dbUser.double_earn_until) > new Date();
        const reward = APP_CFG.TASK_AD_REWARD_USD * (doubleActive ? 2 : 1);

        await sql(
          `UPDATE users SET
             balance_usd = balance_usd + $1,
             total_task_ads = total_task_ads + 1,
             daily_task_ads = CASE WHEN last_task_ad_date = $2 THEN daily_task_ads + 1 ELSE 1 END,
             last_task_ad_date = $2,
             last_task_ad_watch = NOW()
           WHERE id = $3`,
          [reward, today, dbUser.id]
        );
        await logTx(dbUser.id, 'task', 'مهمة إعلان (Task Ad)', reward, 'tx.taskAd');

        const refreshed = (await sql(`SELECT * FROM users WHERE id = $1`, [dbUser.id]))[0];
        await creditReferralCommission(refreshed, reward);

        const newDailyCount = isNewDay ? 1 : dbUser.daily_task_ads + 1;
        return res.json({
          ok: true, reward, newBalance: parseFloat(refreshed.balance_usd),
          dailyTaskAdsProgress: newDailyCount, dailyTaskAdsMax: APP_CFG.TASK_AD_DAILY_MAX,
        });
      }

      // ═══════════ مهمة: الانضمام للقناة ═══════════
      case 'tasks.checkChannel': {
        if (!CHANNEL_USERNAME) return res.status(400).json({ ok: false, error: 'channel_not_configured' });
        const already = await sql(`SELECT 1 FROM user_tasks WHERE user_id = $1 AND task_id = 'join_channel'`, [dbUser.id]);
        if (already.length) return res.json({ ok: true, alreadyDone: true });

        const isMember = await isChannelMember(dbUser.telegram_id);
        if (!isMember) return res.json({ ok: false, error: 'not_member', channel: CHANNEL_USERNAME });

        await sql(`INSERT INTO user_tasks (user_id, task_id) VALUES ($1, 'join_channel') ON CONFLICT DO NOTHING`, [dbUser.id]);
        await sql(`UPDATE users SET balance_usd = balance_usd + $1, points = points + $2 WHERE id = $3`,
          [APP_CFG.JOIN_CHANNEL_REWARD_USD, APP_CFG.JOIN_CHANNEL_REWARD_POINTS, dbUser.id]);
        await logTx(dbUser.id, 'task', 'انضمام لقناة تيليجرام', APP_CFG.JOIN_CHANNEL_REWARD_USD, 'tx.joinChannel');
        await creditReferralCommission(dbUser, APP_CFG.JOIN_CHANNEL_REWARD_USD);

        const refreshed = (await sql(`SELECT balance_usd, points FROM users WHERE id = $1`, [dbUser.id]))[0];
        return res.json({ ok: true, reward: APP_CFG.JOIN_CHANNEL_REWARD_USD, newBalance: parseFloat(refreshed.balance_usd), newPoints: Number(refreshed.points) });
      }

      // ═══════════ مهمة: تسجيل الدخول اليومي ═══════════
      case 'tasks.dailyLogin': {
        const today = new Date().toISOString().slice(0, 10);
        if (toDateStr(dbUser.last_daily_login) === today) {
          return res.json({ ok: true, alreadyDone: true, streak: dbUser.daily_login_streak });
        }
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        const continuesStreak = toDateStr(dbUser.last_daily_login) === yesterday;
        const newStreak = continuesStreak ? dbUser.daily_login_streak + 1 : 1;
        const hitMilestone = newStreak % APP_CFG.DAILY_LOGIN_STREAK_DAYS === 0;
        const reward = APP_CFG.DAILY_LOGIN_REWARD_USD + (hitMilestone ? APP_CFG.DAILY_LOGIN_STREAK_BONUS_USD : 0);

        await sql(
          `UPDATE users SET daily_login_streak = $1, last_daily_login = $2,
                             balance_usd = balance_usd + $3, points = points + $4
           WHERE id = $5 AND last_daily_login IS DISTINCT FROM $2`,
          [newStreak, today, reward, APP_CFG.DAILY_LOGIN_REWARD_POINTS, dbUser.id]
        );
        await logTx(dbUser.id, 'task', hitMilestone ? `مكافأة تسجيل الدخول — ${newStreak} أيام متتالية 🎉` : 'تسجيل دخول يومي', reward, hitMilestone ? 'tx.dailyLoginMilestone' : 'tx.dailyLogin', hitMilestone ? { streak: newStreak } : null);
        await creditReferralCommission(dbUser, reward);

        const refreshed = (await sql(`SELECT balance_usd, points FROM users WHERE id = $1`, [dbUser.id]))[0];
        return res.json({ ok: true, reward, streak: newStreak, milestone: hitMilestone, newBalance: parseFloat(refreshed.balance_usd), newPoints: Number(refreshed.points) });
      }

      // ═══════════ المكافآت (استبدال نقاط) ═══════════
      case 'rewards.redeem': {
        const rewardId = data.rewardId;
        const reward = APP_CFG.REWARDS_CATALOG[rewardId];
        if (!reward) return res.status(400).json({ ok: false, error: 'invalid_reward' });
        if (Number(dbUser.points) < reward.cost) return res.status(400).json({ ok: false, error: 'insufficient_points' });

        // 🛡️ خصم ذري — يمنع الاستبدال المزدوج عبر طلبات متزامنة
        const claimed = await sql(
          `UPDATE users SET points = points - $1 WHERE id = $2 AND points >= $1 RETURNING points`,
          [reward.cost, dbUser.id]
        );
        if (!claimed.length) return res.status(400).json({ ok: false, error: 'insufficient_points' });

        await sql(`INSERT INTO reward_redemptions (user_id, reward_id, cost) VALUES ($1,$2,$3)`, [dbUser.id, rewardId, reward.cost]);

        if (reward.type === 'balance') {
          await sql(`UPDATE users SET balance_usd = balance_usd + $1 WHERE id = $2`, [reward.amountUsd, dbUser.id]);
          await logTx(dbUser.id, 'reward', `استبدال: ${reward.title}`, reward.amountUsd, 'tx.redeem', { title: reward.title });
        } else if (reward.type === 'badge') {
          await sql(`UPDATE users SET is_elite = TRUE WHERE id = $1`, [dbUser.id]);
        } else if (reward.type === 'boost') {
          await sql(`UPDATE users SET double_earn_until = NOW() + INTERVAL '${reward.hours} hours' WHERE id = $1`, [dbUser.id]);
        }

        const refreshed = (await sql(`SELECT points, balance_usd FROM users WHERE id = $1`, [dbUser.id]))[0];
        return res.json({ ok: true, newPointsBalance: Number(refreshed.points), newBalance: parseFloat(refreshed.balance_usd) });
      }

      // ═══════════ المحفظة: TON Connect ═══════════
      case 'wallet.connect': {
        const address = String(data.walletAddress || '').trim();
        if (!address) return res.status(400).json({ ok: false, error: 'walletAddress required' });
        await sql(`UPDATE users SET wallet_address = $1 WHERE id = $2`, [address, dbUser.id]);
        return res.json({ ok: true });
      }

      case 'wallet.disconnect': {
        await sql(`UPDATE users SET wallet_address = NULL WHERE id = $1`, [dbUser.id]);
        return res.json({ ok: true });
      }

      case 'wallet.withdraw': {
        if (!dbUser.wallet_address) return res.status(400).json({ ok: false, error: 'wallet_not_connected' });
        const amount = parseFloat(data.amount);
        if (isNaN(amount) || amount < APP_CFG.WITHDRAW_MIN_USD) {
          return res.status(400).json({ ok: false, error: 'min_withdraw', min: APP_CFG.WITHDRAW_MIN_USD });
        }
        if (parseFloat(dbUser.balance_usd) < amount) {
          return res.status(400).json({ ok: false, error: 'insufficient_balance' });
        }

        if (APP_CFG.WITHDRAW_MIN_ACTIVE_REFERRALS > 0) {
          const activeRefRows = await sql(
            `SELECT COUNT(*)::INT AS cnt FROM users WHERE referred_by = $1 AND referral_activated = TRUE`,
            [dbUser.telegram_id]
          );
          if ((activeRefRows[0]?.cnt ?? 0) < APP_CFG.WITHDRAW_MIN_ACTIVE_REFERRALS) {
            return res.status(403).json({ ok: false, error: 'referrals_required', required: APP_CFG.WITHDRAW_MIN_ACTIVE_REFERRALS });
          }
        }
        if (APP_CFG.WITHDRAW_REQUIRE_CHANNEL && CHANNEL_USERNAME) {
          const isMember = await isChannelMember(dbUser.telegram_id);
          if (!isMember) return res.status(403).json({ ok: false, error: 'channel_required', channel: CHANNEL_USERNAME });
        }
        if (dbUser.shadow_banned) {
          return res.json({ ok: true, newBalance: parseFloat(dbUser.balance_usd) }); // رد وهمي بدون خصم فعلي
        }

        // 🛡️ خصم ذري يمنع السحب المزدوج
        const claimed = await sql(
          `UPDATE users SET balance_usd = balance_usd - $1 WHERE id = $2 AND balance_usd >= $1 RETURNING balance_usd`,
          [amount, dbUser.id]
        );
        if (!claimed.length) return res.status(400).json({ ok: false, error: 'insufficient_balance' });

        await sql(`INSERT INTO withdrawals (user_id, address, amount) VALUES ($1,$2,$3)`, [dbUser.id, dbUser.wallet_address, amount]);
        await logTx(dbUser.id, 'withdraw', 'سحب TON', -amount, 'tx.withdrawTon');

        sendTelegramMessage(
          Number(dbUser.telegram_id),
          `✅ *تم استلام طلب السحب*\n\n💎 *المبلغ:* ${amount.toFixed(2)}$\n👛 *المحفظة:* \`${dbUser.wallet_address}\`\n\n🕒 جاري المعالجة...`
        ).catch(e => console.error('[withdraw notify]', e.message));

        return res.json({ ok: true, newBalance: parseFloat(claimed[0].balance_usd) });
      }

      // ═══════════ الإعدادات ═══════════
      case 'settings.update': {
        const allowedKeys = { notify_tasks: true, notify_earnings: true, notify_contest: true };
        const key = data.key;
        if (!allowedKeys[key]) return res.status(400).json({ ok: false, error: 'invalid_key' });
        const value = !!data.value;
        await sql(`UPDATE users SET ${key} = $1 WHERE id = $2`, [value, dbUser.id]);
        return res.json({ ok: true });
      }

      // ═══════════ السجل ═══════════
      case 'history.list': {
        const filter = ['earn', 'withdraw', 'referral', 'task', 'reward'].includes(data.filter) ? data.filter : null;
        const limit = Math.min(parseInt(data.limit, 10) || 30, 100);
        const rows = filter
          ? await sql(`SELECT category, title, title_key, title_params, amount_usd, created_at FROM transactions WHERE user_id = $1 AND category = $2 ORDER BY created_at DESC LIMIT $3`, [dbUser.id, filter, limit])
          : await sql(`SELECT category, title, title_key, title_params, amount_usd, created_at FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`, [dbUser.id, limit]);
        return res.json({ ok: true, transactions: rows.map(r => ({ ...r, amount_usd: parseFloat(r.amount_usd) })) });
      }

      // ═══════════ الإحالات: تتبع النسخ/المشاركة ═══════════
      case 'referral.logCopy': {
        await sql(`INSERT INTO activity_logs (user_id, action) VALUES ($1, 'ref_copy')`, [dbUser.id]);
        return res.json({ ok: true });
      }
      case 'referral.logShare': {
        await sql(`INSERT INTO activity_logs (user_id, action, meta) VALUES ($1, 'share', $2)`,
          [dbUser.id, JSON.stringify({ platform: data.platform || 'unknown' })]);
        return res.json({ ok: true });
      }

      // 👑 عمولة مدى الحياة للمُحيل — تُستدعى داخلياً كل مرة يربح فيها مستخدم من إعلان
      // (مدمجة أعلاه ضمن tasks.claimAd منطقياً عبر maybeActivateReferral + حساب النسبة هنا لو أردت تفعيلها لاحقاً)

      // ═══════════ أدمن (محمي بـ INTERNAL_SECRET) ═══════════
      case 'admin.banUser': {
        const providedSecret = req.headers['x-internal-secret'] || data.secret || '';
        if (providedSecret !== INTERNAL_SECRET) return res.status(403).json({ ok: false, error: 'Forbidden' });
        const targetId = data.telegram_id;
        const unban = data.unban === true;
        if (!targetId) return res.status(400).json({ ok: false, error: 'telegram_id required' });
        const rows = await sql(`UPDATE users SET banned = $1 WHERE telegram_id = $2 RETURNING id`, [!unban, targetId]);
        if (!rows.length) return res.status(404).json({ ok: false, error: 'User not found' });
        return res.json({ ok: true, banned: !unban });
      }

      case 'admin.sendBotMsg': {
        const providedSecret = req.headers['x-internal-secret'] || data.secret || '';
        if (providedSecret !== INTERNAL_SECRET) return res.status(403).json({ ok: false, error: 'Forbidden' });
        const { chatId, text } = data;
        if (!chatId || !text) return res.status(400).json({ ok: false, error: 'chatId and text required' });
        const result = await sendTelegramMessage(chatId, text);
        return res.json({ ok: !!result.ok });
      }

      case 'admin.listUsers': {
        const providedSecret = req.headers['x-internal-secret'] || data.secret || '';
        if (providedSecret !== INTERNAL_SECRET) return res.status(403).json({ ok: false, error: 'Forbidden' });
        const page = Math.max(parseInt(data.page, 10) || 1, 1);
        const perPage = 100;
        const rows = await sql(
          `SELECT id, telegram_id, username, first_name, balance_usd, points, banned, created_at
           FROM users ORDER BY id DESC LIMIT $1 OFFSET $2`,
          [perPage, (page - 1) * perPage]
        );
        return res.json({ ok: true, users: rows.map(r => ({ ...r, balance_usd: parseFloat(r.balance_usd), points: Number(r.points) })), page });
      }

      default:
        return res.status(400).json({ ok: false, error: `Unknown type: "${type}"` });
    }
  } catch (err) {
    console.error('[Handler error]', type, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
