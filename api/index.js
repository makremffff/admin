// ══════════════════════════════════════════════════════════════════════════════
//  api/admin/index.js  —  BigLeague Admin Panel · Vercel Serverless Function
//  ملف مستقل تماماً عن api/index.js — منعاً لأي تأثير على المستخدمين الحقيقيين
//  لو حصل أي خطأ هنا، التطبيق الأساسي مش هيتأثر إطلاقاً (functions منفصلة على Vercel)
// ══════════════════════════════════════════════════════════════════════════════

const { neon } = require('@neondatabase/serverless');

const DATABASE_URL    = process.env.DATABASE_URL;
const BOT_TOKEN       = process.env.BOT_TOKEN;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET; // نفس المتغيّر المستخدم في api/index.js

if (!INTERNAL_SECRET) {
  throw new Error('[FATAL] INTERNAL_SECRET env var is not set — refusing to run with an insecure fallback key');
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
  return await res.json();
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Internal-Secret');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const body = req.body || {};
  const { type, data = {} } = body;

  // 🛡️ فحص واحد لكل الراوتر — كل الـ types هنا أدمن فقط، محمية بـ INTERNAL_SECRET
  const providedSecret = req.headers['x-internal-secret'] || data.secret || '';
  if (providedSecret !== INTERNAL_SECRET) {
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
        // "متصل الآن" = آخر ظهور خلال 5 دقائق (last_seen_at يُحدَّث في api/index.js مع كل طلب موثّق)
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
        const limit  = Math.min(50, Math.max(1, parseInt(data.limit, 10) || 20));
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
            params.push(search);
            conditions.push(`(first_name ILIKE $${likeIdx} OR username ILIKE $${likeIdx} OR telegram_id::TEXT = $${params.length})`);
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
        const limit        = Math.min(100, Math.max(1, parseInt(data.limit, 10) || 30));
        const offset       = (page - 1) * limit;
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
      case 'banUser': {
        const tgId   = data.telegram_id;
        const unban  = !!data.unban;
        if (!tgId) return res.status(400).json({ ok: false, error: 'telegram_id required' });

        await sql(`UPDATE users SET banned = $1 WHERE telegram_id = $2`, [!unban, tgId]);
        return res.json({ ok: true });
      }

      // ────────────────────────────────────────────────────────────────────
      //  🏆 Competitions — السيرفر الرئيسي (api/index.js) هو المسؤول الوحيد عن
      //  منطق توزيع الجوائز (distributeSeasonPrizes) — هنا بس بنتحكم في
      //  الـ rows (إنشاء/تفعيل/تحريك تاريخ الانتهاء)، من غير تكرار منطق التوزيع
      //  حتى لا يحصل تعارض في قيم الجوائز بين الملفين.
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
        const name         = (data.name || '').trim();
        const days         = Math.max(1, Math.min(365, parseInt(data.duration_days, 10) || 20));
        const activateNow  = !!data.activate_now;
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
        // 🛡️ مبنديش الجوائز هنا — بس بنقرّب end_at لـ NOW() عشان distributeSeasonPrizes()
        // في api/index.js (اللي بيشتغل مع أول طلب حقيقي من أي يوزر) يتكفّل بالتوزيع
        // بنفس المنطق المُختبَر، من غير ما نكرره هنا ونخاطر بتعارض في قيم الجوائز.
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
        const text = (data.text || '').trim();
        if (!text) return res.status(400).json({ ok: false, error: 'Message text required' });

        // رسالة مباشرة لمستخدم واحد (DM من نافذة المستخدم)
        if (data.telegram_id) {
          const result = await sendTelegramMessage(Number(data.telegram_id), text);
          if (!result.ok) return res.status(400).json({ ok: false, error: result.description || 'Failed to send' });
          return res.json({ ok: true, sent: 1, failed: 0 });
        }

        // بث جماعي — على دفعات متوازية لتفادي timeout على Vercel
        const allUsers   = await sql(`SELECT telegram_id FROM users WHERE banned = FALSE`);
        const BATCH_SIZE = 25;
        let sent = 0, failed = 0;
        for (let i = 0; i < allUsers.length; i += BATCH_SIZE) {
          const batch   = allUsers.slice(i, i + BATCH_SIZE);
          const results = await Promise.all(
            batch.map(u => sendTelegramMessage(Number(u.telegram_id), text).catch(() => ({ ok: false })))
          );
          results.forEach(r => { if (r.ok) sent++; else failed++; });
        }
        return res.json({ ok: true, sent, failed });
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
