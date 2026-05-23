'use strict';

/**
 * Admin Panel API — TON Spin / الربح عربي
 * يتصل بنفس قاعدة بيانات index.js الأصلي
 *
 * Endpoints:
 *   GET    /admin/stats          — إحصائيات عامة
 *   GET    /admin/users          — قائمة المستخدمين (مع فلترة وبحث)
 *   GET    /admin/user/:tgId     — تفاصيل مستخدم واحد
 *   DELETE /admin/user/:tgId     — حذف مستخدم (داخل transaction)
 *   POST   /admin/ban            — حظر / رفع حظر
 *   POST   /admin/balance        — تعديل نقاط مستخدم
 *   GET    /admin/withdrawals    — قائمة السحوبات
 *   POST   /admin/withdrawal     — قبول / رفض سحب
 *   GET    /admin/online         — المتصلون (آخر 5 دقائق)
 *   GET    /admin/audit          — سجل الأحداث
 *   GET    /admin/risk           — أحداث المخاطر
 *   POST   /admin/config         — حفظ الإعدادات في DB
 */

const { neon } = require('@neondatabase/serverless');

// ── DB ────────────────────────────────────────────────────────────
const _db = neon(process.env.DATABASE_URL);

async function sql(query, params = []) {
  return await _db(query, params);
}

/**
 * تشغيل عدة استعلامات داخل transaction واحدة.
 * لو أي استعلام فشل → ROLLBACK تلقائي.
 */
async function withTransaction(fn) {
  await sql('BEGIN');
  try {
    const result = await fn();
    await sql('COMMIT');
    return result;
  } catch (err) {
    await sql('ROLLBACK');
    throw err;
  }
}

// ── Config ────────────────────────────────────────────────────────
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'makrem';

// ── Helpers ───────────────────────────────────────────────────────
function fmt(n) {
  return n == null ? 0 : Number(n);
}

// ── CORS headers ──────────────────────────────────────────────────
function setCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers['origin'] || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Secret');
}

// ── Auth check ────────────────────────────────────────────────────
function checkAuth(req, res) {
  const key =
    req.headers['x-admin-secret'] ||
    req.headers['x-admin-Secret'] ||
    '';
  if (key !== ADMIN_SECRET) {
    res.status(403).json({ ok: false, error: 'forbidden' });
    return false;
  }
  return true;
}

// ══════════════════════════════════════════════════════════════════
// HANDLERS
// ══════════════════════════════════════════════════════════════════

