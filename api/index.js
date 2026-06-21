// ══════════════════════════════════════════════════════════════════════════════
//  api/admin/index.js  —  BigLeague Admin Panel · Vercel Serverless Function
//  ملف مستقل تماماً عن api/index.js — منعاً لأي تأثير على المستخدمين الحقيقيين
//  لو حصل أي خطأ هنا، التطبيق الأساسي مش هيتأثر إطلاقاً (functions منفصلة على Vercel)
// ══════════════════════════════════════════════════════════════════════════════

const { neon } = require('@neondatabase/serverless');

const DATABASE_URL = process.env.DATABASE_URL;
const BOT_TOKEN    = process.env.BOT_TOKEN;
const ADMIN_SECRET = process.env.ADMIN_SECRET; // ✅ Fixed: was INTERNAL_SECRET

if (!ADMIN_SECRET) {
  throw new Error('[FATAL] ADMIN_SECRET env var is not set — refusing to run with an insecure fallback key');
}

const _db = neon(DATABASE_URL);
async function sql(query, params = []) {
  return await _db(query, params);
}

async function sendTelegramMessage(chatId, text) {
  if (!BOT_TOKEN) return { ok: false };
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: String(chatId), text, parse_mode: 'Markdown' })
  });
  const json = await res.json();
  // 🛡️ لو فشل بسبب Markdown parse error، إعادة المحاولة كـ نص عادي
  if (!json.ok && /can't parse entities/i.test(json.description || '')) {
    const retry = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId), text })
    });
    return await retry.json();
  }
  return json;
}

async function sendTelegramPhoto(chatId, photoBuffer, mimetype, caption) {
  if (!BOT_TOKEN) return { ok: false };
  const doSend = async (withMarkdown) => {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) {
      form.append('caption', caption);
      if (withMarkdown) form.append('parse_mode', 'Markdown');
    }
    form.append('photo', new Blob([photoBuffer], { type: mimetype || 'image/jpeg' }), 'photo.jpg');
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form });
    return await r.json();
  };
  const json = await doSend(true);
  // 🛡️ نفس مشكلة الـ Markdown parse error — إعادة محاولة بدون تنسيق
  if (!json.ok && /can't parse entities/i.test(json.description || '')) {
    return await doSend(false);
  }
  return json;
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

