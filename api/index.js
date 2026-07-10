// ══════════════════════════════════════════════════════════════════════════════
//  api/admin/index.js  —  BigLeague Admin Panel · Vercel Serverless Function
//  ملف مستقل تماماً عن api/index.js — منعاً لأي تأثير على المستخدمين الحقيقيين
//  لو حصل أي خطأ هنا، التطبيق الأساسي مش هيتأثر إطلاقاً (functions منفصلة على Vercel)
// ══════════════════════════════════════════════════════════════════════════════

const { neon } = require('@neondatabase/serverless');

const DATABASE_URL = process.env.DATABASE_URL;
const BOT_TOKEN    = process.env.BOT_TOKEN;
const ADMIN_SECRET = process.env.ADMIN_SECRET; // ✅ Fixed: was INTERNAL_SECRET

// 💸 قناة إثبات السحوبات — يُرسل لها تلقائياً بعد كل عملية دفع TON ناجحة
const WITHDRAW_PROOF_CHANNEL = process.env.WITHDRAW_PROOF_CHANNEL || '@withdrawlProof2026';

if (!ADMIN_SECRET) {
  throw new Error('[FATAL] ADMIN_SECRET env var is not set — refusing to run with an insecure fallback key');
}

const _db = neon(DATABASE_URL);
async function sql(query, params = []) {
  return await _db(query, params);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  if (!BOT_TOKEN) return { ok: false };
  const body = { chat_id: String(chatId), text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  // 🛡️ لو فشل بسبب مشكلة تنسيق (نادر بعد HTML)، إعادة المحاولة كـ نص عادي بدون وسوم
  if (!json.ok && /can't parse entities/i.test(json.description || '')) {
    const retryBody = { chat_id: String(chatId), text: text.replace(/<[^>]+>/g, '') };
    if (replyMarkup) retryBody.reply_markup = replyMarkup;
    const retry = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(retryBody)
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

// 💱 سعر TON/USDT لحظي — يُستخدم لتحويل مبلغ السحب (بالدولار) لكمية TON قبل الدفع
let _tonRateCache = { value: null, at: 0 };
async function getTonUsdRate() {
  // كاش 60 ثانية لتفادي إغراق CoinGecko بطلبات متكررة
  if (_tonRateCache.value && (Date.now() - _tonRateCache.at) < 60_000) {
    return _tonRateCache.value;
  }
  const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd');
  if (!resp.ok) throw new Error(`CoinGecko HTTP ${resp.status}`);
  const json = await resp.json();
  const rate = json?.['the-open-network']?.usd;
  if (!rate || isNaN(rate)) throw new Error('CoinGecko: invalid rate');
  _tonRateCache = { value: rate, at: Date.now() };
  return rate;
}

// ══════════════════════════════════════════════════════════════════════════════
//  TonCenter — التحقق من المعاملة الصادرة (out) من محفظة الأدمن باتجاه المستخدم
//  بعد ما الأدمن يوقّع من محفظته عبر TonConnect، نبحث في history محفظة الأدمن
//  عن المعاملة الصادرة المطابقة (قيمة + وجهة + توقيت) ونجيب hash الحقيقي على السلسلة.
// ══════════════════════════════════════════════════════════════════════════════
const TONCENTER_BASE    = process.env.TONCENTER_BASE || 'https://toncenter.com/api/v2';
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY || '';

// 🔁 يحوّل عنوان TON بصيغة friendly (مثل UQAB...، EQAB...) إلى raw (workchain:hash)
// لأن TonCenter يرجّع العناوين بصيغة raw دايماً، بينما عنوان المستخدم المخزّن
// بجدول withdrawals غالباً friendly (اللي المستخدم يشوفه وينسخه من محفظته).
// بدون هذا التحويل، المقارنة بين العنوانين ما تتطابق أبداً حتى لو المعاملة صحيحة 100%.
function friendlyTonAddrToRaw(addr) {
  const s = String(addr).trim();
  if (!s) return '';
  if (s.includes(':')) return s.toLowerCase(); // already raw
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length !== 36) return s.toLowerCase(); // مش friendly صالح، رجّعه كما هو
    const workchain = buf.readInt8(1);
    const hash = buf.subarray(2, 34).toString('hex');
    return `${workchain}:${hash}`;
  } catch {
    return s.toLowerCase();
  }
}

function normalizeTonAddrAdmin(addr) {
  if (!addr) return '';
  const raw = friendlyTonAddrToRaw(addr);
  const parts = raw.split(':');
  if (parts.length !== 2) return raw;
  return `${parts[0]}:${parts[1].replace(/^0+/, '') || '0'}`;
}

async function findOutgoingTonTx({ adminWallet, destRaw, nanotons, sinceMs, withdrawId, maxAttempts = 8 }) {
  if (!adminWallet) throw new Error('Admin wallet address missing');

  const wantDest  = normalizeTonAddrAdmin(destRaw);
  const wantValue = String(nanotons);
  const sinceSec  = Math.floor(sinceMs / 1000) - 60;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const url = new URL(`${TONCENTER_BASE}/getTransactions`);
    url.searchParams.set('address', adminWallet);
    url.searchParams.set('limit', '20');
    if (TONCENTER_API_KEY) url.searchParams.set('api_key', TONCENTER_API_KEY);

    const resp = await fetch(url.toString());
    const rawBody = await resp.text();

    if (resp.ok) {
      let body;
      try { body = JSON.parse(rawBody); } catch { body = null; }

      if (body?.ok && Array.isArray(body.result)) {
        for (const tx of body.result) {
          if (Number(tx.utime) < sinceSec) continue;
          const outMsgs = tx.out_msgs || [];
          for (const outMsg of outMsgs) {
            if (String(outMsg.value) !== wantValue) continue;
            if (outMsg.destination && normalizeTonAddrAdmin(outMsg.destination) === wantDest) {
              return { hash: tx.transaction_id?.hash || null, utime: tx.utime };
            }
          }
        }
      }
    } else {
      console.error(`[withdraw#${withdrawId}] TonCenter HTTP ${resp.status}: ${rawBody.slice(0, 200)}`);
    }

    await new Promise(r => setTimeout(r, 2500)); // انتظار قصير قبل إعادة المحاولة — المعاملة تحتاج وقت تظهر بالأرشيف
  }

  return null;
}