// GET /admin/stats
async function handleStats() {
  const users = (
    await sql(`
      SELECT
        COUNT(*)                                                              AS total_users,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day')        AS new_today,
        COUNT(*) FILTER (WHERE updated_at > NOW() - INTERVAL '5 minutes')    AS online,
        COUNT(*) FILTER (WHERE is_banned = TRUE)                             AS banned,
        COUNT(*) FILTER (WHERE is_shadow_banned = TRUE AND is_banned = FALSE) AS shadow_banned,
        COUNT(*) FILTER (WHERE tg_is_premium = TRUE)                         AS premium_users,
        COUNT(*) FILTER (WHERE first_withdraw_done = TRUE)                   AS first_withdraw_done_count,
        COALESCE(SUM(points), 0)                                             AS total_points,
        COALESCE(SUM(total_referrals), 0)                                    AS total_referrals,
        COALESCE(SUM(ads_watched_total), 0)                                  AS total_ads
      FROM users
    `)
  )[0];

  const wdStats = (
    await sql(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')   AS pending_withdrawals,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed_withdrawals,
        COALESCE(SUM(ton_amount) FILTER (WHERE status = 'completed'), 0) AS total_ton_paid
      FROM withdrawals
    `)
  )[0];

  const adsToday = (
    await sql(`
      SELECT COALESCE(SUM(count), 0) AS ads_today
      FROM ad_logs
      WHERE log_date = CURRENT_DATE
    `)
  )[0];

  return {
    ok: true,
    total_users:               fmt(users.total_users),
    new_today:                 fmt(users.new_today),
    online:                    fmt(users.online),
    banned:                    fmt(users.banned),
    shadow_banned:             fmt(users.shadow_banned),
    premium_users:             fmt(users.premium_users),
    total_points:              fmt(users.total_points),
    total_referrals:           fmt(users.total_referrals),
    total_ads:                 fmt(users.total_ads),
    first_withdraw_done_count: fmt(users.first_withdraw_done_count),
    pending_withdrawals:       fmt(wdStats.pending_withdrawals),
    completed_withdrawals:     fmt(wdStats.completed_withdrawals),
    total_ton_paid:            parseFloat(wdStats.total_ton_paid || 0).toFixed(4),
    ads_today:                 fmt(adsToday.ads_today),
  };
}

// GET /admin/users?limit=100&sort=created_at&search=&filter=&online=true
async function handleUsers(query) {
  const limit  = Math.min(parseInt(query.limit  || '100'), 500);
  const search = (query.search || '').trim();
  const filter = (query.filter || '').trim(); // banned | shadow | premium | ''
  const online = query.online === 'true';
  const sort   = query.sort === 'points' ? 'points' : 'created_at';

  const where  = ['1=1'];
  const params = [];
  let   idx    = 1;

  if (search) {
    where.push(
      `(tg_username ILIKE $${idx} OR tg_first_name ILIKE $${idx} OR CAST(tg_id AS TEXT) LIKE $${idx})`
    );
    params.push(`%${search}%`);
    idx++;
  }
  if (filter === 'banned')  where.push('is_banned = TRUE');
  if (filter === 'shadow')  where.push('is_shadow_banned = TRUE AND is_banned = FALSE');
  if (filter === 'premium') where.push('tg_is_premium = TRUE');
  if (online)               where.push(`updated_at > NOW() - INTERVAL '5 minutes'`);

  params.push(limit);

  const rows = await sql(
    `SELECT
       id, tg_id, tg_username, tg_first_name, tg_last_name,
       tg_is_premium, tg_language_code,
       points, level, xp, usdt_balance,
       is_banned, is_shadow_banned, ban_reason,
       risk_score, tg_verified,
       streak_day, total_referrals, earned_from_refs,
       ads_watched_total, first_withdraw_done,
       ip_hash, fp_hash,
       created_at, updated_at
     FROM users
     WHERE ${where.join(' AND ')}
     ORDER BY ${sort} DESC
     LIMIT $${idx}`,
    params
  );

  return { ok: true, users: rows, total: rows.length };
}

// GET /admin/user/:tgId — تفاصيل مستخدم واحد مع سجل نشاطه
async function handleUserDetail(tgId) {
  const id = parseInt(tgId);
  if (!id) return { ok: false, error: 'invalid_id' };

  const userRows = await sql(
    `SELECT * FROM users WHERE tg_id = $1 LIMIT 1`,
    [id]
  );
  if (!userRows.length) return { ok: false, error: 'user_not_found' };
  const u = userRows[0];

  // آخر 10 سجلات في audit_log
  const auditRows = await sql(
    `SELECT action, status, created_at, meta
     FROM audit_log
     WHERE user_id = $1
     ORDER BY created_at DESC LIMIT 10`,
    [u.id]
  );

  // سجل السحوبات
  const wdRows = await sql(
    `SELECT pts, ton_amount, address, status, created_at
     FROM withdrawals
     WHERE user_id = $1
     ORDER BY created_at DESC LIMIT 5`,
    [u.id]
  );

  // إعلانات اليوم
  const adToday = (
    await sql(
      `SELECT count, points_earned
       FROM ad_logs
       WHERE user_id = $1 AND log_date = CURRENT_DATE`,
      [u.id]
    )
  )[0] || { count: 0, points_earned: 0 };

  // إحالاته
  const refRows = await sql(
    `SELECT u2.tg_first_name, u2.tg_username, r.activated, r.created_at
     FROM referrals r
     JOIN users u2 ON u2.id = r.referred_id
     WHERE r.referrer_id = $1
     ORDER BY r.created_at DESC LIMIT 10`,
    [u.id]
  );

  return {
    ok: true,
    user: {
      ...u,
      ads_today:    fmt(adToday.count),
      earned_today: fmt(adToday.points_earned),
    },
    audit:       auditRows,
    withdrawals: wdRows,
    referrals:   refRows,
  };
}

// DELETE /admin/user/:tgId — حذف مستخدم داخل transaction
// FIX: الآن كل الحذف يتم داخل transaction واحدة — لو فشل أي استعلام يُعاد كل شيء
async function handleDeleteUser(tgId) {
  const id = parseInt(tgId);
  if (!id) return { ok: false, error: 'invalid_id' };

  return await withTransaction(async () => {
    const u = (await sql(`SELECT id FROM users WHERE tg_id = $1`, [id]))[0];
    if (!u) return { ok: false, error: 'user_not_found' };

    const uid = u.id;

    await sql(`DELETE FROM sessions             WHERE user_id = $1`, [uid]);
    await sql(`DELETE FROM nonces               WHERE user_id = $1`, [uid]);
    await sql(`DELETE FROM ad_logs              WHERE user_id = $1`, [uid]);
    await sql(`DELETE FROM user_tasks           WHERE user_id = $1`, [uid]);
    await sql(`DELETE FROM referrals            WHERE referrer_id = $1 OR referred_id = $1`, [uid]);
    await sql(`DELETE FROM risk_events          WHERE user_id = $1`, [uid]);
    await sql(`DELETE FROM audit_log            WHERE user_id = $1`, [uid]);
    await sql(`DELETE FROM device_fingerprints  WHERE user_id = $1`, [uid]);
    await sql(`DELETE FROM security_logs        WHERE user_id = $1`, [uid]);
    await sql(`DELETE FROM completed_tasks      WHERE user_id = $1`, [uid]);

    // السحوبات نبقيها للسجل المالي لكن نفصلها عن المستخدم
    await sql(`UPDATE withdrawals SET user_id = NULL WHERE user_id = $1`, [uid]);

    await sql(`DELETE FROM users WHERE id = $1`, [uid]);

    return { ok: true, deleted_tg_id: id };
  });
}

// POST /admin/ban  { tg_id, ban: true/false, reason? }
async function handleBan(body) {
  const tgId   = parseInt(body?.tg_id);
  const ban    = !!body?.ban;
  const reason = body?.reason || 'admin_action';
  if (!tgId) return { ok: false, error: 'missing_tg_id' };

  if (ban) {
    await sql(
      `UPDATE users
       SET is_banned = TRUE, ban_reason = $1, updated_at = NOW()
       WHERE tg_id = $2`,
      [reason, tgId]
    );
  } else {
    await sql(
      `UPDATE users
       SET is_banned = FALSE, is_shadow_banned = FALSE,
           ban_reason = NULL, risk_score = 0, updated_at = NOW()
       WHERE tg_id = $1`,
      [tgId]
    );
  }
  return { ok: true, tg_id: tgId, banned: ban };
}

// POST /admin/balance  { tg_id, action: add|subtract|set, amount, note? }
// FIX: action=set الآن يعدّل النقاط فقط دون المساس بالـ xp المكتسب
async function handleBalance(body) {
  const tgId   = parseInt(body?.tg_id);
  const action = body?.action || 'add';
  const amount = parseInt(body?.amount);
  if (!tgId)         return { ok: false, error: 'missing_tg_id' };
  if (isNaN(amount)) return { ok: false, error: 'invalid_amount' };
  if (amount < 0)    return { ok: false, error: 'amount_must_be_positive' };

  let updateExpr;
  if      (action === 'add')      updateExpr = `points = points + $1, xp = xp + $1`;
  else if (action === 'subtract') updateExpr = `points = GREATEST(0, points - $1), xp = GREATEST(0, xp - $1)`;
  else if (action === 'set')      updateExpr = `points = $1`;   // FIX: لا نعدّل xp عند set
  else return { ok: false, error: 'invalid_action' };

  const r = await sql(
    `UPDATE users
     SET ${updateExpr}, updated_at = NOW()
     WHERE tg_id = $2
     RETURNING id, tg_id, points, xp`,
    [amount, tgId]
  );
  if (!r.length) return { ok: false, error: 'user_not_found' };

  // Sync level بناءً على xp الحالي (غير متأثر بـ set)
  const xp = parseInt(r[0].xp) || 0;
  const LEVEL_THRESHOLDS = [0, 0, 500, 1500, 3500, 8000, 16000, 30000, 55000, 90000, 150000];
  let level = 1;
  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
    if (xp >= LEVEL_THRESHOLDS[i]) { level = i; break; }
  }
  await sql(`UPDATE users SET level = $1 WHERE id = $2`, [level, r[0].id]);

  return {
    ok:         true,
    tg_id:      tgId,
    new_points: fmt(r[0].points),
    action,
    amount,
    note:       body?.note || '',
  };
}

// GET /admin/withdrawals?status=pending|completed|rejected|all&limit=100
async function handleWithdrawals(query) {
  const status   = query.status || 'pending';
  const limit    = Math.min(parseInt(query.limit || '100'), 500);
  const hasFilter = status && status !== 'all';

  const where    = hasFilter ? `WHERE w.status = $1` : `WHERE 1=1`;
  const params   = hasFilter ? [status, limit] : [limit];
  const limitIdx = hasFilter ? 2 : 1;

  const rows = await sql(
    `SELECT
       w.id, w.user_id, w.pts, w.ton_amount, w.address,
       w.method, w.status, w.tx_hash, w.notes,
       w.created_at, w.updated_at, w.reviewed_at,
       u.tg_id, u.tg_username, u.tg_first_name, u.tg_last_name
     FROM withdrawals w
     LEFT JOIN users u ON u.id = w.user_id
     ${where}
     ORDER BY w.created_at DESC
     LIMIT $${limitIdx}`,
    params
  );

  return { ok: true, withdrawals: rows, total: rows.length };
}

// POST /admin/withdrawal  { id, status: approved|rejected, notes?, tx_hash? }
// FIX: completed لم يعد مقبولاً كـ input مباشر — فقط approved أو rejected
async function handleWithdrawalAction(body) {
  const wdId   = parseInt(body?.id);
  const status = body?.status;
  if (!wdId) return { ok: false, error: 'missing_id' };

  // FIX: قبلنا فقط approved أو rejected — لا completed مباشرةً
  if (!['approved', 'rejected'].includes(status)) {
    return { ok: false, error: 'invalid_status — use approved or rejected' };
  }

  return await withTransaction(async () => {
    const wr = (
      await sql(`SELECT user_id, pts, status FROM withdrawals WHERE id = $1`, [wdId])
    )[0];
    if (!wr) return { ok: false, error: 'not_found' };

    // منع معالجة طلب محسوم مسبقاً
    if (wr.status !== 'pending') {
      return { ok: false, error: 'already_resolved', current_status: wr.status };
    }

    // عند الرفض — أعد النقاط للمستخدم
    if (status === 'rejected' && wr.user_id) {
      await sql(
        `UPDATE users SET points = points + $1, updated_at = NOW() WHERE id = $2`,
        [wr.pts, wr.user_id]
      );
    }

    const finalStatus = status === 'approved' ? 'completed' : 'rejected';

    const r = await sql(
      `UPDATE withdrawals
       SET status = $1, notes = $2, tx_hash = $3,
           reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $4
       RETURNING id, status`,
      [finalStatus, body?.notes || null, body?.tx_hash || null, wdId]
    );

    return { ok: true, withdrawal_id: wdId, new_status: r[0].status };
  });
}

// GET /admin/online — المتصلون في آخر 5 دقائق
async function handleOnline() {
  const rows = await sql(`
    SELECT
      id, tg_id, tg_username, tg_first_name,
      points, level, is_banned, updated_at
    FROM users
    WHERE updated_at > NOW() - INTERVAL '5 minutes'
      AND is_banned = FALSE
    ORDER BY updated_at DESC
    LIMIT 100
  `);
  return { ok: true, users: rows, count: rows.length };
}

// GET /admin/audit?user_id=&limit=50
async function handleAudit(query) {
  const uid   = parseInt(query.user_id || '0');
  const limit = Math.min(parseInt(query.limit || '50'), 200);

  const where  = uid ? `WHERE user_id = $1` : `WHERE 1=1`;
  const params = uid ? [uid, limit] : [limit];
  const idx    = uid ? 2 : 1;

  const rows = await sql(
    `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT $${idx}`,
    params
  );
  return { ok: true, logs: rows };
}

// GET /admin/risk?limit=50
async function handleRisk(query) {
  const limit = Math.min(parseInt(query.limit || '50'), 200);
  const rows  = await sql(
    `SELECT r.*, u.tg_username, u.tg_first_name
     FROM risk_events r
     LEFT JOIN users u ON u.id = r.user_id
     ORDER BY r.created_at DESC LIMIT $1`,
    [limit]
  );
  return { ok: true, logs: rows };
}

// POST /admin/config — حفظ الإعدادات في جدول app_config بالـ DB
// FIX: بدل in-memory، الإعدادات تُحفظ فعلياً في DB وتبقى بعد إعادة النشر
async function handleSaveConfig(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid_body' };
  }

  const entries = Object.entries(body);
  if (!entries.length) return { ok: false, error: 'empty_config' };

  // upsert كل قيمة على حدة في جدول app_config(key TEXT PK, value TEXT, updated_at TIMESTAMPTZ)
  for (const [key, value] of entries) {
    await sql(
      `INSERT INTO app_config (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, String(value)]
    );
  }

  console.info('[ADMIN_CONFIG] Saved to DB:', Object.keys(body).join(', '));
  return { ok: true, saved: Object.keys(body) };
}

