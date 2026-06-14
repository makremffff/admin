// ══════════════════════════════════════════════════════════════════════════════
//  api/admin.js  —  Admin Panel API · Vercel Serverless Function
// ══════════════════════════════════════════════════════════════════════════════

const { neon } = require('@neondatabase/serverless');
const crypto   = require('crypto');

const DATABASE_URL    = process.env.DATABASE_URL;
const BOT_TOKEN       = process.env.BOT_TOKEN;
const ADMIN_SECRET    = process.env.ADMIN_SECRET; // Secret for admin auth

if (!ADMIN_SECRET) {
  throw new Error('[FATAL] ADMIN_SECRET env var is not set');
}

const _db = neon(DATABASE_URL);
async function sql(query, params = []) {
  return await _db(query, params);
}

// ══════════════════════════════════════════════════════════════════════════════
//  Auth — ADMIN_SECRET header check
// ══════════════════════════════════════════════════════════════════════════════
function requireAdmin(req) {
  const provided = req.headers['x-admin-secret'] || '';
  return crypto.timingSafeEqual(
    Buffer.from(provided.padEnd(64)),
    Buffer.from(ADMIN_SECRET.padEnd(64))
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  Admin action logger
// ══════════════════════════════════════════════════════════════════════════════
async function logAdminAction(adminNote, targetUserId, action, meta = {}) {
  try {
    await sql(`CREATE TABLE IF NOT EXISTS admin_logs (
      id          SERIAL PRIMARY KEY,
      admin_note  TEXT,
      target_user INT,
      action      TEXT NOT NULL,
      meta        JSONB NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await sql(
      `INSERT INTO admin_logs (admin_note, target_user, action, meta) VALUES ($1,$2,$3,$4)`,
      [adminNote, targetUserId, action, JSON.stringify(meta)]
    );
  } catch(e) {
    console.error('[admin_log error]', e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Telegram Bot Helper
// ══════════════════════════════════════════════════════════════════════════════
async function sendTelegramMessage(chatId, text, extra = {}) {
  if (!BOT_TOKEN) return { ok: false };
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: String(chatId), text, parse_mode: 'Markdown', ...extra })
  });
  return await res.json();
}

async function sendTelegramPhoto(chatId, photo, caption, extra = {}) {
  if (!BOT_TOKEN) return { ok: false };
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: String(chatId), photo, caption, parse_mode: 'Markdown', ...extra })
  });
  return await res.json();
}

// ══════════════════════════════════════════════════════════════════════════════
//  Main Export
// ══════════════════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Secret');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!requireAdmin(req)) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  const { action } = req.query;
  const body = req.body || {};

  try {
    // ══════════════════════════════════════════════════════════════════════
    //  DASHBOARD STATS
    // ══════════════════════════════════════════════════════════════════════
    if (action === 'stats') {
      const [
        totalUsers,
        newToday,
        newWeek,
        totalPts,
        totalBalance,
        activeComp,
        endedComp,
        adWatchesToday,
        topCountry,
        riskStats,
        withdrawStats,
        growthData,
        dailyActivity,
        recentUsers,
        shadowBanned,
      ] = await Promise.all([
        sql(`SELECT COUNT(*)::INT AS count FROM users`),
        sql(`SELECT COUNT(*)::INT AS count FROM users WHERE created_at >= CURRENT_DATE`),
        sql(`SELECT COUNT(*)::INT AS count FROM users WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'`),
        sql(`SELECT COALESCE(SUM(pts),0)::BIGINT AS total FROM users`),
        sql(`SELECT COALESCE(SUM(balance_usd),0)::NUMERIC AS total FROM users`),
        sql(`SELECT COUNT(*)::INT AS count FROM competition WHERE active = TRUE`),
        sql(`SELECT COUNT(*)::INT AS count FROM competition WHERE active = FALSE`),
        sql(`SELECT COUNT(*)::INT AS count FROM ad_watches WHERE created_at >= CURRENT_DATE`),
        sql(`SELECT COUNT(*)::INT AS count FROM users WHERE shadow_banned = TRUE`),
        sql(`SELECT 
              COUNT(CASE WHEN risk_score = 0 THEN 1 END)::INT AS safe,
              COUNT(CASE WHEN risk_score > 0 AND risk_score < 50 THEN 1 END)::INT AS low,
              COUNT(CASE WHEN risk_score >= 50 AND risk_score < 100 THEN 1 END)::INT AS medium,
              COUNT(CASE WHEN risk_score >= 100 THEN 1 END)::INT AS high
            FROM users`),
        sql(`SELECT 
              COUNT(*)::INT AS total,
              COUNT(CASE WHEN status='pending' THEN 1 END)::INT AS pending,
              COUNT(CASE WHEN status='done' THEN 1 END)::INT AS done,
              COALESCE(SUM(CASE WHEN status='done' THEN amount ELSE 0 END),0)::NUMERIC AS paid_out
            FROM withdrawals`),
        sql(`SELECT 
              DATE(created_at) AS day,
              COUNT(*)::INT AS users
            FROM users
            WHERE created_at >= NOW() - INTERVAL '30 days'
            GROUP BY DATE(created_at)
            ORDER BY day ASC`),
        sql(`SELECT 
              DATE(created_at) AS day,
              COUNT(*)::INT AS ads
            FROM ad_watches
            WHERE created_at >= NOW() - INTERVAL '30 days'
            GROUP BY DATE(created_at)
            ORDER BY day ASC`),
        sql(`SELECT id, telegram_id, first_name, username, pts, balance_usd, risk_score, shadow_banned, created_at
             FROM users ORDER BY created_at DESC LIMIT 5`),
        sql(`SELECT COUNT(*)::INT AS count FROM users WHERE shadow_banned = TRUE`),
      ]);

      // Calc growth rate (this week vs last week)
      const thisWeek = newWeek[0].count;
      const prevWeekRows = await sql(`SELECT COUNT(*)::INT AS count FROM users WHERE created_at >= CURRENT_DATE - INTERVAL '14 days' AND created_at < CURRENT_DATE - INTERVAL '7 days'`);
      const prevWeek = prevWeekRows[0].count;
      const growthRate = prevWeek > 0 ? (((thisWeek - prevWeek) / prevWeek) * 100).toFixed(1) : '∞';

      return res.json({
        ok: true,
        stats: {
          totalUsers: totalUsers[0].count,
          newToday: newToday[0].count,
          newWeek: newWeek[0].count,
          growthRate,
          totalPts: totalPts[0].total,
          totalBalance: parseFloat(totalBalance[0].total),
          activeCompetitions: activeComp[0].count,
          endedCompetitions: endedComp[0].count,
          adWatchesToday: adWatchesToday[0].count,
          shadowBanned: shadowBanned[0].count,
          riskStats: riskStats[0],
          withdrawals: withdrawStats[0],
          growthChart: growthData,
          activityChart: dailyActivity,
          recentUsers,
        }
      });
    }

    // ══════════════════════════════════════════════════════════════════════
    //  USERS LIST
    // ══════════════════════════════════════════════════════════════════════
    if (action === 'users') {
      const page    = parseInt(req.query.page  || '1', 10);
      const limit   = parseInt(req.query.limit || '50', 10);
      const search  = req.query.search || '';
      const filter  = req.query.filter || 'all'; // all | banned | shadow | risky
      const offset  = (page - 1) * limit;

      let where = 'WHERE 1=1';
      const params = [];
      let pi = 1;

      if (search) {
        where += ` AND (u.username ILIKE $${pi} OR u.first_name ILIKE $${pi} OR u.telegram_id::TEXT = $${pi+1})`;
        params.push(`%${search}%`, search);
        pi += 2;
      }
      if (filter === 'banned')  where += ` AND u.shadow_banned = TRUE`;
      if (filter === 'risky')   where += ` AND u.risk_score >= 50`;
      if (filter === 'pending') where += ` AND EXISTS (SELECT 1 FROM withdrawals w WHERE w.user_id = u.id AND w.status = 'pending')`;

      const countRows = await sql(`SELECT COUNT(*)::INT AS count FROM users u ${where}`, params);
      const users = await sql(`
        SELECT 
          u.id, u.telegram_id, u.username, u.first_name, u.photo_url,
          u.pts, u.balance_usd, u.risk_score, u.shadow_banned,
          u.created_at, u.last_ad_watch, u.daily_ads,
          u.referral_code, u.referred_by,
          (SELECT COUNT(*)::INT FROM users r WHERE r.referred_by = u.telegram_id) AS referral_count,
          (SELECT COUNT(*)::INT FROM ad_watches aw WHERE aw.user_id = u.id) AS total_ads_watched
        FROM users u
        ${where}
        ORDER BY u.created_at DESC
        LIMIT $${pi} OFFSET $${pi+1}
      `, [...params, limit, offset]);

      return res.json({
        ok: true,
        users,
        total: countRows[0].count,
        page,
        pages: Math.ceil(countRows[0].count / limit)
      });
    }

    // ══════════════════════════════════════════════════════════════════════
    //  SINGLE USER DETAILS
    // ══════════════════════════════════════════════════════════════════════
    if (action === 'user_detail') {
      const userId = parseInt(req.query.id, 10);
      if (!userId) return res.status(400).json({ ok: false, error: 'User ID required' });

      const [user, activityLogs, adminLogs, withdrawals, adHistory, referrals] = await Promise.all([
        sql(`SELECT u.*,
              (SELECT COUNT(*)::INT FROM users r WHERE r.referred_by = u.telegram_id) AS referral_count
             FROM users u WHERE u.id = $1`, [userId]),
        sql(`SELECT * FROM activity_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [userId]),
        sql(`SELECT * FROM admin_logs WHERE target_user = $1 ORDER BY created_at DESC LIMIT 50`, [userId]).catch(() => []),
        sql(`SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [userId]),
        sql(`SELECT * FROM ad_watches WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [userId]),
        sql(`SELECT id, telegram_id, first_name, username, pts, created_at
             FROM users WHERE referred_by = (SELECT telegram_id FROM users WHERE id = $1)
             ORDER BY created_at DESC LIMIT 20`, [userId]),
      ]);

      if (!user[0]) return res.status(404).json({ ok: false, error: 'User not found' });

      return res.json({
        ok: true,
        user: user[0],
        activityLogs,
        adminLogs,
        withdrawals,
        adHistory,
        referrals,
      });
    }

    // ══════════════════════════════════════════════════════════════════════
    //  USER ACTIONS (POST)
    // ══════════════════════════════════════════════════════════════════════
    if (action === 'user_action' && req.method === 'POST') {
      const { userId, type: actionType, value, reason, adminNote } = body;
      if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });

      const userRows = await sql(`SELECT * FROM users WHERE id = $1`, [userId]);
      if (!userRows[0]) return res.status(404).json({ ok: false, error: 'User not found' });
      const user = userRows[0];

      switch (actionType) {
        case 'ban':
          await sql(`UPDATE users SET shadow_banned = TRUE WHERE id = $1`, [userId]);
          await logAdminAction(adminNote, userId, 'ban', { reason });
          break;

        case 'unban':
          await sql(`UPDATE users SET shadow_banned = FALSE WHERE id = $1`, [userId]);
          await logAdminAction(adminNote, userId, 'unban', { reason });
          break;

        case 'shadow_ban':
          await sql(`UPDATE users SET shadow_banned = TRUE WHERE id = $1`, [userId]);
          await logAdminAction(adminNote, userId, 'shadow_ban', { reason });
          break;

        case 'remove_shadow_ban':
          await sql(`UPDATE users SET shadow_banned = FALSE WHERE id = $1`, [userId]);
          await logAdminAction(adminNote, userId, 'remove_shadow_ban', { reason });
          break;

        case 'temp_ban': {
          const hours = parseInt(value, 10);
          if (!hours || hours < 1) return res.status(400).json({ ok: false, error: 'Duration required' });
          // Store temp ban in admin_logs with expiry meta — enforce in your main api/index.js if needed
          await logAdminAction(adminNote, userId, 'temp_ban', { reason, hours, expires_at: new Date(Date.now() + hours * 3600000).toISOString() });
          break;
        }

        case 'adjust_pts': {
          const pts = parseInt(value, 10);
          if (isNaN(pts)) return res.status(400).json({ ok: false, error: 'Invalid points value' });
          await sql(`UPDATE users SET pts = GREATEST(0, pts + $1) WHERE id = $2`, [pts, userId]);
          await logAdminAction(adminNote, userId, 'adjust_pts', { delta: pts, reason });
          break;
        }

        case 'adjust_balance': {
          const amount = parseFloat(value);
          if (isNaN(amount)) return res.status(400).json({ ok: false, error: 'Invalid amount' });
          await sql(`UPDATE users SET balance_usd = GREATEST(0, balance_usd + $1) WHERE id = $2`, [amount, userId]);
          await logAdminAction(adminNote, userId, 'adjust_balance', { delta: amount, reason });
          break;
        }

        case 'adjust_risk': {
          const score = parseInt(value, 10);
          if (isNaN(score) || score < 0 || score > 200) return res.status(400).json({ ok: false, error: 'Risk score must be 0-200' });
          await sql(`UPDATE users SET risk_score = $1, risk_updated_at = NOW() WHERE id = $2`, [score, userId]);
          await logAdminAction(adminNote, userId, 'adjust_risk', { new_score: score, reason });
          break;
        }

        case 'adjust_referrals': {
          // Update referred_by count — add virtual referrals by direct pts grant
          const count = parseInt(value, 10);
          if (isNaN(count)) return res.status(400).json({ ok: false, error: 'Invalid count' });
          await logAdminAction(adminNote, userId, 'adjust_referrals', { delta: count, reason });
          break;
        }

        case 'reset_daily_ads':
          await sql(`UPDATE users SET daily_ads = 0, last_ad_date = NULL WHERE id = $1`, [userId]);
          await logAdminAction(adminNote, userId, 'reset_daily_ads', { reason });
          break;

        case 'approve_withdrawal': {
          const wId = parseInt(value, 10);
          const wRows = await sql(`SELECT * FROM withdrawals WHERE id = $1 AND user_id = $2`, [wId, userId]);
          if (!wRows[0]) return res.status(404).json({ ok: false, error: 'Withdrawal not found' });

          await sql(`UPDATE withdrawals SET status = 'done' WHERE id = $1`, [wId]);
          await logAdminAction(adminNote, userId, 'approve_withdrawal', { withdrawal_id: wId, reason });

          try {
            await sendTelegramMessage(user.telegram_id,
              `✅ *تم تنفيذ طلب السحب*\n\nتم تحويل مبلغ *$${parseFloat(wRows[0].amount).toFixed(2)}* إلى محفظتك بنجاح.`);
          } catch (e) {
            console.error('[notify error]', e.message);
          }
          break;
        }

        case 'reject_withdrawal': {
          const wId = parseInt(value, 10);
          const wRows = await sql(`SELECT * FROM withdrawals WHERE id = $1 AND user_id = $2`, [wId, userId]);
          if (wRows[0] && wRows[0].status === 'pending') {
            await sql(`UPDATE withdrawals SET status = 'rejected' WHERE id = $1`, [wId]);
            // Refund balance
            await sql(`UPDATE users SET balance_usd = balance_usd + $1 WHERE id = $2`, [wRows[0].amount, userId]);

            try {
              await sendTelegramMessage(user.telegram_id,
                `❌ *تم رفض طلب السحب*\n\nتم رفض طلب سحب بمبلغ *$${parseFloat(wRows[0].amount).toFixed(2)}* وإعادة المبلغ إلى رصيدك.${reason ? `\n\nالسبب: ${reason}` : ''}`);
            } catch (e) {
              console.error('[notify error]', e.message);
            }
          }
          await logAdminAction(adminNote, userId, 'reject_withdrawal', { withdrawal_id: wId, reason });
          break;
        }

        default:
          return res.status(400).json({ ok: false, error: `Unknown action: ${actionType}` });
      }

      return res.json({ ok: true });
    }

    // ══════════════════════════════════════════════════════════════════════
    //  COMPETITIONS
    // ══════════════════════════════════════════════════════════════════════
    if (action === 'competitions') {
      const comps = await sql(`
        SELECT c.*,
          (SELECT COUNT(DISTINCT user_id)::INT FROM ad_watches aw 
           WHERE aw.created_at BETWEEN c.start_at AND c.end_at) AS participant_count
        FROM competition c
        ORDER BY c.created_at DESC
      `);
      return res.json({ ok: true, competitions: comps });
    }

    if (action === 'competition_leaderboard') {
      const compId = parseInt(req.query.id, 10);
      const limit  = parseInt(req.query.limit || '50', 10);

      const comp = await sql(`SELECT * FROM competition WHERE id = $1`, [compId]);
      if (!comp[0]) return res.status(404).json({ ok: false, error: 'Competition not found' });

      const leaders = await sql(`
        SELECT 
          u.id, u.telegram_id,
          COALESCE(u.first_name, u.username, 'Anonymous') AS name,
          u.pts, u.photo_url, u.balance_usd,
          (SELECT COUNT(*)::INT FROM users r WHERE r.referred_by = u.telegram_id) AS referral_count,
          ROW_NUMBER() OVER (ORDER BY u.pts DESC, u.telegram_id ASC)::INT AS rank
        FROM users u
        ORDER BY u.pts DESC, u.telegram_id ASC
        LIMIT $1
      `, [limit]);

      return res.json({ ok: true, competition: comp[0], leaderboard: leaders });
    }

    if (action === 'competition_create' && req.method === 'POST') {
      const { name, start_at, end_at } = body;
      if (!name || !start_at || !end_at) return res.status(400).json({ ok: false, error: 'name, start_at, end_at required' });

      const comp = await sql(`
        INSERT INTO competition (name, start_at, end_at, active)
        VALUES ($1, $2, $3, FALSE)
        RETURNING *
      `, [name, start_at, end_at]);

      await logAdminAction(body.adminNote, null, 'competition_create', { name, start_at, end_at });
      return res.json({ ok: true, competition: comp[0] });
    }

    if (action === 'competition_update' && req.method === 'POST') {
      const { id, name, start_at, end_at, active } = body;
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });

      await sql(`
        UPDATE competition SET
          name     = COALESCE($1, name),
          start_at = COALESCE($2, start_at),
          end_at   = COALESCE($3, end_at),
          active   = COALESCE($4, active)
        WHERE id = $5
      `, [name, start_at, end_at, active, id]);

      await logAdminAction(body.adminNote, null, 'competition_update', { id, name, active });
      return res.json({ ok: true });
    }

    if (action === 'competition_activate' && req.method === 'POST') {
      const { id } = body;
      // Deactivate all, then activate target
      await sql(`UPDATE competition SET active = FALSE`);
      await sql(`UPDATE competition SET active = TRUE WHERE id = $1`, [id]);
      await logAdminAction(body.adminNote, null, 'competition_activate', { id });
      return res.json({ ok: true });
    }

    if (action === 'competition_end' && req.method === 'POST') {
      const { id } = body;
      await sql(`UPDATE competition SET active = FALSE, end_at = NOW() WHERE id = $1`, [id]);
      await logAdminAction(body.adminNote, null, 'competition_end', { id });
      return res.json({ ok: true });
    }

    if (action === 'competition_delete' && req.method === 'POST') {
      const { id } = body;
      await sql(`DELETE FROM competition WHERE id = $1 AND active = FALSE`, [id]);
      await logAdminAction(body.adminNote, null, 'competition_delete', { id });
      return res.json({ ok: true });
    }

    // ══════════════════════════════════════════════════════════════════════
    //  WITHDRAWALS
    // ══════════════════════════════════════════════════════════════════════
    if (action === 'withdrawals') {
      const page   = parseInt(req.query.page || '1', 10);
      const limit  = parseInt(req.query.limit || '50', 10);
      const status = req.query.status || 'all';
      const offset = (page - 1) * limit;

      let where = status !== 'all' ? `WHERE w.status = '${status.replace(/'/g,"''")}' ` : 'WHERE 1=1 ';

      const countRows = await sql(`SELECT COUNT(*)::INT AS count FROM withdrawals w ${where}`);
      const rows = await sql(`
        SELECT w.*,
          u.first_name, u.username, u.telegram_id, u.photo_url
        FROM withdrawals w
        JOIN users u ON u.id = w.user_id
        ${where}
        ORDER BY w.created_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]);

      return res.json({
        ok: true,
        withdrawals: rows,
        total: countRows[0].count,
        page,
        pages: Math.ceil(countRows[0].count / limit)
      });
    }

    // ══════════════════════════════════════════════════════════════════════
    //  NOTIFICATIONS
    // ══════════════════════════════════════════════════════════════════════
    if (action === 'send_notification' && req.method === 'POST') {
      const { target, userIds, title, text, photoUrl, buttons, scheduledAt, notifId: bodyNotifId, batchOffset } = body;

      if (!text) return res.status(400).json({ ok: false, error: 'text required' });

      // Build Telegram message
      const fullText = title ? `*${title}*\n\n${text}` : text;

      let inlineKeyboard = null;
      if (buttons && buttons.length > 0) {
        inlineKeyboard = { inline_keyboard: buttons.map(row =>
          Array.isArray(row)
            ? row.map(btn => ({ text: btn.label, url: btn.url }))
            : [{ text: row.label, url: row.url }]
        )};
      }

      const extra = inlineKeyboard ? { reply_markup: inlineKeyboard } : {};

      await sql(`CREATE TABLE IF NOT EXISTS notification_logs (
        id           SERIAL PRIMARY KEY,
        target       TEXT NOT NULL,
        title        TEXT,
        body         TEXT NOT NULL,
        photo_url    TEXT,
        buttons      JSONB,
        scheduled_at TIMESTAMPTZ,
        sent_at      TIMESTAMPTZ,
        sent_count   INT DEFAULT 0,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);

      const sendOne = async (chatId) => {
        if (photoUrl) await sendTelegramPhoto(chatId, photoUrl, fullText, extra);
        else await sendTelegramMessage(chatId, fullText, extra);
      };

      // ── Scheduled — only on first call, just save and return ──────────
      if (scheduledAt && new Date(scheduledAt) > new Date() && !bodyNotifId) {
        const notif = await sql(`
          INSERT INTO notification_logs (target, title, body, photo_url, buttons, scheduled_at)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id
        `, [target, title, text, photoUrl, JSON.stringify(buttons || []), scheduledAt]);
        return res.json({ ok: true, scheduled: true, notifId: notif[0].id });
      }

      // ── Broadcast to ALL users — processed in small batches to avoid
      //    function-timeout (the client loops calling this action with an
      //    increasing batchOffset until "done" is true) ─────────────────
      if (target === 'all') {
        const BATCH_SIZE = 20;
        let notifId = bodyNotifId;
        let offset = parseInt(batchOffset, 10) || 0;

        if (!notifId) {
          const notif = await sql(`
            INSERT INTO notification_logs (target, title, body, photo_url, buttons)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
          `, [target, title, text, photoUrl, JSON.stringify(buttons || [])]);
          notifId = notif[0].id;
        }

        const totalRows = await sql(`SELECT COUNT(*)::INT AS count FROM users WHERE shadow_banned = FALSE`);
        const total = totalRows[0].count;

        const recipients = await sql(
          `SELECT telegram_id FROM users WHERE shadow_banned = FALSE ORDER BY id LIMIT $1 OFFSET $2`,
          [BATCH_SIZE, offset]
        );

        let sentCount = 0;
        for (const r of recipients) {
          try {
            await sendOne(r.telegram_id);
            sentCount++;
          } catch (e) {
            console.error('[notify error]', e.message);
          }
        }

        const nextOffset = offset + BATCH_SIZE;
        const done = nextOffset >= total;

        await sql(
          `UPDATE notification_logs SET sent_count = sent_count + $1, sent_at = CASE WHEN $2 THEN NOW() ELSE sent_at END WHERE id = $3`,
          [sentCount, done, notifId]
        );

        if (done) await logAdminAction(body.adminNote, null, 'send_notification', { target, title });

        return res.json({ ok: true, notifId, sentCount, total, nextOffset, done });
      }

      // ── Targeted send — single user (by Telegram ID) or a small group ──
      let recipients = [];
      if (target === 'group' && userIds?.length) {
        recipients = await sql(`SELECT telegram_id FROM users WHERE id = ANY($1::int[])`, [userIds]);
      } else if (target === 'user' && userIds?.length === 1) {
        recipients = await sql(`SELECT telegram_id FROM users WHERE telegram_id = $1`, [userIds[0]]);
      }

      if (!recipients.length) {
        return res.status(400).json({ ok: false, error: 'لم يتم العثور على مستخدم بهذا الـ Telegram ID' });
      }

      const notif = await sql(`
        INSERT INTO notification_logs (target, title, body, photo_url, buttons)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `, [target, title, text, photoUrl, JSON.stringify(buttons || [])]);

      let sentCount = 0;
      for (const r of recipients) {
        try {
          await sendOne(r.telegram_id);
          sentCount++;
        } catch (e) {
          console.error('[notify error]', e.message);
        }
      }

      await sql(`UPDATE notification_logs SET sent_at = NOW(), sent_count = $1 WHERE id = $2`,
        [sentCount, notif[0].id]);

      await logAdminAction(body.adminNote, null, 'send_notification', { target, sentCount, title });
      return res.json({ ok: true, sentCount, notifId: notif[0].id, done: true });
    }

    if (action === 'notifications_log') {
      const page  = parseInt(req.query.page || '1', 10);
      const limit = parseInt(req.query.limit || '20', 10);
      const offset = (page - 1) * limit;

      await sql(`CREATE TABLE IF NOT EXISTS notification_logs (
        id           SERIAL PRIMARY KEY,
        target       TEXT NOT NULL,
        title        TEXT,
        body         TEXT NOT NULL,
        photo_url    TEXT,
        buttons      JSONB,
        scheduled_at TIMESTAMPTZ,
        sent_at      TIMESTAMPTZ,
        sent_count   INT DEFAULT 0,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);

      const countRows = await sql(`SELECT COUNT(*)::INT AS count FROM notification_logs`);
      const logs = await sql(`SELECT * FROM notification_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);

      return res.json({
        ok: true,
        logs,
        total: countRows[0].count,
        page,
        pages: Math.ceil(countRows[0].count / limit)
      });
    }

    // ══════════════════════════════════════════════════════════════════════
    //  ANALYTICS
    // ══════════════════════════════════════════════════════════════════════
    if (action === 'analytics') {
      const period = req.query.period || '30'; // days

      const [userGrowth, dailyAds, referralStats, balanceStats, adRewardStats] = await Promise.all([
        sql(`SELECT DATE(created_at) AS day, COUNT(*)::INT AS users
             FROM users WHERE created_at >= NOW() - INTERVAL '${parseInt(period)}  days'
             GROUP BY DATE(created_at) ORDER BY day ASC`),
        sql(`SELECT DATE(created_at) AS day, COUNT(*)::INT AS watches, SUM(reward)::BIGINT AS total_reward
             FROM ad_watches WHERE created_at >= NOW() - INTERVAL '${parseInt(period)} days'
             GROUP BY DATE(created_at) ORDER BY day ASC`),
        sql(`SELECT DATE(created_at) AS day, COUNT(*)::INT AS joins
             FROM users WHERE referred_by IS NOT NULL
             AND created_at >= NOW() - INTERVAL '${parseInt(period)} days'
             GROUP BY DATE(created_at) ORDER BY day ASC`),
        sql(`SELECT DATE(created_at) AS day, SUM(amount)::NUMERIC AS withdrawn
             FROM withdrawals WHERE status = 'done'
             AND created_at >= NOW() - INTERVAL '${parseInt(period)} days'
             GROUP BY DATE(created_at) ORDER BY day ASC`),
        sql(`SELECT 
               COUNT(*)::INT AS total_sessions,
               COUNT(CASE WHEN used = TRUE THEN 1 END)::INT AS completed,
               COUNT(CASE WHEN used = FALSE THEN 1 END)::INT AS abandoned
             FROM ad_sessions
             WHERE created_at >= NOW() - INTERVAL '${parseInt(period)} days'`),
      ]);

      return res.json({
        ok: true,
        analytics: {
          userGrowth,
          dailyAds,
          referralStats,
          balanceStats,
          adRewardStats: adRewardStats[0],
        }
      });
    }

    // ══════════════════════════════════════════════════════════════════════
    //  SECURITY / AUDIT LOG
    // ══════════════════════════════════════════════════════════════════════
    if (action === 'security') {
      const page   = parseInt(req.query.page || '1', 10);
      const limit  = parseInt(req.query.limit || '50', 10);
      const offset = (page - 1) * limit;

      const [highRiskUsers, recentActivity, adminActions] = await Promise.all([
        sql(`SELECT u.id, u.telegram_id, u.first_name, u.username, u.risk_score, u.shadow_banned,
                    u.last_ad_watch, u.daily_ads
             FROM users u WHERE u.risk_score > 0
             ORDER BY u.risk_score DESC LIMIT 20`),
        sql(`SELECT al.*, u.first_name, u.username, u.telegram_id
             FROM activity_logs al
             JOIN users u ON u.id = al.user_id
             ORDER BY al.created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]),
        sql(`SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT 20`).catch(() => []),
      ]);

      return res.json({
        ok: true,
        highRiskUsers,
        recentActivity,
        adminActions,
      });
    }

    // ══════════════════════════════════════════════════════════════════════
    //  EXPORT CSV
    // ══════════════════════════════════════════════════════════════════════
    if (action === 'export_users') {
      const users = await sql(`
        SELECT 
          u.id, u.telegram_id, u.username, u.first_name,
          u.pts, u.balance_usd, u.risk_score, u.shadow_banned,
          u.created_at, u.last_ad_watch, u.daily_ads, u.referral_code,
          (SELECT COUNT(*)::INT FROM users r WHERE r.referred_by = u.telegram_id) AS referral_count
        FROM users u ORDER BY u.created_at DESC
      `);

      const headers = ['id','telegram_id','username','first_name','pts','balance_usd','risk_score','shadow_banned','created_at','last_ad_watch','daily_ads','referral_code','referral_count'];
      const csv = [
        headers.join(','),
        ...users.map(u => headers.map(h => {
          const v = u[h];
          if (v === null || v === undefined) return '';
          const s = String(v);
          return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g,'""')}"` : s;
        }).join(','))
      ].join('\n');

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
      return res.send(csv);
    }

    if (action === 'export_withdrawals') {
      const rows = await sql(`
        SELECT w.id, w.address, w.memo, w.amount, w.status, w.created_at,
               u.first_name, u.username, u.telegram_id
        FROM withdrawals w JOIN users u ON u.id = w.user_id
        ORDER BY w.created_at DESC
      `);

      const headers = ['id','telegram_id','first_name','username','address','memo','amount','status','created_at'];
      const csv = [
        headers.join(','),
        ...rows.map(r => headers.map(h => {
          const v = r[h];
          if (v === null || v === undefined) return '';
          const s = String(v);
          return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g,'""')}"` : s;
        }).join(','))
      ].join('\n');

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="withdrawals.csv"');
      return res.send(csv);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  ADMIN LOGS
    // ══════════════════════════════════════════════════════════════════════
    if (action === 'admin_logs') {
      const page  = parseInt(req.query.page || '1', 10);
      const limit = parseInt(req.query.limit || '50', 10);
      const offset = (page - 1) * limit;

      await sql(`CREATE TABLE IF NOT EXISTS admin_logs (
        id          SERIAL PRIMARY KEY,
        admin_note  TEXT,
        target_user INT,
        action      TEXT NOT NULL,
        meta        JSONB NOT NULL DEFAULT '{}',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);

      const countRows = await sql(`SELECT COUNT(*)::INT AS count FROM admin_logs`);
      const logs = await sql(`
        SELECT al.*,
          u.first_name, u.username, u.telegram_id
        FROM admin_logs al
        LEFT JOIN users u ON u.id = al.target_user
        ORDER BY al.created_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]);

      return res.json({
        ok: true,
        logs,
        total: countRows[0].count,
        page,
        pages: Math.ceil(countRows[0].count / limit)
      });
    }

    return res.status(400).json({ ok: false, error: `Unknown action: "${action}"` });

  } catch (err) {
    console.error('[Admin handler error]', action, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
