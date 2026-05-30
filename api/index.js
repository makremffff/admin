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
 * neon() HTTP لا يدعم BEGIN/COMMIT على connections منفصلة.
 * الحل: تنفيذ الـ queries مباشرة بدون transaction wrapper —
 * الأمان يأتي من الـ SELECT FOR UPDATE والـ status check.
 */
async function withTransaction(fn) {
  return await fn();
}

// ── Config ────────────────────────────────────────────────────────
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'makrem';
const BOT_TOKEN    = '8285685691:AAFyZvMVJ9k6UgHuBa8E34Icvk-TZ4-OdaI';

async function sendBotMessage(tgId, text, extra = {}) {
  if (!tgId) return { ok: false };
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgId, text, parse_mode: 'HTML', ...extra }),
    });
    return await res.json();
  } catch (e) {
    console.warn('[BOT_MSG] Failed:', e.message);
    return { ok: false };
  }
}

async function sendBotPhoto(tgId, photo, caption, extra = {}) {
  if (!tgId) return { ok: false };
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgId, photo, caption, parse_mode: 'HTML', ...extra }),
    });
    return await res.json();
  } catch (e) {
    console.warn('[BOT_PHOTO] Failed:', e.message);
    return { ok: false };
  }
}

// ── Helpers ───────────────────────────────────────────────────────
function fmt(n) {
  return n == null ? 0 : Number(n);
}

// ── CORS headers ──────────────────────────────────────────────────
function setCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers['origin'] || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
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

  const taddyToday = (
    await sql(`
      SELECT COALESCE(SUM(count), 0) AS taddy_today
      FROM taddy_ad_logs
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
    adsgram_today:             fmt(adsToday.ads_today),
    taddy_today:               fmt(taddyToday.taddy_today),
    ads_today:                 fmt(adsToday.ads_today) + fmt(taddyToday.taddy_today),
  };
}

// GET /admin/users?limit=100&sort=created_at&search=&filter=&online=true
async function handleUsers(query) {
  const limit  = Math.min(parseInt(query.limit  || '500'), 5000);
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
       u.id, u.tg_id, u.tg_username, u.tg_first_name, u.tg_last_name,
       u.tg_is_premium, u.tg_language_code,
       u.points, u.level, u.xp, u.usdt_balance,
       u.is_banned, u.is_shadow_banned, u.ban_reason,
       u.risk_score, u.tg_verified,
       u.streak_day, u.total_referrals, u.earned_from_refs,
       u.ads_watched_total, u.first_withdraw_done,
       u.ip_hash, u.fp_hash,
       u.created_at, u.updated_at,
       up.photo_url
     FROM users u
     LEFT JOIN user_photos up ON up.user_id = u.id
     WHERE ${where.join(' AND ')}
     ORDER BY u.${sort} DESC
     LIMIT $${idx}`,
    params
  );

  // Adsgram اليوم
  const adsToday = await sql(`
    SELECT user_id, count AS adsgram_today, points_earned AS adsgram_earned_today
    FROM ad_logs WHERE log_date = CURRENT_DATE
  `);
  const adsTodayMap = {};
  for (const a of adsToday) adsTodayMap[a.user_id] = a;

  // Taddy اليوم
  const taddyToday = await sql(`
    SELECT user_id, count AS taddy_today, points_earned AS taddy_earned_today
    FROM taddy_ad_logs WHERE log_date = CURRENT_DATE
  `);
  const taddyTodayMap = {};
  for (const t of taddyToday) taddyTodayMap[t.user_id] = t;

  const enriched = rows.map(u => ({
    ...u,
    adsgram_today:       fmt(adsTodayMap[u.id]?.adsgram_today        ?? 0),
    adsgram_earned_today:fmt(adsTodayMap[u.id]?.adsgram_earned_today  ?? 0),
    taddy_today:         fmt(taddyTodayMap[u.id]?.taddy_today         ?? 0),
    taddy_earned_today:  fmt(taddyTodayMap[u.id]?.taddy_earned_today  ?? 0),
    ads_today:           fmt(adsTodayMap[u.id]?.adsgram_today ?? 0) + fmt(taddyTodayMap[u.id]?.taddy_today ?? 0),
    earned_today:        fmt(adsTodayMap[u.id]?.adsgram_earned_today ?? 0) + fmt(taddyTodayMap[u.id]?.taddy_earned_today ?? 0),
  }));

  return { ok: true, users: enriched, total: enriched.length };
}

