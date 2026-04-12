// ================================================================
//  Tomato Farm — Admin API
//  ضع هذا الملف في: api/admin.js
//  ضع قيم الاتصال مباشرة بدلاً من env
// ================================================================

const { neon } = require('@neondatabase/serverless');

// ══ ضع قيمك هنا مباشرة ══
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_SECRET  = 'admin-secret-key-2025';          // ← مفتاح سري بينك وبين admin.html

// ── SQL executor ─────────────────────────────────────────────────
async function sql(query, params = []) {
  const db = neon(DATABASE_URL);
  return await db(query, params);
}

// ── CORS headers ─────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
}

// ── Auth check ───────────────────────────────────────────────────
function isAuthorized(req) {
  return req.headers['x-admin-key'] === ADMIN_SECRET;
}

// ════════════════════════════════════════════════════════════════
//  MAIN HANDLER
// ════════════════════════════════════════════════════════════════
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const { action } = req.query;
  const body = req.body || {};

  try {

    // ══════════════════════════════════════════════════════════════
    //  STATS — إحصائيات سريعة
    // ══════════════════════════════════════════════════════════════
    if (action === 'stats') {
      const [totals] = await sql(`
        SELECT
          COUNT(*)                                          AS total_users,
          SUM(balance)                                      AS total_balance,
          COUNT(*) FILTER (WHERE shadow_banned = TRUE)      AS banned_count,
          COUNT(*) FILTER (WHERE is_hard_banned = TRUE)     AS hard_banned_count
        FROM users
      `);

      // طلبات سحب معلقة = كل سجل في wd_history حالته pending
      const pendingRows = await sql(`
        SELECT telegram_id, username, wd_history
        FROM users
        WHERE wd_history::text LIKE '%pending%'
      `);
      let pending = 0;
      pendingRows.forEach(u => {
        const hist = Array.isArray(u.wd_history) ? u.wd_history : [];
        pending += hist.filter(w => w.status === 'pending').length;
      });

      return res.status(200).json({
        ok: true,
        stats: {
          total_users:    parseInt(totals.total_users || 0),
          total_balance:  parseFloat(totals.total_balance || 0).toFixed(6),
          banned_count:   parseInt(totals.banned_count || 0),
          pending_withdrawals: pending,
        }
      });
    }

    // ══════════════════════════════════════════════════════════════
    //  GET_USERS — كل المستخدمين مع pagination
    // ══════════════════════════════════════════════════════════════
    if (action === 'get_users') {
      const limit  = parseInt(body.limit  || req.query.limit  || 50);
      const offset = parseInt(body.offset || req.query.offset || 0);

      const users = await sql(`
        SELECT
          telegram_id, username, balance, seeds, water_count,
          risk_score, shadow_banned, is_hard_banned,
          total_harvests, referral_friends, referral_balance,
          created_at, updated_at
        FROM users
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]);

      const [{ cnt }] = await sql(`SELECT COUNT(*) AS cnt FROM users`);

      return res.status(200).json({ ok: true, users, total: parseInt(cnt) });
    }

    // ══════════════════════════════════════════════════════════════
    //  SEARCH_USER — بحث بالـ ID أو username
    // ══════════════════════════════════════════════════════════════
    if (action === 'search_user') {
      const q = String(body.q || req.query.q || '').trim();
      if (!q) return res.status(400).json({ ok: false, error: 'Missing query' });

      let users;
      if (/^\d+$/.test(q)) {
        users = await sql(
          `SELECT telegram_id, username, balance, seeds, water_count,
                  risk_score, shadow_banned, is_hard_banned,
                  total_harvests, referral_friends, referral_balance,
                  wd_history, task_state, created_at, updated_at
           FROM users WHERE telegram_id = $1`,
          [parseInt(q)]
        );
      } else {
        users = await sql(
          `SELECT telegram_id, username, balance, seeds, water_count,
                  risk_score, shadow_banned, is_hard_banned,
                  total_harvests, referral_friends, referral_balance,
                  wd_history, task_state, created_at, updated_at
           FROM users WHERE username ILIKE $1 LIMIT 20`,
          [`%${q}%`]
        );
      }

      return res.status(200).json({ ok: true, users });
    }

    // ══════════════════════════════════════════════════════════════
    //  UPDATE_USER — تعديل رصيد / بذور / ماء / risk / بان
    // ══════════════════════════════════════════════════════════════
    if (action === 'update_user') {
      const { telegram_id, balance, seeds, water_count, risk_score, shadow_banned, is_hard_banned } = body;
      if (!telegram_id) return res.status(400).json({ ok: false, error: 'Missing telegram_id' });

      const fields = [];
      const vals   = [parseInt(telegram_id)];

      if (balance      !== undefined) { fields.push(`balance      = $${vals.length+1}`); vals.push(parseFloat(balance)); }
      if (seeds        !== undefined) { fields.push(`seeds        = $${vals.length+1}`); vals.push(parseInt(seeds)); }
      if (water_count  !== undefined) { fields.push(`water_count  = $${vals.length+1}`); vals.push(parseInt(water_count)); }
      if (risk_score   !== undefined) { fields.push(`risk_score   = $${vals.length+1}`); vals.push(parseInt(risk_score)); }
      if (shadow_banned !== undefined){ fields.push(`shadow_banned = $${vals.length+1}`); vals.push(Boolean(shadow_banned)); }
      if (is_hard_banned !== undefined){ fields.push(`is_hard_banned = $${vals.length+1}`); vals.push(Boolean(is_hard_banned)); }

      if (!fields.length) return res.status(400).json({ ok: false, error: 'No fields to update' });
      fields.push(`updated_at = NOW()`);

      await sql(
        `UPDATE users SET ${fields.join(', ')} WHERE telegram_id = $1`,
        vals
      );

      return res.status(200).json({ ok: true });
    }

    // ══════════════════════════════════════════════════════════════
    //  GET_WITHDRAWALS — كل طلبات السحب المعلقة
    // ══════════════════════════════════════════════════════════════
    if (action === 'get_withdrawals') {
      const rows = await sql(`
        SELECT telegram_id, username, wd_history
        FROM users
        WHERE wd_history::text LIKE '%pending%'
        ORDER BY updated_at DESC
      `);

      const pending = [];
      rows.forEach(u => {
        const hist = Array.isArray(u.wd_history) ? u.wd_history : [];
        hist.forEach((w, idx) => {
          if (w.status === 'pending') {
            pending.push({
              telegram_id: u.telegram_id,
              username:    u.username,
              index:       idx,
              account:     w.account,
              amount:      w.amount,
              date:        w.date,
            });
          }
        });
      });

      return res.status(200).json({ ok: true, withdrawals: pending });
    }

    // ══════════════════════════════════════════════════════════════
    //  RESOLVE_WITHDRAWAL — قبول أو رفض طلب سحب
    // ══════════════════════════════════════════════════════════════
    if (action === 'resolve_withdrawal') {
      const { telegram_id, index, verdict } = body; // verdict: 'approved' | 'rejected'
      if (!telegram_id || index === undefined || !verdict)
        return res.status(400).json({ ok: false, error: 'Missing fields' });

      const rows = await sql(`SELECT wd_history, balance FROM users WHERE telegram_id = $1`, [parseInt(telegram_id)]);
      if (!rows.length) return res.status(404).json({ ok: false, error: 'User not found' });

      const hist = Array.isArray(rows[0].wd_history) ? rows[0].wd_history : [];
      if (!hist[index]) return res.status(400).json({ ok: false, error: 'Invalid index' });

      const entry = hist[index];
      if (entry.status !== 'pending') return res.status(400).json({ ok: false, error: 'Already resolved' });

      hist[index].status = verdict;

      // لو رُفض نرجع الرصيد للمستخدم
      let balanceUpdate = '';
      const updateVals  = [parseInt(telegram_id), JSON.stringify(hist)];
      if (verdict === 'rejected') {
        balanceUpdate = `, balance = balance + $3`;
        updateVals.push(parseFloat(entry.amount));
      }

      await sql(
        `UPDATE users SET wd_history = $2 ${balanceUpdate}, updated_at = NOW() WHERE telegram_id = $1`,
        updateVals
      );

      return res.status(200).json({ ok: true });
    }

    // ══════════════════════════════════════════════════════════════
    //  TASKS — جلب + حفظ المهام من/إلى DB جدول منفصل
    // ══════════════════════════════════════════════════════════════
    if (action === 'get_tasks') {
      // جدول admin_tasks مؤقت إذا ما كان موجود
      await sql(`
        CREATE TABLE IF NOT EXISTS admin_tasks (
          id         TEXT PRIMARY KEY,
          icon       TEXT NOT NULL DEFAULT '⭐',
          name       TEXT NOT NULL,
          reward     NUMERIC(18,6) NOT NULL DEFAULT 0,
          task_type  TEXT NOT NULL DEFAULT 'channel',
          url        TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      const tasks = await sql(`SELECT * FROM admin_tasks ORDER BY created_at ASC`);
      return res.status(200).json({ ok: true, tasks });
    }

    if (action === 'add_task') {
      const { id, icon, name, reward, task_type, url, description } = body;
      if (!id || !name || !url) return res.status(400).json({ ok: false, error: 'Missing fields' });

      await sql(`
        CREATE TABLE IF NOT EXISTS admin_tasks (
          id TEXT PRIMARY KEY, icon TEXT, name TEXT, reward NUMERIC(18,6),
          task_type TEXT, url TEXT, description TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await sql(
        `INSERT INTO admin_tasks (id, icon, name, reward, task_type, url, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           icon=$2, name=$3, reward=$4, task_type=$5, url=$6, description=$7`,
        [id, icon || '⭐', name, parseFloat(reward || 0), task_type || 'channel', url, description || '']
      );
      return res.status(200).json({ ok: true });
    }

    if (action === 'delete_task') {
      const { id } = body;
      if (!id) return res.status(400).json({ ok: false, error: 'Missing id' });
      await sql(`DELETE FROM admin_tasks WHERE id = $1`, [id]);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('[Admin API Error]', action, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
