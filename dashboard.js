// dashboard.js
// لوحة تحكم بوت استثمارات طيبة
// الرابط: https://taibah-agent-backend.onrender.com/admin

const crypto = require('crypto');


function registerDashboard(app, deps) {

  const {
    pool,
    normalizePhone,
    toInternationalSaudi,
    TEMPLATES,
    createCampaign,
    setCampaignStatus,
    extractNumbers,
    createReportWorkbook,
    password,
    maxNumbersPerCampaign = 500,
    defaultDelaySeconds = 8,
  } = deps;


  const COOKIE_NAME = 'taibah_admin';

  const tokenFor = (pass) =>
    crypto
      .createHash('sha256')
      .update(`${pass}:taibah-dashboard`)
      .digest('hex');


  function readCookie(req, name) {

    const header =
      req.headers.cookie || '';

    for (const part of header.split(';')) {

      const [k, ...v] =
        part.trim().split('=');

      if (k === name) {
        return decodeURIComponent(v.join('='));
      }
    }

    return null;
  }


  function isLoggedIn(req) {

    if (!password) {
      return false;
    }

    const token =
      readCookie(req, COOKIE_NAME);

    if (!token) {
      return false;
    }

    const expected =
      tokenFor(password);

    return (
      token.length === expected.length &&
      crypto.timingSafeEqual(
        Buffer.from(token),
        Buffer.from(expected)
      )
    );
  }


  function requireLogin(req, res, next) {

    if (isLoggedIn(req)) {
      return next();
    }

    return res
      .status(401)
      .json({ error: 'login_required' });
  }


  // =====================================================
  // حماية من تخمين كلمة السر: 5 محاولات كل 15 دقيقة
  // =====================================================

  const attempts = new Map();

  function tooManyAttempts(ip) {

    const now = Date.now();

    const a =
      attempts.get(ip) ||
      { count: 0, first: now };

    if (now - a.first > 15 * 60 * 1000) {
      a.count = 0;
      a.first = now;
    }

    attempts.set(ip, a);

    return a.count >= 5;
  }


  // =====================================================
  // الصفحة
  // =====================================================

  app.get('/admin', (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(DASHBOARD_HTML);
  });


  // =====================================================
  // تسجيل الدخول / الخروج
  // =====================================================

  app.post('/admin/api/login', (req, res) => {

    const ip =
      req.ip || 'unknown';

    if (tooManyAttempts(ip)) {
      return res
        .status(429)
        .json({ error: 'too_many' });
    }

    const given =
      String(req.body?.password || '')
        .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
        .trim();

    if (!password || given !== password) {

      attempts.get(ip).count++;

      return res
        .status(401)
        .json({ error: 'wrong_password' });
    }

    attempts.delete(ip);

    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${tokenFor(password)}; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=${7 * 24 * 3600}`
    );

    res.json({ ok: true });
  });


  app.post('/admin/api/logout', (req, res) => {

    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
    );

    res.json({ ok: true });
  });


  app.get('/admin/api/me', (req, res) => {
    res.json({ loggedIn: isLoggedIn(req) });
  });


  // =====================================================
  // رسائل القوالب (مع معرفة هل العميل ردّ بعدها)
  // =====================================================

  const TEMPLATE_MESSAGES_SQL = `
    SELECT
      tm.*,
      EXISTS (
        SELECT 1
        FROM conversations c
        WHERE c.customer_phone = tm.customer_phone
          AND c.role = 'user'
          AND c.created_at > COALESCE(tm.sent_at, tm.queued_at)
      ) AS replied
    FROM template_messages tm
  `;

  const TEMPLATE_FILTERS = {
    all: 'TRUE',
    queued: "status IN ('queued', 'sending')",
    reached: "status IN ('delivered', 'read')",
    delivered: "status = 'delivered'",
    read: "status = 'read'",
    noreply: "status IN ('sent', 'delivered', 'read') AND NOT replied",
    readnoreply: "status = 'read' AND NOT replied",
    replied: "status IN ('sent', 'delivered', 'read') AND replied",
    failed: "status = 'failed'",
  };


  // =====================================================
  // الأرقام العامة
  // =====================================================

  app.get('/admin/api/stats', requireLogin, async (req, res) => {

    try {

      const q = (sql) =>
        pool
          .query(sql)
          .then((r) => r.rows[0]?.count || 0);

      const [
        customers,
        activeToday,
        viewings,
        escalations,
        hotLeads,
        messagesToday,
        templateStats,
      ] = await Promise.all([
        q(`SELECT COUNT(DISTINCT customer_phone)::int AS count FROM conversations WHERE role = 'user'`),
        q(`SELECT COUNT(DISTINCT customer_phone)::int AS count FROM conversations WHERE role = 'user' AND created_at >= CURRENT_DATE`),
        q(`SELECT COUNT(*)::int AS count FROM viewing_requests`),
        q(`SELECT COUNT(*)::int AS count FROM manager_escalations`),
        q(`SELECT COUNT(DISTINCT customer_phone)::int AS count FROM manager_escalations WHERE question LIKE '%احجز شراء%'`),
        q(`SELECT COUNT(*)::int AS count FROM conversations WHERE role = 'user' AND created_at >= CURRENT_DATE`),
        pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE status IN ('queued', 'sending'))::int AS queued,
            COUNT(*) FILTER (WHERE status IN ('sent', 'delivered', 'read'))::int AS accepted,
            COUNT(*) FILTER (WHERE status IN ('delivered', 'read'))::int AS reached,
            COUNT(*) FILTER (WHERE status = 'read')::int AS read_total,
            COUNT(*) FILTER (WHERE status IN ('sent', 'delivered', 'read') AND NOT replied)::int AS no_reply,
            COUNT(*) FILTER (WHERE status = 'read' AND NOT replied)::int AS read_no_reply,
            COUNT(*) FILTER (WHERE status IN ('sent', 'delivered', 'read') AND replied)::int AS replied,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
          FROM (${TEMPLATE_MESSAGES_SQL}) t
        `),
      ]);

      const t = templateStats.rows[0] || {};

      res.json({
        customers,
        activeToday,
        viewings,
        escalations,
        hotLeads,
        messagesToday,
        templates: {
          queued: t.queued || 0,
          accepted: t.accepted || 0,
          reached: t.reached || 0,
          read: t.read_total || 0,
          noReply: t.no_reply || 0,
          readNoReply: t.read_no_reply || 0,
          replied: t.replied || 0,
          failed: t.failed || 0,
        },
      });

    } catch (err) {

      console.error('Dashboard stats error:', err);
      res.status(500).json({ error: 'server_error' });
    }
  });


  app.get('/admin/api/config', requireLogin, (req, res) => {

    res.json({
      maxNumbers: maxNumbersPerCampaign,
      defaultDelay: defaultDelaySeconds,
    });
  });


  // =====================================================
  // العملاء (أحدث عميل راسل البوت في الأعلى)
  // =====================================================

  app.get('/admin/api/customers', requireLogin, async (req, res) => {

    try {

      const search =
        String(req.query.search || '').trim();

      // 1) العملاء مع عدد رسائلهم وآخر نشاط
      const params = [];
      let where = '';

      if (search) {
        params.push(`%${search}%`);
        where =
          `WHERE customer_phone IN (
             SELECT DISTINCT customer_phone FROM conversations
             WHERE customer_phone LIKE $1 OR message ILIKE $1
           )`;
      }

      const base =
        await pool.query(
          `
          SELECT
            customer_phone,
            SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END)::int AS user_messages,
            MAX(created_at) AS last_at,
            MAX(created_at) FILTER (WHERE role = 'user') AS last_user_at,
            COALESCE(
              MAX(created_at) FILTER (WHERE role = 'user') >= CURRENT_DATE,
              false
            ) AS active_today
          FROM conversations
          ${where}
          GROUP BY customer_phone
          ORDER BY
            MAX(created_at) FILTER (WHERE role = 'user') DESC NULLS LAST,
            MAX(created_at) DESC
          LIMIT 500
          `,
          params
        );

      const rows = base.rows;

      if (!rows.length) {
        return res.json([]);
      }

      const phones =
        rows.map((r) => r.customer_phone);

      const placeholders =
        phones.map((_, i) => `$${i + 1}`).join(', ');

      // 2) آخر رسالة من كل عميل + المعاينات + التحويلات + حالة آخر قالب
      const [lastMessages, viewings, escalations, lastTemplates] =
        await Promise.all([
          pool.query(
            `
            SELECT customer_phone, message, created_at, id
            FROM conversations
            WHERE role = 'user'
              AND customer_phone IN (${placeholders})
            ORDER BY created_at DESC, id DESC
            `,
            phones
          ),
          pool.query(
            `SELECT DISTINCT customer_phone FROM viewing_requests WHERE customer_phone IN (${placeholders})`,
            phones
          ),
          pool.query(
            `SELECT customer_phone, question FROM manager_escalations WHERE customer_phone IN (${placeholders})`,
            phones
          ),
          pool.query(
            `
            SELECT DISTINCT ON (customer_phone) customer_phone, status
            FROM template_messages
            WHERE customer_phone IN (${placeholders})
            ORDER BY customer_phone, id DESC
            `,
            phones
          ),
        ]);

      const lastByPhone = {};

      for (const m of lastMessages.rows) {
        if (!(m.customer_phone in lastByPhone)) {
          lastByPhone[m.customer_phone] = m.message;
        }
      }

      const viewingSet =
        new Set(viewings.rows.map((v) => v.customer_phone));

      const escalatedSet = new Set();
      const hotSet = new Set();

      for (const e of escalations.rows) {
        escalatedSet.add(e.customer_phone);
        if (String(e.question || '').includes('احجز شراء')) {
          hotSet.add(e.customer_phone);
        }
      }

      const templateStatus = {};

      for (const t of lastTemplates.rows) {
        templateStatus[t.customer_phone] = t.status;
      }

      res.json(
        rows.map((r) => ({
          ...r,
          last_message: lastByPhone[r.customer_phone] || null,
          has_viewing: viewingSet.has(r.customer_phone),
          escalated: escalatedSet.has(r.customer_phone),
          hot: hotSet.has(r.customer_phone),
          last_tpl_status: templateStatus[r.customer_phone] || null,
        }))
      );

    } catch (err) {

      console.error('Dashboard customers error:', err);
      res.status(500).json({ error: 'server_error' });
    }
  });


  app.get('/admin/api/conversation/:phone', requireLogin, async (req, res) => {

    try {

      const result =
        await pool.query(
          `
          SELECT
            c.role,
            c.message,
            c.created_at,
            tm.status AS tm_status,
            tm.error_text AS tm_error
          FROM conversations c
          LEFT JOIN template_messages tm ON tm.id = c.template_msg_id
          WHERE c.customer_phone = $1
          ORDER BY c.created_at ASC, c.id ASC
          LIMIT 1000
          `,
          [normalizePhone(req.params.phone)]
        );

      res.json(result.rows);

    } catch (err) {

      console.error('Dashboard conversation error:', err);
      res.status(500).json({ error: 'server_error' });
    }
  });


  // =====================================================
  // المعاينات والتحويلات
  // =====================================================

  app.get('/admin/api/viewings', requireLogin, async (req, res) => {

    try {

      const result =
        await pool.query(`
          SELECT *
          FROM viewing_requests
          ORDER BY created_at DESC
          LIMIT 500
        `);

      res.json(result.rows);

    } catch (err) {

      console.error('Dashboard viewings error:', err);
      res.status(500).json({ error: 'server_error' });
    }
  });


  app.get('/admin/api/escalations', requireLogin, async (req, res) => {

    try {

      const result =
        await pool.query(`
          SELECT *
          FROM manager_escalations
          ORDER BY created_at DESC
          LIMIT 500
        `);

      res.json(
        result.rows.map((r) => ({
          ...r,
          hot: String(r.question || '').includes('احجز شراء'),
        }))
      );

    } catch (err) {

      console.error('Dashboard escalations error:', err);
      res.status(500).json({ error: 'server_error' });
    }
  });


  // =====================================================
  // القوالب والحملات
  // =====================================================

  app.get('/admin/api/templates', requireLogin, (req, res) => {

    res.json(
      Object.entries(TEMPLATES).map(
        ([key, t]) => ({
          key,
          name: t.name,
          preview: t.logText || '',
          hasVideo: Boolean(t.videoFile),
        })
      )
    );
  });


  // إنشاء حملة: الإرسال يتم في الخلفية على السيرفر (رسالة كل X ثانية)
  app.post('/admin/api/campaigns', requireLogin, async (req, res) => {

    try {

      const templateKey =
        req.body?.templateKey;

      if (!TEMPLATES[templateKey]) {
        return res
          .status(400)
          .json({ error: 'unknown_template' });
      }

      const numbers =
        extractNumbers(
          String(req.body?.numbersText || '')
        );

      if (!numbers.length) {
        return res
          .status(400)
          .json({ error: 'no_numbers' });
      }

      if (numbers.length > maxNumbersPerCampaign) {
        return res
          .status(400)
          .json({ error: 'too_many_numbers' });
      }

      const campaign =
        await createCampaign(
          templateKey,
          numbers,
          {
            delaySeconds: req.body?.delaySeconds,
          }
        );

      res.json({ ok: true, ...campaign });

    } catch (err) {

      console.error('Dashboard create campaign error:', err);
      res.status(500).json({ error: 'server_error' });
    }
  });


  app.get('/admin/api/campaigns', requireLogin, async (req, res) => {

    try {

      const result =
        await pool.query(`
          SELECT
            c.id,
            c.template_key,
            c.template_name,
            c.delay_seconds,
            c.status,
            c.created_at,
            c.finished_at,
            COUNT(tm.id)::int AS total,
            COUNT(*) FILTER (WHERE tm.status IN ('queued', 'sending'))::int AS queued,
            COUNT(*) FILTER (WHERE tm.status = 'sent')::int AS sent,
            COUNT(*) FILTER (WHERE tm.status = 'delivered')::int AS delivered,
            COUNT(*) FILTER (WHERE tm.status = 'read')::int AS read_count,
            COUNT(*) FILTER (WHERE tm.status = 'failed')::int AS failed,
            COUNT(*) FILTER (WHERE tm.status = 'cancelled')::int AS cancelled
          FROM campaigns c
          LEFT JOIN template_messages tm ON tm.campaign_id = c.id
          GROUP BY c.id
          ORDER BY c.id DESC
          LIMIT 30
        `);

      res.json(result.rows);

    } catch (err) {

      console.error('Dashboard campaigns error:', err);
      res.status(500).json({ error: 'server_error' });
    }
  });


  app.post('/admin/api/campaigns/:id/:action', requireLogin, async (req, res) => {

    try {

      const id =
        parseInt(req.params.id, 10);

      const action =
        String(req.params.action || '');

      if (
        !Number.isInteger(id) ||
        !['pause', 'resume', 'cancel'].includes(action)
      ) {
        return res
          .status(400)
          .json({ error: 'bad_request' });
      }

      await setCampaignStatus(id, action);

      res.json({ ok: true });

    } catch (err) {

      console.error('Dashboard campaign action error:', err);
      res.status(500).json({ error: 'server_error' });
    }
  });


  // كل رسائل القوالب مع حالتها (أُرسلت / وصلت / قُرئت / فشلت) وهل ردّ العميل
  app.get('/admin/api/template-messages', requireLogin, async (req, res) => {

    try {

      const filterKey =
        Object.prototype.hasOwnProperty.call(
          TEMPLATE_FILTERS,
          req.query.filter
        )
          ? req.query.filter
          : 'all';

      const campaignId =
        parseInt(req.query.campaign, 10);

      const params = [];
      let campaignClause = '';

      if (Number.isInteger(campaignId)) {
        params.push(campaignId);
        campaignClause = 'WHERE tm.campaign_id = $1';
      }

      const result =
        await pool.query(
          `
          SELECT *
          FROM (${TEMPLATE_MESSAGES_SQL} ${campaignClause}) t
          WHERE ${TEMPLATE_FILTERS[filterKey]}
          ORDER BY id DESC
          LIMIT 500
          `,
          params
        );

      res.json(result.rows);

    } catch (err) {

      console.error('Dashboard template messages error:', err);
      res.status(500).json({ error: 'server_error' });
    }
  });


  // =====================================================
  // Excel
  // =====================================================

  app.get('/admin/api/export', requireLogin, async (req, res) => {

    try {

      const buffer =
        await createReportWorkbook();

      const date =
        new Date().toISOString().slice(0, 10);

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      res.setHeader(
        'Content-Disposition',
        `attachment; filename="taibah-report-${date}.xlsx"`
      );

      res.send(buffer);

    } catch (err) {

      console.error('Dashboard export error:', err);
      res.status(500).send('تعذّر إنشاء الملف');
    }
  });
}


