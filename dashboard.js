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
    sendTemplateToNumbers,
    createReportWorkbook,
    password,
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
      ] = await Promise.all([
        q(`SELECT COUNT(DISTINCT customer_phone)::int AS count FROM conversations WHERE role = 'user'`),
        q(`SELECT COUNT(DISTINCT customer_phone)::int AS count FROM conversations WHERE role = 'user' AND created_at >= CURRENT_DATE`),
        q(`SELECT COUNT(*)::int AS count FROM viewing_requests`),
        q(`SELECT COUNT(*)::int AS count FROM manager_escalations`),
        q(`SELECT COUNT(DISTINCT customer_phone)::int AS count FROM manager_escalations WHERE question LIKE '%احجز شراء%'`),
        q(`SELECT COUNT(*)::int AS count FROM conversations WHERE role = 'user' AND created_at >= CURRENT_DATE`),
      ]);

      res.json({
        customers,
        activeToday,
        viewings,
        escalations,
        hotLeads,
        messagesToday,
      });

    } catch (err) {

      console.error('Dashboard stats error:', err);
      res.status(500).json({ error: 'server_error' });
    }
  });


  // =====================================================
  // العملاء
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
            MAX(created_at) AS last_at
          FROM conversations
          ${where}
          GROUP BY customer_phone
          ORDER BY last_at DESC
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

      // 2) آخر رسالة من كل عميل + المعاينات + التحويلات
      const [lastMessages, viewings, escalations] =
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

      res.json(
        rows.map((r) => ({
          ...r,
          last_message: lastByPhone[r.customer_phone] || null,
          has_viewing: viewingSet.has(r.customer_phone),
          escalated: escalatedSet.has(r.customer_phone),
          hot: hotSet.has(r.customer_phone),
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
          SELECT role, message, created_at
          FROM conversations
          WHERE customer_phone = $1
          ORDER BY created_at ASC, id ASC
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
  // القوالب
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


  app.post('/admin/api/send-template', requireLogin, async (req, res) => {

    try {

      const template =
        TEMPLATES[req.body?.templateKey];

      if (!template) {
        return res
          .status(400)
          .json({ error: 'unknown_template' });
      }

      const raw =
        Array.isArray(req.body?.numbers)
          ? req.body.numbers
          : [];

      const numbers = [
        ...new Set(
          raw
            .map((n) => toInternationalSaudi(n))
            .filter(Boolean)
        ),
      ];

      if (!numbers.length) {
        return res
          .status(400)
          .json({ error: 'no_numbers' });
      }

      if (numbers.length > 200) {
        return res
          .status(400)
          .json({ error: 'too_many_numbers' });
      }

      const result =
        await sendTemplateToNumbers(
          template,
          numbers
        );

      res.json(result);

    } catch (err) {

      console.error('Dashboard send template error:', err);
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
      res.status(500).send('تعذر إنشاء الملف');
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
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600&family=Reem+Kufi:wght@500;700&display=swap" rel="stylesheet">
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
  }

  * { box-sizing: border-box; }

  html, body {
    margin: 0;
    background: var(--limestone);
    color: var(--ink);
    font-family: "IBM Plex Sans Arabic", Tahoma, Arial, sans-serif;
    font-size: 15px;
    line-height: 1.6;
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
    font-family: "Reem Kufi", "IBM Plex Sans Arabic", sans-serif;
    font-weight: 700;
    margin: 0;
    line-height: 1.3;
  }

  .ltr { direction: ltr; unicode-bidi: embed; display: inline-block; }

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
    background: var(--palm);
    color: #fff;
    font-weight: 600;
  }

  .btn:hover { background: #17493A; }
  .btn[disabled] { opacity: .6; cursor: wait; }

  .btn-ghost {
    background: transparent;
    color: var(--palm);
    border: 1px solid var(--line);
  }

  .btn-ghost:hover { background: var(--palm-soft); }

  .error { color: var(--hot); min-height: 1.6em; margin-top: 10px; font-size: 14px; }

  /* ---------- Layout ---------- */

  #app { display: none; min-height: 100vh; }

  .shell {
    display: grid;
    grid-template-columns: 230px 1fr;
    min-height: 100vh;
  }

  aside {
    background: var(--palm);
    color: #fff;
    padding: 26px 18px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .brand {
    font-family: "Reem Kufi", sans-serif;
    font-size: 21px;
    line-height: 1.35;
    margin-bottom: 4px;
  }

  .brand small {
    display: block;
    font-family: "IBM Plex Sans Arabic", sans-serif;
    font-size: 13px;
    color: #C9DDD2;
    font-weight: 400;
  }

  .rule {
    height: 2px;
    background: var(--gold);
    width: 44px;
    margin: 12px 0 18px;
  }

  nav button {
    width: 100%;
    text-align: right;
    background: transparent;
    border: 0;
    color: #E6F0EA;
    padding: 10px 12px;
    border-radius: 6px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  nav button:hover { background: rgba(255,255,255,.08); }

  nav button.active {
    background: var(--paper);
    color: var(--palm);
    font-weight: 600;
  }

  .count {
    font-size: 12px;
    background: rgba(255,255,255,.16);
    padding: 0 8px;
    border-radius: 10px;
  }

  nav button.active .count { background: var(--palm-soft); }

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
    padding: 28px 32px 48px;
    max-width: 1100px;
    width: 100%;
  }

  .page-head {
    display: flex;
    justify-content: space-between;
    align-items: end;
    gap: 16px;
    margin-bottom: 20px;
    flex-wrap: wrap;
  }

  .page-head h2 { font-size: 28px; }
  .page-head p { margin: 2px 0 0; color: var(--muted); }

  section.view { display: none; }
  section.view.active { display: block; }

  /* ---------- Overview ---------- */

  .ledger {
    background: var(--paper);
    border: 1px solid var(--line);
    display: grid;
    grid-template-columns: repeat(3, 1fr);
  }

  .ledger div {
    padding: 18px 20px;
    border-left: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
  }

  .ledger div:nth-child(3n) { border-left: 0; }
  .ledger div:nth-last-child(-n+3) { border-bottom: 0; }

  .ledger b {
    display: block;
    font-family: "Reem Kufi", sans-serif;
    font-size: 30px;
    color: var(--palm);
    line-height: 1.2;
  }

  .ledger span { color: var(--muted); font-size: 14px; }

  .ledger .is-hot b { color: var(--hot); }

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

  /* ---------- Tables ---------- */

  .panel {
    background: var(--paper);
    border: 1px solid var(--line);
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    min-width: 640px;
  }

  th, td {
    text-align: right;
    padding: 11px 16px;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }

  th {
    font-weight: 500;
    color: var(--muted);
    font-size: 13px;
    background: #FAFBF8;
  }

  tr:last-child td { border-bottom: 0; }

  tbody tr.clickable { cursor: pointer; }
  tbody tr.clickable:hover { background: var(--palm-soft); }

  .snippet {
    color: var(--muted);
    max-width: 340px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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

  .wa {
    color: var(--palm);
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
    background: var(--palm);
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
    display: block;
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
      padding: 16px;
      gap: 10px;
    }

    .rule { display: none; }

    nav {
      display: flex;
      gap: 6px;
      overflow-x: auto;
      padding-bottom: 4px;
    }

    nav button {
      width: auto;
      white-space: nowrap;
      gap: 8px;
    }

    .aside-foot {
      grid-template-columns: 1fr 1fr;
    }

    main { padding: 20px 16px 40px; }

    .ledger { grid-template-columns: repeat(2, 1fr); }
    .ledger div { border-left: 1px solid var(--line) !important; border-bottom: 1px solid var(--line) !important; }

    .send-grid { grid-template-columns: 1fr; }
  }

  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
  }
</style>
</head>
<body>

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
        <button data-view="overview" class="active">نظرة عامة</button>
        <button data-view="customers">العملاء <span class="count" id="nCustomers">0</span></button>
        <button data-view="escalations">طلبات المدير <span class="count hot" id="nHot">0</span></button>
        <button data-view="viewings">المعاينات <span class="count" id="nViewings">0</span></button>
        <button data-view="send">إرسال قالب</button>
      </nav>
      <div class="aside-foot">
        <a href="/admin/api/export">تحميل Excel</a>
        <button id="logout">خروج</button>
      </div>
    </aside>

    <main>

      <!-- نظرة عامة -->
      <section class="view active" id="view-overview">
        <div class="page-head">
          <div>
            <h2>نظرة عامة</h2>
            <p id="todayLabel"></p>
          </div>
          <button class="btn btn-ghost" onclick="refreshAll()">تحديث</button>
        </div>

        <div class="ledger" id="ledger"></div>

        <div class="hotlist">
          <h3>عملاء جاهزين للشراء</h3>
          <p>ضغطوا "احجز شراء". تواصل معهم أول بأول.</p>
          <div id="hotTable"></div>
        </div>
      </section>

      <!-- العملاء -->
      <section class="view" id="view-customers">
        <div class="page-head">
          <div>
            <h2>العملاء</h2>
            <p>اضغط على أي عميل عشان تشوف محادثته كاملة.</p>
          </div>
        </div>
        <div class="toolbar">
          <input class="field" id="search" type="search" placeholder="ابحث برقم أو بكلمة من المحادثة">
        </div>
        <div class="panel" id="customersTable"></div>
      </section>

      <!-- طلبات المدير -->
      <section class="view" id="view-escalations">
        <div class="page-head">
          <div>
            <h2>طلبات المدير</h2>
            <p>أسئلة ما قدر البوت يجاوبها، وعملاء طلبوا الشراء.</p>
          </div>
        </div>
        <div class="panel" id="escalationsTable"></div>
      </section>

      <!-- المعاينات -->
      <section class="view" id="view-viewings">
        <div class="page-head">
          <div>
            <h2>طلبات المعاينة</h2>
            <p>المواعيد اللي سجلها العملاء مع البوت.</p>
          </div>
        </div>
        <div class="panel" id="viewingsTable"></div>
      </section>

      <!-- إرسال قالب -->
      <section class="view" id="view-send">
        <div class="page-head">
          <div>
            <h2>إرسال قالب</h2>
            <p>الرسالة توصل للعميل حتى لو ما راسلنا قبل.</p>
          </div>
        </div>

        <div class="notice">رسائل العروض تُحسب من Meta كرسائل تسويقية بتكلفة على كل رسالة. أرسلها للعملاء المهتمين فقط.</div>

        <div class="send-grid">
          <div class="card">
            <label class="lbl" for="tplSelect">القالب</label>
            <select class="field" id="tplSelect"></select>

            <label class="lbl" for="numbers">أرقام العملاء</label>
            <textarea class="field" id="numbers" placeholder="0551234567&#10;0559876543"></textarea>
            <div class="hint" id="numbersHint">كل رقم في سطر. حتى 200 رقم.</div>

            <div class="row-actions">
              <button class="btn" id="sendBtn">إرسال القالب</button>
              <button class="btn btn-ghost" id="fillAll">إضافة كل العملاء</button>
            </div>

            <div class="result" id="sendResult"></div>
          </div>

          <div class="card">
            <h3>شكل الرسالة</h3>
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

  // ---------- Login ----------

  function showLogin() {
    $('#app').style.display = 'none';
    $('#login').style.display = 'grid';
  }

  function showApp() {
    $('#login').style.display = 'none';
    $('#app').style.display = 'block';
    refreshAll();
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
      $('#loginError').textContent = 'محاولات كثيرة. جرّب بعد 15 دقيقة.';
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
    b.addEventListener('click', () => {
      document.querySelectorAll('nav button').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('section.view').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      $('#view-' + b.dataset.view).classList.add('active');
    });
  });

  // ---------- Data ----------

  let customers = [];

  async function loadStats() {
    const s = await api('/admin/api/stats');

    $('#nCustomers').textContent = s.customers;
    $('#nViewings').textContent = s.viewings;
    $('#nHot').textContent = s.hotLeads;

    const cells = [
      ['عملاء راسلوا البوت', s.customers, ''],
      ['عملاء اليوم', s.activeToday, ''],
      ['رسائل اليوم', s.messagesToday, ''],
      ['طلبات معاينة', s.viewings, ''],
      ['تحويلات للمدير', s.escalations, ''],
      ['جاهزين للشراء', s.hotLeads, 'is-hot'],
    ];

    $('#ledger').innerHTML = cells
      .map((c) => '<div class="' + c[2] + '"><b>' + esc(c[1]) + '</b><span>' + esc(c[0]) + '</span></div>')
      .join('');
  }

  function tags(c) {
    let t = '';
    if (c.hot) t += '<span class="tag hot">احجز شراء</span>';
    else if (c.escalated) t += '<span class="tag esc">حُوّل للمدير</span>';
    if (c.has_viewing) t += '<span class="tag view">معاينة</span>';
    return t;
  }

  async function loadCustomers() {
    const q = $('#search').value.trim();
    customers = await api('/admin/api/customers' + (q ? '?search=' + encodeURIComponent(q) : ''));

    if (!customers.length) {
      $('#customersTable').innerHTML =
        '<div class="empty">' + (q ? 'ما فيه نتائج لهذا البحث.' : 'لما يراسل أول عميل البوت، بيظهر هنا.') + '</div>';
      return;
    }

    $('#customersTable').innerHTML =
      '<table><thead><tr><th>العميل</th><th>آخر رسالة</th><th>رسائله</th><th>آخر نشاط</th><th></th></tr></thead><tbody>' +
      customers.map((c) =>
        '<tr class="clickable" data-phone="' + esc(c.customer_phone) + '">' +
          '<td><span class="ltr">' + esc(localPhone(c.customer_phone)) + '</span><br>' + tags(c) + '</td>' +
          '<td><div class="snippet">' + esc(c.last_message || 'وصله قالب ولم يرد') + '</div></td>' +
          '<td>' + esc(c.user_messages) + '</td>' +
          '<td>' + esc(fmt(c.last_at)) + '</td>' +
          '<td><a class="wa" target="_blank" rel="noopener" href="https://wa.me/' + esc(c.customer_phone) + '" onclick="event.stopPropagation()">واتساب</a></td>' +
        '</tr>'
      ).join('') +
      '</tbody></table>';

    document.querySelectorAll('#customersTable tr.clickable').forEach((tr) => {
      tr.addEventListener('click', () => openConversation(tr.dataset.phone));
    });
  }

  async function loadEscalations() {
    const rows = await api('/admin/api/escalations');

    const table = (list, emptyText) => {
      if (!list.length) return '<div class="empty">' + emptyText + '</div>';
      return '<div class="panel" style="border:0"><table><thead><tr><th>العميل</th><th>الطلب</th><th>وصل للمدير؟</th><th>الوقت</th><th></th></tr></thead><tbody>' +
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
    };

    $('#escalationsTable').innerHTML = table(rows, 'ما فيه طلبات للمدير حتى الآن.');

    const seen = new Set();
    const hot = rows.filter((r) => r.hot && !seen.has(r.customer_phone) && seen.add(r.customer_phone));
    $('#hotTable').innerHTML = table(hot, 'لا يوجد عملاء ضغطوا "احجز شراء" حتى الآن.');

    document.querySelectorAll('#escalationsTable tr.clickable, #hotTable tr.clickable').forEach((tr) => {
      tr.addEventListener('click', () => openConversation(tr.dataset.phone));
    });
  }

  async function loadViewings() {
    const rows = await api('/admin/api/viewings');

    if (!rows.length) {
      $('#viewingsTable').innerHTML = '<div class="empty">ما فيه طلبات معاينة حتى الآن.</div>';
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

  // ---------- Conversation ----------

  async function openConversation(phone) {
    $('#drawerPhone').textContent = localPhone(phone);
    $('#drawerWa').href = 'https://wa.me/' + phone;
    $('#thread').innerHTML = '<div class="empty">جاري التحميل...</div>';
    $('#drawer').classList.add('open');
    $('#drawerBg').classList.add('open');

    const rows = await api('/admin/api/conversation/' + encodeURIComponent(phone));

    $('#thread').innerHTML = rows.length
      ? rows.map((m) => {
          const isTpl = m.role === 'assistant' && String(m.message || '').startsWith('[قالب');
          const cls = isTpl ? 'template' : (m.role === 'assistant' ? 'assistant' : 'user');
          return '<div class="msg ' + cls + '">' + esc(m.message) + '<time>' + esc(fmt(m.created_at)) + '</time></div>';
        }).join('')
      : '<div class="empty">ما فيه رسائل.</div>';

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

  let templates = [];

  async function loadTemplates() {
    templates = await api('/admin/api/templates');

    $('#tplSelect').innerHTML = templates
      .map((t) => '<option value="' + esc(t.key) + '">' + esc(t.key) + ' (' + esc(t.name) + ')</option>')
      .join('');

    showPreview();
  }

  function showPreview() {
    const t = templates.find((x) => x.key === $('#tplSelect').value);
    if (!t) return;
    $('#tplPreview').textContent = t.preview.replace(/^\[[^\]]*\]\n?/, '');
    $('#tplVideo').textContent = t.hasVideo ? 'الرسالة يوصل معها فيديو المشروع في الأعلى.' : '';
  }

  $('#tplSelect').addEventListener('change', showPreview);

  function countNumbers() {
    const n = $('#numbers').value.split(/[\n,،]+/).map((x) => x.trim()).filter(Boolean).length;
    $('#numbersHint').textContent = n ? n + ' رقم. حتى 200 رقم في المرة.' : 'كل رقم في سطر. حتى 200 رقم.';
  }

  $('#numbers').addEventListener('input', countNumbers);

  $('#fillAll').addEventListener('click', async () => {
    if (!customers.length) await loadCustomers();
    $('#numbers').value = customers.map((c) => localPhone(c.customer_phone)).join('\n');
    countNumbers();
  });

  $('#sendBtn').addEventListener('click', async () => {
    const numbers = $('#numbers').value.split(/[\n,،]+/).map((x) => x.trim()).filter(Boolean);
    const key = $('#tplSelect').value;

    if (!numbers.length) {
      $('#sendResult').style.display = 'block';
      $('#sendResult').textContent = 'اكتب رقم واحد على الأقل.';
      return;
    }

    if (!confirm('إرسال قالب "' + key + '" إلى ' + numbers.length + ' رقم؟')) return;

    $('#sendBtn').disabled = true;
    $('#sendBtn').textContent = 'جاري الإرسال...';
    $('#sendResult').style.display = 'block';
    $('#sendResult').textContent = 'جاري الإرسال، لا تقفل الصفحة...';

    try {
      const r = await api('/admin/api/send-template', {
        method: 'POST',
        body: JSON.stringify({ templateKey: key, numbers }),
      });

      if (r.error) {
        const msgs = {
          no_numbers: 'ما لقيت أرقام صحيحة. اكتبها مثل 0551234567.',
          too_many_numbers: 'العدد أكثر من 200. قسّمها على أكثر من مرة.',
          unknown_template: 'القالب غير موجود.',
        };
        $('#sendResult').textContent = msgs[r.error] || 'صار خطأ. جرّب مرة ثانية.';
      } else {
        let text = 'تم الإرسال: ' + r.sent.length + '\nفشل: ' + r.failed.length;
        if (r.failed.length) text += '\n\nالأرقام اللي فشلت:\n' + r.failed.join('\n');
        $('#sendResult').textContent = text;
        refreshAll();
      }
    } catch (e) {
      $('#sendResult').textContent = 'انقطع الاتصال. تأكد من النت وجرّب مرة ثانية.';
    }

    $('#sendBtn').disabled = false;
    $('#sendBtn').textContent = 'إرسال القالب';
  });

  // ---------- Init ----------

  let searchTimer;
  $('#search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadCustomers, 350);
  });

  $('#todayLabel').textContent = new Date().toLocaleDateString('ar-SA-u-ca-gregory-nu-latn', {
    timeZone: 'Asia/Riyadh', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  async function refreshAll() {
    try {
      await Promise.all([loadStats(), loadCustomers(), loadEscalations(), loadViewings(), loadTemplates()]);
    } catch (e) { /* login handled in api() */ }
  }

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