// ══════════════════════════════════════════════════════════════════════════════
//  Main Export
// ══════════════════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  // ── CORS مفتوح — اللوحة صفحة مستقلة (مش Telegram WebApp)، الحماية على السر مش الـ Origin
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Secret'); // ✅ Fixed
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const body = req.body || {};
  const { type, data = {} } = body;

  // 🛡️ فحص واحد لكل الراوتر — كل الـ types هنا أدمن فقط
  const providedSecret = req.headers['x-admin-secret'] || data.secret || ''; // ✅ Fixed
  if (providedSecret !== ADMIN_SECRET) { // ✅ Fixed
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  try {
    switch (type) {

      // ────────────────────────────────────────────────────────────────────
      case 'adminStats': {
        const range = Math.max(1, Math.min(90, parseInt(data.range, 10) || 7));

        const [totals, newUsersRows, adsRows, pendingRows, activityRows, recentRows, competition] = await Promise.all([
          sql(`SELECT COUNT(*)::INT AS total_users,
                      COALESCE(SUM(pts),0)::BIGINT AS total_pts,
                      COALESCE(SUM(balance_usd),0)::NUMERIC AS total_balance
               FROM users`),
          sql(`SELECT COUNT(*)::INT AS count FROM users WHERE created_at >= NOW() - INTERVAL '${range} days'`),
          sql(`SELECT COUNT(*)::INT AS total,
                      COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::INT AS today
               FROM ad_watches`),
          sql(`SELECT COUNT(*)::INT AS count FROM withdrawals WHERE status = 'pending'`),
          sql(`SELECT DATE(created_at) AS day, COUNT(*)::INT AS count
               FROM ad_watches
               WHERE created_at >= NOW() - INTERVAL '${range} days'
               GROUP BY DATE(created_at) ORDER BY day ASC`),
          sql(`SELECT telegram_id, first_name, username, photo_url, pts, created_at
               FROM users ORDER BY created_at DESC LIMIT 8`),
          getActiveCompetition()
        ]);

        return res.json({
          ok: true,
          stats: {
            total_users:         totals[0].total_users,
            new_users:           newUsersRows[0].count,
            total_pts:           Number(totals[0].total_pts),
            total_balance:       parseFloat(totals[0].total_balance),
            pending_withdrawals: pendingRows[0].count,
            total_ads:           adsRows[0].total,
            today_ads:           adsRows[0].today,
          },
          activity: activityRows.map(a => ({ day: a.day, count: a.count })),
          recent_users: recentRows.map(u => ({
            telegram_id: Number(u.telegram_id),
            first_name:  u.first_name,
            username:    u.username,
            photo_url:   u.photo_url,
            created_at:  u.created_at,
            pts:         Number(u.pts)
          })),
          competition: { name: competition?.name || 'Season 1' }
        });
      }

      // ────────────────────────────────────────────────────────────────────
      case 'adminOnlineUsers': {
        const rows = await sql(`
          SELECT telegram_id, first_name, username, photo_url
          FROM users
          WHERE last_seen_at >= NOW() - INTERVAL '5 minutes'
          ORDER BY last_seen_at DESC
          LIMIT 50
        `);

        return res.json({
          ok: true,
          count: rows.length,
          users: rows.map(u => ({
            telegram_id: Number(u.telegram_id),
            first_name:  u.first_name,
            username:    u.username,
            photo_url:   u.photo_url
          }))
        });
      }

      // ────────────────────────────────────────────────────────────────────
      case 'adminUsers': {
        const page   = Math.max(1, parseInt(data.page, 10) || 1);
        const limit  = Math.min(200, Math.max(1, parseInt(data.limit, 10) || 20));
        const offset = (page - 1) * limit;
        const filter = data.filter || 'all';
        const search = (data.search || '').trim();

        const conditions = [];
        const params     = [];
        if (filter === 'banned') conditions.push(`banned = TRUE`);
        if (filter === 'shadow') conditions.push(`shadow_banned = TRUE`);
        if (search) {
          params.push(`%${search}%`);
          const likeIdx = params.length;
          if (/^\d+$/.test(search)) {
            // 🔍 بحث جزئي بالـ ID (مش لازم الرقم كامل) + الاسم/اليوزرنيم لو فيهم أرقام
            conditions.push(`(first_name ILIKE $${likeIdx} OR username ILIKE $${likeIdx} OR telegram_id::TEXT ILIKE $${likeIdx})`);
          } else {
            conditions.push(`(first_name ILIKE $${likeIdx} OR username ILIKE $${likeIdx})`);
          }
        }
        const where   = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const orderBy = filter === 'top' ? 'pts DESC' : 'created_at DESC';

        const [countRows, rows] = await Promise.all([
          sql(`SELECT COUNT(*)::INT AS count FROM users ${where}`, params),
          sql(`SELECT telegram_id, first_name, username, photo_url, pts, balance_usd, daily_ads, banned, shadow_banned
               FROM users ${where} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`, params)
        ]);

        return res.json({
          ok: true,
          users: rows.map(u => ({
            telegram_id:   Number(u.telegram_id),
            first_name:    u.first_name,
            username:      u.username,
            photo_url:     u.photo_url,
            pts:           Number(u.pts),
            balance_usd:   parseFloat(u.balance_usd),
            daily_ads:     u.daily_ads,
            banned:        u.banned,
            shadow_banned: u.shadow_banned
          })),
          total: countRows[0].count
        });
      }


      // ────────────────────────────────────────────────────────────────────
      case 'adminWithdrawals': {
        const page   = Math.max(1, parseInt(data.page, 10) || 1);
        const limit  = Math.min(50, Math.max(1, parseInt(data.limit, 10) || 20));
        const offset = (page - 1) * limit;
        const status = (data.status && data.status !== 'all') ? data.status : null;

        const where  = status ? `WHERE w.status = $1` : '';
        const params = status ? [status] : [];

        const [countRows, rows] = await Promise.all([
          sql(`SELECT COUNT(*)::INT AS count FROM withdrawals w ${where}`, params),
          sql(`SELECT w.id, w.address, w.memo, w.amount, w.status, w.created_at,
                      u.first_name, u.username, u.telegram_id
               FROM withdrawals w JOIN users u ON u.id = w.user_id
               ${where}
               ORDER BY w.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params)
        ]);

        return res.json({
          ok: true,
          withdrawals: rows.map(w => ({
            id:          w.id,
            address:     w.address,
            memo:        w.memo,
            amount:      parseFloat(w.amount),
            status:      w.status,
            created_at:  w.created_at,
            first_name:  w.first_name,
            username:    w.username,
            telegram_id: Number(w.telegram_id)
          })),
          total: countRows[0].count
        });
      }

      // ────────────────────────────────────────────────────────────────────
      case 'adminUpdateWithdrawal': {
        const id      = parseInt(data.id, 10);
        const status  = data.status;
        const allowed = ['pending', 'approved', 'rejected', 'paid'];
        if (!id || !allowed.includes(status)) {
          return res.status(400).json({ ok: false, error: 'Invalid request' });
        }

        const wRows = await sql(`SELECT * FROM withdrawals WHERE id = $1`, [id]);
        if (!wRows.length) return res.status(404).json({ ok: false, error: 'Withdrawal not found' });
        const w = wRows[0];

        // 🛡️ الرصيد اتخصم وقت إنشاء طلب السحب — الرفض لازم يرجّعه
        if (status === 'rejected' && w.status !== 'rejected') {
          await sql(`UPDATE users SET balance_usd = balance_usd + $1 WHERE id = $2`, [w.amount, w.user_id]);
        }

        await sql(`UPDATE withdrawals SET status = $1 WHERE id = $2`, [status, id]);

        const uRows = await sql(`SELECT telegram_id FROM users WHERE id = $1`, [w.user_id]);
        const labels = {
          approved: '✅ Your withdrawal request has been approved',
          rejected: '❌ Your withdrawal request was rejected — the amount was refunded to your balance',
          paid:     '💸 Your withdrawal has been paid'
        };
        if (uRows.length && labels[status]) {
          sendTelegramMessage(
            Number(uRows[0].telegram_id),
            `${labels[status]}\nAmount: *$${parseFloat(w.amount).toFixed(2)}*`
          ).catch(e => console.error('[withdrawal status bot notify]', e.message));
        }

        return res.json({ ok: true });
      }

      // ────────────────────────────────────────────────────────────────────
      case 'adminActivityLogs': {
        const page        = Math.max(1, parseInt(data.page, 10) || 1);
        const limit       = Math.min(100, Math.max(1, parseInt(data.limit, 10) || 30));
        const offset      = (page - 1) * limit;
        const actionFilter = (data.action || '').trim();

        const where  = actionFilter ? `WHERE al.action = $1` : '';
        const params = actionFilter ? [actionFilter] : [];

        const rows = await sql(`
          SELECT al.action, al.meta, al.created_at, u.first_name, u.username
          FROM activity_logs al
          JOIN users u ON u.id = al.user_id
          ${where}
          ORDER BY al.created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `, params);

        return res.json({ ok: true, logs: rows });
      }

      // ────────────────────────────────────────────────────────────────────
      case 'adminUserDetail': {
        const tgId = data.telegram_id;
        if (!tgId) return res.status(400).json({ ok: false, error: 'telegram_id required' });

        const uRows = await sql(`SELECT * FROM users WHERE telegram_id = $1`, [tgId]);
        if (!uRows.length) return res.status(404).json({ ok: false, error: 'User not found' });
        const u = uRows[0];

        const [adStats, refRows] = await Promise.all([
          sql(`SELECT COUNT(*)::INT AS total, COALESCE(SUM(reward),0)::BIGINT AS total_reward
               FROM ad_watches WHERE user_id = $1`, [u.id]),
          sql(`SELECT COUNT(*)::INT AS count FROM users WHERE referred_by = $1`, [u.telegram_id])
        ]);

        return res.json({
          ok: true,
          user: {
            telegram_id:   Number(u.telegram_id),
            first_name:    u.first_name,
            username:      u.username,
            photo_url:     u.photo_url,
            pts:           Number(u.pts),
            balance_usd:   parseFloat(u.balance_usd),
            daily_ads:     u.daily_ads,
            risk_score:    u.risk_score,
            banned:        u.banned,
            shadow_banned: u.shadow_banned,
            created_at:    u.created_at,
            last_ad_watch: u.last_ad_watch,
            referral_code: u.referral_code
          },
          ad_stats: {
            total:        adStats[0].total,
            total_reward: Number(adStats[0].total_reward)
          },
          referrals: refRows[0].count
        });
      }

      // ────────────────────────────────────────────────────────────────────
      case 'adminUserReferrals': {
        const tgId   = data.telegram_id;
        if (!tgId) return res.status(400).json({ ok: false, error: 'telegram_id required' });
        const page   = Math.max(1, parseInt(data.page, 10) || 1);
        const limit  = Math.min(50, Math.max(1, parseInt(data.limit, 10) || 20));
        const offset = (page - 1) * limit;

        const [countRows, rows] = await Promise.all([
          sql(`SELECT COUNT(*)::INT AS count FROM users WHERE referred_by = $1`, [tgId]),
          sql(`SELECT telegram_id, first_name, username, photo_url, pts, balance_usd, created_at
               FROM users WHERE referred_by = $1
               ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, [tgId])
        ]);

        return res.json({
          ok: true,
          referrals: rows.map(u => ({
            telegram_id: Number(u.telegram_id),
            first_name:  u.first_name,
            username:    u.username,
            photo_url:   u.photo_url,
            pts:         Number(u.pts),
            balance_usd: parseFloat(u.balance_usd),
            created_at:  u.created_at
          })),
          total: countRows[0].count
        });
      }

      // ────────────────────────────────────────────────────────────────────
      case 'adminAdjustUser': {
        const tgId = data.telegram_id;
        if (!tgId) return res.status(400).json({ ok: false, error: 'telegram_id required' });

        const hasPts     = data.pts !== undefined && data.pts !== null && data.pts !== '';
        const hasBalance = data.balance_usd !== undefined && data.balance_usd !== null && data.balance_usd !== '';
        if (!hasPts && !hasBalance) {
          return res.status(400).json({ ok: false, error: 'لازم تبعت نقاط أو رصيد على الأقل' });
        }

        const newPts     = hasPts ? Math.trunc(Number(data.pts)) : null;
        const newBalance = hasBalance ? Number(data.balance_usd) : null;
        if (hasPts && (!Number.isFinite(newPts) || newPts < 0)) {
          return res.status(400).json({ ok: false, error: 'قيمة النقاط غير صحيحة' });
        }
        if (hasBalance && (!Number.isFinite(newBalance) || newBalance < 0)) {
          return res.status(400).json({ ok: false, error: 'قيمة الرصيد غير صحيحة' });
        }

        const uRows = await sql(`SELECT id, pts, balance_usd FROM users WHERE telegram_id = $1`, [tgId]);
        if (!uRows.length) return res.status(404).json({ ok: false, error: 'User not found' });
        const before = uRows[0];

        // ✅ UPDATE...RETURNING ذرّية — متوافقة مع Neon HTTP (بدون transactions)
        const rows = await sql(`
          UPDATE users
          SET pts = COALESCE($1, pts),
              balance_usd = COALESCE($2, balance_usd)
          WHERE telegram_id = $3
          RETURNING pts, balance_usd
        `, [newPts, newBalance, tgId]);
        const after = rows[0];

        await sql(`
          INSERT INTO activity_logs (user_id, action, meta, created_at)
          VALUES ($1, 'admin_adjust_pts', $2, NOW())
        `, [before.id, JSON.stringify({
              pts_before:     Number(before.pts),
              pts_after:      Number(after.pts),
              balance_before: parseFloat(before.balance_usd),
              balance_after:  parseFloat(after.balance_usd)
            })]).catch(e => console.error('[adminAdjustUser log]', e.message));

        return res.json({
          ok: true,
          pts: Number(after.pts),
          balance_usd: parseFloat(after.balance_usd)
        });
      }

      // ────────────────────────────────────────────────────────────────────
      case 'banUser': {
        const tgId  = data.telegram_id;
        const unban = !!data.unban;
        if (!tgId) return res.status(400).json({ ok: false, error: 'telegram_id required' });

        await sql(`UPDATE users SET banned = $1 WHERE telegram_id = $2`, [!unban, tgId]);
        return res.json({ ok: true });
      }

      // ────────────────────────────────────────────────────────────────────
      //  🏆 Competitions
      // ────────────────────────────────────────────────────────────────────
      case 'adminCompetitions': {
        const rows = await sql(`
          SELECT id, name, start_at, end_at, active, prize_distributed, created_at
          FROM competition
          ORDER BY created_at DESC
          LIMIT 30
        `);
        return res.json({ ok: true, competitions: rows });
      }

      case 'adminCompetitionCreate': {
        const name        = (data.name || '').trim();
        const days        = Math.max(1, Math.min(365, parseInt(data.duration_days, 10) || 20));
        const activateNow = !!data.activate_now;
        if (!name) return res.status(400).json({ ok: false, error: 'اسم الموسم مطلوب' });

        if (activateNow) {
          await sql(`UPDATE competition SET active = FALSE WHERE active = TRUE`);
        }

        const rows = await sql(`
          INSERT INTO competition (name, start_at, end_at, active, prize_distributed)
          VALUES ($1, NOW(), NOW() + ($2 || ' days')::INTERVAL, $3, FALSE)
          RETURNING id, name, start_at, end_at, active
        `, [name, String(days), activateNow]);

        return res.json({ ok: true, competition: rows[0] });
      }

      case 'adminCompetitionActivate': {
        const id = parseInt(data.id, 10);
        if (!id) return res.status(400).json({ ok: false, error: 'competition id required' });

        const rows = await sql(`SELECT id, prize_distributed FROM competition WHERE id = $1`, [id]);
        if (!rows.length) return res.status(404).json({ ok: false, error: 'Competition not found' });
        if (rows[0].prize_distributed) {
          return res.status(400).json({ ok: false, error: 'هذا الموسم انتهى وتم توزيع جوائزه بالفعل، لا يمكن إعادة تفعيله' });
        }

        await sql(`UPDATE competition SET active = FALSE WHERE active = TRUE`);
        await sql(`UPDATE competition SET active = TRUE WHERE id = $1`, [id]);

        return res.json({ ok: true });
      }

      case 'adminCompetitionEnd': {
        const rows = await sql(`
          UPDATE competition
          SET end_at = NOW()
          WHERE active = TRUE AND prize_distributed = FALSE
          RETURNING id, name
        `);
        if (!rows.length) return res.status(400).json({ ok: false, error: 'لا يوجد موسم نشط حالياً' });

        return res.json({
          ok: true,
          name: rows[0].name,
          note: 'هينتهي تلقائياً وتتوزع الجوائز مع أول طلب حقيقي من أي يوزر (عادة خلال ثواني)'
        });
      }

      // ────────────────────────────────────────────────────────────────────
      case 'adminBroadcast': {
        const text      = (data.text || '').trim();
        const photoB64  = (data.photo_base64 || '').trim();
        const photoMime = data.photo_mimetype || 'image/jpeg';

        if (!text && !photoB64) {
          return res.status(400).json({ ok: false, error: 'لازم نص أو صورة على الأقل' });
        }

        // 🛡️ كابشن الصورة في تليجرام محدود بـ 1024 حرف
        const caption = photoB64 ? text.slice(0, 1024) : text;

        let photoBuffer = null;
        if (photoB64) {
          // ~7M base64 ≈ 5MB صورة فعلية — حد أمان لتفادي تخطي حجم الطلب على Vercel
          if (photoB64.length > 7_000_000) {
            return res.status(400).json({ ok: false, error: 'حجم الصورة كبير جداً' });
          }
          try { photoBuffer = Buffer.from(photoB64, 'base64'); }
          catch { return res.status(400).json({ ok: false, error: 'صورة غير صالحة' }); }
        }

        const sendOne = (chatId) => photoBuffer
          ? sendTelegramPhoto(chatId, photoBuffer, photoMime, caption)
          : sendTelegramMessage(chatId, text);

        // رسالة مباشرة لمستخدم واحد
        if (data.telegram_id) {
          const result = await sendOne(Number(data.telegram_id));
          if (!result.ok) return res.status(400).json({ ok: false, error: result.description || 'Failed to send' });
          return res.json({ ok: true, sent: 1, failed: 0 });
        }

        // بث جماعي — على دفعات متوازية لتفادي timeout على Vercel
        const allUsers   = await sql(`SELECT telegram_id FROM users WHERE banned = FALSE`);
        const BATCH_SIZE = photoBuffer ? 10 : 25; // دفعات أصغر للصور لأنها أبطأ في الرفع
        let sent = 0, failed = 0;
        for (let i = 0; i < allUsers.length; i += BATCH_SIZE) {
          const batch   = allUsers.slice(i, i + BATCH_SIZE);
          const results = await Promise.all(
            batch.map(u => sendOne(Number(u.telegram_id)).catch(() => ({ ok: false })))
          );
          results.forEach(r => { if (r.ok) sent++; else failed++; });
        }
        return res.json({ ok: true, sent, failed });
      }

      // ────────────────────────────────────────────────────────────────────
      case 'adminUpdateRiskScore': {
        const tgId = data.telegram_id;
        const score = parseInt(data.risk_score, 10);
        if (!tgId || isNaN(score) || score < 0 || score > 100) {
          return res.status(400).json({ ok: false, error: 'telegram_id و risk_score (0-100) مطلوبان' });
        }
        await sql(`UPDATE users SET risk_score = $1 WHERE telegram_id = $2`, [score, tgId]);
        return res.json({ ok: true });
      }

      // ────────────────────────────────────────────────────────────────────
      case 'adminToggleShadowBan': {
        const tgId  = data.telegram_id;
        const enable = !!data.enable;
        if (!tgId) return res.status(400).json({ ok: false, error: 'telegram_id required' });
        await sql(`UPDATE users SET shadow_banned = $1 WHERE telegram_id = $2`, [enable, tgId]);
        return res.json({ ok: true });
      }

      // ────────────────────────────────────────────────────────────────────
      case 'adminUserSessions': {
        const tgId = data.telegram_id;
        if (!tgId) return res.status(400).json({ ok: false, error: 'telegram_id required' });
        const uRows = await sql(`SELECT id FROM users WHERE telegram_id = $1`, [tgId]);
        if (!uRows.length) return res.status(404).json({ ok: false, error: 'User not found' });
        const rows = await sql(`
          SELECT id, device_fingerprint, created_at, last_active_at, risk_flags
          FROM sessions
          WHERE user_id = $1
          ORDER BY last_active_at DESC
          LIMIT 10
        `, [uRows[0].id]);
        return res.json({ ok: true, sessions: rows });
      }

      // ────────────────────────────────────────────────────────────────────
      case 'adminDeleteUser': {
        const tgId = data.telegram_id;
        if (!tgId) return res.status(400).json({ ok: false, error: 'telegram_id required' });
        const uRows = await sql(`SELECT id FROM users WHERE telegram_id = $1`, [tgId]);
        if (!uRows.length) return res.status(404).json({ ok: false, error: 'User not found' });
        const uid = uRows[0].id;
        // cascade manual delete to avoid FK issues on DBs without cascade
        await sql(`DELETE FROM sessions WHERE user_id = $1`, [uid]);
        await sql(`DELETE FROM ad_watches WHERE user_id = $1`, [uid]);
        await sql(`DELETE FROM withdrawals WHERE user_id = $1`, [uid]);
        await sql(`DELETE FROM activity_logs WHERE user_id = $1`, [uid]);
        await sql(`DELETE FROM danger WHERE user_id = $1`, [uid]).catch(()=>{});
        await sql(`DELETE FROM users WHERE id = $1`, [uid]);
        return res.json({ ok: true });
      }

      // ────────────────────────────────────────────────────────────────────
      default:
        return res.status(400).json({ ok: false, error: `Unknown type: "${type}"` });
    }
  } catch (err) {
    console.error('[Admin handler error]', type, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
