// ══════════════════════════════════════════════════════════════════════════════
//  api/adsgram-reward.js — Adsgram Reward URL (server-to-server postback)
// ══════════════════════════════════════════════════════════════════════════════
//  هذا الـ endpoint يُستدعى من سيرفرات Adsgram مباشرة (GET) بعد التأكد فعلياً
//  أن المستخدم شاهد الإعلان كاملاً — لا يمر أبداً من متصفح/جهاز المستخدم،
//  وبالتالي لا يمكن لأي مستخدم أو سكربت تزويره أو رؤيته.
//
//  اضبط في partner.adsgram.ai → Ad unit → Reward URL:
//    · لإعلان الفيديو (Reward):
//      https://tomato-v3.vercel.app/api/adsgram-reward?secret=<ADSGRAM_REWARD_SECRET>&userid=[userId]
//    · لإعلان Task (blockId بصيغة task-xxx):
//      https://tomato-v3.vercel.app/api/adsgram-reward?secret=<ADSGRAM_REWARD_SECRET>&userid=[userId]&type=task
//
//  [userId] هو placeholder حرفي — Adsgram تستبدله بـ Telegram ID الخاص بالمستخدم.
//  ADSGRAM_REWARD_SECRET سرّ عشوائي طويل تضبطه في Vercel env vars وتستخدم نفس
//  القيمة في الرابط أعلاه — هو الحماية الوحيدة لأن Adsgram لا توقّع الطلب.
//  كل Block له Reward URL خاص به يُضبط يدويًا من لوحة adsgram — لذلك نميّز نوع
//  التأكيد (reward | task) بإضافة ?type=task يدويًا فقط في رابط Block الـ Task،
//  حتى تبقى حصة الـ Task مفصولة تمامًا عن حصة إعلانات الفيديو في claimAd.
// ══════════════════════════════════════════════════════════════════════════════

const { neon } = require('@neondatabase/serverless');

const DATABASE_URL          = process.env.DATABASE_URL;
const ADSGRAM_REWARD_SECRET = process.env.ADSGRAM_REWARD_SECRET;

const sql = neon(DATABASE_URL);

async function ensureTable() {
  await sql(`CREATE TABLE IF NOT EXISTS ad_reward_confirmations (
    id          SERIAL PRIMARY KEY,
    telegram_id BIGINT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'reward',
    consumed    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await sql(`ALTER TABLE ad_reward_confirmations ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'reward'`);
  await sql(`CREATE INDEX IF NOT EXISTS idx_arc_lookup ON ad_reward_confirmations (telegram_id, kind, consumed, created_at)`);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  // 🛡️ السر داخل الرابط هو الحماية الوحيدة هنا — لازم يطابق ما تم ضبطه في Vercel env
  if (!ADSGRAM_REWARD_SECRET) {
    console.error('[adsgram-reward] ADSGRAM_REWARD_SECRET not set in env');
    return res.status(503).send('Not configured');
  }
  if (req.query.secret !== ADSGRAM_REWARD_SECRET) {
    return res.status(403).send('Forbidden');
  }

  // Adsgram تستبدل [userId] بـ Telegram ID رقمي
  const telegramId = parseInt(req.query.userid, 10);
  if (!req.query.userid || !Number.isFinite(telegramId) || telegramId <= 0) {
    return res.status(400).send('Bad userid');
  }

  // 🏷️ نوع التأكيد — يُحدَّد من ?type=task في رابط Block الـ Task (ثابت نضبطه نحن في
  // partner.adsgram.ai)، أي قيمة تبدأ بـ "task" تُصنَّف task، وأي شيء آخر (أو غياب type) reward
  const rawType = (req.query.type || '').toString().toLowerCase();
  const kind = rawType.startsWith('task') ? 'task' : 'reward';

  try {
    await ensureTable();

    // تنظيف السجلات القديمة (احتياط فقط)
    await sql(`DELETE FROM ad_reward_confirmations WHERE created_at < NOW() - INTERVAL '1 day'`);

    await sql(`INSERT INTO ad_reward_confirmations (telegram_id, kind) VALUES ($1, $2)`, [telegramId, kind]);

    console.log(`[adsgram-reward] confirmed ${kind} view for telegram_id=${telegramId}`);
    return res.status(200).send('OK');
  } catch (err) {
    console.error('[adsgram-reward] error:', err.message);
    return res.status(500).send('Server error');
  }
};