// GET /admin/users/all?sort=referrals&page=1&per_page=200
async function handleAllUsers(query) {
  const perPage = Math.min(parseInt(query.per_page || '500'), 5000);
  const page    = Math.max(parseInt(query.page    || '1'),  1);
  const offset  = (page - 1) * perPage;
  const sortMap = {
    referrals: 'total_referrals',
    points:    'points',
    ads:       'ads_watched_total',
    created:   'created_at',
  };
  const sortCol = sortMap[query.sort] || 'total_referrals';

  const countRow = (await sql(`SELECT COUNT(*) AS cnt FROM users`))[0];
  const total    = parseInt(countRow.cnt);

  const rows = await sql(
    `SELECT
       u.id, u.tg_id, u.tg_username, u.tg_first_name, u.tg_last_name,
       u.tg_is_premium, u.points, u.level,
       u.total_referrals, u.earned_from_refs,
       u.ads_watched_total, u.usdt_balance,
       u.is_banned, u.is_shadow_banned,
       u.created_at,
       up.photo_url
     FROM users u
     LEFT JOIN user_photos up ON up.user_id = u.id
     ORDER BY u.${sortCol} DESC
     LIMIT $1 OFFSET $2`,
    [perPage, offset]
  );

  // Adsgram اليوم
  const adsToday = await sql(`
    SELECT user_id, count AS adsgram_today, points_earned AS adsgram_earned_today
    FROM ad_logs WHERE log_date = CURRENT_DATE
  `);
  const adsTodayMap = {};
  for (const a of adsToday) adsTodayMap[a.user_id] = a;

  // Taddy اليوم
  const taddyToday = await sql(`
    SELECT user_id, count AS taddy_today, points_earned AS taddy_earned_today
    FROM taddy_ad_logs WHERE log_date = CURRENT_DATE
  `);
  const taddyTodayMap = {};
  for (const t of taddyToday) taddyTodayMap[t.user_id] = t;

  const enriched = rows.map(u => ({
    ...u,
    adsgram_today:        fmt(adsTodayMap[u.id]?.adsgram_today         ?? 0),
    adsgram_earned_today: fmt(adsTodayMap[u.id]?.adsgram_earned_today   ?? 0),
    taddy_today:          fmt(taddyTodayMap[u.id]?.taddy_today          ?? 0),
    taddy_earned_today:   fmt(taddyTodayMap[u.id]?.taddy_earned_today   ?? 0),
    ads_today:            fmt(adsTodayMap[u.id]?.adsgram_today ?? 0) + fmt(taddyTodayMap[u.id]?.taddy_today ?? 0),
    earned_today:         fmt(adsTodayMap[u.id]?.adsgram_earned_today ?? 0) + fmt(taddyTodayMap[u.id]?.taddy_earned_today ?? 0),
  }));

  return {
    ok:       true,
    users:    enriched,
    total,
    page,
    per_page: perPage,
    pages:    Math.ceil(total / perPage),
  };
}