// ══════════════════════════════════════════════════════════════════
// URL PARSER
// ══════════════════════════════════════════════════════════════════
function parseUrl(rawUrl = '') {
  const qIdx = rawUrl.indexOf('?');
  let path   = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  const query = {};
  if (qIdx >= 0) {
    new URLSearchParams(rawUrl.slice(qIdx + 1)).forEach((v, k) => {
      query[k] = v;
    });
  }
  // strip /admin/api prefix اللي يضيفه vercel.json rewrite
  // مثال: /admin/api/admin/stats → /admin/stats
  if (path.startsWith('/admin/api')) {
    path = path.slice('/admin/api'.length) || '/';
  }
  return { path, query };
}

// ══════════════════════════════════════════════════════════════════
// ROUTER — متوافق مع Vercel Serverless Functions
// ══════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!checkAuth(req, res)) return;

  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }

  const { path, query } = parseUrl(req.url || '');

  try {
    // ── GET ──────────────────────────────────────────────────────
    if (req.method === 'GET') {
      if (path.endsWith('/admin/stats'))
        return res.status(200).json(await handleStats());

      if (path.includes('/admin/user/') && !path.endsWith('/admin/users')) {
        const tgId = path.split('/admin/user/')[1]?.split('/')[0];
        return res.status(200).json(await handleUserDetail(tgId));
      }

      if (path.endsWith('/admin/users') || path.includes('/admin/users?'))
        return res.status(200).json(await handleUsers(query));

      if (path.endsWith('/admin/withdrawals') || path.includes('/admin/withdrawals?'))
        return res.status(200).json(await handleWithdrawals(query));

      if (path.endsWith('/admin/online'))
        return res.status(200).json(await handleOnline());

      if (path.endsWith('/admin/audit') || path.includes('/admin/audit?'))
        return res.status(200).json(await handleAudit(query));

      if (path.endsWith('/admin/risk') || path.includes('/admin/risk?'))
        return res.status(200).json(await handleRisk(query));

      return res.status(404).json({ ok: false, error: 'not_found', path });
    }

    // ── DELETE ───────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      if (path.includes('/admin/user/')) {
        const tgId = path.split('/admin/user/')[1]?.split('/')[0];
        return res.status(200).json(await handleDeleteUser(tgId));
      }
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    // ── POST ─────────────────────────────────────────────────────
    if (req.method === 'POST') {
      if (path.endsWith('/admin/ban'))
        return res.status(200).json(await handleBan(body));

      if (path.endsWith('/admin/balance'))
        return res.status(200).json(await handleBalance(body));

      if (path.endsWith('/admin/withdrawal'))
        return res.status(200).json(await handleWithdrawalAction(body));

      if (path.endsWith('/admin/config'))
        return res.status(200).json(await handleSaveConfig(body));

      return res.status(404).json({ ok: false, error: 'not_found', path });
    }

    return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  } catch (err) {
    console.error('[ADMIN_API] Error:', err.message, err.stack?.split('\n')[1]);
    return res.status(500).json({
      ok:     false,
      error:  'internal_server_error',
      detail: err.message,
    });
  }
};