// =====================================================
// صفحة الداشبورد (HTML + CSS + JS)
// =====================================================

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>لوحة بوت استثمارات طيبة</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --limestone: #F2F3EF;
    --paper: #FFFFFF;
    --ink: #1A2620;
    --muted: #5E6B64;
    --line: #DCE0D8;
    --palm: #1E5B43;
    --palm-soft: #E3EEE8;
    --gold: #A8822F;
    --gold-soft: #F5EDDA;
    --hot: #B3412E;
    --hot-soft: #F8E7E3;
    --wa-blue: #2AA3DF;
    --accent: #1E5B43;
    --accent-soft: #E3EEE8;
  }

  /* لون خاص لكل خانة: عشان تعرف أنت واقف فين بالظبط */
  body[data-view="overview"]    { --accent: #1E5B43; --accent-soft: #E3EEE8; }
  body[data-view="customers"]   { --accent: #245EA8; --accent-soft: #E2ECF8; }
  body[data-view="escalations"] { --accent: #C2571A; --accent-soft: #FBEBDD; }
  body[data-view="viewings"]    { --accent: #6A4C9C; --accent-soft: #ECE6F5; }
  body[data-view="messages"]    { --accent: #0F7C80; --accent-soft: #DDF0F0; }
  body[data-view="send"]        { --accent: #A8822F; --accent-soft: #F5EDDA; }

  * { box-sizing: border-box; }

  html, body {
    margin: 0;
    background: var(--limestone);
    color: var(--ink);
    font-family: "Cairo", Tahoma, Arial, sans-serif;
    font-size: 15px;
    line-height: 1.7;
  }

  button, input, select, textarea {
    font: inherit;
    color: inherit;
  }

  button { cursor: pointer; }

  :focus-visible {
    outline: 2px solid var(--gold);
    outline-offset: 2px;
  }

  h1, h2, h3 {
    font-family: "Cairo", sans-serif;
    font-weight: 700;
    margin: 0;
    line-height: 1.4;
  }

  .ltr { direction: ltr; unicode-bidi: embed; display: inline-block; }
  .muted { color: var(--muted); }

  /* ---------- Login ---------- */

  #login {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    background:
      linear-gradient(var(--palm), var(--palm)) top / 100% 6px no-repeat,
      var(--limestone);
  }

  .login-box {
    width: 100%;
    max-width: 360px;
    background: var(--paper);
    border: 1px solid var(--line);
    border-top: 4px solid var(--gold);
    padding: 32px 28px;
  }

  .login-box h1 { font-size: 26px; color: var(--palm); }
  .login-box p { color: var(--muted); margin: 6px 0 22px; }

  .field {
    width: 100%;
    padding: 11px 12px;
    border: 1px solid var(--line);
    background: var(--paper);
    border-radius: 6px;
  }

  .btn {
    border: 0;
    border-radius: 6px;
    padding: 10px 18px;
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }

  .btn:hover { filter: brightness(.92); }
  .btn[disabled] { opacity: .6; cursor: wait; }

  .btn-ghost {
    background: transparent;
    color: var(--accent);
    border: 1px solid var(--line);
  }

  .btn-ghost:hover { background: var(--accent-soft); filter: none; }

  .btn-small { padding: 4px 12px; font-size: 13px; }

  .btn-danger { background: transparent; color: var(--hot); border: 1px solid var(--hot-soft); }
  .btn-danger:hover { background: var(--hot-soft); filter: none; }

  .error { color: var(--hot); min-height: 1.6em; margin-top: 10px; font-size: 14px; }

  /* ---------- Layout ---------- */

  #app { display: none; min-height: 100vh; }

  .shell {
    display: grid;
    grid-template-columns: 240px 1fr;
    min-height: 100vh;
  }

  aside {
    background: #17231E;
    color: #fff;
    padding: 26px 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  @media (min-width: 861px) {
    aside {
      position: sticky;
      top: 0;
      height: 100vh;
      overflow-y: auto;
    }
  }

  .brand {
    font-family: "Cairo", sans-serif;
    font-weight: 700;
    font-size: 21px;
    line-height: 1.4;
    margin-bottom: 4px;
  }

  .brand small {
    display: block;
    font-family: "Cairo", sans-serif;
    font-size: 13px;
    color: #B5C9BE;
    font-weight: 400;
  }

  .rule {
    height: 2px;
    background: var(--gold);
    width: 44px;
    margin: 12px 0 18px;
  }

  nav { display: flex; flex-direction: column; gap: 4px; }

  nav button {
    width: 100%;
    text-align: right;
    background: transparent;
    border: 0;
    border-right: 5px solid transparent;
    color: #E6F0EA;
    padding: 10px 12px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  nav button .label { flex: 1; }

  /* مربع ملوّن ثابت قدام كل خانة */
  nav button::before {
    content: "";
    width: 12px;
    height: 12px;
    border-radius: 3px;
    background: var(--c);
    box-shadow: 0 0 0 2px rgba(255,255,255,.85);
    flex: none;
  }

  nav button[data-view="overview"]    { --c: #2F9E72; }
  nav button[data-view="customers"]   { --c: #4C8EE0; }
  nav button[data-view="escalations"] { --c: #EE8A4A; }
  nav button[data-view="viewings"]    { --c: #9D7FD6; }
  nav button[data-view="messages"]    { --c: #2BB5B9; }
  nav button[data-view="send"]        { --c: #D9B04E; }

  nav button:hover { background: rgba(255,255,255,.08); }

  nav button.active {
    background: var(--paper);
    color: var(--ink);
    font-weight: 700;
    border-right-color: var(--c);
  }

  .count {
    font-size: 12px;
    background: rgba(255,255,255,.16);
    padding: 0 8px;
    border-radius: 10px;
  }

  nav button.active .count { background: var(--limestone); }

  .count.hot { background: var(--hot); color: #fff; }

  .aside-foot {
    margin-top: auto;
    display: grid;
    gap: 8px;
  }

  .aside-foot a, .aside-foot button {
    color: #E6F0EA;
    background: transparent;
    border: 1px solid rgba(255,255,255,.25);
    border-radius: 6px;
    padding: 8px 12px;
    text-decoration: none;
    text-align: center;
    font-size: 14px;
  }

  main {
    padding: 22px 32px 48px;
    max-width: 1120px;
    width: 100%;
    border-top: 6px solid var(--accent);
  }

  .crumb {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 14px;
    margin-bottom: 10px;
  }

  .crumb b {
    background: var(--accent);
    color: #fff;
    padding: 1px 12px;
    border-radius: 12px;
    font-weight: 600;
  }

  .page-head {
    display: flex;
    justify-content: space-between;
    align-items: end;
    gap: 16px;
    margin-bottom: 20px;
    padding-bottom: 12px;
    border-bottom: 2px solid var(--accent-soft);
    flex-wrap: wrap;
  }

  .page-head h2 { font-size: 28px; color: var(--accent); }
  .page-head p { margin: 2px 0 0; color: var(--muted); }

  section.view { display: none; }
  section.view.active { display: block; }

  h3.sub { font-size: 18px; margin: 26px 0 10px; color: var(--accent); }

  /* ---------- Overview ---------- */

  .ledger {
    background: var(--line);
    border: 1px solid var(--line);
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1px;
  }

  .ledger .cell {
    background: var(--paper);
    border: 0;
    border-radius: 0;
    text-align: right;
    padding: 16px 20px;
    display: block;
    width: 100%;
  }

  .ledger .cell:hover { background: var(--accent-soft); }

  .ledger .cell b {
    display: block;
    font-family: "Cairo", sans-serif;
    font-weight: 700;
    font-size: 30px;
    color: var(--accent);
    line-height: 1.3;
  }

  .ledger .cell span {
    color: var(--muted);
    font-size: 14px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .ledger .cell.is-hot b { color: var(--hot); }
  .ledger .cell.is-bad b { color: var(--hot); }

  .hotlist {
    margin-top: 26px;
    background: var(--paper);
    border: 1px solid var(--line);
    border-right: 4px solid var(--hot);
  }

  .hotlist h3 {
    font-size: 18px;
    padding: 16px 20px 4px;
  }

  .hotlist > p {
    margin: 0;
    padding: 0 20px 12px;
    color: var(--muted);
    font-size: 14px;
  }

  /* ---------- Chips ---------- */

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 14px;
  }

  .chip {
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 16px;
    padding: 3px 14px;
    font-size: 14px;
    color: var(--ink);
  }

  .chip:hover { background: var(--accent-soft); }

  .chip.active {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
  }

  /* ---------- Tables ---------- */

  .panel {
    background: var(--paper);
    border: 1px solid var(--line);
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    min-width: 680px;
  }

  th, td {
    text-align: right;
    padding: 11px 16px;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }

  th {
    font-weight: 600;
    color: var(--accent);
    font-size: 13px;
    background: var(--accent-soft);
  }

  tr:last-child td { border-bottom: 0; }

  tbody tr.clickable { cursor: pointer; }
  tbody tr.clickable:hover { background: var(--accent-soft); }

  .snippet {
    color: var(--muted);
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .why {
    color: var(--hot);
    font-size: 12px;
    max-width: 280px;
    line-height: 1.5;
  }

  .tag {
    display: inline-block;
    font-size: 12px;
    padding: 1px 8px;
    border-radius: 10px;
    margin-left: 4px;
    white-space: nowrap;
  }

  .tag.view { background: var(--gold-soft); color: #7A5D1E; }
  .tag.esc { background: var(--palm-soft); color: var(--palm); }
  .tag.hot { background: var(--hot); color: #fff; }
  .tag.replied { background: #DDF0F0; color: #0F7C80; }

  .wa {
    color: var(--accent);
    font-weight: 600;
    text-decoration: none;
    white-space: nowrap;
  }

  .wa:hover { text-decoration: underline; }

  .empty {
    padding: 36px 20px;
    text-align: center;
    color: var(--muted);
  }

  .toolbar {
    display: flex;
    gap: 10px;
    margin-bottom: 14px;
  }

  .toolbar .field { max-width: 360px; }

  /* ---------- Ticks (علامات الصح زي واتساب) ---------- */

  .ticks {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    white-space: nowrap;
    color: #7A857E;
  }

  .ticks svg { display: block; }
  .ticks.read { color: var(--wa-blue); }
  .ticks.failed { color: var(--hot); }
  .ticks.queued { color: var(--gold); }

  /* ---------- Campaigns ---------- */

  .camp {
    background: var(--paper);
    border: 1px solid var(--line);
    border-right: 4px solid var(--accent);
    padding: 14px 18px;
    margin-bottom: 12px;
  }

  .camp.paused { border-right-color: var(--gold); }
  .camp.cancelled { border-right-color: var(--muted); opacity: .8; }
  .camp.picked { box-shadow: 0 0 0 2px var(--accent); }

  .camp-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .camp-title { font-weight: 700; }

  .camp-status {
    font-size: 12px;
    padding: 1px 10px;
    border-radius: 10px;
    background: var(--accent-soft);
    color: var(--accent);
    margin-right: 8px;
  }

  .bar {
    height: 8px;
    background: var(--line);
    border-radius: 4px;
    overflow: hidden;
    margin: 10px 0;
  }

  .bar i { display: block; height: 100%; background: var(--accent); }

  .camp-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 18px;
    font-size: 13px;
  }

  .camp-actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }

  /* ---------- Conversation drawer ---------- */

  .drawer-bg {
    position: fixed;
    inset: 0;
    background: rgba(26,38,32,.4);
    display: none;
  }

  .drawer {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    width: min(520px, 100%);
    background: var(--limestone);
    display: none;
    flex-direction: column;
    box-shadow: 8px 0 30px rgba(26,38,32,.18);
  }

  .drawer.open, .drawer-bg.open { display: flex; }
  .drawer-bg.open { display: block; }

  .drawer header {
    background: #17231E;
    color: #fff;
    padding: 16px 20px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
  }

  .drawer header a { color: #fff; }

  .drawer header button {
    background: transparent;
    border: 1px solid rgba(255,255,255,.35);
    color: #fff;
    border-radius: 6px;
    padding: 4px 12px;
  }

  .thread {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .msg {
    max-width: 82%;
    padding: 9px 13px;
    border-radius: 10px;
    white-space: pre-wrap;
    word-wrap: break-word;
    font-size: 14px;
  }

  .msg time {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 11px;
    color: var(--muted);
    margin-top: 4px;
  }

  .msg.user {
    align-self: flex-start;
    background: var(--paper);
    border: 1px solid var(--line);
  }

  .msg.assistant {
    align-self: flex-end;
    background: var(--palm-soft);
  }

  .msg.template {
    align-self: flex-end;
    background: var(--gold-soft);
    border: 1px dashed var(--gold);
  }

  /* ---------- Send ---------- */

  .send-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
  }

  .card {
    background: var(--paper);
    border: 1px solid var(--line);
    padding: 20px;
  }

  .card h3 { font-size: 18px; margin-bottom: 12px; }

  label.lbl {
    display: block;
    font-weight: 500;
    margin: 14px 0 6px;
  }

  label.lbl:first-of-type { margin-top: 0; }

  textarea.field {
    min-height: 170px;
    resize: vertical;
    direction: ltr;
    text-align: left;
  }

  .delay-row { display: flex; align-items: center; gap: 10px; }
  .delay-row .field { max-width: 110px; text-align: center; }

  .hint { color: var(--muted); font-size: 13px; margin-top: 6px; }

  .preview {
    white-space: pre-wrap;
    background: var(--gold-soft);
    border-right: 3px solid var(--gold);
    padding: 14px;
    font-size: 14px;
    max-height: 340px;
    overflow-y: auto;
  }

  .result {
    margin-top: 16px;
    padding: 14px;
    border: 1px solid var(--line);
    background: #FAFBF8;
    white-space: pre-wrap;
    font-size: 14px;
    display: none;
  }

  .row-actions { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; }

  .notice {
    background: var(--gold-soft);
    border-right: 3px solid var(--gold);
    padding: 10px 14px;
    font-size: 14px;
    margin-bottom: 16px;
  }

  /* ---------- Mobile ---------- */

  @media (max-width: 860px) {

    .shell { grid-template-columns: 1fr; }

    aside {
      padding: 14px;
      gap: 10px;
    }

    .rule { display: none; }

    nav {
      flex-direction: row;
      overflow-x: auto;
      padding-bottom: 4px;
    }

    nav button {
      width: auto;
      white-space: nowrap;
      border-right: 0;
      border-bottom: 4px solid transparent;
    }

    nav button.active { border-bottom-color: var(--c); }

    .aside-foot {
      grid-template-columns: 1fr 1fr;
    }

    main { padding: 18px 16px 40px; }

    .ledger { grid-template-columns: repeat(2, 1fr); }

    .send-grid { grid-template-columns: 1fr; }
  }

  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
  }
</style>
</head>
<body data-view="overview">

<!-- تسجيل الدخول -->
<div id="login">
  <form class="login-box" id="loginForm">
    <h1>لوحة بوت طيبة</h1>
    <p>استثمارات طيبة العقارية</p>
    <input class="field" id="password" type="password" inputmode="numeric" autocomplete="current-password" placeholder="كلمة السر" required>
    <div class="error" id="loginError"></div>
    <button class="btn" style="width:100%" type="submit">دخول</button>
  </form>
</div>

<!-- اللوحة -->
<div id="app">
  <div class="shell">
    <aside>
      <div class="brand">بوت طيبة<small>استثمارات طيبة العقارية</small></div>
      <div class="rule"></div>
      <nav>
        <button data-view="overview" class="active"><span class="label">نظرة عامة</span></button>
        <button data-view="customers"><span class="label">العملاء</span> <span class="count" id="nCustomers">0</span></button>
        <button data-view="escalations"><span class="label">طلبات المدير</span> <span class="count hot" id="nHot">0</span></button>
        <button data-view="viewings"><span class="label">المعاينات</span> <span class="count" id="nViewings">0</span></button>
        <button data-view="messages"><span class="label">الرسائل المرسلة</span> <span class="count" id="nNoReply">0</span></button>
        <button data-view="send"><span class="label">إرسال قالب</span></button>
      </nav>
      <div class="aside-foot">
        <a href="/admin/api/export">تحميل Excel</a>
        <button id="logout">خروج</button>
      </div>
    </aside>

    <main>

      <div class="crumb">أنت الآن في: <b id="crumbName">نظرة عامة</b></div>

      <!-- نظرة عامة -->
      <section class="view active" id="view-overview">
        <div class="page-head">
          <div>
            <h2>نظرة عامة</h2>
            <p id="todayLabel"></p>
          </div>
          <button class="btn btn-ghost" id="refreshBtn">تحديث</button>
        </div>

        <h3 class="sub" style="margin-top:0">العملاء والطلبات</h3>
        <div class="ledger" id="ledger"></div>

        <h3 class="sub">حالة القوالب المرسلة</h3>
        <div class="ledger" id="ledger2"></div>

        <div class="hotlist">
          <h3>عملاء جاهزون للشراء</h3>
          <p>ضغطوا على «احجز شراء»، فتواصل معهم أولًا بأول.</p>
          <div id="hotTable"></div>
        </div>
      </section>

      <!-- العملاء -->
      <section class="view" id="view-customers">
        <div class="page-head">
          <div>
            <h2>العملاء</h2>
            <p>أحدث عميل راسل البوت يظهر في الأعلى. اضغط على أي عميل لعرض محادثته كاملة.</p>
          </div>
        </div>
        <div class="toolbar">
          <input class="field" id="search" type="search" placeholder="ابحث برقم الهاتف أو بكلمة من المحادثة">
        </div>
        <div class="chips" id="customerChips"></div>
        <div class="panel" id="customersTable"></div>
      </section>

      <!-- طلبات المدير -->
      <section class="view" id="view-escalations">
        <div class="page-head">
          <div>
            <h2>طلبات المدير</h2>
            <p>أسئلة لم يستطع البوت الإجابة عنها، وعملاء طلبوا الشراء.</p>
          </div>
        </div>
        <div class="chips" id="escChips"></div>
        <div class="panel" id="escalationsTable"></div>
      </section>

      <!-- المعاينات -->
      <section class="view" id="view-viewings">
        <div class="page-head">
          <div>
            <h2>طلبات المعاينة</h2>
            <p>المواعيد التي سجّلها العملاء عبر البوت.</p>
          </div>
        </div>
        <div class="panel" id="viewingsTable"></div>
      </section>

      <!-- الرسائل المرسلة -->
      <section class="view" id="view-messages">
        <div class="page-head">
          <div>
            <h2>الرسائل المرسلة</h2>
            <p>حالة كل قالب أُرسل: أُرسلت، وصلت، قُرئت، وهل ردّ العميل.</p>
          </div>
        </div>
        <div id="campaigns"></div>
        <div class="chips" id="msgChips"></div>
        <div class="panel" id="messagesTable"></div>
      </section>

      <!-- إرسال قالب -->
      <section class="view" id="view-send">
        <div class="page-head">
          <div>
            <h2>إرسال قالب</h2>
            <p>تصل الرسالة إلى العميل حتى لو لم يراسلنا من قبل.</p>
          </div>
        </div>

        <div class="notice">تُحتسب رسائل العروض لدى Meta كرسائل تسويقية بتكلفة على كل رسالة، فأرسلها إلى العملاء المهتمين فقط. وقد يكون لحسابك حدّ يومي لعدد العملاء الجدد، فتأكد منه في WhatsApp Manager قبل الإرسال الكبير.</div>

        <div class="send-grid">
          <div class="card">
            <label class="lbl" for="tplSelect">القالب</label>
            <select class="field" id="tplSelect"></select>

            <label class="lbl" for="delay">الفاصل بين كل رسالة والتي بعدها</label>
            <div class="delay-row">
              <input class="field" id="delay" type="number" min="1" max="3600" value="8" inputmode="numeric">
              <span>ثانية</span>
            </div>

            <label class="lbl" for="numbers">أرقام العملاء</label>
            <textarea class="field" id="numbers" placeholder="0551234567&#10;0559876543"></textarea>
            <div class="hint" id="numbersHint">اكتب كل رقم في سطر مستقل.</div>

            <div class="row-actions">
              <button class="btn" id="sendBtn">بدء الإرسال</button>
              <button class="btn btn-ghost" id="fillAll">إضافة كل العملاء</button>
            </div>

            <div class="result" id="sendResult"></div>
          </div>

          <div class="card">
            <h3>معاينة الرسالة</h3>
            <div class="preview" id="tplPreview"></div>
            <div class="hint" id="tplVideo"></div>
          </div>
        </div>
      </section>

    </main>
  </div>
</div>

<!-- نافذة المحادثة -->
<div class="drawer-bg" id="drawerBg"></div>
<div class="drawer" id="drawer">
  <header>
    <div>
      <div style="font-weight:600" class="ltr" id="drawerPhone"></div>
      <a id="drawerWa" target="_blank" rel="noopener">فتح في واتساب</a>
    </div>
    <button id="drawerClose">إغلاق</button>
  </header>
  <div class="thread" id="thread"></div>
</div>

<script>
  const $ = (s) => document.querySelector(s);

  const esc = (v) =>
    String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const fmt = (d) => {
    if (!d) return '';
    try {
      return new Date(d).toLocaleString('ar-SA-u-ca-gregory-nu-latn', {
        timeZone: 'Asia/Riyadh',
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch (e) {
      return new Date(d).toLocaleString();
    }
  };

  const localPhone = (p) => {
    p = String(p || '');
    return p.startsWith('9665') ? '0' + p.slice(3) : '+' + p;
  };

  async function api(path, options) {
    const res = await fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    }, options || {}));

    if (res.status === 401) {
      showLogin();
      throw new Error('login_required');
    }

    return res.json();
  }

  // ---------- علامات الصح ----------

  const SVG_CLOCK = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 4.6V8l2.4 1.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  const SVG_ONE = '<svg viewBox="0 0 16 11" width="16" height="11" aria-hidden="true"><path d="M1.5 6.2l3.1 3.1L11.2 2.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const SVG_TWO = '<svg viewBox="0 0 16 11" width="16" height="11" aria-hidden="true"><path d="M0.8 6.2l3.1 3.1L10.5 2.2M5.6 8.4l.9.9L15.2 2.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const SVG_X = '<svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';
  const SVG_DASH = '<svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true"><path d="M3 7h8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';

  const TICK = {
    queued:    { svg: SVG_CLOCK, label: 'في الانتظار', cls: 'queued' },
    sending:   { svg: SVG_CLOCK, label: 'جارٍ الإرسال', cls: 'queued' },
    sent:      { svg: SVG_ONE,   label: 'أُرسلت', cls: 'sent' },
    delivered: { svg: SVG_TWO,   label: 'وصلت', cls: 'delivered' },
    read:      { svg: SVG_TWO,   label: 'قُرئت', cls: 'read' },
    failed:    { svg: SVG_X,     label: 'فشلت', cls: 'failed' },
    cancelled: { svg: SVG_DASH,  label: 'أُلغيت', cls: 'cancelled' },
  };

  function ticks(status, withLabel) {
    const t = TICK[status];
    if (!t) return '';
    return '<span class="ticks ' + t.cls + '" title="' + esc(t.label) + '">' + t.svg +
      (withLabel ? '<span>' + esc(t.label) + '</span>' : '') + '</span>';
  }

  // ---------- الخانات والألوان ----------

  const VIEW_NAMES = {
    overview: 'نظرة عامة',
    customers: 'العملاء',
    escalations: 'طلبات المدير',
    viewings: 'طلبات المعاينة',
    messages: 'الرسائل المرسلة',
    send: 'إرسال قالب',
  };

  const CUSTOMER_FILTERS = [
    ['all', 'الكل'],
    ['today', 'راسلوا اليوم'],
    ['hot', 'جاهزون للشراء'],
    ['viewing', 'لديهم طلب معاينة'],
    ['escalated', 'حُوِّلوا للمدير'],
  ];

  const ESC_FILTERS = [
    ['all', 'الكل'],
    ['hot', 'جاهزون للشراء'],
  ];

  const MSG_FILTERS = [
    ['all', 'الكل'],
    ['queued', 'في الانتظار'],
    ['reached', 'وصلت'],
    ['delivered', 'وصلت ولم تُقرأ'],
    ['read', 'قُرئت'],
    ['noreply', 'لم يردّوا'],
    ['readnoreply', 'قرأوا ولم يردّوا'],
    ['replied', 'ردّوا'],
    ['failed', 'فشلت'],
  ];

  const CAMPAIGN_LABELS = {
    running: 'قيد الإرسال',
    paused: 'متوقفة مؤقتًا',
    done: 'اكتملت',
    cancelled: 'أُلغيت',
  };

  const filters = { customers: 'all', escalations: 'all', messages: 'all' };

  let currentView = 'overview';
  let msgCampaign = null;
  let customers = [];
  let escalationsData = [];
  let messagesData = [];
  let campaignsData = [];
  let templates = [];
  let maxNumbers = 500;
  let defaultDelay = 8;

  function setView(view) {
    currentView = view;
    document.body.dataset.view = view;

    document.querySelectorAll('nav button').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === view);
    });

    document.querySelectorAll('section.view').forEach((x) => {
      x.classList.toggle('active', x.id === 'view-' + view);
    });

    $('#crumbName').textContent = VIEW_NAMES[view] || '';
    window.scrollTo(0, 0);
  }

  function go(view, filter) {
    if (filters[view] !== undefined) {
      filters[view] = filter || 'all';
    }

    if (view === 'messages' && (!filter || filter === 'all')) {
      msgCampaign = null;
    }

    setView(view);

    if (view === 'customers') renderCustomers();
    if (view === 'escalations') renderEscalations();
    if (view === 'messages') loadMessagesView().catch(() => {});
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest ? e.target.closest('[data-go]') : null;
    if (el) go(el.dataset.go, el.dataset.filter || '');
  });

  function renderChips(el, defs, current, onPick) {
    el.innerHTML = defs
      .map((d) => '<button type="button" class="chip' + (d[0] === current ? ' active' : '') + '" data-f="' + esc(d[0]) + '">' + esc(d[1]) + '</button>')
      .join('');

    el.querySelectorAll('.chip').forEach((b) => {
      b.addEventListener('click', () => onPick(b.dataset.f));
    });
  }

  // ---------- Login ----------

  let refreshTimer = null;

  function showLogin() {
    $('#app').style.display = 'none';
    $('#login').style.display = 'grid';
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }

  function showApp() {
    $('#login').style.display = 'none';
    $('#app').style.display = 'block';
    setView('overview');
    refreshAll();

    // تحديث تلقائي كل 15 ثانية: العميل اللي راسل يطلع لفوق وعلامات الصح تتحدث لوحدها
    if (!refreshTimer) {
      refreshTimer = setInterval(() => {
        if ($('#app').style.display === 'block' && document.visibilityState === 'visible') {
          refreshQuiet();
        }
      }, 15000);
    }
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#loginError').textContent = '';

    const res = await fetch('/admin/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('#password').value }),
    });

    if (res.ok) {
      $('#password').value = '';
      showApp();
    } else if (res.status === 429) {
      $('#loginError').textContent = 'محاولات كثيرة. حاول مرة أخرى بعد 15 دقيقة.';
    } else {
      $('#loginError').textContent = 'كلمة السر غير صحيحة.';
    }
  });

  $('#logout').addEventListener('click', async () => {
    await fetch('/admin/api/logout', { method: 'POST' });
    showLogin();
  });

  // ---------- Navigation ----------

  document.querySelectorAll('nav button').forEach((b) => {
    b.addEventListener('click', () => go(b.dataset.view, ''));
  });

  // ---------- Overview ----------

  function cell(label, value, view, filter, cls, icon) {
    return '<button type="button" class="cell ' + (cls || '') + '" data-go="' + esc(view) + '" data-filter="' + esc(filter || '') + '">' +
      '<b>' + esc(value) + '</b><span>' + (icon || '') + esc(label) + '</span></button>';
  }

  async function loadStats() {
    const s = await api('/admin/api/stats');

    $('#nCustomers').textContent = s.customers;
    $('#nViewings').textContent = s.viewings;
    $('#nHot').textContent = s.hotLeads;
    $('#nNoReply').textContent = s.templates.noReply;

    $('#ledger').innerHTML =
      cell('عملاء راسلوا البوت', s.customers, 'customers', 'all') +
      cell('عملاء راسلوا اليوم', s.activeToday, 'customers', 'today') +
      cell('رسائل اليوم', s.messagesToday, 'customers', 'today') +
      cell('طلبات المعاينة', s.viewings, 'viewings', '') +
      cell('التحويلات إلى المدير', s.escalations, 'escalations', 'all') +
      cell('جاهزون للشراء', s.hotLeads, 'escalations', 'hot', 'is-hot');

    const t = s.templates;

    $('#ledger2').innerHTML =
      cell('قوالب أُرسلت', t.accepted, 'messages', 'all', '', ticks('sent')) +
      cell('وصلت للعميل', t.reached, 'messages', 'reached', '', ticks('delivered')) +
      cell('قرأها العميل', t.read, 'messages', 'read', '', ticks('read')) +
      cell('لم يردّوا عليها', t.noReply, 'messages', 'noreply', '') +
      cell('قرأوا ولم يردّوا', t.readNoReply, 'messages', 'readnoreply', '', ticks('read')) +
      cell('فشلت', t.failed, 'messages', 'failed', 'is-bad', ticks('failed'));
  }

  // ---------- Customers ----------

  function tags(c) {
    let t = '';
    if (c.hot) t += '<span class="tag hot">احجز شراء</span>';
    else if (c.escalated) t += '<span class="tag esc">حُوِّل إلى المدير</span>';
    if (c.has_viewing) t += '<span class="tag view">معاينة</span>';
    return t;
  }

  function customerMatches(c, f) {
    if (f === 'today') return c.active_today;
    if (f === 'hot') return c.hot;
    if (f === 'viewing') return c.has_viewing;
    if (f === 'escalated') return c.escalated;
    return true;
  }

  function renderCustomers() {
    renderChips($('#customerChips'), CUSTOMER_FILTERS, filters.customers, (f) => {
      filters.customers = f;
      renderCustomers();
    });

    const q = $('#search').value.trim();
    const rows = customers.filter((c) => customerMatches(c, filters.customers));

    if (!rows.length) {
      $('#customersTable').innerHTML =
        '<div class="empty">' + (q || filters.customers !== 'all' ? 'لا توجد نتائج مطابقة.' : 'سيظهر العملاء هنا عند مراسلة أول عميل للبوت.') + '</div>';
      return;
    }

    $('#customersTable').innerHTML =
      '<table><thead><tr><th>العميل</th><th>آخر رسالة</th><th>آخر قالب</th><th>عدد رسائله</th><th>آخر نشاط</th><th></th></tr></thead><tbody>' +
      rows.map((c) =>
        '<tr class="clickable" data-phone="' + esc(c.customer_phone) + '">' +
          '<td><span class="ltr">' + esc(localPhone(c.customer_phone)) + '</span><br>' + tags(c) + '</td>' +
          '<td><div class="snippet">' + esc(c.last_message || 'وصله قالب ولم يردّ') + '</div></td>' +
          '<td>' + (c.last_tpl_status ? ticks(c.last_tpl_status, true) : '<span class="muted">—</span>') + '</td>' +
          '<td>' + esc(c.user_messages) + '</td>' +
          '<td>' + esc(fmt(c.last_user_at || c.last_at)) + '</td>' +
          '<td><a class="wa" target="_blank" rel="noopener" href="https://wa.me/' + esc(c.customer_phone) + '" onclick="event.stopPropagation()">واتساب</a></td>' +
        '</tr>'
      ).join('') +
      '</tbody></table>';

    document.querySelectorAll('#customersTable tr.clickable').forEach((tr) => {
      tr.addEventListener('click', () => openConversation(tr.dataset.phone));
    });
  }

  async function loadCustomers() {
    const q = $('#search').value.trim();
    customers = await api('/admin/api/customers' + (q ? '?search=' + encodeURIComponent(q) : ''));
    renderCustomers();
  }

  // ---------- Escalations ----------

  function escalationTable(list, emptyText) {
    if (!list.length) return '<div class="empty">' + emptyText + '</div>';
    return '<div class="panel" style="border:0"><table><thead><tr><th>العميل</th><th>الطلب</th><th>أُبلغ المدير؟</th><th>الوقت</th><th></th></tr></thead><tbody>' +
      list.map((r) =>
        '<tr class="clickable" data-phone="' + esc(r.customer_phone) + '">' +
          '<td><span class="ltr">' + esc(localPhone(r.customer_phone)) + '</span>' + (r.hot ? '<br><span class="tag hot">احجز شراء</span>' : '') + '</td>' +
          '<td><div class="snippet">' + esc(r.question) + '</div></td>' +
          '<td>' + (r.manager_notified ? 'نعم' : 'لا') + '</td>' +
          '<td>' + esc(fmt(r.created_at)) + '</td>' +
          '<td><a class="wa" target="_blank" rel="noopener" href="https://wa.me/' + esc(r.customer_phone) + '" onclick="event.stopPropagation()">واتساب</a></td>' +
        '</tr>'
      ).join('') +
      '</tbody></table></div>';
  }

  function renderEscalations() {
    renderChips($('#escChips'), ESC_FILTERS, filters.escalations, (f) => {
      filters.escalations = f;
      renderEscalations();
    });

    const list = filters.escalations === 'hot'
      ? escalationsData.filter((r) => r.hot)
      : escalationsData;

    $('#escalationsTable').innerHTML = escalationTable(
      list,
      filters.escalations === 'hot' ? 'لا يوجد عملاء ضغطوا على «احجز شراء» حتى الآن.' : 'لا توجد طلبات للمدير حتى الآن.'
    );

    const seen = new Set();
    const hot = escalationsData.filter((r) => r.hot && !seen.has(r.customer_phone) && seen.add(r.customer_phone));
    $('#hotTable').innerHTML = escalationTable(hot, 'لا يوجد عملاء ضغطوا على «احجز شراء» حتى الآن.');

    document.querySelectorAll('#escalationsTable tr.clickable, #hotTable tr.clickable').forEach((tr) => {
      tr.addEventListener('click', () => openConversation(tr.dataset.phone));
    });
  }

  async function loadEscalations() {
    escalationsData = await api('/admin/api/escalations');
    renderEscalations();
  }

  // ---------- Viewings ----------

  async function loadViewings() {
    const rows = await api('/admin/api/viewings');

    if (!rows.length) {
      $('#viewingsTable').innerHTML = '<div class="empty">لا توجد طلبات معاينة حتى الآن.</div>';
      return;
    }

    $('#viewingsTable').innerHTML =
      '<table><thead><tr><th>العميل</th><th>العقار</th><th>اليوم</th><th>الوقت</th><th>الصفة</th><th>تاريخ الطلب</th></tr></thead><tbody>' +
      rows.map((r) =>
        '<tr class="clickable" data-phone="' + esc(r.customer_phone) + '">' +
          '<td><span class="ltr">' + esc(localPhone(r.customer_phone)) + '</span></td>' +
          '<td>' + esc(r.property_name) + '</td>' +
          '<td>' + esc(r.requested_day) + '</td>' +
          '<td>' + esc(r.requested_time) + '</td>' +
          '<td>' + esc(r.customer_type) + '</td>' +
          '<td>' + esc(fmt(r.created_at)) + '</td>' +
        '</tr>'
      ).join('') +
      '</tbody></table>';

    document.querySelectorAll('#viewingsTable tr.clickable').forEach((tr) => {
      tr.addEventListener('click', () => openConversation(tr.dataset.phone));
    });
  }

  // ---------- Sent messages + campaigns ----------

  function renderCampaigns() {
    const shown = campaignsData.slice(0, 6);

    if (!shown.length) {
      $('#campaigns').innerHTML = '';
      return;
    }

    $('#campaigns').innerHTML = shown.map((c) => {
      const done = c.total - c.queued - c.cancelled;
      const pct = c.total ? Math.round(done * 100 / c.total) : 0;
      const active = c.status === 'running' || c.status === 'paused';

      let buttons = '<button type="button" class="btn btn-ghost btn-small" data-camp-pick="' + c.id + '">' + (msgCampaign === c.id ? 'عرض كل الرسائل' : 'عرض رسائل هذه الحملة') + '</button>';
      if (c.status === 'running') buttons += '<button type="button" class="btn btn-ghost btn-small" data-camp="' + c.id + '" data-action="pause">إيقاف مؤقت</button>';
      if (c.status === 'paused') buttons += '<button type="button" class="btn btn-small" data-camp="' + c.id + '" data-action="resume">استئناف</button>';
      if (active) buttons += '<button type="button" class="btn btn-danger btn-small" data-camp="' + c.id + '" data-action="cancel">إلغاء الباقي</button>';

      return '<div class="camp ' + esc(c.status) + (msgCampaign === c.id ? ' picked' : '') + '">' +
        '<div class="camp-top">' +
          '<div><span class="camp-title">حملة #' + esc(c.id) + ' — ' + esc(c.template_name) + '</span>' +
          '<span class="camp-status">' + esc(CAMPAIGN_LABELS[c.status] || c.status) + '</span></div>' +
          '<div class="muted">' + esc(done) + ' من ' + esc(c.total) + ' — رسالة كل ' + esc(c.delay_seconds) + ' ثانية</div>' +
        '</div>' +
        '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
        '<div class="camp-stats">' +
          '<span>' + ticks('sent', true) + ' ' + esc(c.sent) + '</span>' +
          '<span>' + ticks('delivered', true) + ' ' + esc(c.delivered) + '</span>' +
          '<span>' + ticks('read', true) + ' ' + esc(c.read_count) + '</span>' +
          '<span>' + ticks('failed', true) + ' ' + esc(c.failed) + '</span>' +
          (c.queued ? '<span>' + ticks('queued', true) + ' ' + esc(c.queued) + '</span>' : '') +
        '</div>' +
        '<div class="camp-actions">' + buttons + '</div>' +
      '</div>';
    }).join('');

    document.querySelectorAll('[data-camp-pick]').forEach((b) => {
      b.addEventListener('click', () => {
        const id = Number(b.dataset.campPick);
        msgCampaign = msgCampaign === id ? null : id;
        loadMessagesView().catch(() => {});
      });
    });

    document.querySelectorAll('[data-camp][data-action]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (b.dataset.action === 'cancel' && !confirm('هل تريد إلغاء الرسائل المتبقية في هذه الحملة؟ الرسائل التي أُرسلت لن تتأثر.')) return;
        await api('/admin/api/campaigns/' + b.dataset.camp + '/' + b.dataset.action, { method: 'POST' });
        loadMessagesView().catch(() => {});
        loadStats().catch(() => {});
      });
    });
  }

  function renderMessages() {
    renderChips($('#msgChips'), MSG_FILTERS, filters.messages, (f) => {
      filters.messages = f;
      loadMessagesView().catch(() => {});
    });

    if (!messagesData.length) {
      $('#messagesTable').innerHTML = '<div class="empty">لا توجد رسائل مطابقة.</div>';
      return;
    }

    $('#messagesTable').innerHTML =
      '<table><thead><tr><th>العميل</th><th>القالب</th><th>الحالة</th><th>آخر تحديث</th><th>ردّ العميل</th><th></th></tr></thead><tbody>' +
      messagesData.map((r) =>
        '<tr class="clickable" data-phone="' + esc(r.customer_phone) + '">' +
          '<td><span class="ltr">' + esc(localPhone(r.customer_phone)) + '</span></td>' +
          '<td>' + esc(r.template_name) + '</td>' +
          '<td>' + ticks(r.status, true) +
            (r.status === 'failed' && (r.error_text || r.error_code)
              ? '<div class="why">' + esc((r.error_code ? '(' + r.error_code + ') ' : '') + String(r.error_text || '').slice(0, 140)) + '</div>'
              : '') +
          '</td>' +
          '<td>' + esc(fmt(r.read_at || r.delivered_at || r.sent_at || r.failed_at || r.queued_at)) + '</td>' +
          '<td>' + (r.replied ? '<span class="tag replied">ردّ</span>' : '<span class="muted">—</span>') + '</td>' +
          '<td><a class="wa" target="_blank" rel="noopener" href="https://wa.me/' + esc(r.customer_phone) + '" onclick="event.stopPropagation()">واتساب</a></td>' +
        '</tr>'
      ).join('') +
      '</tbody></table>';

    document.querySelectorAll('#messagesTable tr.clickable').forEach((tr) => {
      tr.addEventListener('click', () => openConversation(tr.dataset.phone));
    });
  }

  async function loadMessagesView() {
    const [campaigns, rows] = await Promise.all([
      api('/admin/api/campaigns'),
      api('/admin/api/template-messages?filter=' + encodeURIComponent(filters.messages) + (msgCampaign ? '&campaign=' + msgCampaign : '')),
    ]);

    campaignsData = campaigns;
    messagesData = rows;
    renderCampaigns();
    renderMessages();
  }

  // ---------- Conversation ----------

  async function openConversation(phone) {
    $('#drawerPhone').textContent = localPhone(phone);
    $('#drawerWa').href = 'https://wa.me/' + phone;
    $('#thread').innerHTML = '<div class="empty">جارٍ التحميل...</div>';
    $('#drawer').classList.add('open');
    $('#drawerBg').classList.add('open');

    const rows = await api('/admin/api/conversation/' + encodeURIComponent(phone));

    $('#thread').innerHTML = rows.length
      ? rows.map((m) => {
          const isTpl = m.role === 'assistant' && String(m.message || '').startsWith('[قالب');
          const cls = isTpl ? 'template' : (m.role === 'assistant' ? 'assistant' : 'user');
          const status = m.tm_status ? ticks(m.tm_status, true) : '';
          const why = m.tm_status === 'failed' && m.tm_error ? '<span class="why">' + esc(String(m.tm_error).slice(0, 120)) + '</span>' : '';
          return '<div class="msg ' + cls + '">' + esc(m.message) + '<time><span>' + esc(fmt(m.created_at)) + '</span>' + status + why + '</time></div>';
        }).join('')
      : '<div class="empty">لا توجد رسائل.</div>';

    $('#thread').scrollTop = $('#thread').scrollHeight;
  }

  function closeDrawer() {
    $('#drawer').classList.remove('open');
    $('#drawerBg').classList.remove('open');
  }

  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerBg').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

  // ---------- Send template ----------

  async function loadTemplates() {
    templates = await api('/admin/api/templates');

    $('#tplSelect').innerHTML = templates
      .map((t) => '<option value="' + esc(t.key) + '">' + esc(t.key) + ' (' + esc(t.name) + ')</option>')
      .join('');

    showPreview();
  }

  async function loadConfig() {
    const cfg = await api('/admin/api/config');
    maxNumbers = cfg.maxNumbers;
    defaultDelay = cfg.defaultDelay;
    if (!$('#delay').dataset.touched) $('#delay').value = defaultDelay;
    updateSendHint();
  }

  function showPreview() {
    const t = templates.find((x) => x.key === $('#tplSelect').value);
    if (!t) return;
    $('#tplPreview').textContent = t.preview.replace(/^\[[^\]]*\]\n?/, '');
    $('#tplVideo').textContent = t.hasVideo ? 'يُرسل مع الرسالة فيديو المشروع في أعلاها.' : '';
  }

  $('#tplSelect').addEventListener('change', showPreview);

  // نفس طريقة السيرفر في استخراج الأرقام (للعدّ والتقدير فقط)
  function toEnglishDigits(t) {
    return String(t || '')
      .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
      .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
  }

  function toIntlSaudi(raw) {
    let n = String(raw || '').replace(/\D/g, '');
    if (n.startsWith('00')) n = n.slice(2);
    if (/^05\d{8}$/.test(n)) return '966' + n.slice(1);
    if (/^5\d{8}$/.test(n)) return '966' + n;
    if (/^9665\d{8}$/.test(n)) return n;
    if (n.length >= 10 && n.length <= 15 && !n.startsWith('0')) return n;
    return null;
  }

  function extractNumbersClient(text) {
    const out = [];
    const lines = toEnglishDigits(text).split(/[\n,،;؛]+/).map((l) => l.trim()).filter(Boolean);

    for (const line of lines) {
      const compact = line.replace(/[\s\-()]/g, '');
      const whole = /^\+?\d{9,15}$/.test(compact) ? toIntlSaudi(compact) : null;
      if (whole) { out.push(whole); continue; }
      for (const token of line.split(/\s+/)) {
        const n = toIntlSaudi(token);
        if (n) out.push(n);
      }
    }

    return [...new Set(out)];
  }

  function updateSendHint() {
    const n = extractNumbersClient($('#numbers').value).length;
    const delay = Math.max(1, Math.round(Number($('#delay').value) || defaultDelay));
    const minutes = Math.max(1, Math.round(n * delay / 60));

    $('#numbersHint').textContent = n
      ? n + ' رقم، والمدة المتوقعة نحو ' + minutes + ' دقيقة (بحد أقصى ' + maxNumbers + ' رقم في الحملة).'
      : 'اكتب كل رقم في سطر مستقل، بحد أقصى ' + maxNumbers + ' رقم في الحملة.';
  }

  $('#numbers').addEventListener('input', updateSendHint);
  $('#delay').addEventListener('input', () => { $('#delay').dataset.touched = '1'; updateSendHint(); });

  $('#fillAll').addEventListener('click', async () => {
    if (!customers.length) await loadCustomers();
    $('#numbers').value = customers.map((c) => localPhone(c.customer_phone)).join('\n');
    updateSendHint();
  });

  $('#sendBtn').addEventListener('click', async () => {
    const text = $('#numbers').value;
    const key = $('#tplSelect').value;
    const delay = Math.max(1, Math.round(Number($('#delay').value) || defaultDelay));
    const count = extractNumbersClient(text).length;
    const box = $('#sendResult');

    box.style.display = 'block';
    box.textContent = '';

    if (!count) {
      box.textContent = 'اكتب رقمًا واحدًا على الأقل.';
      return;
    }

    if (!confirm('هل تريد إرسال القالب «' + key + '» إلى ' + count + ' رقم، بفاصل ' + delay + ' ثانية بين كل رسالة؟')) return;

    $('#sendBtn').disabled = true;
    box.textContent = 'جارٍ جدولة الإرسال...';

    try {
      const r = await api('/admin/api/campaigns', {
        method: 'POST',
        body: JSON.stringify({ templateKey: key, numbersText: text, delaySeconds: delay }),
      });

      if (r.error) {
        const msgs = {
          no_numbers: 'لم يتم العثور على أرقام صحيحة. اكتبها بصيغة 0551234567.',
          too_many_numbers: 'العدد يتجاوز ' + maxNumbers + ' رقم. قسّم الأرقام على أكثر من حملة.',
          unknown_template: 'القالب غير موجود.',
        };
        box.textContent = msgs[r.error] || 'حدث خطأ. حاول مرة أخرى.';
      } else {
        const minutes = Math.max(1, Math.round(r.total * r.delaySeconds / 60));
        box.innerHTML = '';
        const line = document.createElement('div');
        line.textContent = 'تمت جدولة الإرسال: ' + r.total + ' رقم، رسالة كل ' + r.delaySeconds + ' ثانية (نحو ' + minutes + ' دقيقة). يمكنك إغلاق الصفحة، فالإرسال يكمل تلقائيًا على السيرفر.';
        box.appendChild(line);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-ghost btn-small';
        btn.style.marginTop = '10px';
        btn.dataset.go = 'messages';
        btn.dataset.filter = 'all';
        btn.textContent = 'متابعة التقدم';
        box.appendChild(btn);
        $('#numbers').value = '';
        updateSendHint();
        loadStats().catch(() => {});
      }
    } catch (e) {
      box.textContent = 'انقطع الاتصال. تأكد من الإنترنت وحاول مرة أخرى.';
    }

    $('#sendBtn').disabled = false;
  });

  // ---------- Init ----------

  let searchTimer;
  $('#search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadCustomers().catch(() => {}), 350);
  });

  $('#todayLabel').textContent = new Date().toLocaleDateString('ar-SA-u-ca-gregory-nu-latn', {
    timeZone: 'Asia/Riyadh', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  async function refreshAll() {
    try {
      await Promise.all([loadStats(), loadCustomers(), loadEscalations(), loadViewings(), loadTemplates(), loadConfig(), loadMessagesView()]);
    } catch (e) { /* login handled in api() */ }
  }

  // التحديث التلقائي: ما يلمس خانة الإرسال ولا اللي أنت بتكتبه
  async function refreshQuiet() {
    try {
      const jobs = [loadStats(), loadCustomers(), loadEscalations(), loadViewings()];
      if (currentView === 'messages') jobs.push(loadMessagesView());
      await Promise.all(jobs);
    } catch (e) { /* ignore */ }
  }

  $('#refreshBtn').addEventListener('click', refreshAll);

  fetch('/admin/api/me', { credentials: 'same-origin' })
    .then((r) => r.json())
    .then((r) => (r.loggedIn ? showApp() : showLogin()))
    .catch(showLogin);
</script>
</body>
</html>`;


module.exports = {
  registerDashboard,
};
