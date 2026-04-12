// ================================================================
//  Tomato Farm — Admin API  (api/admin.js)
// ================================================================

const { neon } = require('@neondatabase/serverless');

const ADMIN_SECRET = 'admin-secret-key-2025';

// ── SQL executor ─────────────────────────────────────────────────
async function sql(query, params = []) {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) throw new Error('DATABASE_URL is not set in environment variables');
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
    //  STATS
    // ══════════════════════════════════════════════════════════════
    if (action === 'stats') {
      const [totals] = await sql(`
        SELECT
          COUNT(*)                                          AS total_users,
          COALESCE(SUM(balance), 0)                         AS total_balance,
          COUNT(*) FILTER (WHERE shadow_banned = TRUE)      AS banned_count,
          COUNT(*) FILTER (WHERE is_hard_banned = TRUE)     AS hard_banned_count
        FROM users
      `);

      // FIX: cast jsonb → text بشكل صحيح
      const pendingRows = await sql(`
        SELECT telegram_id, username, wd_history
        FROM users
        WHERE wd_history::jsonb::text LIKE '%pending%'
      `);
      let pending = 0;
      pendingRows.forEach(u => {
        const hist = Array.isArray(u.wd_history) ? u.wd_history : [];
        pending += hist.filter(w => w.status === 'pending').length;
      });

      return res.status(200).json({
        ok: true,
        stats: {
          total_users:         parseInt(totals.total_users || 0),
          total_balance:       parseFloat(totals.total_balance || 0).toFixed(6),
          banned_count:        parseInt(totals.banned_count || 0),
          pending_withdrawals: pending,
        }
      });
    }

    // ══════════════════════════════════════════════════════════════
    //  GET_USERS
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

      // FIX: Neon يرجع COUNT كـ "count" مش "cnt"
      const countRow = await sql(`SELECT COUNT(*) AS cnt FROM users`);
      const total = parseInt(countRow[0]?.cnt || countRow[0]?.count || 0);

      return res.status(200).json({ ok: true, users, total });
    }

    // ══════════════════════════════════════════════════════════════
    //  SEARCH_USER
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
    //  UPDATE_USER
    // ══════════════════════════════════════════════════════════════
    if (action === 'update_user') {
      const { telegram_id, balance, seeds, water_count, risk_score, shadow_banned, is_hard_banned } = body;
      if (!telegram_id) return res.status(400).json({ ok: false, error: 'Missing telegram_id' });

      const fields = [];
      const vals   = [parseInt(telegram_id)];

      if (balance       !== undefined) { fields.push(`balance       = $${vals.length+1}`); vals.push(parseFloat(balance)); }
      if (seeds         !== undefined) { fields.push(`seeds         = $${vals.length+1}`); vals.push(parseInt(seeds)); }
      if (water_count   !== undefined) { fields.push(`water_count   = $${vals.length+1}`); vals.push(parseInt(water_count)); }
      if (risk_score    !== undefined) { fields.push(`risk_score    = $${vals.length+1}`); vals.push(parseInt(risk_score)); }
      if (shadow_banned !== undefined) { fields.push(`shadow_banned  = $${vals.length+1}`); vals.push(Boolean(shadow_banned)); }
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
    //  GET_WITHDRAWALS
    // ══════════════════════════════════════════════════════════════
    if (action === 'get_withdrawals') {
      const rows = await sql(`
        SELECT telegram_id, username, wd_history
        FROM users
        WHERE wd_history::jsonb::text LIKE '%pending%'
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
    //  RESOLVE_WITHDRAWAL
    // ══════════════════════════════════════════════════════════════
    if (action === 'resolve_withdrawal') {
      const { telegram_id, index, verdict } = body;
      if (!telegram_id || index === undefined || !verdict)
        return res.status(400).json({ ok: false, error: 'Missing fields' });

      const rows = await sql(`SELECT wd_history, balance FROM users WHERE telegram_id = $1`, [parseInt(telegram_id)]);
      if (!rows.length) return res.status(404).json({ ok: false, error: 'User not found' });

      const hist = Array.isArray(rows[0].wd_history) ? rows[0].wd_history : [];
      if (!hist[index]) return res.status(400).json({ ok: false, error: 'Invalid index' });

      const entry = hist[index];
      if (entry.status !== 'pending') return res.status(400).json({ ok: false, error: 'Already resolved' });

      hist[index].status = verdict;

      let balanceUpdate = '';
      const updateVals  = [parseInt(telegram_id), JSON.stringify(hist)];
      if (verdict === 'rejected') {
        balanceUpdate = `, balance = balance + $3`;
        updateVals.push(parseFloat(entry.amount));
      }

      await sql(
        `UPDATE users SET wd_history = $2::jsonb ${balanceUpdate}, updated_at = NOW() WHERE telegram_id = $1`,
        updateVals
      );

      return res.status(200).json({ ok: true });
    }

    // ══════════════════════════════════════════════════════════════
    //  TASKS — يستخدم جدول tasks الرئيسي (نفس جدول اللعبة)
    // ══════════════════════════════════════════════════════════════
    if (action === 'get_tasks') {
      // bootstrap الجدول إذا لم يكن موجوداً
      await sql(`
        CREATE TABLE IF NOT EXISTS tasks (
          id          TEXT          PRIMARY KEY,
          icon        TEXT          NOT NULL DEFAULT '⭐',
          name        TEXT          NOT NULL,
          reward      NUMERIC(18,6) NOT NULL DEFAULT 0,
          task_type   TEXT          NOT NULL DEFAULT 'url',
          url         TEXT,
          channel     TEXT,
          description TEXT          NOT NULL DEFAULT '',
          is_active   BOOLEAN       NOT NULL DEFAULT TRUE,
          sort_order  INT           NOT NULL DEFAULT 0,
          created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
        )
      `);
      const tasks = await sql(`SELECT * FROM tasks ORDER BY sort_order ASC, created_at ASC`);
      return res.status(200).json({ ok: true, tasks });
    }

    if (action === 'add_task') {
      const { id, icon, name, reward, task_type, url, channel, description } = body;
      if (!id || !name) return res.status(400).json({ ok: false, error: 'Missing id or name' });

      // تحقق: channel task يحتاج channel، url task يحتاج url
      if (task_type === 'channel' && !channel)
        return res.status(400).json({ ok: false, error: 'channel task requires channel username' });
      if (task_type === 'url' && !url)
        return res.status(400).json({ ok: false, error: 'url task requires url' });

      // sort_order = آخر قيمة + 1
      const maxOrder = await sql(`SELECT COALESCE(MAX(sort_order),0) AS m FROM tasks`);
      const nextOrder = parseInt(maxOrder[0]?.m || 0) + 1;

      await sql(
        `INSERT INTO tasks (id, icon, name, reward, task_type, url, channel, description, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET
           icon=$2, name=$3, reward=$4, task_type=$5,
           url=$6, channel=$7, description=$8`,
        [
          id,
          icon || '⭐',
          name,
          parseFloat(reward || 0),
          task_type || 'url',
          task_type === 'url'     ? (url || null)     : null,
          task_type === 'channel' ? (channel || null)  : null,
          description || '',
          nextOrder,
        ]
      );
      return res.status(200).json({ ok: true });
    }

    if (action === 'delete_task') {
      const { id } = body;
      if (!id) return res.status(400).json({ ok: false, error: 'Missing id' });
      // أيضاً احذف إنجازات المستخدمين المرتبطة
      await sql(`DELETE FROM user_tasks WHERE task_id = $1`, [id]).catch(() => {});
      await sql(`DELETE FROM tasks WHERE id = $1`, [id]);
      return res.status(200).json({ ok: true });
    }

    if (action === 'toggle_task') {
      const { id, is_active } = body;
      if (!id) return res.status(400).json({ ok: false, error: 'Missing id' });
      await sql(`UPDATE tasks SET is_active = $2 WHERE id = $1`, [id, Boolean(is_active)]);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('[Admin API Error]', action, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
