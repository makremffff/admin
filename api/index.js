/**
 * Zero Trust API — v5.0 "الربح عربي"
 *
 * ✅ Dynamic CONFIG System — GET /config endpoint
 * ✅ First Withdraw System — first_withdraw_done column
 * ✅ Adsgram Task — DB-persistent state (no session-only)
 * ✅ Multi-Account relaxed: MAX_PER_IP=3, MAX_PER_FP=2
 * ✅ New Account Protection (24h grace period)
 * ✅ Honest Shadow Ban — returns ok:false, error:'account_review'
 * ✅ Referral validation — active user required (ads>=3 OR pts>=MIN)
 * ✅ Persistent Fingerprint — soft verification on change
 * ✅ Daily Gift — CURRENT_DATE server-side only
 * ✅ Atomic Rewards — SELECT FOR UPDATE + transactions where needed
 * ✅ All original security preserved: Nonce, Zero Trust, Replay, TimingSafeEqual
 * ✅ Clear structured logging for all risk/shadow/block events
 * ✅ USDT balance unchanged by tasks/ads/referrals
 */

'use strict';

const {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} = require('crypto');
const { neon } = require('@neondatabase/serverless');

// ── DB ────────────────────────────────────────────────────────────
const _db = neon(process.env.DATABASE_URL);
async function sql(query, params = []) {
  return await _db(query, params);
}

// ── Environment ───────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN    || '';
const CHANNEL_ID   = process.env.CHANNEL_ID   || '';   // e.g. "@botbababab" or "-100123456789"
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me-in-env';
const IP_SALT      = process.env.IP_SALT      || 'rebh_ip_salt_2025';
const IS_DEV       = process.env.NODE_ENV !== 'production';