// 🧱 يضمن وجود أعمدة دفع TON بجدول withdrawals (idempotent — آمن يتكرر كل استدعاء)
let _withdrawColsEnsured = false;
async function ensureWithdrawTonColumns() {
  if (_withdrawColsEnsured) return;
  await sql(`ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS ton_amount NUMERIC(18,9)`);
  await sql(`ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS ton_rate   NUMERIC(18,9)`);
  await sql(`ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS tx_hash    TEXT`);
  await sql(`ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS paid_at    TIMESTAMPTZ`);
  _withdrawColsEnsured = true;
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
        // 🛠️ كان بيرجع 0 دايماً لأن العمودين updated_at/last_seen_at ما كانوش موجودين
        // فعلياً بجدول users (كان بيفشل الاستعلام بصمت). دلوقتي last_seen_at بيتحدث
        // مع كل طلب من المستخدم (شوف api/index.js) فالاستعلام بيشتغل صح.
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

        await ensureWithdrawTonColumns();

        const [countRows, rows] = await Promise.all([
          sql(`SELECT COUNT(*)::INT AS count FROM withdrawals w ${where}`, params),
          sql(`SELECT w.id, w.address, w.memo, w.amount, w.status, w.created_at,
                      w.ton_amount, w.ton_rate, w.tx_hash, w.paid_at,
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
            ton_amount:  w.ton_amount != null ? parseFloat(w.ton_amount) : null,
            ton_rate:    w.ton_rate   != null ? parseFloat(w.ton_rate)   : null,
            tx_hash:     w.tx_hash,
            paid_at:     w.paid_at,
            first_name:  w.first_name,
            username:    w.username,
            telegram_id: Number(w.telegram_id)
          })),
          total: countRows[0].count
        });
      }

      // ────────────────────────────────────────────────────────────────────
      //  💎 adminWithdrawTonQuote — يرجّع سعر TON/USDT اللحظي + كمية TON
      //  المطلوبة لدفع طلب سحب معيّن، قبل ما الأدمن يوقّع من محفظته
      // ────────────────────────────────────────────────────────────────────
      case 'adminWithdrawTonQuote': {
        const id = parseInt(data.id, 10);
        if (!id) return res.status(400).json({ ok: false, error: 'Invalid request' });

        const wRows = await sql(`SELECT * FROM withdrawals WHERE id = $1`, [id]);
        if (!wRows.length) return res.status(404).json({ ok: false, error: 'Withdrawal not found' });
        const w = wRows[0];
        if (w.status === 'paid') return res.status(400).json({ ok: false, error: 'Already paid' });

        let rate;
        try { rate = await getTonUsdRate(); }
        catch (e) {
          console.error('[adminWithdrawTonQuote] rate fetch failed:', e.message);
          return res.status(502).json({ ok: false, error: 'Could not fetch TON/USDT rate — try again' });
        }

        const usdAmount = parseFloat(w.amount);
        const tonAmount = +(usdAmount / rate).toFixed(9);

        return res.json({ ok: true, usdAmount, tonAmount, rate, address: w.address, memo: w.memo });
      }

      // ────────────────────────────────────────────────────────────────────
      //  💎 adminMarkWithdrawPaid — بعد ما الأدمن يرسل TON فعلياً من محفظته
      //  عبر TonConnect، نتحقق من TonCenter لجلب TXID الحقيقي على السلسلة
      //  ونسجّل الدفع + نرسل الإشعارات. لا نثق بأي "نجاح" من الفرونت وحده.
      // ────────────────────────────────────────────────────────────────────
      case 'adminMarkWithdrawPaid': {
        await ensureWithdrawTonColumns();

        const id          = parseInt(data.id, 10);
        const tonAmount   = parseFloat(data.tonAmount);
        const rate        = parseFloat(data.rate);
        const adminWallet = (data.adminWallet || '').trim();
        const sentAtMs    = parseInt(data.sentAtMs, 10) || Date.now();

        if (!id || !adminWallet) return res.status(400).json({ ok: false, error: 'Invalid request' });
        if (isNaN(tonAmount) || tonAmount <= 0) return res.status(400).json({ ok: false, error: 'Invalid TON amount' });

        const wRows = await sql(`SELECT w.*, u.telegram_id, u.username, u.first_name
                                  FROM withdrawals w JOIN users u ON u.id = w.user_id
                                  WHERE w.id = $1`, [id]);
        if (!wRows.length) return res.status(404).json({ ok: false, error: 'Withdrawal not found' });
        const w = wRows[0];
        if (w.status === 'paid') return res.status(400).json({ ok: false, error: 'Already paid' });

        const nanotons = Math.round(tonAmount * 1e9);
        let match;
        try {
          match = await findOutgoingTonTx({
            adminWallet, destRaw: w.address, nanotons, sinceMs: sentAtMs, withdrawId: id
          });
        } catch (e) {
          console.error('[adminMarkWithdrawPaid] TonCenter check failed:', e.message);
          return res.status(502).json({ ok: false, error: 'Could not verify transaction on TonCenter — try again shortly' });
        }

        if (!match || !match.hash) {
          return res.status(408).json({ ok: false, error: 'Transaction not found on-chain yet — wait a few seconds and retry' });
        }

        const txHashHex = match.hash ? Buffer.from(match.hash, 'base64').toString('hex') : null;
        const txHash = txHashHex || match.hash;

        await sql(
          `UPDATE withdrawals SET status = 'paid', ton_amount = $1, ton_rate = $2, tx_hash = $3, paid_at = NOW() WHERE id = $4`,
          [tonAmount, isNaN(rate) ? null : rate, txHash, id]
        );

        const usdAmount = parseFloat(w.amount);
        const explorerUrl = `https://tonviewer.com/transaction/${txHash}`;
        const shortAddr = w.address.length > 20
          ? `${w.address.slice(0, 10)}...${w.address.slice(-8)}`
          : w.address;
        const paidAtStr = new Date().toLocaleString('en-GB', {
          day: '2-digit', month: 'short', year: 'numeric',
          hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC'
        }).replace(',', ' •');

        // ✅ إشعار المستخدم — فيه TXID الحقيقي
        const userMsg =
          `💸 <b>Withdrawal Successfully Paid</b> ✅\n\n` +
          `👤 User: ${escapeHtml(w.username ? '@' + w.username : (w.first_name || `User#${w.telegram_id}`))}\n` +
          `🆔 User ID: <code>${w.telegram_id}</code>\n\n` +
          `💰 Amount: <b>$${usdAmount.toFixed(2)}</b> USDT\n` +
          `🔄 Sent: <code>${tonAmount} TON</code>\n\n` +
          `👛 Wallet: <code>${escapeHtml(shortAddr)}</code>\n` +
          `🕒 Time: ${paidAtStr} UTC\n\n` +
          `🔗 Transaction: <a href="${explorerUrl}">View on Tonviewer</a>\n\n` +
          `🎉 Your withdrawal has been processed successfully.\n\n` +
          `🏆 <b>BigLeague — Earn • Compete • Win</b>\n` +
          `Real rewards. Fast payouts.`;

        // 📢 إثبات السحب — يُرسل تلقائياً لقناة الإثبات
        const displayName = w.username ? '@' + w.username : (w.first_name || `User#${w.telegram_id}`);
        const botPlayUrl = `https://t.me/EarnlixBot/play?startapp=ref_7741750541`;
        const channelMsg =
          `💸 <b>New Withdrawal Paid</b> ✅\n\n` +
          `👤 User: ${escapeHtml(displayName)}\n` +
          `🆔 User ID: <code>${w.telegram_id}</code>\n\n` +
          `💰 Amount: <b>$${usdAmount.toFixed(2)}</b> USDT\n` +
          `🔄 Sent: <code>${tonAmount} TON</code>\n\n` +
          `👛 Wallet: <code>${escapeHtml(shortAddr)}</code>\n` +
          `🕒 Time: ${paidAtStr} UTC\n\n` +
          `🔗 Transaction: <a href="${explorerUrl}">View on Tonviewer</a>\n\n` +
          `🏆 <b>BigLeague — Earn • Compete • Win</b>\n` +
          `Real rewards. Fast payouts.`;
        const channelKeyboard = {
          inline_keyboard: [[{ text: '🎮 Play Now', url: botPlayUrl }]]
        };

        // 🛡️ ننتظر الإرسالين قبل ما نرجّع الرد — على Vercel، أي Promise معلّق بعد
        // res.json() ممكن ينقطع فوراً (تجميد/إنهاء الـ function)، فكان هذا سبب
        // عدم وصول إشعار القناة أحياناً رغم نجاح الدفع فعلياً.
        const [userNotify, channelNotify] = await Promise.allSettled([
          sendTelegramMessage(Number(w.telegram_id), userMsg),
          sendTelegramMessage(WITHDRAW_PROOF_CHANNEL, channelMsg, channelKeyboard)
        ]);
        if (userNotify.status === 'rejected' || userNotify.value?.ok === false) {
          console.error('[withdraw paid bot notify]', userNotify.reason?.message || JSON.stringify(userNotify.value));
        }
        if (channelNotify.status === 'rejected' || channelNotify.value?.ok === false) {
          console.error('[withdraw proof channel notify]', channelNotify.reason?.message || JSON.stringify(channelNotify.value));
        }

        return res.json({ ok: true, txHash });
      }

      // ────────────────────────────────────────────────────────────────────
      case 'adminUpdateWithdrawal': {
        const id      = parseInt(data.id, 10);
        const status  = data.status;
        // 🛡️ 'paid' صار له مسار مخصص (adminMarkWithdrawPaid) لازم يمرّ فيه TXID حقيقي
        const allowed = ['pending', 'approved', 'rejected'];
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
          rejected: '❌ Your withdrawal request was rejected — the amount was refunded to your balance'
        };
        if (uRows.length && labels[status]) {
          sendTelegramMessage(
            Number(uRows[0].telegram_id),
            `${labels[status]}\nAmount: <b>$${parseFloat(w.amount).toFixed(2)}</b>`
          ).catch(e => console.error('[withdrawal status bot notify]', e.message));
        }

        return res.json({ ok: true });
      }

      // ────────────────────────────────────────────────────────────────────
      //  💎 Deposits — عمليات إيداع TON (صورة/اسم اللاعب + TX hash)
      // ────────────────────────────────────────────────────────────────────
      case 'adminDeposits': {
        const page   = Math.max(1, parseInt(data.page, 10) || 1);
        const limit  = Math.min(50, Math.max(1, parseInt(data.limit, 10) || 20));
        const offset = (page - 1) * limit;
        const status = (data.status && data.status !== 'all') ? data.status : null;

        const where  = status ? `WHERE d.status = $1` : '';
        const params = status ? [status] : [];

        const [countRows, rows] = await Promise.all([
          sql(`SELECT COUNT(*)::INT AS count FROM deposits d ${where}`, params),
          sql(`SELECT d.id, d.package_id, d.tickets, d.ton_amount, d.wallet_address,
                      d.status, d.tx_hash, d.created_at, d.confirmed_at,
                      u.telegram_id, u.first_name, u.username, u.photo_url
               FROM deposits d JOIN users u ON u.id = d.user_id
               ${where}
               ORDER BY d.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params)
        ]);

        return res.json({
          ok: true,
          deposits: rows.map(d => ({
            id:             d.id,
            package_id:     d.package_id,
            tickets:        d.tickets,
            ton_amount:     parseFloat(d.ton_amount),
            wallet_address: d.wallet_address,
            status:         d.status,
            tx_hash:        d.tx_hash,
            created_at:     d.created_at,
            confirmed_at:   d.confirmed_at,
            telegram_id:    Number(d.telegram_id),
            first_name:     d.first_name,
            username:       d.username,
            photo_url:      d.photo_url
          })),
          total: countRows[0].count
        });
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

      case 'adminCompetitionAdjustTime': {
        const hours = parseFloat(data.hours);
        if (!hours || isNaN(hours)) return res.status(400).json({ ok: false, error: 'عدد الساعات مطلوب' });
        if (Math.abs(hours) > 24 * 90) return res.status(400).json({ ok: false, error: 'قيمة غير منطقية' });

        const rows = await sql(`
          UPDATE competition
          SET end_at = end_at + ($1 || ' hours')::INTERVAL
          WHERE active = TRUE AND prize_distributed = FALSE
          RETURNING id, name, end_at, start_at
        `, [String(hours)]);
        if (!rows.length) return res.status(400).json({ ok: false, error: 'لا يوجد موسم نشط حالياً' });

        if (new Date(rows[0].end_at) <= new Date(rows[0].start_at)) {
          return res.status(400).json({ ok: false, error: 'وقت النهاية لازم يكون بعد وقت البداية' });
        }

        return res.json({ ok: true, competition: rows[0] });
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
        // 🛡️ فك أي إحالات بتشاور على اليوزر ده — لو فيه FK كان ده سبب فشل الحذف
        await sql(`UPDATE users SET referred_by = NULL WHERE referred_by = $1`, [tgId]).catch(e => console.error('[deleteUser referred_by]', e.message));
        // cascade manual delete — كل خطوة معزولة عشان لو جدول فرعي فيه مشكلة ما يوقفش باقي الحذف
        await sql(`DELETE FROM sessions WHERE user_id = $1`, [uid]).catch(e => console.error('[deleteUser sessions]', e.message));
        await sql(`DELETE FROM ad_watches WHERE user_id = $1`, [uid]).catch(e => console.error('[deleteUser ad_watches]', e.message));
        await sql(`DELETE FROM withdrawals WHERE user_id = $1`, [uid]).catch(e => console.error('[deleteUser withdrawals]', e.message));
        await sql(`DELETE FROM activity_logs WHERE user_id = $1`, [uid]).catch(e => console.error('[deleteUser activity_logs]', e.message));
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