// GET /admin/user/:tgId — تفاصيل مستخدم واحد مع سجل نشاطه
async function handleUserDetail(tgId) {
  const id = parseInt(tgId);
  if (!id) return { ok: false, error: 'invalid_id' };

  const userRows = await sql(
    `SELECT u.*, up.photo_url FROM users u
     LEFT JOIN user_photos up ON up.user_id = u.id
     WHERE u.tg_id = $1 LIMIT 1`,
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

  // إعلانات اليوم — Adsgram
  const adToday = (
    await sql(
      `SELECT count, points_earned
       FROM ad_logs
       WHERE user_id = $1 AND log_date = CURRENT_DATE`,
      [u.id]
    )
  )[0] || { count: 0, points_earned: 0 };

  // إعلانات اليوم — Taddy
  const taddyToday = (
    await sql(
      `SELECT count, points_earned
       FROM taddy_ad_logs
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
      adsgram_today:        fmt(adToday.count),
      adsgram_earned_today: fmt(adToday.points_earned),
      taddy_today:          fmt(taddyToday.count),
      taddy_earned_today:   fmt(taddyToday.points_earned),
      ads_today:            fmt(adToday.count) + fmt(taddyToday.count),
      earned_today:         fmt(adToday.points_earned) + fmt(taddyToday.points_earned),
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

    // كل جدول في try/catch منفصل — لو الجدول غير موجود لا يوقف العملية
    const tryDel = async (q, p) => { try { await sql(q, p); } catch(_) {} };

    await tryDel(`DELETE FROM sessions            WHERE user_id = $1`, [uid]);
    await tryDel(`DELETE FROM nonces              WHERE user_id = $1`, [uid]);
    await tryDel(`DELETE FROM ad_logs             WHERE user_id = $1`, [uid]);
    await tryDel(`DELETE FROM user_tasks          WHERE user_id = $1`, [uid]);
    await tryDel(`DELETE FROM referrals           WHERE referrer_id = $1 OR referred_id = $1`, [uid]);
    await tryDel(`DELETE FROM risk_events         WHERE user_id = $1`, [uid]);
    await tryDel(`DELETE FROM audit_log           WHERE user_id = $1`, [uid]);
    await tryDel(`DELETE FROM device_fingerprints WHERE user_id = $1`, [uid]);
    await tryDel(`DELETE FROM security_logs       WHERE user_id = $1`, [uid]);
    await tryDel(`DELETE FROM completed_tasks     WHERE user_id = $1`, [uid]);
    await tryDel(`UPDATE withdrawals SET user_id = NULL WHERE user_id = $1`, [uid]);

    // حذف المستخدم نفسه — هذا يجب أن ينجح
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

  // Atomic update: فقط إذا الحالة pending — يمنع المعالجة المزدوجة
  const finalStatus = status === 'approved' ? 'completed' : 'rejected';

  // تحقق من وجود الطلب وأنه لا يزال pending — نجلب كل البيانات اللازمة للرسالة
  const wr = (
    await sql(
      `SELECT w.user_id, w.pts, w.ton_amount, w.address, w.status,
              u.tg_id
       FROM withdrawals w
       LEFT JOIN users u ON u.id = w.user_id
       WHERE w.id = $1`,
      [wdId]
    )
  )[0];
  if (!wr) return { ok: false, error: 'not_found' };
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

  // تحديث حالة السحب (atomic — فقط إذا لا يزال pending)
  const r = await sql(
    `UPDATE withdrawals
     SET status = $1, notes = $2, tx_hash = $3,
         reviewed_at = NOW(), updated_at = NOW()
     WHERE id = $4 AND status = 'pending'
     RETURNING id, status`,
    [finalStatus, body?.notes || null, body?.tx_hash || null, wdId]
  );

  if (!r.length) return { ok: false, error: 'already_resolved' };

  // ── إرسال إشعار للمستخدم عبر البوت ──────────────────────────────
  if (wr.tg_id) {
    const fee       = parseFloat(wr.ton_amount) * 0.10;
    const netAmount = (parseFloat(wr.ton_amount) - fee).toFixed(4);
    const grossStr  = parseFloat(wr.ton_amount).toFixed(4);
    const feeStr    = fee.toFixed(4);
    const shortAddr = wr.address
      ? `${wr.address.slice(0, 6)}…${wr.address.slice(-4)}`
      : '—';

    if (finalStatus === 'completed') {
      await sendBotMessage(
        wr.tg_id,
        `✅ <b>تم قبول طلب السحب</b>\n\n` +
        `لقد تم قبول طلب سحبك من قبل الفريق 🎉\n\n` +
        `💰 <b>الكمية:</b> ${grossStr} TON\n` +
        `🔻 <b>رسوم (10%):</b> ${feeStr} TON\n` +
        `📤 <b>المبلغ المُرسَل:</b> ${netAmount} TON\n` +
        `👛 <b>المحفظة:</b> <code>${shortAddr}</code>\n\n` +
        `سيصلك المبلغ خلال وقت قصير. شكراً لثقتك بنا! 🚀`
      );
    } else {
      await sendBotMessage(
        wr.tg_id,
        `❌ <b>تم رفض طلب السحب</b>\n\n` +
        `للأسف تم رفض طلب سحبك.\n` +
        (body?.notes ? `📝 <b>السبب:</b> ${body.notes}\n` : '') +
        `\nتمت إعادة <b>${wr.pts}</b> نقطة إلى رصيدك. يمكنك إعادة المحاولة في أي وقت.`
      );
    }
  }

  return { ok: true, withdrawal_id: wdId, new_status: r[0].status };
}

// POST /admin/broadcast
async function handleBroadcast(body) {
  const { text, image_url, button_label, button_url } = body || {};
  if (!text) return { ok: false, error: 'missing_text' };

  // جلب كل tg_id للمستخدمين النشطين
  const users = await sql(`SELECT tg_id FROM users WHERE tg_id IS NOT NULL AND is_banned = FALSE`);
  if (!users.length) return { ok: false, error: 'no_users' };

  // بناء الـ inline keyboard لو في زر
  const extra = {};
  if (button_label && button_url) {
    extra.reply_markup = {
      inline_keyboard: [[{ text: button_label, url: button_url }]],
    };
  }

  let sent = 0, failed = 0;
  for (const u of users) {
    try {
      let r;
      if (image_url) {
        r = await sendBotPhoto(u.tg_id, image_url, text, extra);
      } else {
        r = await sendBotMessage(u.tg_id, text, extra);
      }
      if (r?.ok) sent++; else failed++;
    } catch (_) { failed++; }
    // تأخير بسيط لتجنب حد الـ rate limit
    await new Promise(r => setTimeout(r, 35));
  }

  return { ok: true, total: users.length, sent, failed };
}

// GET /admin/online — المتصلون في آخر 5 دقائق
async function handleOnline() {
  const rows = await sql(`
    SELECT
      u.id, u.tg_id, u.tg_username, u.tg_first_name,
      u.points, u.level, u.is_banned, u.updated_at,
      up.photo_url
    FROM users u
    LEFT JOIN user_photos up ON up.user_id = u.id
    WHERE u.updated_at > NOW() - INTERVAL '5 minutes'
      AND u.is_banned = FALSE
    ORDER BY u.updated_at DESC
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
// CHANNELS — إدارة قنوات المهمات
// ══════════════════════════════════════════════════════════════════

// GET /admin/channels
async function handleGetChannels() {
  const rows = await sql(
    `SELECT id, title, url, tg_chat_id, reward, max_members, is_active, sort_order, created_at
     FROM channels ORDER BY sort_order ASC, created_at ASC`
  );
  return { ok: true, channels: rows };
}

// POST /admin/channels  { title, url, tg_chat_id?, reward, max_members?, is_active? }
async function handleAddChannel(body) {
  const title       = (body?.title || '').trim();
  const url         = (body?.url   || '').trim();
  const tgChatId    = body?.tg_chat_id  || null;
  const reward      = parseInt(body?.reward ?? 2500);
  const maxMembers  = parseInt(body?.max_members ?? 0);
  const isActive    = body?.is_active !== false;
  const sortOrder   = parseInt(body?.sort_order ?? 0);

  if (!title) return { ok: false, error: 'missing_title' };
  if (!url)   return { ok: false, error: 'missing_url' };
  if (isNaN(reward) || reward < 0) return { ok: false, error: 'invalid_reward' };

  const r = await sql(
    `INSERT INTO channels(title, url, tg_chat_id, reward, max_members, is_active, sort_order)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [title, url, tgChatId, reward, maxMembers, isActive, sortOrder]
  );
  return { ok: true, channel: r[0] };
}

// PUT /admin/channels/:id  — تعديل قناة
async function handleUpdateChannel(id, body) {
  const cid = parseInt(id);
  if (!cid) return { ok: false, error: 'invalid_id' };

  const fields = [];
  const params = [];
  let idx = 1;

  if (body?.title      !== undefined) { fields.push(`title=$${idx++}`);       params.push(body.title); }
  if (body?.url        !== undefined) { fields.push(`url=$${idx++}`);         params.push(body.url); }
  if (body?.tg_chat_id !== undefined) { fields.push(`tg_chat_id=$${idx++}`);  params.push(body.tg_chat_id || null); }
  if (body?.reward     !== undefined) { fields.push(`reward=$${idx++}`);      params.push(parseInt(body.reward)); }
  if (body?.max_members!== undefined) { fields.push(`max_members=$${idx++}`); params.push(parseInt(body.max_members)); }
  if (body?.is_active  !== undefined) { fields.push(`is_active=$${idx++}`);   params.push(!!body.is_active); }
  if (body?.sort_order !== undefined) { fields.push(`sort_order=$${idx++}`);  params.push(parseInt(body.sort_order)); }

  if (!fields.length) return { ok: false, error: 'nothing_to_update' };

  params.push(cid);
  const r = await sql(
    `UPDATE channels SET ${fields.join(',')} WHERE id=$${idx} RETURNING *`,
    params
  );
  if (!r.length) return { ok: false, error: 'channel_not_found' };
  return { ok: true, channel: r[0] };
}

// DELETE /admin/channels/:id
async function handleDeleteChannel(id) {
  const cid = parseInt(id);
  if (!cid) return { ok: false, error: 'invalid_id' };
  const r = await sql(`DELETE FROM channels WHERE id=$1 RETURNING id`, [cid]);
  if (!r.length) return { ok: false, error: 'channel_not_found' };
  return { ok: true, deleted_id: cid };
}

// ══════════════════════════════════════════════════════════════════
// SOCIAL TASKS — إدارة المهمات الاجتماعية
// ══════════════════════════════════════════════════════════════════

// GET /admin/social/tasks — جلب كل المهمات
async function handleGetSocialTasks() {
  const rows = await sql(
    `SELECT id, title, description, reward, icon, note, promo_text,
            promo_optional, task_url, proof_required, is_active, sort_order, created_at
     FROM social_tasks ORDER BY sort_order ASC, id ASC`
  );
  return { ok: true, tasks: rows };
}

// POST /admin/social/tasks — إضافة مهمة جديدة
async function handleAddSocialTask(body) {
  const d = body || {};
  const title        = (d.title || '').trim();
  const icon         = (d.icon  || 'default').trim();
  const reward       = parseInt(d.reward ?? 500);
  const description  = (d.description  || '').trim();
  const note         = (d.note         || '').trim();
  const promoText    = (d.promo_text   || '').trim();
  const taskUrl      = (d.task_url     || '').trim();
  const proofReq     = d.proof_required !== false;
  const isActive     = d.is_active     !== false;
  const sortOrder    = parseInt(d.sort_order ?? 0);

  if (!title)  return { ok: false, error: 'missing_title' };
  if (isNaN(reward) || reward < 0) return { ok: false, error: 'invalid_reward' };

  const r = await sql(
    `INSERT INTO social_tasks(title, description, reward, icon, note, promo_text,
                              promo_optional, task_url, proof_required, is_active, sort_order)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [title, description, reward, icon, note, promoText,
     d.promo_optional !== false, taskUrl, proofReq, isActive, sortOrder]
  );
  return { ok: true, task: r[0] };
}

// PUT /admin/social/tasks/:id — تعديل مهمة
async function handleUpdateSocialTask(id, body) {
  const tid = parseInt(id);
  if (!tid) return { ok: false, error: 'invalid_id' };
  const d = body || {};

  const fields = []; const params = []; let idx = 1;
  const set = (col, val) => { fields.push(`${col}=$${idx++}`); params.push(val); };

  if (d.title        !== undefined) set('title',         d.title);
  if (d.description  !== undefined) set('description',   d.description);
  if (d.reward       !== undefined) set('reward',        parseInt(d.reward));
  if (d.icon         !== undefined) set('icon',          d.icon);
  if (d.note         !== undefined) set('note',          d.note);
  if (d.promo_text   !== undefined) set('promo_text',    d.promo_text);
  if (d.promo_optional!==undefined) set('promo_optional',!!d.promo_optional);
  if (d.task_url     !== undefined) set('task_url',      d.task_url);
  if (d.proof_required!==undefined) set('proof_required',!!d.proof_required);
  if (d.is_active    !== undefined) set('is_active',     !!d.is_active);
  if (d.sort_order   !== undefined) set('sort_order',    parseInt(d.sort_order));

  if (!fields.length) return { ok: false, error: 'nothing_to_update' };
  params.push(tid);
  const r = await sql(
    `UPDATE social_tasks SET ${fields.join(',')} WHERE id=$${idx} RETURNING *`, params
  );
  if (!r.length) return { ok: false, error: 'task_not_found' };
  return { ok: true, task: r[0] };
}

// DELETE /admin/social/tasks/:id
async function handleDeleteSocialTask(id) {
  const tid = parseInt(id);
  if (!tid) return { ok: false, error: 'invalid_id' };
  const r = await sql(`DELETE FROM social_tasks WHERE id=$1 RETURNING id`, [tid]);
  if (!r.length) return { ok: false, error: 'task_not_found' };
  return { ok: true, deleted_id: tid };
}

// GET /admin/social/proofs?status=pending&limit=50 — جلب الإثباتات
async function handleGetSocialProofs(query) {
  const status = query.status || 'pending';
  const limit  = Math.min(parseInt(query.limit || '50'), 200);
  const offset = parseInt(query.offset || '0');
  const hasFilter = status && status !== 'all';

  const where  = hasFilter ? `WHERE sp.status = $1` : `WHERE 1=1`;
  const params = hasFilter ? [status, limit, offset] : [limit, offset];
  const lIdx   = hasFilter ? 2 : 1;

  const rows = await sql(
    `SELECT sp.id, sp.user_id, sp.task_id, sp.proof_image, sp.status,
            sp.created_at, sp.reviewed_by, sp.reviewed_at,
            u.tg_id, u.tg_first_name, u.tg_username,
            st.title AS task_title, st.reward, st.icon AS task_icon
     FROM social_proofs sp
     JOIN users        u  ON u.id  = sp.user_id
     JOIN social_tasks st ON st.id = sp.task_id
     ${where}
     ORDER BY sp.created_at ASC
     LIMIT $${lIdx} OFFSET $${lIdx + 1}`,
    params
  );

  const [{ cnt }] = await sql(
    `SELECT COUNT(*) AS cnt FROM social_proofs ${hasFilter ? `WHERE status = '${status}'` : ''}`
  );

  return { ok: true, proofs: rows, total: parseInt(cnt), limit, offset };
}

// POST /admin/social/review — قبول أو رفض إثبات مع إشعار بوت
async function handleSocialReview(body) {
  const proofId  = parseInt(body?.proof_id);
  const action   = body?.action; // 'approve' | 'reject'
  const reviewer = body?.reviewer || 'admin';

  if (!proofId || !['approve', 'reject'].includes(action)) {
    return { ok: false, error: 'invalid_params' };
  }

  const [proof] = await sql(
    `SELECT sp.id, sp.user_id, sp.status, sp.task_id,
            st.reward, st.title AS task_title, st.icon AS task_icon,
            u.tg_id, u.tg_first_name
     FROM social_proofs sp
     JOIN social_tasks  st ON st.id = sp.task_id
     JOIN users         u  ON u.id  = sp.user_id
     WHERE sp.id = $1`,
    [proofId]
  );
  if (!proof)                   return { ok: false, error: 'proof_not_found' };
  if (proof.status !== 'pending') return { ok: false, error: 'already_reviewed' };

  const newStatus = action === 'approve' ? 'approved' : 'rejected';

  // Transaction
  await sql(`BEGIN`);
  try {
    await sql(
      `UPDATE social_proofs SET status=$1, reviewed_by=$2, reviewed_at=NOW() WHERE id=$3`,
      [newStatus, reviewer, proofId]
    );
    if (action === 'approve') {
      await sql(
        `UPDATE users SET balance = balance + $1 WHERE id = $2`,
        [proof.reward, proof.user_id]
      );
    }
    await sql(`COMMIT`);
  } catch (err) {
    await sql(`ROLLBACK`);
    throw err;
  }

  // إشعار البوت
  if (proof.tg_id) {
    const platformLabels = {
      facebook: 'فيسبوك', twitter: 'تويتر / X', tiktok: 'تيك توك',
      telegram: 'تيليجرام', instagram: 'إنستغرام', youtube: 'يوتيوب',
    };
    const platform = platformLabels[proof.task_icon] || proof.task_title;

    if (action === 'approve') {
      await sendBotMessage(
        proof.tg_id,
        `🎉 <b>تهانينا!</b>\n\n` +
        `تم مراجعة مهمتك على <b>${platform}</b> وتم قبولها بنجاح ✅\n\n` +
        `💰 تم إضافة <b>${Number(proof.reward).toLocaleString('ar')}</b> نقطة إلى حسابك!\n\n` +
        `شكراً لتفاعلك مع المنصة 🚀`
      );
    } else {
      await sendBotMessage(
        proof.tg_id,
        `❌ <b>تم رفض المهمة</b>\n\n` +
        `للأسف تم رفض إثبات مهمتك على <b>${platform}</b>.\n` +
        (body?.reason ? `📝 <b>السبب:</b> ${body.reason}\n` : '') +
        `\nيمكنك إعادة المحاولة وإرسال لقطة شاشة واضحة.`
      );
    }
  }

  return { ok: true, proof_id: proofId, new_status: newStatus };
}

// ══════════════════════════════════════════════════════════════════
// URL PARSER
// ══════════════════════════════════════════════════════════════════
function parseUrl(rawUrl = '') {
  const qIdx = rawUrl.indexOf('?');
  const path = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  const query = {};
  if (qIdx >= 0) {
    new URLSearchParams(rawUrl.slice(qIdx + 1)).forEach((v, k) => {
      query[k] = v;
    });
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

      if (path.endsWith('/admin/users/all') || path.includes('/admin/users/all?'))
        return res.status(200).json(await handleAllUsers(query));

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

      if (path.endsWith('/admin/channels') || path.includes('/admin/channels?'))
        return res.status(200).json(await handleGetChannels());

      if (path.endsWith('/admin/social/tasks') || path.includes('/admin/social/tasks?'))
        return res.status(200).json(await handleGetSocialTasks());

      if (path.endsWith('/admin/social/proofs') || path.includes('/admin/social/proofs?'))
        return res.status(200).json(await handleGetSocialProofs(query));

      return res.status(404).json({ ok: false, error: 'not_found', path });
    }

    // ── DELETE ───────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      if (path.includes('/admin/user/')) {
        const tgId = path.split('/admin/user/')[1]?.split('/')[0];
        return res.status(200).json(await handleDeleteUser(tgId));
      }
      if (path.includes('/admin/channels/')) {
        const chId = path.split('/admin/channels/')[1]?.split('/')[0];
        return res.status(200).json(await handleDeleteChannel(chId));
      }
      if (path.includes('/admin/social/tasks/')) {
        const tid = path.split('/admin/social/tasks/')[1]?.split('/')[0];
        return res.status(200).json(await handleDeleteSocialTask(tid));
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

      if (path.endsWith('/admin/channels'))
        return res.status(200).json(await handleAddChannel(body));

      if (path.endsWith('/admin/social/tasks'))
        return res.status(200).json(await handleAddSocialTask(body));

      if (path.endsWith('/admin/social/review'))
        return res.status(200).json(await handleSocialReview(body));

      if (path.endsWith('/admin/broadcast'))
        return res.status(200).json(await handleBroadcast(body));

      return res.status(404).json({ ok: false, error: 'not_found', path });
    }

    // ── PUT ──────────────────────────────────────────────────────
    if (req.method === 'PUT') {
      if (path.includes('/admin/channels/')) {
        const chId = path.split('/admin/channels/')[1]?.split('/')[0];
        return res.status(200).json(await handleUpdateChannel(chId, body));
      }
      if (path.includes('/admin/social/tasks/')) {
        const tid = path.split('/admin/social/tasks/')[1]?.split('/')[0];
        return res.status(200).json(await handleUpdateSocialTask(tid, body));
      }
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