// ── Telegram Bot API: check channel membership ───────────────────
async function checkTelegramMembership(telegramUserId) {
  if (!BOT_TOKEN || !CHANNEL_ID) {
    // إذا لم يُضبط BOT_TOKEN أو CHANNEL_ID → نتجاوز الفحص (dev mode)
    console.warn('[TG_MEMBER] BOT_TOKEN or CHANNEL_ID not set — skipping check');
    return { ok: true, skipped: true };
  }
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(CHANNEL_ID)}&user_id=${telegramUserId}`;
    const res  = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
    const json = await res.json();
    if (!json.ok) {
      console.warn('[TG_MEMBER] API error:', json.description);
      return { ok: false, reason: json.description || 'api_error' };
    }
    const status = json.result?.status; // member | administrator | creator | left | kicked | restricted
    const isMember = ['member', 'administrator', 'creator'].includes(status);
    return { ok: isMember, status };
  } catch (err) {
    console.error('[TG_MEMBER] fetch error:', err.message);
    return { ok: false, reason: 'network_error' };
  }
}

// ═══════════════════════════════════════════════════════════════════
// DYNAMIC CONFIG — Single source of truth
// Any change here reflects immediately in GET /config
// ═══════════════════════════════════════════════════════════════════
const CONFIG = Object.freeze({
  withdraw: {
    first_min:    3000,   // أول سحبة للمستخدم الجديد
    normal_min:   20000,  // السحب الطبيعي بعد أول سحبة
    normal_level: 5,      // المستوى المطلوب للسحب الطبيعي
  },
  rewards: {
    referral:          100,   // نقاط لكل إحالة
    telegram_task:     200,   // مهمة تيليجرام
    adsgram_task:      50,    // مهمة Adsgram
    daily_ads_10:      200,   // مشاهدة 10 إعلانات
    daily_ads_25:      300,   // مشاهدة 25 إعلان
    daily_referrals_3: 1000,  // 3 إحالات يومية
    points_per_ad:     50,    // نقاط لكل إعلان
  },
  telegram: {
    channel_url: 'https://t.me/botbababab',
  },
  ads: {
    daily_limit:       22,
    cooldown_ms:       30 * 1000,
    min_duration_ms:   14 * 1000,
  },
  adsgram_task: {
    cooldown_ms:       60 * 1000,
    min_watch_ms:      1500,   // 1.5 ثانية — Adsgram يتحكم بوقت الإعلان
    // ✅ اسم/عنوان المهمة الديناميكي — يتغير حسب مزود الإعلان
    // غيّر هذه القيم من السيرفر فقط، الواجهة تقرأها من /config
    title_ar:          'بلاي غيم تو غيت تون',
    title_en:          'Play Game to Get TON',
    block_id:          'task-30166',
  },
  // ═══ هدية الربح اليومي — ديناميكية من السيرفر ═══
  daily_gift: {
    rewards: [100, 150, 200, 250, 300, 400, 750, 800, 900, 1000],
    titles_ar: [
      'اليوم الأول', 'اليوم الثاني', 'اليوم الثالث', 'اليوم الرابع',
      'اليوم الخامس', 'اليوم السادس', 'اليوم السابع',
      'اليوم الثامن', 'اليوم التاسع', 'اليوم العاشر'
    ],
    descs_ar: [
      'مبروك! بداية رائعة معنا.\nاستمر يومياً لتضاعف مكافآتك!',
      'يومان متتاليان!\nالمثابرة هي مفتاح النجاح.',
      'ثلاثة أيام متتالية!\nمكافأة خاصة بانتظارك.',
      'أسبوعك يقترب!\nاستمر في التحدي.',
      'خمسة أيام!\nأنت من الملتزمين الحقيقيين.',
      'يوم واحد ويكتمل أسبوعك!\nلا تتوقف.',
      'أسبوع كامل!\nمكافأة ضخمة بانتظارك.',
      'تجاوزت الأسبوع!\nمكافأة استثنائية.',
      'تسعة أيام!\nأنت أسطورة.',
      'عشرة أيام متتالية!\nمكافأة الأبطال.'
    ],
  },
  referral: {
    min_active_ads:    3,     // الحد الأدنى للإعلانات لاعتبار المستخدم نشيطاً
    min_active_pts:    100,   // أو النقاط
  },
});

// ── Internal CFG (backward compat) ───────────────────────────────
const CFG = {
  POINTS_PER_AD:         CONFIG.rewards.points_per_ad,
  POINTS_PER_REFERRAL:   CONFIG.rewards.referral,
  POINTS_PER_TG_TASK:    CONFIG.rewards.telegram_task,
  ADS_DAILY_LIMIT:       CONFIG.ads.daily_limit,
  WITHDRAW_MIN_PTS:      CONFIG.withdraw.normal_min,
  WITHDRAW_MIN_LEVEL:    CONFIG.withdraw.normal_level,
  WITHDRAW_FIRST_MIN:    CONFIG.withdraw.first_min,
  PTS_PER_TON:           100000,

  NONCE_TTL_MS:          5  * 60 * 1000,
  AD_NONCE_TTL_MS:       3  * 60 * 1000,  // ✅ رُفع من 30s إلى 3 دقائق — يكفي لأي إعلان
  AD_COOLDOWN_MS:        CONFIG.ads.cooldown_ms,
  AD_MIN_DURATION_MS:    CONFIG.ads.min_duration_ms,
  ADSGRAM_TASK_COOLDOWN_MS:  CONFIG.adsgram_task.cooldown_ms,
  ADSGRAM_TASK_POINTS:   CONFIG.rewards.adsgram_task,
  ADSGRAM_TASK_MIN_WATCH_MS: CONFIG.adsgram_task.min_watch_ms,

  SESSION_TTL_MS:        7  * 24 * 60 * 60 * 1000,
  RATE_WINDOW_MS:        60 * 1000,
  RATE_MAX:              30,
  RATE_WRITE_MAX:        15,

  RISK_BAN:              100,
  RISK_SHADOW:           60,

  // ── New Account Protection ────────────────────────────────────
  ACCOUNT_AGE_PROTECTION_MS: 24 * 60 * 60 * 1000,  // 24h grace period

  // ── Multi-account — relaxed ───────────────────────────────────
  MULTI_ACCT: {
    MAX_PER_IP: 3,   // was 1 → now 3 (shared WiFi/NAT tolerance)
    MAX_PER_FP: 2,   // was 1 → now 2 (family devices)
    IP_WHITELIST: new Set([]),
  },

  LEVEL_THRESHOLDS: [0, 0, 500, 1500, 3500, 8000, 16000, 30000, 55000, 90000, 150000],
  GIFT_REWARDS:     CONFIG.daily_gift.rewards,
};

// ── In-memory rate limit ──────────────────────────────────────────
const rateLimitMap = new Map();

// ── Bootstrap ready promise ───────────────────────────────────────
let _bootstrapPromise = null;

// ═══════════════════════════════════════════════════════════════════
// BOOTSTRAP — DB Schema
// ═══════════════════════════════════════════════════════════════════
let _bootstrapped = false;
async function bootstrap() {
  if (_bootstrapped) return;
  _bootstrapped = true;
  try {
    // ── users ─────────────────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      tg_id BIGINT UNIQUE NOT NULL,
      tg_username TEXT, tg_first_name TEXT, tg_last_name TEXT,
      tg_language_code TEXT DEFAULT 'ar',
      tg_is_premium BOOLEAN DEFAULT FALSE,
      points BIGINT DEFAULT 0, level INT DEFAULT 1, xp BIGINT DEFAULT 0,
      usdt_balance NUMERIC(18,6) DEFAULT 0,
      is_banned BOOLEAN DEFAULT FALSE,
      is_shadow_banned BOOLEAN DEFAULT FALSE,
      ban_reason TEXT, risk_score INT DEFAULT 0,
      referrer_id BIGINT, tg_verified BOOLEAN DEFAULT FALSE,
      streak_day INT DEFAULT 0, last_gift_date DATE,
      ads_watched_total BIGINT DEFAULT 0,
      total_referrals INT DEFAULT 0, earned_from_refs BIGINT DEFAULT 0,
      ip_hash TEXT, fp_hash TEXT,
      cluster_ban BOOLEAN DEFAULT FALSE,
      last_ip_hash TEXT,
      ad_last_reward TIMESTAMPTZ,
      first_withdraw_done BOOLEAN DEFAULT FALSE,
      adsgram_status TEXT DEFAULT 'ready',
      adsgram_started_at TIMESTAMPTZ,
      adsgram_expires_at TIMESTAMPTZ,
      adsgram_completed BOOLEAN DEFAULT FALSE,
      adsgram_claimed BOOLEAN DEFAULT FALSE,
      adsgram_last_claimed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // ── sessions ─────────────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      fingerprint_hash TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      ad_nonce      TEXT,
      ad_nonce_exp  TIMESTAMPTZ,
      ad_nonce_used BOOLEAN DEFAULT FALSE,
      ad_started_at TIMESTAMPTZ,
      adsgram_task_started_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_active TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      is_revoked BOOLEAN DEFAULT FALSE
    )`);

    // ── nonces ───────────────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS nonces (
      id BIGSERIAL PRIMARY KEY,
      nonce      TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      user_id    BIGINT NOT NULL,
      ip_hash    TEXT,
      fp_hash    TEXT,
      action     TEXT,
      used       BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )`);

    // ── audit_log ────────────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      user_id    BIGINT,
      session_id TEXT,
      action     TEXT NOT NULL,
      status     TEXT NOT NULL,
      ip_hash    TEXT,
      fp_hash    TEXT,
      meta       JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // ── ad_logs ───────────────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS ad_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      log_date DATE NOT NULL DEFAULT CURRENT_DATE,
      count INT DEFAULT 0,
      points_earned BIGINT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, log_date)
    )`);

    // ── withdrawals ───────────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS withdrawals (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      pts BIGINT NOT NULL,
      ton_amount NUMERIC(18,6),
      address TEXT NOT NULL,
      method TEXT DEFAULT 'ton',
      status TEXT DEFAULT 'pending',
      tx_hash TEXT, notes TEXT,
      reviewed_at TIMESTAMPTZ, reviewed_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // ── user_tasks ────────────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS user_tasks (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      task_type TEXT NOT NULL,
      completed BOOLEAN DEFAULT FALSE,
      completed_at TIMESTAMPTZ,
      task_date DATE DEFAULT CURRENT_DATE,
      reward_claimed BOOLEAN DEFAULT FALSE,
      UNIQUE(user_id, task_type, task_date)
    )`);

    // ── referrals ─────────────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS referrals (
      id BIGSERIAL PRIMARY KEY,
      referrer_id BIGINT NOT NULL,
      referred_id BIGINT NOT NULL,
      points_given BIGINT DEFAULT 0,
      activated BOOLEAN DEFAULT FALSE,
      activated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(referred_id)
    )`);

    // ── risk_events ───────────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS risk_events (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT,
      event_type TEXT NOT NULL,
      ip_hash TEXT, fp_hash TEXT,
      score_delta INT DEFAULT 0,
      meta JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // ── channels ─────────────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS channels (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      reward INT DEFAULT 2500,
      max_members INT DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      sort_order INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // ── seed default channel if empty ─────────────────────────────
    await sql(`
      INSERT INTO channels(title, url, reward, max_members, is_active, sort_order)
      SELECT 'قناة الربح عربي', 'https://t.me/botbababab', 2500, 0, TRUE, 0
      WHERE NOT EXISTS (SELECT 1 FROM channels LIMIT 1)
    `);

    // ── completed_tasks ───────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS completed_tasks (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      task_key TEXT NOT NULL,
      completed_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, task_key)
    )`);


    // ── device_fingerprints ───────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS device_fingerprints (
      fingerprint   TEXT NOT NULL,
      user_id       BIGINT NOT NULL,
      user_agent    TEXT,
      lang          TEXT,
      screen        TEXT,
      timezone_off  INT DEFAULT 0,
      last_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (fingerprint, user_id)
    )`);

    // ── security_logs ─────────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS security_logs (
      id          BIGSERIAL PRIMARY KEY,
      user_id     BIGINT,
      ip_hash     TEXT,
      fingerprint TEXT,
      action      TEXT NOT NULL,
      risk_score  INT  NOT NULL DEFAULT 0,
      verdict     TEXT NOT NULL DEFAULT 'allow',
      detail      JSONB NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    // ── Migrations ────────────────────────────────────────────────
    const migrations = [
      `ALTER TABLE sessions  ADD COLUMN IF NOT EXISTS ad_nonce TEXT`,
      `ALTER TABLE sessions  ADD COLUMN IF NOT EXISTS ad_nonce_exp TIMESTAMPTZ`,
      `ALTER TABLE sessions  ADD COLUMN IF NOT EXISTS ad_nonce_used BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE sessions  ADD COLUMN IF NOT EXISTS ad_started_at TIMESTAMPTZ`,
      `ALTER TABLE sessions  ADD COLUMN IF NOT EXISTS adsgram_task_started_at TIMESTAMPTZ`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS ad_last_reward TIMESTAMPTZ`,
      `ALTER TABLE nonces    ADD COLUMN IF NOT EXISTS session_id TEXT`,
      `ALTER TABLE nonces    ADD COLUMN IF NOT EXISTS ip_hash TEXT`,
      `ALTER TABLE nonces    ADD COLUMN IF NOT EXISTS fp_hash TEXT`,
      `ALTER TABLE nonces    ADD COLUMN IF NOT EXISTS action  TEXT`,
      `ALTER TABLE nonces    ADD COLUMN IF NOT EXISTS used    BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS cluster_ban BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS last_ip_hash TEXT`,
      // v5.0 migrations
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS first_withdraw_done BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS usdt_balance NUMERIC(18,6) DEFAULT 0`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS adsgram_status TEXT DEFAULT 'ready'`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS adsgram_started_at TIMESTAMPTZ`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS adsgram_expires_at TIMESTAMPTZ`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS adsgram_completed BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS adsgram_claimed BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS adsgram_last_claimed_at TIMESTAMPTZ`,
      `ALTER TABLE referrals ADD COLUMN IF NOT EXISTS activated BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE referrals ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ`,
      `ALTER TABLE user_tasks ADD COLUMN IF NOT EXISTS reward_claimed BOOLEAN DEFAULT FALSE`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='completed_tasks_user_key_unique') THEN ALTER TABLE completed_tasks ADD CONSTRAINT completed_tasks_user_key_unique UNIQUE(user_id, task_key); END IF; END $$`,
    ];
    for (const m of migrations) { try { await sql(m); } catch (_) {} }

    // ── Indexes ───────────────────────────────────────────────────
    const idxs = [
      `CREATE INDEX IF NOT EXISTS idx_dfp_user ON device_fingerprints(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_dfp_fp   ON device_fingerprints(fingerprint)`,
      `CREATE INDEX IF NOT EXISTS idx_sl_user  ON security_logs(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_s_user   ON sessions(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_s_exp    ON sessions(expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_s_ip     ON sessions(ip_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_s_fp     ON sessions(fingerprint_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_n_hash   ON nonces(nonce)`,
      `CREATE INDEX IF NOT EXISTS idx_n_sess   ON nonces(session_id)`,
      `CREATE INDEX IF NOT EXISTS idx_n_user   ON nonces(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_n_used   ON nonces(used, expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_al_ud    ON ad_logs(user_id, log_date)`,
      `CREATE INDEX IF NOT EXISTS idx_wd_user  ON withdrawals(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ref_ref  ON referrals(referrer_id)`,
      `CREATE INDEX IF NOT EXISTS idx_u_ip     ON users(last_ip_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_u_fp     ON users(fp_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_u  ON audit_log(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_ct_user  ON completed_tasks(user_id, task_key)`,
    ];
    for (const q of idxs) { try { await sql(q); } catch (_) {} }

    console.log('[DB] bootstrap OK v5.0 — Dynamic Config + First Withdraw + DB Adsgram');
  } catch (e) {
    console.error('[DB] bootstrap error:', e.message);
  }
}
_bootstrapPromise = bootstrap();

// ── Cleanup — كل ساعة ────────────────────────────────────────────
setInterval(async () => {
  try {
    await sql(`DELETE FROM nonces   WHERE expires_at < NOW() OR used = TRUE`);
    await sql(`DELETE FROM sessions WHERE expires_at < NOW()`);
    await sql(`
      UPDATE sessions
      SET ad_nonce=NULL, ad_nonce_exp=NULL, ad_nonce_used=FALSE
      WHERE ad_nonce_exp < NOW()
    `);
    await sql(`DELETE FROM audit_log   WHERE created_at < NOW() - INTERVAL '30 days'`);
    await sql(`DELETE FROM risk_events WHERE created_at < NOW() - INTERVAL '7 days'`);
    // Reset adsgram_status إذا انتهت المهلة بدون claim
    await sql(`
      UPDATE users
      SET adsgram_status='ready', adsgram_completed=FALSE
      WHERE adsgram_status='watching'
        AND adsgram_expires_at IS NOT NULL
        AND adsgram_expires_at < NOW() - INTERVAL '5 minutes'
    `);
    console.log('[CLEANUP] OK');
  } catch (_) {}
}, 60 * 60 * 1000);


// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function sha256(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}

function genRawNonce(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

function constantTimeCompare(a, b) {
  try {
    const sA = String(a || '');
    const sB = String(b || '');
    const bufA = Buffer.from(sha256(sA), 'hex');
    const bufB = Buffer.from(sha256(sB), 'hex');
    const match = timingSafeEqual(bufA, bufB);
    return match && sA === sB;
  } catch (_) { return false; }
}

function hashIp(ip) {
  return sha256((ip || '') + IP_SALT).slice(0, 32);
}

function hashFp(fp) {
  try {
    return sha256(typeof fp === 'string' ? fp : JSON.stringify(fp)).slice(0, 40);
  } catch (_) { return 'unknown'; }
}

function computeLevel(xp) {
  const t = CFG.LEVEL_THRESHOLDS;
  for (let i = t.length - 1; i >= 0; i--) if (xp >= t[i]) return i;
  return 1;
}

function giftReward(day) {
  return CFG.GIFT_REWARDS[Math.min(day - 1, CFG.GIFT_REWARDS.length - 1)] || 100;
}

function getIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || '0.0.0.0';
}

function isValidTon(addr) {
  const a = (addr || '').trim();
  return (a.startsWith('EQ') || a.startsWith('UQ') || a.startsWith('0:')) && a.length >= 48;
}

function verifyTg(initData) {
  if (!initData || !BOT_TOKEN) {
    return IS_DEV
      ? { ok: true, data: { id: 99999999, first_name: 'Dev', language_code: 'ar' } }
      : { ok: false };
  }
  try {
    const p = new URLSearchParams(initData), hash = p.get('hash');
    if (!hash) return { ok: false };
    p.delete('hash');
    const str = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
    const sk  = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    if (createHmac('sha256', sk).update(str).digest('hex') !== hash) return { ok: false };
    if (Math.floor(Date.now() / 1000) - parseInt(p.get('auth_date') || '0') > 86400) return { ok: false };
    return { ok: true, data: JSON.parse(p.get('user') || '{}') };
  } catch (_) { return { ok: false }; }
}

function rateLimit(key, max = CFG.RATE_MAX) {
  const now = Date.now();
  let e = rateLimitMap.get(key);
  if (!e || now > e.resetAt) {
    e = { count: 0, resetAt: now + CFG.RATE_WINDOW_MS };
    rateLimitMap.set(key, e);
  }
  return ++e.count <= max;
}

// ── Structured logging helpers ────────────────────────────────────
function logRisk(reason, userId, extra = {}) {
  console.warn(`[RISK] reason=${reason} userId=${userId}`, JSON.stringify(extra));
}
function logShadow(reason, userId, extra = {}) {
  console.warn(`[SHADOW_BAN] reason=${reason} userId=${userId}`, JSON.stringify(extra));
}
function logRewardBlock(reason, userId, extra = {}) {
  console.info(`[REWARD_BLOCK] reason=${reason} userId=${userId}`, JSON.stringify(extra));
}
function logFingerprintChange(userId, oldFp, newFp) {
  console.info(`[FP_CHANGE] userId=${userId} old=${oldFp?.slice(0,8)} new=${newFp?.slice(0,8)}`);
}
function logAdsgramState(userId, state, extra = {}) {
  console.info(`[ADSGRAM] userId=${userId} state=${state}`, JSON.stringify(extra));
}


// ═══════════════════════════════════════════════════════════════════
// SESSION
// ═══════════════════════════════════════════════════════════════════

async function validateSession(sid, ipHash, fpHash) {
  if (!sid) return null;
  const r = await sql(
    `SELECT s.*, u.is_banned, u.is_shadow_banned, u.cluster_ban, u.risk_score
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1
       AND s.is_revoked = FALSE
       AND s.expires_at > NOW()
     LIMIT 1`,
    [sid]
  );
  if (!r.length) return null;
  const session = r[0];

  // ── Fingerprint change — soft verification (no immediate ban) ──
  if (session.fingerprint_hash && fpHash && session.fingerprint_hash !== fpHash) {
    logFingerprintChange(session.user_id, session.fingerprint_hash, fpHash);

    // Check account age — new accounts get extra grace
    const userRow = (await sql(`SELECT created_at FROM users WHERE id=$1`, [session.user_id]))[0];
    const accountAgeMs = userRow ? Date.now() - new Date(userRow.created_at).getTime() : 999999999;
    const isNewAccount = accountAgeMs < CFG.ACCOUNT_AGE_PROTECTION_MS;

    if (!isNewAccount) {
      // Soft risk increment — not immediate ban
      await addRisk(session.user_id, 'session_fp_change', ipHash, fpHash, 8,
        { old_fp: session.fingerprint_hash?.slice(0,8), new_fp: fpHash?.slice(0,8) });
      await writeAudit(session.user_id, sid, 'session_validate', 'fp_mismatch_risk', ipHash, fpHash, {
        fingerprint_change_reason: 'fp_changed_soft_verify',
        old_fp: session.fingerprint_hash?.slice(0,8),
        new_fp: fpHash?.slice(0,8),
        is_new_account: false,
      });
    } else {
      console.info(`[FP_CHANGE] New account grace — no risk for userId=${session.user_id}`);
      await writeAudit(session.user_id, sid, 'session_validate', 'fp_mismatch_grace', ipHash, fpHash, {
        fingerprint_change_reason: 'new_account_grace_period',
        is_new_account: true,
        account_age_ms: accountAgeMs,
      });
    }
    // Do NOT revoke session — just increment risk
  }

  await sql(`UPDATE sessions SET last_active=NOW() WHERE id=$1`, [sid]);
  return session;
}

async function issueAdNonce(sessionId) {
  const nonce = genRawNonce(32);
  const exp   = new Date(Date.now() + CFG.AD_NONCE_TTL_MS).toISOString();
  const r = await sql(
    `UPDATE sessions
     SET ad_nonce=$1, ad_nonce_exp=$2, ad_nonce_used=FALSE
     WHERE id=$3 AND is_revoked=FALSE
     RETURNING id`,
    [nonce, exp, sessionId]
  );
  return r.length ? nonce : null;
}

async function issueNonce(sessionId, userId, ipHash, fpHash, action) {
  const nonce = genRawNonce(32);
  const exp   = new Date(Date.now() + CFG.NONCE_TTL_MS).toISOString();
  await sql(
    `INSERT INTO nonces(nonce, session_id, user_id, ip_hash, fp_hash, action, expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [nonce, sessionId, userId, ipHash, fpHash, action, exp]
  );
  return nonce;
}

async function consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, action) {
  if (!rawNonce) return 'missing';
  const r = await sql(
    `SELECT id, ip_hash, fp_hash, action, used, expires_at
     FROM nonces
     WHERE nonce=$1 AND session_id=$2 AND user_id=$3 AND used=FALSE
     LIMIT 1`,
    [rawNonce, sessionId, userId]
  );
  if (!r.length) return 'invalid';
  const n = r[0];
  if (n.used) { await addRisk(userId, 'nonce_replay', ipHash, fpHash, 20); return 'replay'; }
  if (new Date(n.expires_at) < new Date()) return 'expired';
  if (n.action && n.action !== action) { await addRisk(userId, 'nonce_action_mismatch', ipHash, fpHash, 15); return 'action_mismatch'; }
  if (!constantTimeCompare(n.fp_hash || fpHash, fpHash)) {
    await addRisk(userId, 'nonce_fp_mismatch', ipHash, fpHash, 15);
    return 'fp_mismatch';
  }
  const consumed = await sql(
    `UPDATE nonces SET used=TRUE WHERE id=$1 AND used=FALSE RETURNING id`,
    [n.id]
  );
  if (!consumed.length) return 'race';
  return 'ok';
}

async function consumeAdNonce(sessionId, clientNonce, userId, ipHash, fpHash) {
  if (!clientNonce) {
    await addRisk(userId, 'reward_ad_no_nonce', ipHash, fpHash, 15);
    return 'missing';
  }
  const rows = await sql(
    `SELECT ad_nonce, ad_nonce_exp, ad_nonce_used
     FROM sessions WHERE id=$1 AND is_revoked=FALSE`,
    [sessionId]
  );
  if (!rows.length) return 'invalid';
  const { ad_nonce, ad_nonce_exp, ad_nonce_used } = rows[0];
  if (!ad_nonce) { await addRisk(userId, 'reward_ad_no_nonce_issued', ipHash, fpHash, 15); return 'not_issued'; }
  if (ad_nonce_used) { await addRisk(userId, 'reward_ad_nonce_reuse', ipHash, fpHash, 30); return 'replay'; }
  if (!ad_nonce_exp || new Date(ad_nonce_exp) < new Date()) {
    await sql(`UPDATE sessions SET ad_nonce=NULL, ad_nonce_exp=NULL, ad_nonce_used=FALSE WHERE id=$1`, [sessionId]);
    return 'expired';
  }
  const match = constantTimeCompare(clientNonce, ad_nonce);
  if (!match) { await addRisk(userId, 'reward_ad_nonce_mismatch', ipHash, fpHash, 40); return 'mismatch'; }
  const consumed = await sql(
    `UPDATE sessions
     SET ad_nonce=NULL, ad_nonce_exp=NULL, ad_nonce_used=TRUE
     WHERE id=$1 AND ad_nonce=$2 AND ad_nonce_used=FALSE
     RETURNING id`,
    [sessionId, ad_nonce]
  );
  if (!consumed.length) { await addRisk(userId, 'reward_ad_race_condition', ipHash, fpHash, 10); return 'race'; }
  return 'ok';
}


// ═══════════════════════════════════════════════════════════════════
// AUDIT LOG + RISK
// ═══════════════════════════════════════════════════════════════════

async function writeAudit(userId, sessionId, action, status, ipHash, fpHash, meta = {}) {
  try {
    await sql(
      `INSERT INTO audit_log(user_id, session_id, action, status, ip_hash, fp_hash, meta)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [userId || null, sessionId || null, action, status, ipHash || null, fpHash || null, JSON.stringify(meta)]
    );
  } catch (_) {}
}

async function addRisk(userId, type, ipHash, fpHash, delta, meta = {}) {
  try {
    logRisk(type, userId, { delta, ...meta });
    await sql(
      `INSERT INTO risk_events(user_id, event_type, ip_hash, fp_hash, score_delta, meta)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [userId, type, ipHash, fpHash, delta, JSON.stringify(meta)]
    );
    if (delta > 0) {
      await sql(`UPDATE users SET risk_score=LEAST(risk_score+$1, 200) WHERE id=$2`, [delta, userId]);
      await sql(
        `UPDATE users SET is_banned=TRUE, ban_reason='auto_risk'
         WHERE id=$1 AND risk_score >= $2 AND is_banned=FALSE`,
        [userId, CFG.RISK_BAN]
      );
      const shadowResult = await sql(
        `UPDATE users SET is_shadow_banned=TRUE
         WHERE id=$1 AND risk_score >= $2 AND is_banned=FALSE AND is_shadow_banned=FALSE
         RETURNING id`,
        [userId, CFG.RISK_SHADOW]
      );
      if (shadowResult.length) {
        logShadow('auto_risk_threshold', userId, { risk_type: type, delta });
      }
    }
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════
// MULTI-ACCOUNT DETECTION — relaxed limits + new account protection
// ═══════════════════════════════════════════════════════════════════
async function checkMultiAccount(userId, ipHash, fpHash, accountAgeMs) {
  const cfg = CFG.MULTI_ACCT;
  if (cfg.IP_WHITELIST.has(ipHash)) return { flagged: false };

  const isNewAccount = accountAgeMs < CFG.ACCOUNT_AGE_PROTECTION_MS;

  const ipAccounts = await sql(
    `SELECT COUNT(DISTINCT u.id) AS cnt FROM users u
     WHERE u.last_ip_hash=$1 AND u.id != $2 AND u.is_banned = FALSE`,
    [ipHash, userId]
  );
  const ipCnt = parseInt(ipAccounts[0]?.cnt) || 0;

  const fpAccounts = await sql(
    `SELECT COUNT(DISTINCT u.id) AS cnt FROM users u
     WHERE u.fp_hash=$1 AND u.id != $2 AND u.is_banned = FALSE`,
    [fpHash, userId]
  );
  const fpCnt = parseInt(fpAccounts[0]?.cnt) || 0;

  const ipViolation = ipCnt >= cfg.MAX_PER_IP;
  const fpViolation = fpCnt >= cfg.MAX_PER_FP;

  if (fpViolation && !isNewAccount) {
    // Hard ban — strong evidence only for older accounts
    logRisk('multi_account_fp_hard_ban', userId, { fpCnt, ipCnt, accountAgeMs });
    return { flagged: true, reason: 'multi_fp', ban: true };
  }

  if (fpViolation && isNewAccount) {
    // New account + FP match — soft risk only, wait for evidence
    await addRisk(userId, 'multi_account_fp_new_account', ipHash, fpHash, 10,
      { fpCnt, note: 'New account grace — soft risk only' });
    logRisk('multi_account_fp_new_grace', userId, { fpCnt, isNewAccount: true });
    return { flagged: false, warned: true };
  }

  if (ipViolation) {
    // IP violation — warning only (shared NAT/WiFi)
    await addRisk(userId, 'multi_account_ip_warning', ipHash, fpHash, 5,
      { ipCnt, note: 'Shared IP — no ban' });
    logRisk('multi_account_ip_warning', userId, { ipCnt });
    return { flagged: false, warned: true };
  }

  const bannedOnIp = await sql(
    `SELECT COUNT(*) AS cnt FROM users WHERE last_ip_hash=$1 AND is_banned=TRUE AND id!=$2`,
    [ipHash, userId]
  );
  if ((parseInt(bannedOnIp[0]?.cnt) || 0) > 3) {
    await addRisk(userId, 'cluster_ip_banned', ipHash, fpHash, 10);
  }

  return { flagged: false };
}


// ═══════════════════════════════════════════════════════════════════
// USER OPS
// ═══════════════════════════════════════════════════════════════════

async function upsertUser(tgUser, ipHash, fpHash) {
  const r = await sql(
    `INSERT INTO users(tg_id,tg_username,tg_first_name,tg_last_name,tg_language_code,tg_is_premium,ip_hash,fp_hash,last_ip_hash)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT(tg_id) DO UPDATE SET
       tg_username=EXCLUDED.tg_username,
       tg_first_name=EXCLUDED.tg_first_name,
       tg_last_name=EXCLUDED.tg_last_name,
       tg_language_code=EXCLUDED.tg_language_code,
       tg_is_premium=EXCLUDED.tg_is_premium,
       last_ip_hash=EXCLUDED.last_ip_hash,
       updated_at=NOW()
     RETURNING *`,
    [
      tgUser.id, tgUser.username || null, tgUser.first_name || null,
      tgUser.last_name || null, tgUser.language_code || 'ar',
      !!tgUser.is_premium, ipHash, fpHash, ipHash,
    ]
  );
  return r[0];
}

async function syncLevel(userId) {
  const r = await sql(`SELECT xp FROM users WHERE id=$1`, [userId]);
  if (!r.length) return;
  await sql(
    `UPDATE users SET level=$1 WHERE id=$2`,
    [computeLevel(parseInt(r[0].xp) || 0), userId]
  );
}

async function upsertTask(userId, taskType) {
  await sql(
    `INSERT INTO user_tasks(user_id, task_type, completed, completed_at, task_date)
     VALUES($1,$2,TRUE,NOW(),CURRENT_DATE)
     ON CONFLICT(user_id, task_type, task_date)
     DO UPDATE SET completed=TRUE, completed_at=NOW()`,
    [userId, taskType]
  );
}

// ── Check if referral reward can be given (referred must be active) ──
async function isReferralActive(userId) {
  const r = (await sql(`SELECT ads_watched_total, points FROM users WHERE id=$1`, [userId]))[0];
  if (!r) return false;
  const adsWatched = parseInt(r.ads_watched_total) || 0;
  const pts = parseInt(r.points) || 0;
  return adsWatched >= CONFIG.referral.min_active_ads || pts >= CONFIG.referral.min_active_pts;
}


// ═══════════════════════════════════════════════════════════════════
// GET /config — Dynamic Config Endpoint
// ═══════════════════════════════════════════════════════════════════
function handleGetConfig() {
  return {
    ok: true,
    withdraw: {
      first_min:    CONFIG.withdraw.first_min,
      normal_min:   CONFIG.withdraw.normal_min,
      normal_level: CONFIG.withdraw.normal_level,
    },
    rewards: {
      referral:          CONFIG.rewards.referral,
      telegram_task:     CONFIG.rewards.telegram_task,
      adsgram_task:      CONFIG.rewards.adsgram_task,
      daily_ads_10:      CONFIG.rewards.daily_ads_10,
      daily_ads_25:      CONFIG.rewards.daily_ads_25,
      daily_referrals_3: CONFIG.rewards.daily_referrals_3,
      points_per_ad:     CONFIG.rewards.points_per_ad,
    },
    telegram: {
      channel_url: CONFIG.telegram.channel_url,
    },
    ads: {
      daily_limit:     CONFIG.ads.daily_limit,
      cooldown_ms:     CONFIG.ads.cooldown_ms,
      min_duration_ms: CONFIG.ads.min_duration_ms,
    },
    adsgram_task: {
      title_ar:  CONFIG.adsgram_task.title_ar,
      title_en:  CONFIG.adsgram_task.title_en,
      block_id:  CONFIG.adsgram_task.block_id,
      reward:    CONFIG.rewards.adsgram_task,
      cooldown_ms: CONFIG.adsgram_task.cooldown_ms,
    },
    daily_gift: {
      rewards:   CONFIG.daily_gift.rewards,
      titles_ar: CONFIG.daily_gift.titles_ar,
      descs_ar:  CONFIG.daily_gift.descs_ar,
    },
  };
}


// ═══════════════════════════════════════════════════════════════════
// CREATE SESSION
// ═══════════════════════════════════════════════════════════════════
async function handleCreateSession(body, ipHash, fpHash) {
  const initData = body?.data?.initData || '';
  const fpData   = body?.data?.fp || {};

  const tgResult = verifyTg(initData);
  if (!tgResult.ok && !IS_DEV) {
    return { ok: false, error: 'invalid_init_data', status: 401 };
  }

  const tgUser = tgResult.data?.id
    ? tgResult.data
    : { id: 99999999, first_name: 'Dev', language_code: 'ar' };
  if (!tgUser.id) return { ok: false, error: 'no_user_id', status: 401 };

  const tid = parseInt(tgUser.id);
  const user = await upsertUser(tgUser, ipHash, fpHash);
  const accountAgeMs = Date.now() - new Date(user.created_at).getTime();
  const isNewAccount = accountAgeMs < CFG.ACCOUNT_AGE_PROTECTION_MS;

  // ── Referral processing ───────────────────────────────────────
  try {
    const sp = new URLSearchParams(initData).get('start_param') || '';
    const m  = sp.match(/^ref_(\d+)$/);
    if (m) {
      const refTgId = parseInt(m[1]);
      if (refTgId !== tid) {  // prevent self-referral
        const rr = await sql(`SELECT id FROM users WHERE tg_id=$1`, [refTgId]);
        if (rr.length) {
          const referrerId = rr[0].id;
          // Check not already registered
          const existing = await sql(
            `SELECT id FROM referrals WHERE referred_id=$1`,
            [user.id]
          );
          if (!existing.length) {
            // Store referral — reward given only when referred becomes active
            await sql(
              `INSERT INTO referrals(referrer_id, referred_id, points_given, activated)
               VALUES($1,$2,0,FALSE)
               ON CONFLICT(referred_id) DO NOTHING`,
              [referrerId, user.id]
            );
            await sql(`UPDATE users SET referrer_id=$1 WHERE id=$2 AND referrer_id IS NULL`, [referrerId, user.id]);
          }
        }
      } else {
        logRewardBlock('self_referral_prevented', user.id, { tg_id: tid });
      }
    }
  } catch (_) {}

  // ── Check hard ban ────────────────────────────────────────────
  const userRow = (await sql(
    `SELECT is_banned, is_shadow_banned, risk_score, created_at FROM users WHERE id=$1`,
    [user.id]
  ))[0];

  if (userRow?.is_banned) {
    await writeAudit(user.id, null, 'create_session', 'hard_banned', ipHash, fpHash, { tg_id: tid });
    return { ok: false, is_banned: true, ban_type: 'hard', status: 403 };
  }

  if (userRow?.is_shadow_banned) {
    await writeAudit(user.id, null, 'create_session', 'shadow_banned', ipHash, fpHash, { tg_id: tid });
    logShadow('create_session_blocked', user.id, { tg_id: tid });
    // ✅ Honest response — no fake success
    return { ok: false, error: 'account_review', is_shadow_banned: true, status: 200 };
  }

  // ── Multi-account check ───────────────────────────────────────
  try {
    const multiResult = await checkMultiAccount(user.id, ipHash, fpHash, accountAgeMs);

    if (multiResult.flagged && multiResult.ban) {
      await sql(
        `UPDATE users SET is_banned=TRUE, ban_reason='multi_account', updated_at=NOW() WHERE id=$1`,
        [user.id]
      );
      try {
        await sql(
          `INSERT INTO security_logs(user_id,ip_hash,fingerprint,action,risk_score,verdict,detail)
           VALUES($1,$2,$3,'multi_account_detected',100,'deny',$4)`,
          [user.id, ipHash, fpHash, JSON.stringify({
            reason: 'multi_account_hard_ban', tg_id: tid,
          })]
        );
      } catch (_) {}
      await writeAudit(user.id, null, 'create_session', 'multi_account_banned', ipHash, fpHash, { tg_id: tid });
      return { ok: false, is_banned: true, ban_type: 'hard', status: 200 };
    }

    if (multiResult.warned) {
      await writeAudit(user.id, null, 'create_session', 'multi_account_warned', ipHash, fpHash, {
        tg_id: tid, is_new: isNewAccount,
      });
    }
  } catch (multiErr) {
    console.warn('[CREATE_SESSION] Multi-account check error (non-fatal):', multiErr.message);
  }
  // ── Revoke old sessions + create new (atomic) ─────────────────
  let sessionId;
  try {
    await sql(`UPDATE sessions SET is_revoked=TRUE WHERE user_id=$1`, [user.id]);
    sessionId = genRawNonce(32);
    const exp = new Date(Date.now() + CFG.SESSION_TTL_MS).toISOString();
    await sql(
      `INSERT INTO sessions(id, user_id, fingerprint_hash, ip_hash, expires_at)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(id) DO NOTHING`,
      [sessionId, user.id, fpHash, ipHash, exp]
    );
    console.info(`[CREATE_SESSION] Session created for userId=${user.id} tgId=${tid} isNew=${isNewAccount}`);
  } catch (sessionErr) {
    console.error('[CREATE_SESSION] Failed to create session:', sessionErr.message);
    await writeAudit(user.id, null, 'create_session', 'session_insert_error', ipHash, fpHash, {
      error: sessionErr.message, tg_id: tid,
    });
    return { ok: false, error: 'session_creation_failed', status: 500 };
  }

  // ── Save device fingerprint ───────────────────────────────────
  const fpObj = typeof fpData === 'object' ? fpData : {};
  try {
    await sql(
      `INSERT INTO device_fingerprints(fingerprint, user_id, user_agent, lang, screen, timezone_off)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(fingerprint, user_id) DO UPDATE SET last_seen=NOW()`,
      [fpHash, user.id,
       fpObj.user_agent || null, fpObj.lang || null,
       fpObj.screen || null, parseInt(fpObj.tz_offset) || 0]
    );
  } catch (fpErr) {
    // Non-fatal — session still valid
    console.warn('[CREATE_SESSION] FP save error (non-fatal):', fpErr.message);
  }
  await writeAudit(user.id, sessionId, 'create_session', 'ok', ipHash, fpHash, {
    tg_id: tid, is_new_account: isNewAccount,
  });

  try { await syncLevel(user.id); } catch (lvlErr) {
    console.warn('[CREATE_SESSION] syncLevel error (non-fatal):', lvlErr.message);
  }

  // ── Try to activate pending referral for this user ────────────
  try {
    if (await isReferralActive(user.id)) {
      await activatePendingReferral(user.id);
    }
  } catch (refErr) {
    console.warn('[CREATE_SESSION] Referral activation error (non-fatal):', refErr.message);
  }
  const finalUser = (await sql(`SELECT * FROM users WHERE id=$1`, [user.id]))[0];

  return {
    ok: true,
    _sid: sessionId,
    user: {
      points:              parseInt(finalUser.points) || 0,
      level:               parseInt(finalUser.level) || 1,
      xp:                  parseInt(finalUser.xp) || 0,
      tg_verified:         finalUser.tg_verified,
      streak_day:          finalUser.streak_day,
      last_gift_date:      finalUser.last_gift_date,
      total_referrals:     finalUser.total_referrals,
      earned_from_refs:    parseInt(finalUser.earned_from_refs) || 0,
      first_withdraw_done: !!finalUser.first_withdraw_done,
    },
  };
}

// ── Activate referral reward when referred user becomes active ────
async function activatePendingReferral(referredUserId) {
  const pendingRef = (await sql(
    `SELECT id, referrer_id FROM referrals
     WHERE referred_id=$1 AND activated=FALSE
     LIMIT 1`,
    [referredUserId]
  ))[0];

  if (!pendingRef) return;

  // Atomic activate — prevent duplicate
  const activated = await sql(
    `UPDATE referrals
     SET activated=TRUE, activated_at=NOW(), points_given=$1
     WHERE id=$2 AND activated=FALSE
     RETURNING id`,
    [CONFIG.rewards.referral, pendingRef.id]
  );

  if (!activated.length) return; // race condition — already done

  // Give reward to referrer
  await sql(
    `UPDATE users
     SET points=points+$1, xp=xp+$1,
         total_referrals=total_referrals+1,
         earned_from_refs=earned_from_refs+$1,
         updated_at=NOW()
     WHERE id=$2`,
    [CONFIG.rewards.referral, pendingRef.referrer_id]
  );

  await syncLevel(pendingRef.referrer_id);

  // Check daily referral mission (3 referrals today)
  const todayRefs = (await sql(
    `SELECT COUNT(*) AS cnt FROM referrals
     WHERE referrer_id=$1
       AND activated=TRUE
       AND DATE(activated_at)=CURRENT_DATE`,
    [pendingRef.referrer_id]
  ))[0];

  if ((parseInt(todayRefs?.cnt) || 0) >= 3) {
    // Check not already claimed
    const alreadyClaimed = (await sql(
      `SELECT id FROM user_tasks
       WHERE user_id=$1 AND task_type='daily_refs_3' AND task_date=CURRENT_DATE AND reward_claimed=TRUE`,
      [pendingRef.referrer_id]
    )).length > 0;

    if (!alreadyClaimed) {
      await sql(
        `INSERT INTO user_tasks(user_id, task_type, completed, completed_at, task_date, reward_claimed)
         VALUES($1,'daily_refs_3',TRUE,NOW(),CURRENT_DATE,FALSE)
         ON CONFLICT(user_id, task_type, task_date) DO UPDATE
         SET completed=TRUE, completed_at=NOW()`,
        [pendingRef.referrer_id]
      );
    }
  }

  await writeAudit(pendingRef.referrer_id, null, 'referral_activated', 'ok', null, null, {
    referred_id: referredUserId, reward: CONFIG.rewards.referral,
  });
  console.info(`[REFERRAL] Activated — referrer=${pendingRef.referrer_id} referred=${referredUserId} reward=${CONFIG.rewards.referral}`);
}


// ═══════════════════════════════════════════════════════════════════
// LOAD — Full user data
// ═══════════════════════════════════════════════════════════════════
async function handleLoad(userId) {
  const rows = await sql(`SELECT * FROM users WHERE id=$1`, [userId]);
  if (!rows.length) return { ok: false, error: 'user_not_found' };
  const u = rows[0];

  const adR = await sql(`SELECT count,points_earned FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`, [userId]);
  const ad  = adR[0] || { count: 0, points_earned: 0 };
  const watched = parseInt(ad.count) || 0;

  const wR = await sql(`SELECT pts,address,method,status,created_at FROM withdrawals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [userId]);
  const rR = await sql(`SELECT u.tg_first_name,u.tg_username,u.created_at FROM referrals r JOIN users u ON u.id=r.referred_id WHERE r.referrer_id=$1 ORDER BY r.created_at DESC LIMIT 10`, [userId]);
  const tR = await sql(`SELECT task_type, reward_claimed FROM user_tasks WHERE user_id=$1 AND task_date=CURRENT_DATE AND completed=TRUE`, [userId]);

  // ── Adsgram state from DB ─────────────────────────────────────
  const adsgramState = buildAdsgramState(u);

  // ── Withdraw info based on first_withdraw_done ────────────────
  const firstWithdrawDone = !!u.first_withdraw_done;
  const withdrawInfo = firstWithdrawDone
    ? { withdraw_min: CONFIG.withdraw.normal_min, withdraw_level: CONFIG.withdraw.normal_level, first_withdraw_offer: false }
    : { withdraw_min: CONFIG.withdraw.first_min,  withdraw_level: 0,                            first_withdraw_offer: true };

  return {
    ok: true,
    points:       parseInt(u.points) || 0,
    level:        parseInt(u.level)  || 1,
    xp:           parseInt(u.xp)    || 0,
    usdt_balance: parseFloat(u.usdt_balance) || 0,
    tg_verified:  u.tg_verified,
    streak_day:   u.streak_day,
    last_gift_date: u.last_gift_date,
    tg_id:        u.tg_id,
    ads_total:         CFG.ADS_DAILY_LIMIT,
    ads_remaining:     Math.max(0, CFG.ADS_DAILY_LIMIT - watched),
    ads_watched_today: watched,
    earned_today:      parseInt(ad.points_earned) || 0,
    ads_watched_total: parseInt(u.ads_watched_total) || 0,
    total_referrals:   u.total_referrals,
    earned_from_refs:  parseInt(u.earned_from_refs) || 0,
    first_withdraw_done: firstWithdrawDone,
    withdraw_info: withdrawInfo,
    adsgram_task: adsgramState,
    withdrawals: wR.map(w => ({
      pts: parseInt(w.pts) || 0, address: w.address,
      method: w.method, status: w.status, ts: new Date(w.created_at).getTime(),
    })),
    referral_list: rR.map(r => ({
      name: r.tg_first_name || r.tg_username || 'مستخدم',
      ts: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
    })),
    completed_tasks: tR.map(r => ({
      task_type: r.task_type,
      reward_claimed: !!r.reward_claimed,
    })),
    config: handleGetConfig(),
  };
}

// ── Build Adsgram state from user DB row ──────────────────────────
function buildAdsgramState(u) {
  const now = Date.now();
  let status = u.adsgram_status || 'ready';

  // If watching and cooldown has passed — status = claim or ready
  if (status === 'watching' && u.adsgram_expires_at) {
    const expiresAt = new Date(u.adsgram_expires_at).getTime();
    if (now >= expiresAt) {
      status = u.adsgram_completed ? 'claim' : 'ready';
    }
  }

  // If claimed recently (60s ago), it's completed
  if (u.adsgram_claimed && u.adsgram_last_claimed_at) {
    const claimedAt = new Date(u.adsgram_last_claimed_at).getTime();
    const elapsed = now - claimedAt;
    if (elapsed < CFG.ADSGRAM_TASK_COOLDOWN_MS) {
      status = 'cooldown';
    } else {
      status = 'ready';  // cooldown over — can watch again
    }
  }

  const remaining = (status === 'watching' && u.adsgram_expires_at)
    ? Math.max(0, Math.ceil((new Date(u.adsgram_expires_at).getTime() - now) / 1000))
    : (status === 'cooldown' && u.adsgram_last_claimed_at)
    ? Math.max(0, Math.ceil((CFG.ADSGRAM_TASK_COOLDOWN_MS - (now - new Date(u.adsgram_last_claimed_at).getTime())) / 1000))
    : 0;

  return {
    status,
    remaining_seconds: remaining,
    reward: CONFIG.rewards.adsgram_task,
    claimed: !!u.adsgram_claimed,
  };
}

// ═══════════════════════════════════════════════════════════════════
// GET STATE — lightweight polling
// ═══════════════════════════════════════════════════════════════════
async function handleGetState(userId) {
  const r = await sql(`SELECT points,level,xp,total_referrals,earned_from_refs,ad_last_reward,
    adsgram_status,adsgram_started_at,adsgram_expires_at,adsgram_completed,adsgram_claimed,adsgram_last_claimed_at
    FROM users WHERE id=$1`, [userId]);
  if (!r.length) return { ok: false, error: 'user_not_found' };
  const u  = r[0];
  const ad = (await sql(`SELECT count,points_earned FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`, [userId]))[0] || { count: 0, points_earned: 0 };

  let ad_cooldown_ms = 0;
  if (u.ad_last_reward) {
    const elapsed = Date.now() - new Date(u.ad_last_reward).getTime();
    ad_cooldown_ms = Math.max(0, CFG.AD_COOLDOWN_MS - elapsed);
  }

  return {
    ok: true,
    points:        parseInt(u.points) || 0,
    level:         parseInt(u.level)  || 1,
    xp:            parseInt(u.xp)    || 0,
    total_referrals:  u.total_referrals,
    earned_from_refs: parseInt(u.earned_from_refs) || 0,
    ads_watched_today: parseInt(ad.count) || 0,
    ads_remaining:     Math.max(0, CFG.ADS_DAILY_LIMIT - (parseInt(ad.count) || 0)),
    earned_today:      parseInt(ad.points_earned) || 0,
    ad_cooldown_ms,
    ads_daily_limit: CFG.ADS_DAILY_LIMIT,
    adsgram_task: buildAdsgramState(u),
  };
}


// ═══════════════════════════════════════════════════════════════════
// START AD + REWARD AD
// ═══════════════════════════════════════════════════════════════════
async function handleStartAd(userId, sessionId, ipHash, fpHash) {
  const adR = await sql(
    `SELECT count FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`,
    [userId]
  );
  if ((parseInt(adR[0]?.count) || 0) >= CFG.ADS_DAILY_LIMIT) {
    return { ok: false, error: 'daily_limit_reached' };
  }
  const coolRow = (await sql(`SELECT ad_last_reward FROM users WHERE id=$1`, [userId]))[0];
  if (coolRow?.ad_last_reward) {
    const elapsed = Date.now() - new Date(coolRow.ad_last_reward).getTime();
    if (elapsed < CFG.AD_COOLDOWN_MS) {
      return { ok: false, error: 'cooldown_active', wait_ms: CFG.AD_COOLDOWN_MS - elapsed };
    }
  }
  const nonce = await issueAdNonce(sessionId);
  if (!nonce) return { ok: false, error: 'session_invalid' };
  await writeAudit(userId, sessionId, 'start_ad', 'ok', ipHash, fpHash, {});
  return { ok: true, ad_nonce: nonce };
}

async function handleRewardAd(userId, sessionId, ipHash, fpHash, body, rawNonce) {
  const clientStartedAt = parseInt(body?.data?.ad_started_at) || 0;

  // [1] Nonce verification
  const nonceResult = await consumeAdNonce(sessionId, rawNonce, userId, ipHash, fpHash);
  if (nonceResult !== 'ok') {
    logRewardBlock(`nonce_${nonceResult}`, userId, {});
    return { ok: false, error: `nonce_${nonceResult}` };
  }

  // [2] Shadow ban check — honest response
  const uR = await sql(`SELECT is_shadow_banned FROM users WHERE id=$1`, [userId]);
  if (uR[0]?.is_shadow_banned) {
    logShadow('reward_ad_blocked', userId, {});
    logRewardBlock('shadow_ban', userId, {});
    return { ok: false, error: 'account_review' };
  }

  // [3] Daily limit
  const adR = await sql(`SELECT count FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`, [userId]);
  const watchedToday = parseInt(adR[0]?.count) || 0;
  if (watchedToday >= CFG.ADS_DAILY_LIMIT) {
    logRewardBlock('daily_limit', userId, { watched: watchedToday });
    return { ok: false, error: 'daily_limit_reached' };
  }

  // [4] Cooldown check
  const coolRow = (await sql(`SELECT ad_last_reward FROM users WHERE id=$1`, [userId]))[0];
  if (coolRow?.ad_last_reward) {
    const elapsed = Date.now() - new Date(coolRow.ad_last_reward).getTime();
    if (elapsed < CFG.AD_COOLDOWN_MS) {
      const waitMs = CFG.AD_COOLDOWN_MS - elapsed;
      logRewardBlock('cooldown_active', userId, { wait_ms: waitMs });
      return { ok: false, error: 'cooldown_active', wait_ms: waitMs };
    }
  }

  // [5] Client-side timing check
  if (clientStartedAt > 0) {
    const clientElapsed = Date.now() - clientStartedAt;
    if (clientElapsed < CFG.AD_MIN_DURATION_MS) {
      await addRisk(userId, 'ad_too_fast_client', ipHash, fpHash, 10);
      logRewardBlock('timing_invalid', userId, { elapsed_ms: clientElapsed });
      return { ok: false, error: 'ad_duration_invalid' };
    }
  }

  // [6] Replay detection
  const recentReward = await sql(
    `SELECT id FROM audit_log
     WHERE user_id=$1 AND action='reward_ad' AND status='ok'
       AND created_at > NOW() - INTERVAL '25 seconds'
     LIMIT 1`,
    [userId]
  );
  if (recentReward.length) {
    await addRisk(userId, 'reward_ad_replay', ipHash, fpHash, 15);
    logRewardBlock('replay_detected', userId, {});
    return { ok: false, error: 'cooldown_active', wait_ms: CFG.AD_COOLDOWN_MS };
  }

  // [7] Atomic reward — INSERT ... ON CONFLICT with count check
  const lr = await sql(
    `INSERT INTO ad_logs(user_id, log_date, count, points_earned)
     VALUES($1, CURRENT_DATE, 1, $2)
     ON CONFLICT(user_id, log_date) DO UPDATE SET
       count         = CASE WHEN ad_logs.count < $3 THEN ad_logs.count + 1         ELSE ad_logs.count         END,
       points_earned = CASE WHEN ad_logs.count < $3 THEN ad_logs.points_earned + $2 ELSE ad_logs.points_earned END,
       updated_at    = NOW()
     RETURNING count, points_earned`,
    [userId, CFG.POINTS_PER_AD, CFG.ADS_DAILY_LIMIT]
  );
  const watched = parseInt(lr[0].count) || 0;

  await sql(
    `UPDATE users
     SET points=points+$1, xp=xp+$1,
         ads_watched_total=ads_watched_total+1,
         ad_last_reward=NOW(),
         updated_at=NOW()
     WHERE id=$2`,
    [CFG.POINTS_PER_AD, userId]
  );

  await syncLevel(userId);

  // ── Daily missions completion ──────────────────────────────────
  if (watched >= 10) await upsertTask(userId, 'ads_10');
  if (watched >= 25) await upsertTask(userId, 'ads_25');

  // ── Activate pending referral if user just became active ──────
  if (watched >= CONFIG.referral.min_active_ads) {
    try { await activatePendingReferral(userId); } catch (_) {}
  }

  await writeAudit(userId, sessionId, 'reward_ad', 'ok', ipHash, fpHash, {
    watched, points_earned: CFG.POINTS_PER_AD,
  });

  const ur = await sql(`SELECT points FROM users WHERE id=$1`, [userId]);
  return {
    ok:           true,
    remaining:    Math.max(0, CFG.ADS_DAILY_LIMIT - watched),
    watchedToday: watched,
    earnedToday:  parseInt(lr[0].points_earned) || 0,
    earned:       CONFIG.rewards.ad_watch,
    points:       parseInt(ur[0]?.points) || 0,
    all_done:     watched >= CFG.ADS_DAILY_LIMIT,
    cooldown_ms:  CFG.AD_COOLDOWN_MS,
  };
}


// ═══════════════════════════════════════════════════════════════════
// ADSGRAM TASK — DB-Persistent State
// States: ready → watching → (cooldown expires) → claim → completed
// ═══════════════════════════════════════════════════════════════════

async function handleStartAdsgramTask(userId, sessionId, ipHash, fpHash) {
  const u = (await sql(
    `SELECT adsgram_status, adsgram_claimed, adsgram_last_claimed_at, adsgram_expires_at FROM users WHERE id=$1`,
    [userId]
  ))[0];

  if (!u) return { ok: false, error: 'user_not_found' };

  const now = Date.now();

  // If already in watching state and timer still active → return current state (idempotent)
  if (u.adsgram_status === 'watching' && u.adsgram_expires_at) {
    const expiresAt = new Date(u.adsgram_expires_at).getTime();
    if (now < expiresAt) {
      const remaining = Math.ceil((expiresAt - now) / 1000);
      logAdsgramState(userId, 'already_watching', { remaining });
      // أصدر task_nonce حتى لو already_watching — الكليانت يحتاجه للـ claim
      const alreadyTaskNonce = await issueNonce(sessionId, userId, ipHash, fpHash, 'claim_adsgram_task');
      return {
        ok: true,
        already_watching: true,
        task_nonce: alreadyTaskNonce,
        adsgram_task: {
          status: 'watching',
          remaining_seconds: remaining,
          reward: CONFIG.rewards.adsgram_task,
          claimed: false,
        },
      };
    }
  }

  // Check cooldown from last claim
  if (u.adsgram_claimed && u.adsgram_last_claimed_at) {
    const elapsed = now - new Date(u.adsgram_last_claimed_at).getTime();
    if (elapsed < CFG.ADSGRAM_TASK_COOLDOWN_MS) {
      const waitMs = CFG.ADSGRAM_TASK_COOLDOWN_MS - elapsed;
      return {
        ok: false,
        error: 'cooldown_active',
        wait_ms: waitMs,
        adsgram_task: buildAdsgramState(u),
      };
    }
  }

  const nowDate = new Date();
  const expiresAt = new Date(nowDate.getTime() + CFG.ADSGRAM_TASK_MIN_WATCH_MS);

  // Set state to watching — DB persistent
  await sql(
    `UPDATE users
     SET adsgram_status='watching',
         adsgram_started_at=$1,
         adsgram_expires_at=$2,
         adsgram_completed=FALSE,
         adsgram_claimed=FALSE,
         updated_at=NOW()
     WHERE id=$3`,
    [nowDate.toISOString(), expiresAt.toISOString(), userId]
  );

  // Also update session for backward compat
  await sql(`UPDATE sessions SET adsgram_task_started_at=NOW() WHERE id=$1`, [sessionId]);

  await writeAudit(userId, sessionId, 'start_adsgram_task', 'ok', ipHash, fpHash, {
    expires_at: expiresAt.toISOString(),
  });

  logAdsgramState(userId, 'watching', { expires_at: expiresAt.toISOString() });

  // أصدر task_nonce — يُستخدم في claim_adsgram_task كـ X-Nonce
  const taskNonce = await issueNonce(sessionId, userId, ipHash, fpHash, 'claim_adsgram_task');

  return {
    ok: true,
    task_nonce: taskNonce,
    adsgram_task: {
      status: 'watching',
      remaining_seconds: Math.ceil(CFG.ADSGRAM_TASK_MIN_WATCH_MS / 1000),
      reward: CONFIG.rewards.adsgram_task,
      claimed: false,
    },
  };
}

async function handleClaimAdsgramTask(userId, sessionId, ipHash, fpHash, rawNonce) {
  // استهلك task_nonce أولاً
  if (!rawNonce) return { ok: false, error: 'nonce_missing' };
  const nonceResult = await consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, 'claim_adsgram_task');
  if (nonceResult !== 'ok') return { ok: false, error: nonceResult };

  // ── Fetch current state from DB (source of truth) ─────────────
  const u = (await sql(
    `SELECT adsgram_status, adsgram_started_at, adsgram_expires_at,
            adsgram_completed, adsgram_claimed, adsgram_last_claimed_at,
            is_shadow_banned
     FROM users WHERE id=$1`,
    [userId]
  ))[0];

  if (!u) return { ok: false, error: 'user_not_found' };

  const now = Date.now();

  // [1] Check if task was started
  if (!u.adsgram_started_at) {
    logRewardBlock('adsgram_not_started', userId, {});
    await writeAudit(userId, sessionId, 'claim_adsgram_task', 'not_started', ipHash, fpHash, {
      adsgram_state: 'no_started_at',
    });
    return { ok: false, error: 'task_not_started' };
  }

  // [2] Check minimum watch time
  const startedAt = new Date(u.adsgram_started_at).getTime();
  const elapsed   = now - startedAt;
  if (elapsed < CFG.ADSGRAM_TASK_MIN_WATCH_MS) {
    const wait = CFG.ADSGRAM_TASK_MIN_WATCH_MS - elapsed;
    await addRisk(userId, 'adsgram_task_too_fast', ipHash, fpHash, 15);
    logRewardBlock('adsgram_too_fast', userId, { elapsed_ms: elapsed, wait_ms: wait });
    await writeAudit(userId, sessionId, 'claim_adsgram_task', 'too_fast', ipHash, fpHash, {
      elapsed_ms: elapsed, min_ms: CFG.ADSGRAM_TASK_MIN_WATCH_MS,
      adsgram_state: 'too_fast',
    });
    return { ok: false, error: 'task_too_fast', wait_ms: wait };
  }

  // [3] Check cooldown from last claim
  if (u.adsgram_last_claimed_at) {
    const lastClaimed = new Date(u.adsgram_last_claimed_at).getTime();
    const cooldownElapsed = now - lastClaimed;
    if (cooldownElapsed < CFG.ADSGRAM_TASK_COOLDOWN_MS) {
      const waitMs = CFG.ADSGRAM_TASK_COOLDOWN_MS - cooldownElapsed;
      logRewardBlock('adsgram_cooldown', userId, { wait_ms: waitMs });
      await writeAudit(userId, sessionId, 'claim_adsgram_task', 'cooldown', ipHash, fpHash, {
        wait_ms: waitMs, adsgram_state: 'cooldown',
      });
      return { ok: false, error: 'cooldown_active', wait_ms: waitMs };
    }
  }

  // [4] Shadow ban — honest response
  if (u.is_shadow_banned) {
    logShadow('adsgram_claim_blocked', userId, {});
    logRewardBlock('shadow_ban', userId, {});
    return { ok: false, error: 'account_review' };
  }

  // [5] Atomic reward — mark as claimed first (prevent race)
  const marked = await sql(
    `UPDATE users
     SET adsgram_status='completed',
         adsgram_completed=TRUE,
         adsgram_claimed=TRUE,
         adsgram_last_claimed_at=NOW(),
         updated_at=NOW()
     WHERE id=$1
       AND (adsgram_claimed=FALSE OR adsgram_last_claimed_at < NOW() - INTERVAL '60 seconds')
     RETURNING id`,
    [userId]
  );

  if (!marked.length) {
    logRewardBlock('adsgram_duplicate_claim', userId, {});
    return { ok: false, error: 'already_claimed_today' };
  }

  // [6] Give points
  await sql(
    `UPDATE users SET points=points+$1, xp=xp+$1, updated_at=NOW() WHERE id=$2`,
    [CFG.ADSGRAM_TASK_POINTS, userId]
  );
  await sql(
    `INSERT INTO completed_tasks(user_id, task_key, completed_at)
     VALUES($1, 'adsgram_task_daily', NOW())
     ON CONFLICT DO NOTHING`,
    [userId]
  );

  await syncLevel(userId);
  await writeAudit(userId, sessionId, 'claim_adsgram_task', 'ok', ipHash, fpHash, {
    points: CFG.ADSGRAM_TASK_POINTS, adsgram_state: 'completed',
  });

  logAdsgramState(userId, 'completed', { reward: CFG.ADSGRAM_TASK_POINTS });

  const ur = await sql(`SELECT points FROM users WHERE id=$1`, [userId]);
  const freshU = ur[0];
  return {
    ok: true,
    points: parseInt(freshU?.points) || 0,
    earned: CFG.ADSGRAM_TASK_POINTS,
    adsgram_task: {
      status: 'completed',
      remaining_seconds: 0,
      reward: CONFIG.rewards.adsgram_task,
      claimed: true,
    },
  };
}


// ═══════════════════════════════════════════════════════════════════
// CLAIM DAILY MISSION REWARD
// ═══════════════════════════════════════════════════════════════════
async function handleClaimDailyMission(userId, body, rawNonce, sessionId, fpHash, ipHash) {
  const taskType = body?.data?.task_type || '';
  const allowedMissions = {
    'ads_10':       CONFIG.rewards.daily_ads_10,
    'ads_25':       CONFIG.rewards.daily_ads_25,
    'daily_refs_3': CONFIG.rewards.daily_referrals_3,
  };

  if (!allowedMissions[taskType]) {
    return { ok: false, error: 'invalid_task_type' };
  }

  const result = await consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, 'claim_daily_mission');
  if (result !== 'ok') return { ok: false, error: result };

  // Check shadow ban — honest
  const uCheck = (await sql(`SELECT is_shadow_banned FROM users WHERE id=$1`, [userId]))[0];
  if (uCheck?.is_shadow_banned) {
    logShadow('daily_mission_blocked', userId, { task_type: taskType });
    return { ok: false, error: 'account_review' };
  }

  // Atomic: mark as claimed + give reward
  const taskRow = await sql(
    `UPDATE user_tasks
     SET reward_claimed=TRUE
     WHERE user_id=$1
       AND task_type=$2
       AND task_date=CURRENT_DATE
       AND completed=TRUE
       AND reward_claimed=FALSE
     RETURNING id`,
    [userId, taskType]
  );

  if (!taskRow.length) {
    logRewardBlock('daily_mission_not_completed_or_already_claimed', userId, { task_type: taskType });
    return { ok: false, error: 'task_not_completed_or_already_claimed' };
  }

  const reward = allowedMissions[taskType];
  await sql(
    `UPDATE users SET points=points+$1, xp=xp+$1, updated_at=NOW() WHERE id=$2`,
    [reward, userId]
  );
  await syncLevel(userId);
  await writeAudit(userId, sessionId, 'claim_daily_mission', 'ok', ipHash, fpHash, {
    task_type: taskType, reward,
  });

  const ur = (await sql(`SELECT points FROM users WHERE id=$1`, [userId]))[0];
  return { ok: true, reward, points: parseInt(ur?.points) || 0, task_type: taskType };
}


// ═══════════════════════════════════════════════════════════════════
// CLAIM GIFT — Daily Streak (server-side CURRENT_DATE)
// ═══════════════════════════════════════════════════════════════════
async function handleClaimGift(userId, rawNonce, sessionId, fpHash, ipHash) {
  const result = await consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, 'claim_gift');
  if (result !== 'ok') return { ok: false, error: result };

  // Use CURRENT_DATE from database to prevent timezone exploits
  const r = await sql(
    `SELECT last_gift_date, streak_day,
            CURRENT_DATE AS today,
            (CURRENT_DATE - INTERVAL '1 day')::date AS yesterday
     FROM users WHERE id=$1`,
    [userId]
  );
  const u = r[0];
  if (!u) return { ok: false, error: 'user_not_found' };

  const today     = String(u.today).slice(0, 10);
  const yesterday = String(u.yesterday).slice(0, 10);
  const last      = u.last_gift_date ? String(u.last_gift_date).slice(0, 10) : '';

  if (last === today) return { ok: false, error: 'already_claimed_today' };

  const newStreak = last === yesterday ? (parseInt(u.streak_day) || 0) + 1 : 1;
  const reward    = giftReward(newStreak);

  // Atomic update — prevents double claim via idempotent condition
  const updated = await sql(
    `UPDATE users
     SET points=points+$1, xp=xp+$1, streak_day=$2,
         last_gift_date=CURRENT_DATE, updated_at=NOW()
     WHERE id=$3 AND (last_gift_date IS NULL OR last_gift_date < CURRENT_DATE)
     RETURNING points, level`,
    [reward, newStreak, userId]
  );

  if (!updated.length) return { ok: false, error: 'already_claimed_today' };

  await syncLevel(userId);
  const fresh = (await sql(`SELECT points, level FROM users WHERE id=$1`, [userId]))[0];
  await writeAudit(userId, sessionId, 'claim_gift', 'ok', ipHash, fpHash, { reward, streak: newStreak });
  return { ok: true, reward, streak_day: newStreak, points: parseInt(fresh?.points) || 0, level: fresh?.level };
}


// ═══════════════════════════════════════════════════════════════════
// GET CHANNELS — Dynamic channel list from DB
// ═══════════════════════════════════════════════════════════════════
async function handleGetChannels(userId) {
  const channels = await sql(
    `SELECT id, title, url, reward, max_members FROM channels
     WHERE is_active=TRUE ORDER BY sort_order ASC, id ASC`
  );

  // Check which channels this user has already verified
  const verified = await sql(
    `SELECT task_type FROM user_tasks
     WHERE user_id=$1 AND completed=TRUE
       AND task_type LIKE 'channel_%'`,
    [userId]
  );
  const verifiedSet = new Set(verified.map(r => r.task_type));

  return {
    ok: true,
    channels: channels.map(c => ({
      id:          c.id,
      title:       c.title,
      url:         c.url,
      reward:      c.reward,
      max_members: parseInt(c.max_members) || 0,
      verified:    verifiedSet.has('channel_' + c.id),
    })),
  };
}


// ═══════════════════════════════════════════════════════════════════
// VERIFY CHANNEL TASK — verify membership for a specific channel
// ═══════════════════════════════════════════════════════════════════
async function handleVerifyChannelTask(userId, body, rawNonce, sessionId, fpHash, ipHash) {
  const channelId = parseInt(body?.data?.channel_id);
  if (!channelId) return { ok: false, error: 'missing_channel_id' };

  // ✅ action مطابق للـ get_nonce الذي يرسله الكليانت: 'verify_channel_task'
  // كان 'verify_tg_task' خطأ → يسبب nonce_action_mismatch → 500
  const result = await consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, 'verify_channel_task');
  if (result !== 'ok') return { ok: false, error: result };

  const uCheck = (await sql(
    `SELECT is_shadow_banned, tg_id FROM users WHERE id=$1`,
    [userId]
  ))[0];
  if (!uCheck) return { ok: false, error: 'user_not_found' };
  if (uCheck.is_shadow_banned) {
    logShadow('channel_task_blocked', userId, {});
    return { ok: false, error: 'account_review' };
  }

  const taskKey = 'channel_' + channelId;

  // Already verified?
  const existing = (await sql(
    `SELECT id FROM user_tasks
     WHERE user_id=$1 AND task_type=$2 AND completed=TRUE`,
    [userId, taskKey]
  ));
  if (existing.length) return { ok: false, error: 'already_verified' };

  // Get channel info
  const ch = (await sql(`SELECT url, reward FROM channels WHERE id=$1 AND is_active=TRUE`, [channelId]))[0];
  if (!ch) return { ok: false, error: 'channel_not_found' };

  // Telegram membership check — extract username from URL
  const telegramId = uCheck.tg_id;
  if (telegramId && !IS_DEV && BOT_TOKEN && CHANNEL_ID) {
    // Use global CHANNEL_ID for now; can be extended per-channel
    const membership = await checkTelegramMembership(telegramId);
    if (!membership.ok && !membership.skipped) {
      return { ok: false, error: 'not_in_channel' };
    }
  }

  const reward = parseInt(ch.reward) || 2500;

  await sql(
    `UPDATE users SET points=points+$1, xp=xp+$1, updated_at=NOW() WHERE id=$2`,
    [reward, userId]
  );
  await upsertTask(userId, taskKey);
  await syncLevel(userId);

  const fresh = (await sql(`SELECT points FROM users WHERE id=$1`, [userId]))[0];
  await writeAudit(userId, sessionId, 'verify_channel_task', 'ok', ipHash, fpHash, {
    channel_id: channelId, reward,
  });

  return { ok: true, reward, points: parseInt(fresh?.points) || 0 };
}


// ═══════════════════════════════════════════════════════════════════
// VERIFY TG TASK
// ═══════════════════════════════════════════════════════════════════
async function handleVerifyTgTask(userId, rawNonce, sessionId, fpHash, ipHash) {
  const result = await consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, 'verify_tg_task');
  if (result !== 'ok') return { ok: false, error: result };

  const uCheck = (await sql(`SELECT is_shadow_banned, tg_id, tg_verified FROM users WHERE id=$1`, [userId]))[0];
  if (!uCheck) return { ok: false, error: 'user_not_found' };
  if (uCheck.is_shadow_banned) {
    logShadow('tg_task_blocked', userId, {});
    return { ok: false, error: 'account_review' };
  }
  if (uCheck.tg_verified) return { ok: false, error: 'already_verified' };

  // ── فحص العضوية الفعلي عبر Bot API ─────────────────────────────
  const telegramId = uCheck.tg_id;
  if (telegramId && !IS_DEV) {
    const membership = await checkTelegramMembership(telegramId);
    if (!membership.ok && !membership.skipped) {
      console.warn(`[VERIFY_TG] user ${userId} not in channel — status: ${membership.status}`);
      return { ok: false, error: 'not_in_channel' };
    }
  }

  const reward = CONFIG.rewards.telegram_task;
  const tgUpdateRes = await sql(
    `UPDATE users SET tg_verified=TRUE, points=points+$1, xp=xp+$1, updated_at=NOW()
     WHERE id=$2 AND tg_verified=FALSE
     RETURNING id`,
    [reward, userId]
  );
  if (!tgUpdateRes.length) return { ok: false, error: 'already_verified' };
  await syncLevel(userId);
  await upsertTask(userId, 'tg_join');
  const fresh = (await sql(`SELECT points, level FROM users WHERE id=$1`, [userId]))[0];
  await writeAudit(userId, sessionId, 'verify_tg_task', 'ok', ipHash, fpHash, { reward });
  return { ok: true, reward, points: parseInt(fresh?.points) || 0, level: fresh?.level };
}


// ═══════════════════════════════════════════════════════════════════
// SUBMIT WITHDRAW — First Withdraw System
// ═══════════════════════════════════════════════════════════════════
async function handleSubmitWithdraw(userId, body, rawNonce, sessionId, fpHash, ipHash) {
  const result = await consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, 'submit_withdraw');
  if (result !== 'ok') return { ok: false, error: result };

  const address = (body?.data?.address || '').trim();
  if (!isValidTon(address)) return { ok: false, error: 'invalid_address' };

  const r = await sql(`SELECT points, level, first_withdraw_done FROM users WHERE id=$1`, [userId]);
  if (!r.length) return { ok: false, error: 'user_not_found' };

  const pts   = parseInt(r[0].points) || 0;
  const level = parseInt(r[0].level)  || 1;
  const firstDone = !!r[0].first_withdraw_done;

  // Determine requirements based on first withdraw status
  if (!firstDone) {
    // First withdraw — lower threshold, no level requirement
    if (pts < CONFIG.withdraw.first_min) {
      return {
        ok: false,
        error: 'insufficient_balance',
        required: CONFIG.withdraw.first_min,
        have: pts,
        first_withdraw_offer: true,
      };
    }
  } else {
    // Normal withdraw — full requirements
    if (level < CONFIG.withdraw.normal_level) {
      return { ok: false, error: 'level_too_low', required_level: CONFIG.withdraw.normal_level };
    }
    if (pts < CONFIG.withdraw.normal_min) {
      return { ok: false, error: 'insufficient_balance', required: CONFIG.withdraw.normal_min, have: pts };
    }
  }

  const ton = parseFloat((pts / CFG.PTS_PER_TON).toFixed(6));
  await sql(`UPDATE users SET points=points-$1, updated_at=NOW() WHERE id=$2`, [pts, userId]);
  const wr = await sql(
    `INSERT INTO withdrawals(user_id, pts, ton_amount, address, method, status) VALUES($1,$2,$3,$4,'ton','pending') RETURNING id`,
    [userId, pts, ton, address]
  );

  // Mark first withdraw as done
  if (!firstDone) {
    await sql(`UPDATE users SET first_withdraw_done=TRUE, updated_at=NOW() WHERE id=$1`, [userId]);
  }

  const nb = (await sql(`SELECT points FROM users WHERE id=$1`, [userId]))[0];
  await writeAudit(userId, sessionId, 'submit_withdraw', 'ok', ipHash, fpHash, {
    pts, ton, first_withdraw: !firstDone,
  });
  return {
    ok: true,
    withdraw_id:  wr[0].id,
    pts_deducted: pts,
    ton_amount:   ton,
    new_balance:  parseInt(nb?.points) || 0,
    status:       'pending',
    first_withdraw: !firstDone,
  };
}


// ═══════════════════════════════════════════════════════════════════
// GET REFERRALS
// ═══════════════════════════════════════════════════════════════════
async function handleGetReferrals(userId) {
  const r = (await sql(`SELECT total_referrals, earned_from_refs, tg_id FROM users WHERE id=$1`, [userId]))[0];
  const rR = await sql(
    `SELECT u.tg_first_name, u.tg_username, u.created_at, ref.activated
     FROM referrals ref
     JOIN users u ON u.id=ref.referred_id
     WHERE ref.referrer_id=$1
     ORDER BY ref.created_at DESC LIMIT 20`,
    [userId]
  );
  return {
    ok: true,
    total_referrals:  r.total_referrals,
    earned_from_refs: parseInt(r.earned_from_refs) || 0,
    pts_per_referral: CONFIG.rewards.referral,
    referral_list: rR.map(x => ({
      name:      x.tg_first_name || x.tg_username || 'مستخدم',
      ts:        new Date(x.created_at).getTime(),
      activated: !!x.activated,
    })),
    tg_id: r.tg_id,
  };
}


// ═══════════════════════════════════════════════════════════════════
// TRACK AD EVENT — no rewards, just audit + timing
// ═══════════════════════════════════════════════════════════════════
async function handleTrackAdEvent(userId, sessionId, body, ipHash, fpHash) {
  const allowed = new Set([
    'ad_requested', 'ad_loaded', 'ad_started',
    'ad_failed', 'ad_completed', 'reward_granted',
    'suspicious_activity',
  ]);
  const event   = body?.data?.event   || '';
  const ad_type = body?.data?.ad_type || 'daily_ad'; // 'adsgram_task' | 'daily_ad'
  if (!allowed.has(event)) return { ok: false, error: 'unknown_event' };

  if (event === 'ad_started' && ad_type !== 'adsgram_task') {
    await sql(`UPDATE sessions SET ad_started_at=NOW() WHERE id=$1`, [sessionId]);
  }

  // ── فصل تام: adsgram_task يُحدّث session فقط، start_adsgram_task هو المصدر الحقيقي لـ users
  if (event === 'ad_started' && ad_type === 'adsgram_task') {
    await sql(`UPDATE sessions SET adsgram_task_started_at=NOW() WHERE id=$1`, [sessionId]);
    // لا نُحدّث users هنا — start_adsgram_task يفعل ذلك قبل widget.show()
  }

  if (event === 'suspicious_activity') {
    const reason = String(body?.data?.reason || 'client_report').slice(0, 50);
    await addRisk(userId, `client_suspicious_${reason}`, ipHash, fpHash, 10);
  }

  await writeAudit(userId, sessionId, event, 'tracked', ipHash, fpHash, {
    ad_type,
    meta: body?.data?.meta || {},
  });
  return { ok: true };
}


// ═══════════════════════════════════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════════════════════════════════
async function handleAdmin(action, body) {
  if (action === 'list_withdrawals') {
    const r = await sql(
      `SELECT w.id,w.user_id,u.tg_username,u.tg_first_name,w.pts,w.ton_amount,w.address,w.status,w.created_at
       FROM withdrawals w JOIN users u ON u.id=w.user_id
       WHERE w.status=$1 ORDER BY w.created_at DESC LIMIT 100`,
      [body?.status || 'pending']
    );
    return { ok: true, withdrawals: r };
  }
  if (action === 'approve_withdrawal') {
    const id = parseInt(body?.withdraw_id);
    if (!id) return { ok: false, error: 'missing_id' };
    await sql(`UPDATE withdrawals SET status='completed', tx_hash=$1, reviewed_at=NOW() WHERE id=$2`, [body?.tx_hash || '', id]);
    return { ok: true };
  }
  if (action === 'reject_withdrawal') {
    const id = parseInt(body?.withdraw_id);
    if (!id) return { ok: false, error: 'missing_id' };
    const wr = await sql(`SELECT user_id, pts FROM withdrawals WHERE id=$1`, [id]);
    if (wr.length) await sql(`UPDATE users SET points=points+$1 WHERE id=$2`, [wr[0].pts, wr[0].user_id]);
    await sql(`UPDATE withdrawals SET status='rejected', reviewed_at=NOW() WHERE id=$1`, [id]);
    return { ok: true };
  }
  if (action === 'ban_user') {
    const tgId = parseInt(body?.tg_id);
    if (!tgId) return { ok: false, error: 'missing_tg_id' };
    await sql(`UPDATE users SET is_banned=TRUE, ban_reason=$1 WHERE tg_id=$2`, [body?.reason || 'admin_ban', tgId]);
    return { ok: true };
  }
  if (action === 'unban_user') {
    const tgId = parseInt(body?.tg_id);
    if (!tgId) return { ok: false, error: 'missing_tg_id' };
    await sql(`UPDATE users SET is_banned=FALSE, ban_reason=NULL, risk_score=0, is_shadow_banned=FALSE WHERE tg_id=$1`, [tgId]);
    return { ok: true };
  }
  if (action === 'stats') {
    const r = (await sql(`
      SELECT
        COUNT(*) AS total_users,
        COUNT(*) FILTER(WHERE created_at > NOW() - INTERVAL '1 day') AS new_today,
        SUM(points) AS total_points,
        COUNT(*) FILTER(WHERE is_banned) AS banned_users,
        COUNT(*) FILTER(WHERE is_shadow_banned) AS shadow_banned_users,
        COUNT(*) FILTER(WHERE first_withdraw_done) AS first_withdraw_done_count
      FROM users
    `))[0];
    const w = (await sql(`
      SELECT COUNT(*) AS pending_wd, COALESCE(SUM(pts),0) AS pending_pts
      FROM withdrawals WHERE status='pending'
    `))[0];
    return { ok: true, stats: { ...r, ...w } };
  }
  if (action === 'audit_log') {
    const rows = await sql(
      `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ${parseInt(body?.limit) || 100}`
    );
    return { ok: true, logs: rows };
  }
  if (action === 'risk_log') {
    const rows = await sql(
      `SELECT * FROM risk_events ORDER BY created_at DESC LIMIT ${parseInt(body?.limit) || 100}`
    );
    return { ok: true, logs: rows };
  }
  if (action === 'shadow_unban') {
    const tgId = parseInt(body?.tg_id);
    if (!tgId) return { ok: false, error: 'missing_tg_id' };
    await sql(`UPDATE users SET is_shadow_banned=FALSE, risk_score=0 WHERE tg_id=$1`, [tgId]);
    return { ok: true };
  }
  if (action === 'set_usdt') {
    const tgId = parseInt(body?.tg_id);
    const amount = parseFloat(body?.amount);
    if (!tgId) return { ok: false, error: 'missing_tg_id' };
    if (isNaN(amount) || amount < 0) return { ok: false, error: 'invalid_amount' };
    const r = await sql(
      `UPDATE users SET usdt_balance=$1, updated_at=NOW() WHERE tg_id=$2 RETURNING id, usdt_balance`,
      [amount.toFixed(6), tgId]
    );
    if (!r.length) return { ok: false, error: 'user_not_found' };
    return { ok: true, tg_id: tgId, usdt_balance: parseFloat(r[0].usdt_balance) };
  }
  if (action === 'add_usdt') {
    const tgId = parseInt(body?.tg_id);
    const amount = parseFloat(body?.amount);
    if (!tgId) return { ok: false, error: 'missing_tg_id' };
    if (isNaN(amount)) return { ok: false, error: 'invalid_amount' };
    const r = await sql(
      `UPDATE users SET usdt_balance=GREATEST(0, usdt_balance+$1), updated_at=NOW() WHERE tg_id=$2 RETURNING id, usdt_balance`,
      [amount.toFixed(6), tgId]
    );
    if (!r.length) return { ok: false, error: 'user_not_found' };
    return { ok: true, tg_id: tgId, usdt_balance: parseFloat(r[0].usdt_balance) };
  }
  return { ok: false, error: 'unknown_admin_action' };
}


// ═══════════════════════════════════════════════════════════════════
// ADSGRAM SERVER-TO-SERVER REWARD CALLBACK
// GET /api/adsgram-reward?userId=[tg_id]
// ═══════════════════════════════════════════════════════════════════
async function handleAdsgramCallback(req, res) {
  res.setHeader('Content-Type', 'text/plain');
  const rawUrl  = req.url || '';
  const qStart  = rawUrl.indexOf('?');
  const query   = qStart >= 0 ? new URLSearchParams(rawUrl.slice(qStart + 1)) : new URLSearchParams();
  const rawId   = query.get('userId') || query.get('userid') || query.get('user_id') || '';
  const tgId    = parseInt(rawId, 10);

  if (!tgId || isNaN(tgId) || tgId <= 0) {
    res.status(400).end('invalid_user');
    return;
  }
  res.status(200).end('ok');

  try {
    const ipHash = hashIp(getIp(req));
    const userRows = await sql(`SELECT id, is_shadow_banned FROM users WHERE tg_id=$1`, [tgId]);
    if (!userRows.length) {
      await writeAudit(0, 'adsgram_cb', 'adsgram_callback', 'user_not_found', ipHash, null, { tg_id: tgId });
      return;
    }
    const user   = userRows[0];
    const userId = user.id;

    if (user.is_shadow_banned) {
      await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'shadow_banned', ipHash, null, {});
      return;
    }

    const adLog = (await sql(`SELECT count FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`, [userId]))[0];
    if ((parseInt(adLog?.count) || 0) >= CFG.ADS_DAILY_LIMIT) {
      await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'daily_limit', ipHash, null, {});
      return;
    }

    const coolRow = (await sql(`SELECT ad_last_reward FROM users WHERE id=$1`, [userId]))[0];
    if (coolRow?.ad_last_reward) {
      const elapsed = Date.now() - new Date(coolRow.ad_last_reward).getTime();
      if (elapsed < CFG.AD_COOLDOWN_MS) {
        await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'cooldown', ipHash, null, { elapsed_ms: elapsed });
        return;
      }
    }

    // Replay detection
    const recentCb = await sql(
      `SELECT id FROM audit_log
       WHERE user_id=$1 AND action='adsgram_callback' AND status='ok'
         AND created_at > NOW() - INTERVAL '30 seconds'
       LIMIT 1`,
      [userId]
    );
    if (recentCb.length) {
      await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'replay', ipHash, null, {});
      return;
    }

    await sql(
      `UPDATE users SET points=points+$1, xp=xp+$1, ad_last_reward=NOW(), updated_at=NOW() WHERE id=$2`,
      [CFG.POINTS_PER_AD, userId]
    );
    await sql(
      `INSERT INTO ad_logs(user_id, log_date, count, points_earned)
       VALUES($1, CURRENT_DATE, 1, $2)
       ON CONFLICT(user_id, log_date)
       DO UPDATE SET count=ad_logs.count+1, points_earned=ad_logs.points_earned+$2`,
      [userId, CFG.POINTS_PER_AD]
    );
    await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'ok', ipHash, null, {
      tg_id: tgId, points_earned: CFG.POINTS_PER_AD,
    });
    console.info('[Adsgram CB] ✅ Reward — userId:', userId, 'tgId:', tgId);
  } catch (err) {
    console.error('[Adsgram CB] Error:', err.message);
  }
}


// ═══════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  // ── Ensure DB is bootstrapped before handling any request ─────
  if (_bootstrapPromise) { try { await _bootstrapPromise; } catch (_) {} }

  // ── GET /config — Dynamic Config ──────────────────────────────
  if (req.method === 'GET' && (req.url || '').includes('/config')) {
    res.setHeader('Access-Control-Allow-Origin', req.headers['origin'] || '*');
    res.setHeader('Cache-Control', 'no-cache');
    return res.status(200).json(handleGetConfig());
  }

  // ── Adsgram Server Callback ────────────────────────────────────
  if (req.method === 'GET' && (req.url || '').includes('adsgram-reward')) {
    return handleAdsgramCallback(req, res);
  }

  res.setHeader('Access-Control-Allow-Origin', req.headers['origin'] || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, X-Init-Data, X-Fingerprint, X-Nonce, X-Admin-Secret, X-Session-Id, X-Session-ID'
  );
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'method_not_allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { return res.status(400).json({ error: 'invalid_json' }); }
  }
  if (!body || typeof body !== 'object') body = {};

  const type = body?.type || '';
  if (!type) return res.status(400).json({ error: 'missing_type' });

  // ── Session extraction ─────────────────────────────────────────
  const cookieHeader = req.headers['cookie'] || '';
  const sidMatch     = cookieHeader.match(/(?:^|;)\s*sid=([^;]+)/);
  const sessionFromCookie = sidMatch ? decodeURIComponent(sidMatch[1]) : '';
  const sessionFromHeader = req.headers['x-session-id'] || req.headers['x-session-Id'] || '';
  const sessionId = sessionFromCookie || sessionFromHeader;

  const fpRaw    = req.headers['x-fingerprint']  || '{}';
  const rawNonce = req.headers['x-nonce']        || '';
  const adminKey = req.headers['x-admin-secret'] || '';

  const ipHash = hashIp(getIp(req));
  let fpData = {};
  try { fpData = JSON.parse(fpRaw); } catch (_) {}
  const fpHash = hashFp(fpData);

  // ── Rate limit per IP ──────────────────────────────────────────
  const isWrite = !['load', 'get_state', 'create_session', 'get_referrals', 'track_ad_event', 'start_ad'].includes(type);
  if (!rateLimit(`ip_${ipHash}_${type}`, isWrite ? CFG.RATE_WRITE_MAX : CFG.RATE_MAX)) {
    return res.status(429).json({ ok: false, error: 'rate_limited' });
  }

  try {
    // ── Admin ─────────────────────────────────────────────────────
    if (type === 'admin') {
      if (adminKey !== ADMIN_SECRET) return res.status(403).json({ ok: false, error: 'forbidden' });
      return res.status(200).json(await handleAdmin(body?.action, body));
    }

    // ── Issue Nonce (for client to use in write operations) ───────
    if (type === 'get_nonce') {
      if (!sessionId) return res.status(401).json({ ok: false, error: 'session_required' });
      const session = await validateSession(sessionId, ipHash, fpHash);
      if (!session) return res.status(401).json({ ok: false, error: 'session_invalid_or_expired' });
      const action = body?.data?.action || 'general';
      const nonce = await issueNonce(sessionId, session.user_id, ipHash, fpHash, action);
      return res.status(200).json({ ok: true, nonce });
    }

    // ── Create Session ────────────────────────────────────────────
    if (type === 'create_session') {
      const result = await handleCreateSession(body, ipHash, fpHash);
      if (result._sid) {
        const maxAge  = Math.floor(CFG.SESSION_TTL_MS / 1000);
        const isHttps = req.headers['x-forwarded-proto'] === 'https'
          || req.connection?.encrypted
          || process.env.NODE_ENV === 'production';
        const sameSite = isHttps ? 'None' : 'Lax';
        const secure   = isHttps ? '; Secure' : '';
        res.setHeader('Set-Cookie',
          `sid=${encodeURIComponent(result._sid)}; HttpOnly; SameSite=${sameSite}${secure}; Max-Age=${maxAge}; Path=/`
        );
        result._session_token = result._sid;
        delete result._sid;
      }
      return res.status(result.status || 200).json(result);
    }

    // ── Session validation ─────────────────────────────────────────
    if (!sessionId) return res.status(401).json({ ok: false, error: 'session_required' });
    const session = await validateSession(sessionId, ipHash, fpHash);
    if (!session)  return res.status(401).json({ ok: false, error: 'session_invalid_or_expired' });
    if (session.is_banned || session.cluster_ban) {
      return res.status(403).json({ ok: false, is_banned: true });
    }

    const userId = session.user_id;

    // ── Rate limit per User ────────────────────────────────────────
    if (!rateLimit(`u_${userId}_${type}`, isWrite ? 10 : 20)) {
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    }

    let result;
    switch (type) {
      case 'load':
        result = await handleLoad(userId);
        break;
      case 'get_state':
        result = await handleGetState(userId);
        break;
      case 'start_ad':
        result = await handleStartAd(userId, sessionId, ipHash, fpHash);
        break;
      case 'reward_ad':
        result = await handleRewardAd(userId, sessionId, ipHash, fpHash, body, rawNonce);
        break;
      case 'start_adsgram_task':
        result = await handleStartAdsgramTask(userId, sessionId, ipHash, fpHash);
        break;
      case 'claim_adsgram_task':
        result = await handleClaimAdsgramTask(userId, sessionId, ipHash, fpHash, rawNonce);
        break;
      case 'claim_daily_mission':
        result = await handleClaimDailyMission(userId, body, rawNonce, sessionId, fpHash, ipHash);
        break;
      case 'claim_gift':
        result = await handleClaimGift(userId, rawNonce, sessionId, fpHash, ipHash);
        break;
      case 'verify_tg_task':
        result = await handleVerifyTgTask(userId, rawNonce, sessionId, fpHash, ipHash);
        break;
      case 'submit_withdraw':
        result = await handleSubmitWithdraw(userId, body, rawNonce, sessionId, fpHash, ipHash);
        break;
      case 'get_channels':
        result = await handleGetChannels(userId);
        break;
      case 'verify_channel_task':
        result = await handleVerifyChannelTask(userId, body, rawNonce, sessionId, fpHash, ipHash);
        break;
      case 'get_referrals':
        result = await handleGetReferrals(userId);
        break;
      case 'track_ad_event':
        result = await handleTrackAdEvent(userId, sessionId, body, ipHash, fpHash);
        break;
      default:
        console.warn(`[UNKNOWN_ACTION] type=${type} userId=${userId}`);
        await writeAudit(userId, sessionId, type, 'unknown_action', ipHash, fpHash, { type });
        result = { ok: false, error: 'unknown_action' };
    }

    // ✅ Shadow ban: نُرجع honest response — لا fake success
    // (تمت المعالجة داخل كل handler بشكل منفصل)

    return res.status(200).json(result);

  } catch (e) {
    console.error(`[${type}] Error:`, e.message, e.stack?.split('\n')[1]);
    return res.status(500).json({
      ok: false,
      error: 'internal_server_error',
      detail: e.message,   // ✅ دائماً — لتسهيل debugging في production
      type,
    });
  }
};
