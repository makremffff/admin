// ══════════════════════════════════════════════════════════════════════════════
//  api/index.js  —  BigLeague · Vercel Serverless Function
// ══════════════════════════════════════════════════════════════════════════════

const { neon } = require('@neondatabase/serverless');
const crypto   = require('crypto');

const DATABASE_URL    = process.env.DATABASE_URL;
const BOT_TOKEN       = process.env.BOT_TOKEN;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET; // ← أضفه في Vercel env vars

// ── Anti-abuse config ─────────────────────────────────────────────────────────
const CFG = {
  AD_COOLDOWN_SEC:    60,   // cooldown بين إعلانين
  AD_DAILY_MAX:       30,   // أكثر إعلان يومي
  IP_MAX_ADS_PER_HR:  40,   // أكثر إعلان لكل IP بالساعة
  IP_MAX_REQ_PER_MIN: 60,   // أكثر طلب عام لكل IP بالدقيقة
  RISK_BAN_THRESHOLD: 100,  // risk score يؤدي لـ shadow ban
  TS_DRIFT_SEC:       300,  // أكثر فرق مقبول بالـ timestamp
  AD_TIMING_TOLERANCE_SEC: 2,
  RISK_DECAY_PER_DAY: 10,

  // 🎮 Coin Rain mini-game — جلسة سيرفر لكل جولة، لا تُرسَل نقاط من العميل أبداً
  GAME_ROUND_TICKETS:         600,   // تذاكر ثابتة لكل جولة مكتملة (السيرفر يقرر، لا العميل)
  GAME_ROUND_DURATION_SEC:     40,   // مدة الجولة الفعلية — لا تقبل إرسال أسرع من هذا
  GAME_ROUND_SESSION_TTL_SEC: 300,   // أقصى وقت لإرسال الجولة بعد بدئها (5 دقائق)
};

// ── App business-logic config (synced to frontend via init response) ──────────
const APP_CFG = {
  REF_TICKET_REWARD : 5000,   // competition tickets per referral
  REF_USDT_REWARD   : 0.015,  // USDT added to referrer balance per referral
  AD_TICKET_REWARD  : 750,    // tickets per ad
  AD_DAILY_MAX      : CFG.AD_DAILY_MAX,
  WITHDRAW_MIN      : 1.00,
  PODIUM_PRIZES     : { first: 25, second: 10, third: 7 },
  LB_PRIZE_LABEL    : 'Each $1',
  // توقيت المسابقة — اضبط COMPETITION_END_MS في Vercel env (Unix ms timestamp)
  // مثال: Date.now() + 20 * 24 * 60 * 60 * 1000 ← 20 يوم من الآن
  // للتعيين: node -e "console.log(Date.now() + 20*24*60*60*1000)"
  COMPETITION_END_MS: process.env.COMPETITION_END_MS
    ? parseInt(process.env.COMPETITION_END_MS, 10)
    : Date.now() + 20 * 24 * 60 * 60 * 1000,
};

// 🛡️ مدة المشاهدة المطلوبة — لكل شبكة إعلانات مدتها الحقيقية (عدّل القيم حسب شبكتك)
const AD_DURATIONS = {
  adsgram: 16,
  monetag: 16,
  telega:  16,
  default: 16,
};
// نافذة استخدام الـ token بعد انتهاء المدة المطلوبة — صلاحية ضيقة بدل 5 دقائق ثابتة
const AD_GRACE_SEC = 20;

// 🎯 عتبة المشاهدة الكاملة — أقل من هذه القيمة يُمنح 60% فقط من المكافأة
const AD_FULL_REWARD_MIN_SEC = 33;

const _db = neon(DATABASE_URL);
async function sql(query, params = []) {
  return await _db(query, params);
}

// ══════════════════════════════════════════════════════════════════════════════
//  Ad Token — موقّع (HMAC) وغير قابل للتزوير، يُنشأ على السيرفر فقط
// ══════════════════════════════════════════════════════════════════════════════
// 🛡️ بدون INTERNAL_SECRET، أي شخص يقدر يحسب AD_TOKEN_KEY ويولّد ad tokens مزوّرة
// (كان فيه fallback ثابت ومكتوب بالكود — ثغرة). الآن: fail-closed بدل تشغيل غير آمن.
if (!INTERNAL_SECRET) {
  throw new Error('[FATAL] INTERNAL_SECRET env var is not set — refusing to run with an insecure fallback key');
}

const AD_TOKEN_KEY = crypto
  .createHmac('sha256', 'ad-token-v1')
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
    id            SERIAL PRIMARY KEY,
    telegram_id   BIGINT  UNIQUE NOT NULL,
    username      TEXT,
    first_name    TEXT,
    photo_url     TEXT,
    pts           BIGINT  NOT NULL DEFAULT 0,
    balance_usd   NUMERIC(10,2) NOT NULL DEFAULT 0,
    referral_code TEXT    UNIQUE,
    referred_by   BIGINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  // Backfill columns — آمن على جداول قديمة
  await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url     TEXT`);
  await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ad_watch TIMESTAMPTZ`);
  await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_ads     INT NOT NULL DEFAULT 0`);
  await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ad_date  DATE`);
  await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS risk_score    INT NOT NULL DEFAULT 0`);
  await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS shadow_banned BOOLEAN NOT NULL DEFAULT FALSE`);
  await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS risk_updated_at TIMESTAMPTZ`);
  await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT FALSE`);
  await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_seen BOOLEAN NOT NULL DEFAULT FALSE`);
  await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_game_round TIMESTAMPTZ`); // 🎮 Coin Rain — آخر جولة لعبة أُرسلت

  // 🎮 جلسات اللعبة — تُنشأ من السيرفر حصراً، لا تُرسَل نقاط من العميل أبداً
  await sql(`CREATE TABLE IF NOT EXISTS game_sessions (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         INT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    used            BOOLEAN     NOT NULL DEFAULT FALSE,
    double_approved BOOLEAN     NOT NULL DEFAULT FALSE,
    seed            INT,
    sequence_json   TEXT
  )`);
  await sql(`ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS seed INT`);
  await sql(`ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS sequence_json TEXT`);
  await sql(`CREATE INDEX IF NOT EXISTS idx_game_sessions_user ON game_sessions(user_id, used, created_at)`);

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

  // Rate limiting بالـ IP
  await sql(`CREATE TABLE IF NOT EXISTS ip_limits (
    ip           TEXT NOT NULL,
    window_type  TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    count        INT NOT NULL DEFAULT 0,
    PRIMARY KEY (ip, window_type, window_start)
  )`);

  // منع replay نفس initData
  await sql(`CREATE TABLE IF NOT EXISTS used_init_hashes (
    hash    TEXT PRIMARY KEY,
    used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await sql(`CREATE TABLE IF NOT EXISTS withdrawals (
    id         SERIAL PRIMARY KEY,
    user_id    INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    address    TEXT NOT NULL,
    memo       TEXT,
    amount     NUMERIC(10,2) NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await sql(`CREATE TABLE IF NOT EXISTS ad_watches (
    id         SERIAL PRIMARY KEY,
    user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reward     INT NOT NULL DEFAULT 750,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // 🛡️ تأكيدات Adsgram Reward URL — server-to-server، لا تمر من متصفح المستخدم أبداً
  // كل صف يعني "Adsgram أكّد أن هذا المستخدم شاهد إعلاناً فعلياً الآن"
  await sql(`CREATE TABLE IF NOT EXISTS ad_reward_confirmations (
    id          SERIAL PRIMARY KEY,
    telegram_id BIGINT NOT NULL,
    consumed    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await sql(`CREATE INDEX IF NOT EXISTS idx_arc_lookup ON ad_reward_confirmations (telegram_id, consumed, created_at)`);
  await sql(`CREATE TABLE IF NOT EXISTS activity_logs (
    id         SERIAL PRIMARY KEY,
    user_id    INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action     TEXT NOT NULL,
    meta       JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await sql(`CREATE INDEX IF NOT EXISTS idx_users_pts ON users (pts DESC)`);

  // جدول المسابقات — يخزن توقيت كل موسم (start/end)
  // السرفر يقرأ منه ويرسل COMPETITION_END_MS للفرونت عبر init response
  await sql(`CREATE TABLE IF NOT EXISTS competition (
    id         SERIAL PRIMARY KEY,
    name       TEXT        NOT NULL DEFAULT 'Season 1',
    start_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    end_at     TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '20 days',
    active     BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  // seed: لو ما في موسم نشط → أنشئ واحد تلقائي 20 يوم من الآن
  await sql(`
    INSERT INTO competition (name, start_at, end_at, active)
    SELECT 'Season 1', NOW(), NOW() + INTERVAL '20 days', TRUE
    WHERE NOT EXISTS (SELECT 1 FROM competition WHERE active = TRUE)
  `);

  // 🏆 يتتبّع أي موسم تم توزيع جوائزه فعلاً — يمنع التوزيع المكرر
  await sql(`ALTER TABLE competition ADD COLUMN IF NOT EXISTS prize_distributed BOOLEAN NOT NULL DEFAULT FALSE`);
}

// ══════════════════════════════════════════════════════════════════════════════
//  Telegram initData verification
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

// ══════════════════════════════════════════════════════════════════════════════
//  🛡️  Helpers: IP · Rate Limit · Risk Score · InitData Hash
// ══════════════════════════════════════════════════════════════════════════════
function getClientIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

async function checkIPLimit(ip, type) {
  // type: 'min' = دقيقة عام | 'hr' = ساعة للإعلانات
  const max     = type === 'min' ? CFG.IP_MAX_REQ_PER_MIN : CFG.IP_MAX_ADS_PER_HR;
  const trunc   = type === 'min' ? `DATE_TRUNC('minute', NOW())` : `DATE_TRUNC('hour', NOW())`;
  const interval = type === 'min' ? '2 minutes' : '2 hours';
  await sql(`DELETE FROM ip_limits WHERE window_start < NOW() - INTERVAL '${interval}'`);
  const rows = await sql(
    `INSERT INTO ip_limits (ip, window_type, window_start, count)
     VALUES ($1, $2, ${trunc}, 1)
     ON CONFLICT (ip, window_type, window_start)
     DO UPDATE SET count = ip_limits.count + 1
     RETURNING count`,
    [ip, type]
  );
  return rows[0].count <= max; // true = مسموح
}

// ══════════════════════════════════════════════════════
// 🎮 Seed-based sequence generator — mirrors client PRNG
//    نفس Mulberry32 المستخدم في game.js (يجب أن يبقيا متطابقين)
// ══════════════════════════════════════════════════════
function _makePrng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _GAME_TYPES   = [{ w: 58, val: 4 }, { w: 20, val: 16 }, { w: 22, val: -3 }];
const _GAME_TOTAL_W = _GAME_TYPES.reduce((a, t) => a + t.w, 0); // 100
const _GAME_SEQ_LEN = 90; // أقصى عدد عناصر يمكن أن تظهر في 40 ثانية

function generateGameSequence(seed) {
  const rng = _makePrng(seed);
  const seq = [];
  for (let i = 0; i < _GAME_SEQ_LEN; i++) {
    const typeRoll = rng(); // استهلاك 1: نوع العنصر  (mirrors pickType)
    rng();                  // استهلاك 2: spawnCd      (mirrors spawnItem)
    const xRnd    = rng(); // استهلاك 3: موقع X        (mirrors spawnItem)
    const biasRnd = rng(); // استهلاك 4: center-bias   (mirrors spawnItem — مُستهلَك دائماً)

    let val = _GAME_TYPES[0].val, isBomb = false;
    let r = typeRoll * _GAME_TOTAL_W, pushed = false;
    for (const t of _GAME_TYPES) {
      r -= t.w;
      if (r <= 0) { val = t.val; isBomb = t.val < 0; pushed = true; break; }
    }
    if (!pushed) isBomb = false;

    // 🛡️ x مُعيَّن بـ seed — قنابل: 80% في المنتصف (30%–70%) ، 20% عشوائي
    const xNorm = isBomb
      ? (biasRnd < 0.80
          ? 0.30 + xRnd * 0.40   // zone مركزية
          : 0.05 + xRnd * 0.90)  // كامل العرض
      : 0.05 + xRnd * 0.90;      // تذاكر: عشوائي كامل

    seq.push({ val, x: xNorm }); // { val: -3|2|8, x: 0.00–1.00 }
  }
  return seq;
}

async function addRisk(userId, points, reason) {
  console.warn(`[RISK] user=${userId} +${points} reason=${reason}`);
  const rows = await sql(
    `UPDATE users SET risk_score = risk_score + $1, risk_updated_at = NOW() WHERE id = $2
     RETURNING risk_score, shadow_banned`,
    [points, userId]
  );
  if (!rows[0].shadow_banned && rows[0].risk_score >= CFG.RISK_BAN_THRESHOLD) {
    await sql(`UPDATE users SET shadow_banned = TRUE WHERE id = $1`, [userId]);
    console.warn(`[SHADOWBAN] auto-banned user=${userId}`);
  }
}

// 🛡️ يقلل risk_score تدريجياً مع الوقت (RISK_DECAY_PER_DAY نقطة/يوم) — يمنع
// تراكم دائم من false positives، ويرفع shadow ban تلقائياً لو رجع الـ score صفر
async function decayRisk(userId) {
  const rows = await sql(`
    WITH decayed AS (
      SELECT id,
             GREATEST(0, risk_score - FLOOR(EXTRACT(EPOCH FROM (NOW() - COALESCE(risk_updated_at, created_at))) / 86400) * $2)::INT AS new_score
      FROM users WHERE id = $1
    )
    UPDATE users u SET
      risk_score      = d.new_score,
      risk_updated_at = NOW(),
      shadow_banned   = CASE WHEN d.new_score = 0 THEN FALSE ELSE u.shadow_banned END
    FROM decayed d
    WHERE u.id = d.id
    RETURNING u.risk_score, u.shadow_banned
  `, [userId, CFG.RISK_DECAY_PER_DAY]);
  return rows[0];
}

// 🛡️ هاش لكل (initData + token) لا لكل initData لحالها.
// initData بتيليجرام ثابتة طوال الجلسة (~ساعة، نفس مدة TTL تحت)، فلو اعتمدنا
// عليها فقط، أي إعلان ثاني بنفس الجلسة كان يُرفض كـ "مكرر". إضافة الـ token
// (فريد ومُصدَر لكل إعلان) تحل التضارب وتحافظ على نفس مستوى الحماية ضد replay.
async function checkAndMarkInitHash(initData, token) {
  const hash = crypto.createHash('sha256').update(initData + ':watchAd:' + token).digest('hex');
  await sql(`DELETE FROM used_init_hashes WHERE used_at < NOW() - INTERVAL '1 hour'`);
  try {
    await sql(`INSERT INTO used_init_hashes (hash) VALUES ($1)`, [hash]);
    return true;  // جديد ✓
  } catch {
    return false; // مكرر ✗
  }
}

// 🛡️ يستهلك تأكيد Adsgram (إن وُجد) لهذا المستخدم — يُستدعى من watchAd
// يعيد true فقط لو وصل تأكيد server-to-server حقيقي من Adsgram لم يُستهلك بعد
async function consumeAdsgramConfirmation(telegramId) {
  await sql(`DELETE FROM ad_reward_confirmations WHERE created_at < NOW() - INTERVAL '10 minutes'`);
  const rows = await sql(`
    UPDATE ad_reward_confirmations
    SET consumed = TRUE
    WHERE id = (
      SELECT id FROM ad_reward_confirmations
      WHERE telegram_id = $1 AND consumed = FALSE
      ORDER BY created_at ASC
      LIMIT 1
    )
    RETURNING id
  `, [telegramId]);
  return rows.length > 0;
}

async function upsertUser(tgUser, startParam = null) {
  const { id: telegram_id, username = null, first_name = null, photo_url = null } = tgUser;
  const refCode = `REF${telegram_id}`;

  // Only brand-new users can be attached to a referrer, and only once.
  const existing = await sql('SELECT id FROM users WHERE telegram_id = $1', [telegram_id]);

  let referredBy = null;
  if (existing.length === 0 && startParam) {
    const m = /^ref_(\d+)$/.exec(String(startParam).trim());
    if (m && m[1] !== String(telegram_id)) {
      const refUser = await sql('SELECT telegram_id FROM users WHERE telegram_id = $1', [m[1]]);
      if (refUser.length > 0) referredBy = m[1];
    }
  }

  await sql(`
    INSERT INTO users (telegram_id, username, first_name, photo_url, referral_code, referred_by)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (telegram_id) DO UPDATE SET
      username   = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      photo_url  = COALESCE(EXCLUDED.photo_url, users.photo_url)
  `, [telegram_id, username, first_name, photo_url, refCode, referredBy]);

  // Credit tickets + USDT to referrer — only for brand-new users
  if (existing.length === 0 && referredBy) {
    try {
      await sql(`
        UPDATE users
        SET pts         = pts + $1,
            balance_usd = balance_usd + $2
        WHERE telegram_id = $3
      `, [APP_CFG.REF_TICKET_REWARD, APP_CFG.REF_USDT_REWARD, referredBy]);
      console.log('[referral] credited to referrer ' + referredBy);
    } catch (creditErr) {
      console.error('[referral] credit SQL failed:', creditErr.message);
    }

    // Bot notification is best-effort — never blocks the init response
    const joinerName = first_name || username || 'Someone';
    sendTelegramMessage(
      referredBy,
      `🎉 *${joinerName}* joined BigLeague using your referral link!\n\nYou earned *+${APP_CFG.REF_TICKET_REWARD.toLocaleString()} competition points* 🏆 and *+$${APP_CFG.REF_USDT_REWARD} USDT* 💵\n\nKeep sharing to climb the leaderboard!`
    ).catch(e => console.error('[referral] bot notify failed:', e.message));
  }

  const rows = await sql('SELECT * FROM users WHERE telegram_id = $1', [telegram_id]);
  return rows[0];
}

async function getUserRank(userId) {
  const rows = await sql(`
    SELECT (COUNT(*) + 1)::INT AS rank
    FROM users WHERE pts > (SELECT pts FROM users WHERE id = $1)
  `, [userId]);
  return rows[0]?.rank ?? 1;
}

async function getActiveCompetition() {
  const rows = await sql(`
    SELECT id, name, start_at, end_at
    FROM competition
    WHERE active = TRUE
    ORDER BY created_at DESC
    LIMIT 1
  `);
  return rows[0] || null;
}

async function getLeaderboard(limit = 8) {
  return await sql(`
    SELECT telegram_id,
           COALESCE(first_name, username, 'Anonymous') AS name,
           pts,
           photo_url,
           ROW_NUMBER() OVER (ORDER BY pts DESC, telegram_id ASC)::INT AS rank
    FROM users ORDER BY pts DESC, telegram_id ASC LIMIT $1
  `, [limit]);
}

// ══════════════════════════════════════════════════════════════════════════════
//  🏆 توزيع جوائز المسابقة — تُستدعى مع كل طلب
//
//  لو انتهى وقت الموسم النشط (end_at <= NOW) ولم تُوزَّع جوائزه بعد:
//   1. كل مستخدم يأخذ حصته من الجوائز في balance_usd حسب ترتيبه النهائي
//      (المركز 1/2/3 → PODIUM_PRIZES، المراكز 4-11 → $1 لكل واحد، نفس
//      الترتيب المعروض في الـ leaderboard/podium).
//   2. تصفير نقاط الجميع (pts = 0) وبدء موسم جديد تلقائياً لمدة 20 يوم.
//
//  🛡️ آمنة عند التشغيل المتزامن (Vercel serverless = عدة invocations بنفس
//  اللحظة): الـ UPDATE الأول بالأسفل يعمل "claim" ذرّي — فقط الـ invocation
//  اللي يرجّع صف هو المسؤول عن التوزيع، والباقي يرجعوا فوراً بدون أي تأثير.
// ══════════════════════════════════════════════════════════════════════════════
async function distributeSeasonPrizes() {
  const claimed = await sql(`
    UPDATE competition
    SET active = FALSE, prize_distributed = TRUE
    WHERE active = TRUE AND prize_distributed = FALSE AND end_at <= NOW()
    RETURNING id, name
  `);
  if (claimed.length === 0) return; // لا يوجد موسم منتهٍ بانتظار التوزيع

  const endedComp = claimed[0];
  const { first, second, third } = APP_CFG.PODIUM_PRIZES;
  const OTHERS_PRIZE = 1; // "Each $1" — المراكز 4 إلى 11 (نفس LB_PRIZE_LABEL)

  // 🏆 منح الجوائز دفعة واحدة على balance_usd حسب نفس ترتيب getLeaderboard
  // (pts DESC, telegram_id ASC) — pts > 0 فقط، لمنع منح جوائز لحسابات لم تشارك
  const winners = await sql(`
    WITH ranked AS (
      SELECT id, telegram_id,
             ROW_NUMBER() OVER (ORDER BY pts DESC, telegram_id ASC) AS rnk
      FROM users
      WHERE pts > 0
    ),
    prized AS (
      SELECT id, telegram_id, rnk,
        CASE
          WHEN rnk = 1 THEN $1::NUMERIC
          WHEN rnk = 2 THEN $2::NUMERIC
          WHEN rnk = 3 THEN $3::NUMERIC
          WHEN rnk BETWEEN 4 AND 11 THEN $4::NUMERIC
          ELSE 0
        END AS prize
      FROM ranked
      WHERE rnk <= 11
    )
    UPDATE users u
    SET balance_usd = balance_usd + p.prize
    FROM prized p
    WHERE u.id = p.id AND p.prize > 0
    RETURNING u.telegram_id, p.rnk, p.prize
  `, [first, second, third, OTHERS_PRIZE]);

  // 🔄 تصفير نقاط الجميع — موسم جديد يبدأ بترتيب نظيف للكل
  await sql(`UPDATE users SET pts = 0`);

  // ▶️ إنشاء الموسم التالي (الاسم: "Season N" → "Season N+1")
  const m       = /(\d+)\s*$/.exec(endedComp.name || '');
  const nextNum = m ? (parseInt(m[1], 10) + 1) : 2;
  const nextName = m
    ? endedComp.name.replace(/\d+\s*$/, String(nextNum))
    : `${endedComp.name || 'Season'} ${nextNum}`;

  await sql(`
    INSERT INTO competition (name, start_at, end_at, active, prize_distributed)
    VALUES ($1, NOW(), NOW() + INTERVAL '20 days', TRUE, FALSE)
  `, [nextName]);

  console.log(`[competition] "${endedComp.name}" ended — ${winners.length} prizes paid, started "${nextName}"`);

  // ✅ إشعار بوت للفائزين (best-effort — لا يوقف التنفيذ)
  for (const w of winners) {
    const prizeAmount = parseFloat(w.prize);
    sendTelegramMessage(
      Number(w.telegram_id),
      `🏆 *${endedComp.name} Has Ended!*\n\nYou finished *#${w.rnk}* on the leaderboard and won *+$${prizeAmount.toFixed(2)}* 🎉\n\nIt's already credited to your balance — withdraw anytime!\n\nA new season just started. Good luck! 🚀`
    ).catch(e => console.error('[prize bot notify]', e.message));
  }
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

// ══════════════════════════════════════════════════════════════════════════════
//  Main Export
// ══════════════════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  // ── CORS ────────────────────────────────────────────────────────────────────
  const allowedOrigins = ['https://web.telegram.org','https://webk.telegram.org','https://webz.telegram.org'];
  const origin = req.headers['origin'] || '';
  // Admin panel can run from any origin (protected by INTERNAL_SECRET)
  res.setHeader('Access-Control-Allow-Origin',  allowedOrigins.includes(origin) ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data, X-Internal-Secret');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    await ensureSchema();
  } catch (err) {
    console.error('[Schema error]', err.message);
    return res.status(500).json({ ok: false, error: 'DB schema error: ' + err.message });
  }

  // 🏆 توزيع جوائز المسابقة فور انتهائها وبدء موسم جديد — best-effort،
  // لا يوقف الطلب الحالي حتى لو فشل (سيُعاد المحاولة في الطلب التالي)
  try {
    await distributeSeasonPrizes();
  } catch (err) {
    console.error('[Prize distribution error]', err.message);
  }

  // 🛡️ IP rate limit عام
  const clientIP = getClientIP(req);
  try {
    const ipOk = await checkIPLimit(clientIP, 'min');
    if (!ipOk) return res.status(429).json({ ok: false, error: 'Too many requests' });
  } catch (err) {
    console.error('[IP limit error]', err.message);
  }

  const body              = req.body || {};
  const { type, data = {} } = body;
  const rawInitData       = body.initData || req.headers['x-telegram-init-data'] || '';

  // ── Auth ──────────────────────────────────────────────────────────────────
  let tgUser = null;
  let dbUser = null;

  if (type !== 'sendBotMsg') {
    tgUser = verifyInitData(rawInitData);

    if (!tgUser) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    // 🛡️ فحص timestamp العميل — يمنع replay متأخر
    if (data.ts) {
      const drift = Math.abs(Date.now() / 1000 - parseInt(data.ts, 10));
      if (drift > CFG.TS_DRIFT_SEC) {
        return res.status(400).json({ ok: false, error: 'Request expired' });
      }
    }

    try {
      dbUser = await upsertUser(tgUser, data.startParam || null);
    } catch (err) {
      console.error('[upsertUser error]', err.message);
      return res.status(500).json({ ok: false, error: 'DB error: ' + err.message });
    }

    // 🛡️ تلاشي تدريجي لـ risk_score مع الوقت + رفع شادو-بان تلقائي لو رجع الـ score صفر
    if (dbUser.risk_score > 0 || dbUser.shadow_banned) {
      try {
        const decayed = await decayRisk(dbUser.id);
        if (decayed) {
          dbUser.risk_score    = decayed.risk_score;
          dbUser.shadow_banned = decayed.shadow_banned;
        }
      } catch (err) {
        console.error('[decayRisk error]', err.message);
      }
    }
    // ملاحظة: شيلنا الرد العام الموحّد لـ shadow ban (كان يكسر صفحات مثل init
    // لكل المحظورين). صار التعامل معه داخل كل case على حدة (watchAd / withdraw)
    // فقط — أي الأماكن اللي فيها مكسب فعلي (نقاط / فلوس).
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  🛡️ Admin Router — محمي بـ INTERNAL_SECRET فقط، لا يحتاج Telegram initData
  // ══════════════════════════════════════════════════════════════════════════════
  if (type && type.startsWith('admin')) {
    const providedSecret = req.headers['x-internal-secret'] || data.secret || '';
    if (!INTERNAL_SECRET || providedSecret !== INTERNAL_SECRET) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    try {
      switch (type) {

        // ── إحصاءات لوحة التحكم ───────────────────────────────────────────────
        case 'adminStats': {
          const range = data.range || 7; // أيام
          const [totals, newUsers, activity, topUsers, recentUsers, pendingW, competition] = await Promise.all([
            sql(`SELECT
                   COUNT(*)                           AS total_users,
                   SUM(pts)                           AS total_pts,
                   SUM(balance_usd)                   AS total_balance,
                   COUNT(*) FILTER (WHERE banned)     AS banned_count,
                   COUNT(*) FILTER (WHERE shadow_banned) AS shadow_count
                 FROM users`),
            sql(`SELECT COUNT(*)::INT AS cnt FROM users
                 WHERE created_at >= NOW() - INTERVAL '1 day' * $1`, [range]),
            sql(`SELECT
                   DATE(created_at AT TIME ZONE 'UTC') AS day,
                   COUNT(*) AS cnt
                 FROM activity_logs
                 WHERE created_at >= NOW() - INTERVAL '1 day' * $1
                 GROUP BY day ORDER BY day ASC`, [range]),
            sql(`SELECT first_name, username, pts, balance_usd, telegram_id
                 FROM users ORDER BY pts DESC LIMIT 5`),
            sql(`SELECT id, first_name, username, telegram_id, pts, balance_usd, created_at, banned, photo_url
                 FROM users ORDER BY created_at DESC LIMIT 10`),
            sql(`SELECT COUNT(*)::INT AS cnt, SUM(amount) AS total FROM withdrawals WHERE status='pending'`),
            sql(`SELECT * FROM competition WHERE active=TRUE LIMIT 1`),
          ]);
          const [adStats, gameStats, watchStats] = await Promise.all([
            sql(`SELECT COUNT(*)::INT AS total_ads FROM ad_watches WHERE created_at >= NOW() - INTERVAL '1 day' * $1`, [range]),
            sql(`SELECT COUNT(*)::INT AS total_games FROM game_sessions WHERE used=TRUE AND created_at >= NOW() - INTERVAL '1 day' * $1`, [range]),
            sql(`SELECT COUNT(*)::INT AS today_ads FROM ad_watches WHERE created_at >= NOW() - INTERVAL '1 day'`),
          ]);
          return res.json({
            ok: true,
            stats: {
              total_users:    Number(totals[0]?.total_users  || 0),
              total_pts:      Number(totals[0]?.total_pts    || 0),
              total_balance:  parseFloat(totals[0]?.total_balance || 0),
              banned_count:   Number(totals[0]?.banned_count  || 0),
              shadow_count:   Number(totals[0]?.shadow_count  || 0),
              new_users:      newUsers[0]?.cnt || 0,
              total_ads:      adStats[0]?.total_ads || 0,
              today_ads:      watchStats[0]?.today_ads || 0,
              total_games:    gameStats[0]?.total_games || 0,
              pending_withdrawals: pendingW[0]?.cnt || 0,
              pending_amount: parseFloat(pendingW[0]?.total || 0),
            },
            activity: activity.map(r => ({ day: r.day, count: Number(r.cnt) })),
            top_users: topUsers,
            recent_users: recentUsers,
            competition: competition[0] || null,
          });
        }

        // ── قائمة المستخدمين ──────────────────────────────────────────────────
        case 'adminUsers': {
          const page    = Math.max(1, parseInt(data.page  || 1, 10));
          const limit   = Math.min(50, parseInt(data.limit || 20, 10));
          const search  = data.search  || '';
          const filter  = data.filter  || 'all'; // all|banned|shadow|top
          const offset  = (page - 1) * limit;

          let where = 'WHERE 1=1';
          const params = [];
          if (search) {
            params.push(`%${search}%`);
            where += ` AND (username ILIKE $${params.length} OR first_name ILIKE $${params.length} OR telegram_id::TEXT = $${params.length})`;
          }
          if (filter === 'banned')   where += ' AND banned=TRUE';
          if (filter === 'shadow')   where += ' AND shadow_banned=TRUE';

          const orderBy = filter === 'top' ? 'ORDER BY pts DESC' : 'ORDER BY created_at DESC';

          params.push(limit, offset);
          const [users, countRes] = await Promise.all([
            sql(`SELECT id, telegram_id, first_name, username, photo_url, pts, balance_usd,
                        daily_ads, risk_score, banned, shadow_banned, onboarding_seen,
                        created_at, last_ad_watch, referred_by
                 FROM users ${where} ${orderBy}
                 LIMIT $${params.length - 1} OFFSET $${params.length}`, params),
            sql(`SELECT COUNT(*)::INT AS total FROM users ${where}`, params.slice(0, -2)),
          ]);
          return res.json({
            ok: true,
            users: users.map(u => ({ ...u, pts: Number(u.pts), balance_usd: parseFloat(u.balance_usd) })),
            total: countRes[0]?.total || 0,
            page, limit,
          });
        }

        // ── تفاصيل مستخدم واحد ────────────────────────────────────────────────
        case 'adminUserDetail': {
          const tid = data.telegram_id;
          if (!tid) return res.status(400).json({ ok: false, error: 'telegram_id required' });
          const [user, logs, referrals, withdraws, adWatches] = await Promise.all([
            sql(`SELECT * FROM users WHERE telegram_id=$1`, [tid]),
            sql(`SELECT action, meta, created_at FROM activity_logs
                 WHERE user_id=(SELECT id FROM users WHERE telegram_id=$1)
                 ORDER BY created_at DESC LIMIT 30`, [tid]),
            sql(`SELECT COUNT(*)::INT AS cnt FROM users WHERE referred_by=$1`, [tid]),
            sql(`SELECT * FROM withdrawals
                 WHERE user_id=(SELECT id FROM users WHERE telegram_id=$1)
                 ORDER BY created_at DESC LIMIT 10`, [tid]),
            sql(`SELECT COUNT(*)::INT AS total, SUM(reward) AS total_reward
                 FROM ad_watches
                 WHERE user_id=(SELECT id FROM users WHERE telegram_id=$1)`, [tid]),
          ]);
          if (!user[0]) return res.status(404).json({ ok: false, error: 'User not found' });
          return res.json({
            ok: true,
            user: { ...user[0], pts: Number(user[0].pts), balance_usd: parseFloat(user[0].balance_usd) },
            logs,
            referrals: referrals[0]?.cnt || 0,
            withdrawals: withdraws,
            ad_stats: { total: adWatches[0]?.total || 0, total_reward: Number(adWatches[0]?.total_reward || 0) },
          });
        }

        // ── قائمة السحوبات ────────────────────────────────────────────────────
        case 'adminWithdrawals': {
          const page   = Math.max(1, parseInt(data.page  || 1, 10));
          const limit  = Math.min(50, parseInt(data.limit || 20, 10));
          const status = data.status || 'all';
          const offset = (page - 1) * limit;
          const where  = status !== 'all' ? `WHERE w.status=$1` : 'WHERE 1=1';
          const params = status !== 'all' ? [status, limit, offset] : [limit, offset];
          const [rows, cnt] = await Promise.all([
            sql(`SELECT w.*, u.first_name, u.username, u.telegram_id
                 FROM withdrawals w JOIN users u ON w.user_id=u.id
                 ${where} ORDER BY w.created_at DESC
                 LIMIT $${params.length - 1} OFFSET $${params.length}`, params),
            sql(`SELECT COUNT(*)::INT AS total FROM withdrawals w ${where}`,
                status !== 'all' ? [status] : []),
          ]);
          return res.json({ ok: true, withdrawals: rows, total: cnt[0]?.total || 0, page, limit });
        }

        // ── تحديث حالة سحب ───────────────────────────────────────────────────
        case 'adminUpdateWithdrawal': {
          const { id, status } = data;
          if (!id || !['approved','rejected','paid'].includes(status))
            return res.status(400).json({ ok: false, error: 'id and valid status required' });
          await sql(`UPDATE withdrawals SET status=$1 WHERE id=$2`, [status, id]);
          // لو رُفض: أعِد الرصيد للمستخدم
          if (status === 'rejected') {
            await sql(`UPDATE users u SET balance_usd = balance_usd + w.amount
                       FROM withdrawals w WHERE w.id=$1 AND w.user_id=u.id`, [id]);
          }
          return res.json({ ok: true });
        }

        // ── ضبط نقاط مستخدم ──────────────────────────────────────────────────
        case 'adminAdjustPts': {
          const { telegram_id, pts, reason } = data;
          if (!telegram_id || pts === undefined) return res.status(400).json({ ok: false, error: 'telegram_id and pts required' });
          const rows = await sql(
            `UPDATE users SET pts = GREATEST(0, pts + $1) WHERE telegram_id=$2
             RETURNING id, pts`, [pts, telegram_id]);
          if (!rows[0]) return res.status(404).json({ ok: false, error: 'User not found' });
          await sql(`INSERT INTO activity_logs (user_id, action, meta) VALUES ($1, 'admin_adjust_pts', $2)`,
            [rows[0].id, JSON.stringify({ delta: pts, reason: reason || 'admin' })]);
          return res.json({ ok: true, new_pts: Number(rows[0].pts) });
        }

        // ── ضبط رصيد مستخدم ──────────────────────────────────────────────────
        case 'adminAdjustBalance': {
          const { telegram_id, amount, reason } = data;
          if (!telegram_id || amount === undefined) return res.status(400).json({ ok: false, error: 'telegram_id and amount required' });
          const rows = await sql(
            `UPDATE users SET balance_usd = GREATEST(0, balance_usd + $1) WHERE telegram_id=$2
             RETURNING id, balance_usd`, [amount, telegram_id]);
          if (!rows[0]) return res.status(404).json({ ok: false, error: 'User not found' });
          await sql(`INSERT INTO activity_logs (user_id, action, meta) VALUES ($1, 'admin_adjust_balance', $2)`,
            [rows[0].id, JSON.stringify({ delta: amount, reason: reason || 'admin' })]);
          return res.json({ ok: true, new_balance: parseFloat(rows[0].balance_usd) });
        }

        // ── إرسال رسالة broadcast ─────────────────────────────────────────────
        case 'adminBroadcast': {
          const { text, telegram_id } = data;
          if (!text) return res.status(400).json({ ok: false, error: 'text required' });
          if (telegram_id) {
            // رسالة لمستخدم واحد
            const result = await sendTelegramMessage(telegram_id, text);
            return res.json({ ok: !!result?.ok });
          }
          // broadcast لكل المستخدمين
          const users = await sql(`SELECT telegram_id FROM users WHERE banned=FALSE ORDER BY id`);
          let sent = 0, failed = 0;
          for (const u of users) {
            const r = await sendTelegramMessage(Number(u.telegram_id), text).catch(() => null);
            if (r?.ok) sent++; else failed++;
            await new Promise(r => setTimeout(r, 50)); // throttle
          }
          return res.json({ ok: true, sent, failed, total: users.length });
        }

        // ── سجل النشاط ───────────────────────────────────────────────────────
        case 'adminActivityLogs': {
          const page   = Math.max(1, parseInt(data.page  || 1, 10));
          const limit  = Math.min(100, parseInt(data.limit || 30, 10));
          const action = data.action || '';
          const offset = (page - 1) * limit;
          const where  = action ? `WHERE l.action=$1` : 'WHERE 1=1';
          const params = action ? [action, limit, offset] : [limit, offset];
          const rows = await sql(`
            SELECT l.id, l.action, l.meta, l.created_at,
                   u.first_name, u.username, u.telegram_id
            FROM activity_logs l JOIN users u ON l.user_id=u.id
            ${where} ORDER BY l.created_at DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
          return res.json({ ok: true, logs: rows });
        }

        default:
          return res.status(400).json({ ok: false, error: `Unknown admin type: "${type}"` });
      }
    } catch (err) {
      console.error('[Admin error]', type, err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  // ── Router ─────────────────────────────────────────────────────────────────
  try {
    switch (type) {

      case 'init': {
        const [userRank, leaderboard, refStats, competition] = await Promise.all([
          getUserRank(dbUser.id),
          getLeaderboard(11),
          sql(`SELECT COUNT(*)::INT AS ref_count, (COUNT(*)*5000)::INT AS ref_earned
               FROM users WHERE referred_by = $1`, [dbUser.telegram_id]),
          getActiveCompetition()
        ]);

        // دمج توقيت المسابقة من DB في الـ config
        const configWithCompetition = {
          ...APP_CFG,
          COMPETITION_END_MS:   competition ? new Date(competition.end_at).getTime()   : APP_CFG.COMPETITION_END_MS,
          COMPETITION_START_MS: competition ? new Date(competition.start_at).getTime() : Date.now(),
          COMPETITION_NAME:     competition?.name ?? 'Season 1',
        };
        return res.json({
          ok: true,
          user: {
            id:            dbUser.id,
            telegram_id:   Number(dbUser.telegram_id),
            name:          dbUser.first_name || dbUser.username || 'You',
            photo_url:     dbUser.photo_url || null,
            pts:           Number(dbUser.pts),
            balance_usd:   parseFloat(dbUser.balance_usd),
            referral_code: dbUser.referral_code,
            rank:          userRank,
            banned:        dbUser.banned || false,
            onboarding_seen: dbUser.onboarding_seen || false
          },
          leaderboard: leaderboard.map(r => ({
            telegram_id: Number(r.telegram_id),
            name: r.name,
            photo_url: r.photo_url || null,
            pts:  Number(r.pts),
            rank: r.rank
          })),
          referral: {
            count:  refStats[0]?.ref_count  ?? 0,
            earned: refStats[0]?.ref_earned ?? 0
          },
          config: configWithCompetition
        });
      }

      // ✅ markOnboardingSeen — يُسجَّل في DB بدل localStorage (يضمن مشاهدة واحدة فقط حتى بعد مسح الكاش)
      case 'markOnboardingSeen': {
        await sql(`UPDATE users SET onboarding_seen = TRUE WHERE id = $1`, [dbUser.id]);
        return res.json({ ok: true });
      }

      // 🛡️ startAd — الخطوة الأولى: احجز token موقّع قبل تشغيل الإعلان
      case 'startAd': {
        const today = new Date().toISOString().slice(0, 10);
        const uRows = await sql(`SELECT last_ad_watch, daily_ads, last_ad_date FROM users WHERE id = $1`, [dbUser.id]);
        const u = uRows[0];
        const sameDay = u.last_ad_date && String(u.last_ad_date).slice(0, 10) === today;
        const dailyCount = sameDay ? u.daily_ads : 0;

        if (dailyCount >= CFG.AD_DAILY_MAX) {
          return res.status(429).json({ ok: false, error: 'Daily ad limit reached' });
        }
        if (u.last_ad_watch) {
          const secSince = (Date.now() - new Date(u.last_ad_watch).getTime()) / 1000;
          if (secSince < CFG.AD_COOLDOWN_SEC) {
            return res.status(429).json({ ok: false, error: 'Please wait', waitSec: Math.ceil(CFG.AD_COOLDOWN_SEC - secSince) });
          }
        }

        // 🛡️ احذف أي token قديم غير مستخدم — يمنع تجميع tokens
        await sql(`DELETE FROM ad_sessions WHERE user_id = $1 AND used = FALSE`, [dbUser.id]);

        // 🛡️ مدة المشاهدة تُحدَّد من السيرفر حسب نوع الإعلان — لا توجد قيمة ثابتة 30s
        const adType = (typeof data.adType === 'string' ? data.adType.toLowerCase() : 'default');
        const dur    = AD_DURATIONS[adType] || AD_DURATIONS.default;

        // 🔒 Payload موقّع HMAC — لا يمكن للعميل تعديل uid/adType/iat/dur ولا إنشاء token بدون السر
        const token = signAdToken({ uid: dbUser.id, adType, dur, iat: Date.now() });

        await sql(`INSERT INTO ad_sessions (token, user_id, ad_type) VALUES ($1, $2, $3)`, [token, dbUser.id, adType]);
        return res.json({ ok: true, token });
      }

      case 'watchAd': {
        const { token } = data;

        // 🛡️ تحقق التوقيع أولاً — أي تلاعب أو تزوير يُرفض فوراً قبل أي وصول لقاعدة البيانات
        const payload = verifyAdToken(token);
        if (!payload || typeof payload.uid !== 'number' || typeof payload.iat !== 'number') {
          await addRisk(dbUser.id, 30, 'no_token');
          return res.status(400).json({ ok: false, error: 'Invalid session' });
        }

        // 🛡️ التحقق إن الـ token صادر لهذا المستخدم بالضبط
        if (payload.uid !== dbUser.id) {
          await addRisk(dbUser.id, 80, 'token_stolen');
          return res.status(403).json({ ok: false, error: 'Session mismatch' });
        }

        // 🛡️ IP limit للإعلانات
        const ipAdOk = await checkIPLimit(clientIP, 'hr');
        if (!ipAdOk) return res.status(429).json({ ok: false, error: 'Too many ads from this network' });

        // جلب الجلسة (one-time use — حماية إضافية حتى لو التوقيع صحيح)
        const sessions = await sql(`SELECT * FROM ad_sessions WHERE token = $1`, [token]);
        if (sessions.length === 0) {
          await addRisk(dbUser.id, 40, 'fake_token');
          return res.status(400).json({ ok: false, error: 'Invalid session' });
        }
        const session = sessions[0];

        if (session.user_id !== dbUser.id) {
          await addRisk(dbUser.id, 80, 'token_stolen');
          return res.status(403).json({ ok: false, error: 'Session mismatch' });
        }

        if (session.used) {
          await addRisk(dbUser.id, 60, 'used_token');
          return res.status(400).json({ ok: false, error: 'Session already used' });
        }

        // 🛡️ مدة المشاهدة المطلوبة محسوبة من التوكن نفسه (موقّعة من السيرفر، لا يتحكم بها العميل)
        const requiredDur = AD_DURATIONS[payload.adType] || AD_DURATIONS.default;
        const sessionAge  = (Date.now() - payload.iat) / 1000;

        // 🛡️ لازم مضى وقت كافٍ — إثبات المشاهدة الفعلية
        // (مع هامش صغير لفروقات الشبكة/الجهاز — تحميل SDK وعرض الإعلان
        // عادة بياخذوا أطول من requiredDur أصلاً)
        if (sessionAge < requiredDur - CFG.AD_TIMING_TOLERANCE_SEC) {
          await addRisk(dbUser.id, 70, `too_fast_${Math.round(sessionAge)}s`);
          return res.status(400).json({ ok: false, error: 'Ad not fully watched' });
        }

        // 🛡️ نافذة صلاحية ضيقة (مدة الإعلان + هامش صغير) بدل صلاحية ثابتة 5 دقائق
        if (sessionAge > requiredDur + AD_GRACE_SEC) {
          await sql(`DELETE FROM ad_sessions WHERE token = $1`, [token]);
          await addRisk(dbUser.id, 20, `token_expired_${Math.round(sessionAge)}s`);
          return res.status(400).json({ ok: false, error: 'Session expired' });
        }

        // فحص الـ daily limit مرة ثانية (atomic)
        const today = new Date().toISOString().slice(0, 10);
        const uRows = await sql(`SELECT daily_ads, last_ad_date, last_ad_watch FROM users WHERE id = $1`, [dbUser.id]);
        const u2 = uRows[0];
        const sameDay = u2.last_ad_date && String(u2.last_ad_date).slice(0, 10) === today;
        if ((sameDay ? u2.daily_ads : 0) >= CFG.AD_DAILY_MAX) {
          return res.status(429).json({ ok: false, error: 'Daily ad limit reached' });
        }

        // 🛡️ فحص cooldown داخل watchAd أيضاً — لو تجاوز startAd بطريقة ما
        if (u2.last_ad_watch) {
          const secSince = (Date.now() - new Date(u2.last_ad_watch).getTime()) / 1000;
          if (secSince < CFG.AD_COOLDOWN_SEC) {
            await addRisk(dbUser.id, 40, `cooldown_bypass_${Math.round(secSince)}s`);
            return res.status(429).json({ ok: false, error: 'Please wait between ads' });
          }
        }

        // 🛡️ بوابة Adsgram Reward URL — تمنع السكربتات من تزوير "المشاهدة" بمجرد الانتظار
        // مفعّلة فقط لـ adType === 'adsgram' وفقط بعد ضبط ADSGRAM_REWARD_SECRET في env
        // لازم وصل تأكيد server-to-server حقيقي من Adsgram لهذا المستخدم قبل منح النقاط
        if (payload.adType === 'adsgram' && process.env.ADSGRAM_REWARD_SECRET) {
          const confirmed = await consumeAdsgramConfirmation(dbUser.telegram_id);
          if (!confirmed) {
            // قد يكون تأكيد Adsgram لم يصل بعد (تأخير شبكة) — اطلب من العميل إعادة المحاولة بعد قليل
            return res.status(202).json({ ok: false, error: 'pending_confirmation', retryAfterMs: 1500 });
          }
        }

        // 🛡️ منع replay — يُسجَّل هنا فقط بعد تأكيد Adsgram حتى تنجح إعادة المحاولة عند pending_confirmation
        const hashOk = await checkAndMarkInitHash(rawInitData, token);
        if (!hashOk) {
          await addRisk(dbUser.id, 50, 'replay_initData');
          return res.status(400).json({ ok: false, error: 'Duplicate request' });
        }

        const AD_REWARD = APP_CFG.AD_TICKET_REWARD;

        // 🎯 تحديد المكافأة: أقل من AD_FULL_REWARD_MIN_SEC → 60% فقط
        const isPartialWatch = sessionAge < AD_FULL_REWARD_MIN_SEC;
        const actualReward   = isPartialWatch ? Math.round(AD_REWARD * 0.6) : AD_REWARD;

        // 🛡️ Shadow ban — كل الفحوصات أعلاه نجحت بشكل طبيعي (نفس تجربة مستخدم حقيقي)،
        // بس ما رايح نمنح نقاط فعلية. الرد يبدو ناجح عشان المخترق ما يلاحظ شي،
        // وما عاد بيؤثر على باقي الصفحات (init وغيرها) كما كان سابقاً.
        if (dbUser.shadow_banned) {
          await sql(`UPDATE ad_sessions SET used = TRUE WHERE token = $1`, [token]);
          const fakeRank = await getUserRank(dbUser.id);
          return res.json({
            ok:        true,
            reward:    actualReward,
            partial:   isPartialWatch,
            rankUp:    false,
            newRank:   fakeRank,
            rankDelta: 0,
            chatId:    null
          });
        }

        const rankBefore = await getUserRank(dbUser.id);

        // 🔒 Atomic update
        await sql(`
          UPDATE users SET
            pts           = pts + $1,
            last_ad_watch = NOW(),
            daily_ads     = CASE WHEN last_ad_date = CURRENT_DATE THEN daily_ads + 1 ELSE 1 END,
            last_ad_date  = CURRENT_DATE
          WHERE id = $2
        `, [actualReward, dbUser.id]);

        // وسّم الـ token كمستخدم
        await sql(`UPDATE ad_sessions SET used = TRUE WHERE token = $1`, [token]);
        await sql('INSERT INTO ad_watches (user_id, reward) VALUES ($1, $2)', [dbUser.id, actualReward]);

        const rankAfter  = await getUserRank(dbUser.id);
        const rankUp     = rankAfter < rankBefore;

        // ✅ إشعار rank-up مباشر من الباكند
        if (rankUp) {
          sendTelegramMessage(
            Number(dbUser.telegram_id),
            `🏆 *Rank Up!*\nYou reached *#${rankAfter}* on the leaderboard!\nKeep watching ads to stay on top 🔥`
          ).catch(e => console.error('[rankup bot notify]', e.message));
        }

        return res.json({
          ok:        true,
          reward:    actualReward,
          partial:   isPartialWatch,
          rankUp,
          newRank:   rankAfter,
          rankDelta: rankUp ? rankBefore - rankAfter : 0
        });
      }

      // ══════════════════════════════════════════════════════════════════
      // 🎮 gameRoundStart — ينشئ جلسة جولة على السيرفر ويعيد UUID معتم
      //    العميل لا يرسل أي نقاط — السيرفر يحدد المكافأة داخلياً
      // ══════════════════════════════════════════════════════════════════
      case 'gameRoundStart': {
        // كولداون: يمنع إنشاء جلسات أسرع من مدة الجولة الفعلية
        const gRows = await sql(`SELECT last_game_round FROM users WHERE id = $1`, [dbUser.id]);
        const lastRound = gRows[0]?.last_game_round;
        if (lastRound) {
          const secSince = (Date.now() - new Date(lastRound).getTime()) / 1000;
          if (secSince < CFG.GAME_ROUND_DURATION_SEC - 5) {
            return res.status(429).json({ ok: false, error: 'Please wait', waitSec: Math.ceil(CFG.GAME_ROUND_DURATION_SEC - 5 - secSince) });
          }
        }
        // تنظيف جلسات قديمة غير مُستخدَمة لهذا المستخدم
        await sql(`DELETE FROM game_sessions WHERE user_id = $1 AND used = FALSE AND created_at < NOW() - INTERVAL '6 minutes'`, [dbUser.id]);
        // إنشاء seed + تسلسل عناصر محدد مسبقاً (السيرفر يعرف كل عنصر سيظهر)
        const seed     = (Math.random() * 2 ** 31) >>> 0;
        const sequence = generateGameSequence(seed);
        const sRows    = await sql(
          `INSERT INTO game_sessions (user_id, seed, sequence_json) VALUES ($1, $2, $3) RETURNING id`,
          [dbUser.id, seed, JSON.stringify(sequence)]
        );
        // _t = token معتم، seed للـ PRNG على العميل — لا يوجد "sessionId" في الـ JSON
        return res.json({ ok: true, _t: sRows[0].id, seed });
      }

      // ══════════════════════════════════════════════════════════════════
      // 🎮 gameAdVerify — يتحقق من تأكيد Adsgram S2S ويُفعّل المضاعفة
      //    على الجلسة داخلياً بدون إرسال أي قيمة من العميل
      // ══════════════════════════════════════════════════════════════════
      case 'gameAdVerify': {
        const { _t: gAvSid } = data;
        if (!gAvSid) return res.status(400).json({ ok: false, error: 'Missing token' });

        const gAvRows = await sql(
          `SELECT id, user_id, used, double_approved FROM game_sessions WHERE id = $1`,
          [gAvSid]
        );
        if (!gAvRows.length || gAvRows[0].user_id !== dbUser.id)
          return res.status(403).json({ ok: false, error: 'Invalid token' });
        if (gAvRows[0].used)
          return res.status(400).json({ ok: false, error: 'Session already used' });
        if (gAvRows[0].double_approved)
          return res.status(400).json({ ok: false, error: 'Double already applied' });

        // 🛡️ تأكيد Adsgram S2S — نفس آلية الإعلانات الرئيسية
        if (process.env.ADSGRAM_REWARD_SECRET) {
          const confirmed = await consumeAdsgramConfirmation(dbUser.telegram_id);
          if (!confirmed) {
            return res.status(202).json({ ok: false, error: 'pending_confirmation', retryAfterMs: 1500 });
          }
        }

        await sql(`UPDATE game_sessions SET double_approved = TRUE WHERE id = $1`, [gAvSid]);
        return res.json({ ok: true });
      }

      // ══════════════════════════════════════════════════════════════════
      // 🎮 gameRoundEnd — يستهلك الجلسة ويمنح مكافأة ثابتة من السيرفر
      //    لا يقبل أي نقاط أو score من العميل
      // ══════════════════════════════════════════════════════════════════
      case 'gameRoundEnd': {
        // c = caught indices (مؤشرات العناصر التي صادها اللاعب)
        // n = totalSpawned  (كم عنصر ظهر فعلاً في هذه الجولة)
        // _t = token معتم (يُستخدم داخلياً فقط — لا يُعرض في UI)
        const { _t: gReSid, c: rawCaught, n: totalSpawned } = data;
        if (!gReSid) return res.status(400).json({ ok: false, error: 'Missing token' });

        const gReRows = await sql(
          `SELECT id, user_id, used, double_approved, created_at, sequence_json FROM game_sessions WHERE id = $1`,
          [gReSid]
        );
        if (!gReRows.length || gReRows[0].user_id !== dbUser.id) {
          await addRisk(dbUser.id, 40, 'game_invalid_token');
          return res.status(403).json({ ok: false, error: 'Invalid token' });
        }
        const gs = gReRows[0];
        if (gs.used) {
          await addRisk(dbUser.id, 30, 'game_replay');
          return res.status(400).json({ ok: false, error: 'Session already used' });
        }

        // 🛡️ تحقق من التوقيت
        const elapsed = (Date.now() - new Date(gs.created_at).getTime()) / 1000;
        if (elapsed < CFG.GAME_ROUND_DURATION_SEC - 5) {
          await addRisk(dbUser.id, 60, `game_too_fast_${Math.round(elapsed)}s`);
          return res.status(400).json({ ok: false, error: 'Round not complete' });
        }
        if (elapsed > CFG.GAME_ROUND_SESSION_TTL_SEC) {
          await sql(`UPDATE game_sessions SET used = TRUE WHERE id = $1`, [gReSid]);
          return res.status(400).json({ ok: false, error: 'Session expired' });
        }

        // 🛡️ تحقق من بيانات الصيد
        const sequence    = gs.sequence_json ? JSON.parse(gs.sequence_json) : null;
        const spawnedCount = Math.min(Math.max(0, parseInt(totalSpawned) || 0), _GAME_SEQ_LEN);
        const caughtIds   = Array.isArray(rawCaught) ? rawCaught : [];

        // 🛡️ التحقق من سجل موقع السلة (bLog)
        // العميل يرسل مصفوفة x مُعيَّر (0-1) كل 500ms طوال الجولة
        const rawBLog = data.bLog;
        const bLog = Array.isArray(rawBLog)
          ? rawBLog.filter(v => typeof v === 'number' && isFinite(v) && v >= 0 && v <= 1).slice(0, 200)
          : [];

        if (bLog.length < 8) {
          // سجل مفقود أو شحيح جداً — شك في التلاعب عبر API مباشرة
          await addRisk(dbUser.id, 30, `game_missing_basket_log_n${bLog.length}`);
        } else {
          // تحقق من حركة السلة: سلة ثابتة = بوت
          const mean   = bLog.reduce((a, b) => a + b, 0) / bLog.length;
          const stdDev = Math.sqrt(bLog.reduce((a, x) => a + (x - mean) ** 2, 0) / bLog.length);
          if (stdDev < 0.02) {
            await addRisk(dbUser.id, 55, `game_static_basket_std${stdDev.toFixed(4)}`);
          }
        }

        let score = 0;
        if (sequence) {
          const seen = new Set();
          for (const idx of caughtIds) {
            const i = parseInt(idx);
            if (!Number.isInteger(i) || i < 0 || i >= spawnedCount || seen.has(i)) continue;
            seen.add(i);
            // تنسيق جديد {val, x} أو قديم (رقم مباشر) — backward compat
            const entry = sequence[i];
            score += (typeof entry === 'object' ? entry?.val : entry) ?? 0;
          }
          score = Math.max(0, score);

          // 🛡️ نسبة صيد مشبوهة (> 95% من كل العناصر)
          if (spawnedCount > 10 && seen.size / spawnedCount > 0.95) {
            await addRisk(dbUser.id, 25, `game_catch_rate_${Math.round(seen.size / spawnedCount * 100)}pct`);
          }

          // 🛡️ تحقق مكاني: تذكرة في منطقة بعيدة يجب أن يكون السلة قريبة منها
          if (bLog.length >= 8) {
            for (const idx of seen) {
              const entry = sequence[idx];
              if (!entry || typeof entry !== 'object' || entry.val <= 0) continue;
              const itemX = entry.x; // 0-1 normalized
              // منطقة حافة (< 18% أو > 82% من عرض الشاشة)
              if (itemX < 0.18 || itemX > 0.82) {
                const basketReached = bLog.some(bx => Math.abs(bx - itemX) < 0.20);
                if (!basketReached) {
                  await addRisk(dbUser.id, 50, `game_impossible_catch_x${itemX.toFixed(2)}_idx${idx}`);
                  break; // نقطة واحدة تكفي للتنبيه
                }
              }
            }
          }
        } else {
          // جلسة قديمة بدون sequence — مكافأة ثابتة fallback
          score = CFG.GAME_ROUND_TICKETS;
        }

        // استهلاك الجلسة atomic
        const consumed = await sql(
          `UPDATE game_sessions SET used = TRUE WHERE id = $1 AND used = FALSE RETURNING id`,
          [gReSid]
        );
        if (!consumed.length) return res.status(400).json({ ok: false, error: 'Session already used' });

        const doubled = gs.double_approved;
        const awarded = doubled ? score * 2 : score;

        await sql(`UPDATE users SET last_game_round = NOW() WHERE id = $1`, [dbUser.id]);

        // 🛡️ Shadow ban
        if (dbUser.shadow_banned) return res.json({ ok: true, awarded, doubled });

        await sql(`UPDATE users SET pts = pts + $1 WHERE id = $2`, [awarded, dbUser.id]);
        await sql(`INSERT INTO activity_logs (user_id, action, meta) VALUES ($1, 'game_round', $2)`,
          [dbUser.id, JSON.stringify({ score, awarded, doubled, spawned: spawnedCount, caught: caughtIds.length })]);

        return res.json({ ok: true, awarded, doubled });
      }

      case 'withdraw': {
        const { address, memo, amount } = data;
        if (!address?.trim()) return res.status(400).json({ ok: false, error: 'Wallet address required' });
        const amt = parseFloat(amount);
        if (isNaN(amt) || amt < APP_CFG.WITHDRAW_MIN) return res.status(400).json({ ok: false, error: `Minimum withdrawal is $${APP_CFG.WITHDRAW_MIN.toFixed(2)}` });
        if (parseFloat(dbUser.balance_usd) < amt) return res.status(400).json({ ok: false, error: 'Insufficient balance' });

        // 🛡️ Shadow ban — رد ناجح وهمي بدون خصم رصيد فعلي أو تسجيل سحب حقيقي
        if (dbUser.shadow_banned) {
          return res.json({ ok: true });
        }

        await sql('UPDATE users SET balance_usd = balance_usd - $1 WHERE id = $2', [amt, dbUser.id]);
        await sql('INSERT INTO withdrawals (user_id, address, memo, amount) VALUES ($1,$2,$3,$4)',
          [dbUser.id, address.trim(), memo?.trim() || null, amt]);

        // ✅ إشعار بوت مباشر من الباكند
        sendTelegramMessage(
          Number(dbUser.telegram_id),
          `💸 *Withdrawal Request Received*\nAmount: *$${amt.toFixed(2)}*\nAddress: \`${address.trim()}\`\nStatus: *Under Review* ⏳`
        ).catch(e => console.error('[withdraw bot notify]', e.message));

        return res.json({ ok: true });
      }

      case 'banUser': {
        // 🛡️ أدمن فقط — محمي بـ INTERNAL_SECRET
        const providedSecret = req.headers['x-internal-secret'] || data.secret || '';
        if (!INTERNAL_SECRET || providedSecret !== INTERNAL_SECRET) {
          return res.status(403).json({ ok: false, error: 'Forbidden' });
        }
        const targetId = data.telegram_id;
        const unban    = data.unban === true;
        if (!targetId) return res.status(400).json({ ok: false, error: 'telegram_id required' });
        const rows = await sql(
          `UPDATE users SET banned = $1 WHERE telegram_id = $2 RETURNING id, telegram_id`,
          [!unban, targetId]
        );
        if (rows.length === 0) return res.status(404).json({ ok: false, error: 'User not found' });
        console.log(`[ban] telegram_id=${targetId} banned=${!unban}`);
        return res.json({ ok: true, banned: !unban });
      }

      case 'sendBotMsg': {
        // 🛡️ محمي بـ INTERNAL_SECRET — منع أي شخص خارجي
        const providedSecret = req.headers['x-internal-secret'] || data.secret || '';
        if (!INTERNAL_SECRET || providedSecret !== INTERNAL_SECRET) {
          return res.status(403).json({ ok: false, error: 'Forbidden' });
        }
        const { chatId, text } = data;
        if (!chatId || !text) return res.status(400).json({ ok: false, error: 'chatId and text required' });
        const result = await sendTelegramMessage(chatId, text);
        return res.json({ ok: !!result.ok });
      }

      case 'logRefCopy': {
        await sql("INSERT INTO activity_logs (user_id, action) VALUES ($1, 'ref_copy')", [dbUser.id]);
        return res.json({ ok: true });
      }

      case 'logShare': {
        await sql("INSERT INTO activity_logs (user_id, action, meta) VALUES ($1, 'share', $2)",
          [dbUser.id, JSON.stringify({ platform: data.platform || 'unknown' })]);
        return res.json({ ok: true });
      }

      case 'logSecEvent': {
        const event  = String(data.event  || 'unknown').slice(0, 64);
        const detail = data.detail ? JSON.stringify(data.detail).slice(0, 256) : null;
        await sql(
          `INSERT INTO activity_logs (user_id, action, meta) VALUES ($1, 'sec_event', $2)`,
          [dbUser.id, JSON.stringify({ event, detail })]
        );
        console.warn(`[sec_event] user=${dbUser.id} event=${event}`);
        return res.json({ ok: true });
      }

      default:
        return res.status(400).json({ ok: false, error: `Unknown type: "${type}"` });
    }
  } catch (err) {
    console.error('[Handler error]', type, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
