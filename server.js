require('dotenv').config();

const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const {
  generateReplyDetailed,
  generateStickerReply,
  isViewingRequest,
  extractViewingData,
  detectCurrentProperty,
} = require('./agentBrain');

const { registerDashboard } = require('./dashboard');

const app = express();

// Render يمرر الطلبات عن طريق proxy
app.set('trust proxy', 1);

app.use(
  express.json({
    limit: '25mb',
  })
);

const PORT =
  Number(process.env.PORT) ||
  3000;

const VERIFY_TOKEN =
  process.env.WHATSAPP_VERIFY_TOKEN ||
  '';

const WHATSAPP_TOKEN =
  process.env.WHATSAPP_TOKEN ||
  '';

const PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID ||
  '';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  '';

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY ||
  '';

const ADMIN_REPORT_CODE =
  process.env.ADMIN_REPORT_CODE ||
  '';

const ADMIN_WHATSAPP_NUMBERS =
  String(
    process.env.ADMIN_WHATSAPP_NUMBERS ||
    ''
  )
    .split(',')
    .map(
      (number) =>
        number.replace(/\D/g, '')
    )
    .filter(Boolean);

const CONTACT_NUMBER =
  process.env.CONTACT_NUMBER ||
  '0564685620';

// كلمة سر الداشبورد (لو ما انحطت، تستخدم كلمة سر التقرير)
const DASHBOARD_PASSWORD =
  process.env.DASHBOARD_PASSWORD ||
  ADMIN_REPORT_CODE;


// =====================================================
// المدير العام (التحويل لما البوت ما يعرف يرد)
// =====================================================

// الرقم اللي يظهر للعميل
const MANAGER_DISPLAY_NUMBER =
  process.env.MANAGER_DISPLAY_NUMBER ||
  '0544574050';

// رقم واتساب المدير بالصيغة الدولية (لإرسال التنبيه)
const MANAGER_WHATSAPP_NUMBER =
  String(
    process.env.MANAGER_WHATSAPP_NUMBER ||
    '966544574050'
  ).replace(/\D/g, '');

// =====================================================
// القوالب (رسائل نرسلها للعملاء من نفسنا)
// =====================================================

// رابط السيرفر نفسه (عشان واتساب يقدر يحمّل الفيديو منه)
const PUBLIC_BASE_URL =
  (
    process.env.PUBLIC_BASE_URL ||
    'https://taibah-agent-backend.onrender.com'
  ).replace(/\/$/, '');

// كل قالب له كلمة تكتبها بعد كلمة السر
// مثال: 102030 رونق 0551234567
const TEMPLATES = {

  'رونق': {
    name: 'rawnaq_project',
    language: 'ar',
    videoFile: 'rawnaq.mp4',
    // هذا النص يتحفظ في المحادثة عشان البوت يعرف إن العميل وصله عرض الرونق
    logText:
`[قالب مرسل للعميل: مشروع الرونق]
السلام عليكم ورحمة الله 🌹
نقدّم لك مشروع الرونق 🏛️ شقق فندقية بتصميم أندلسي فاخر في المدينة المنورة.
مواصفات الشقة: المساحة 135 م²، 4 غرف + صالة + مطبخ، 3 دورات مياه، ملحق خاص للعاملة.
خدمات المشروع: صالات استقبال للرجال والنساء، نادي رياضي، غرف خاصة للسائقين، مواقف سيارات.
للتفاصيل والأسعار: أزرار (اتصل بالمدير / أبي التفاصيل / احجز شراء) أو 0544574050`,
  },
};

// أقصى عدد أرقام في أمر واتساب الواحد
const MAX_NUMBERS_PER_COMMAND = 200;

// الفاصل الافتراضي بين رسالة والتي بعدها (بالثواني) عند إرسال القوالب
const DEFAULT_SEND_DELAY_SECONDS =
  Number(process.env.DEFAULT_SEND_DELAY_SECONDS) || 8;

// أقصى عدد أرقام في الحملة الواحدة من اللوحة
const MAX_NUMBERS_PER_CAMPAIGN = 500;


// ما نزعج المدير بنفس العميل أكثر من مرة كل 30 دقيقة
const MANAGER_ALERT_COOLDOWN_MS =
  30 * 60 * 1000;

const lastManagerAlert =
  new Map();


// =====================================================
// PostgreSQL
// =====================================================

const pool =
  new Pool({
    connectionString:
      DATABASE_URL,

    ssl:
      DATABASE_URL &&
      !DATABASE_URL.includes(
        'localhost'
      )
        ? {
            rejectUnauthorized:
              false,
          }
        : false,
  });


pool.on(
  'error',
  (err) => {
    console.error(
      'PostgreSQL pool error:',
      err
    );
  }
);


// =====================================================
// إنشاء الجداول
// =====================================================

async function initializeDatabase() {

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      customer_phone VARCHAR(30) NOT NULL,
      role VARCHAR(20) NOT NULL,
      message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_conversations_phone
    ON conversations(customer_phone);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS viewing_requests (
      id SERIAL PRIMARY KEY,
      customer_phone VARCHAR(30) NOT NULL,
      property_name TEXT,
      requested_day VARCHAR(100),
      requested_time VARCHAR(100),
      customer_type VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS viewing_sessions (
      customer_phone VARCHAR(30) PRIMARY KEY,
      property_name TEXT,
      requested_day VARCHAR(100),
      requested_time VARCHAR(100),
      customer_type VARCHAR(50),
      status VARCHAR(30) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // جدول جديد: الأسئلة اللي تحولت للمدير
  await pool.query(`
    CREATE TABLE IF NOT EXISTS manager_escalations (
      id SERIAL PRIMARY KEY,
      customer_phone VARCHAR(30) NOT NULL,
      question TEXT,
      manager_notified BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // حملات إرسال القوالب (رسالة كل X ثانية في الخلفية)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      template_key VARCHAR(50) NOT NULL,
      template_name VARCHAR(100) NOT NULL,
      delay_seconds INT NOT NULL DEFAULT 8,
      status VARCHAR(20) NOT NULL DEFAULT 'running',
      notify_phone VARCHAR(30),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      finished_at TIMESTAMP
    );
  `);

  // كل رسالة قالب (في الطابور أو مرسلة) وحالتها: أُرسلت / وصلت / قُرئت / فشلت
  await pool.query(`
    CREATE TABLE IF NOT EXISTS template_messages (
      id SERIAL PRIMARY KEY,
      campaign_id INT,
      customer_phone VARCHAR(30) NOT NULL,
      template_key VARCHAR(50),
      template_name VARCHAR(100),
      status VARCHAR(20) NOT NULL DEFAULT 'queued',
      wamid TEXT,
      error_code INT,
      error_text TEXT,
      queued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      sent_at TIMESTAMP,
      delivered_at TIMESTAMP,
      read_at TIMESTAMP,
      failed_at TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_template_messages_phone
    ON template_messages(customer_phone);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_template_messages_wamid
    ON template_messages(wamid);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_template_messages_campaign
    ON template_messages(campaign_id, status);
  `);

  // ربط رسالة القالب في المحادثة بحالتها (لعرض علامات الصح)
  await pool.query(`
    ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS template_msg_id INT;
  `);

  console.log(
    'Database tables ready'
  );
}


// =====================================================
// Health
// =====================================================

app.get(
  '/',
  (req, res) => {
    res
      .status(200)
      .send(
        'Taibah AI Agent is running'
      );
  }
);


// ملفات الفيديو للقوالب (واتساب يحمّلها من هنا)
app.get(
  '/media/:file',
  (req, res) => {

    const file =
      path.basename(
        String(req.params.file || '')
      );

    if (!/\.(mp4|jpg|jpeg|png)$/i.test(file)) {
      return res.sendStatus(404);
    }

    const fullPath =
      path.join(__dirname, file);

    if (!fs.existsSync(fullPath)) {
      return res.sendStatus(404);
    }

    res.sendFile(fullPath);
  }
);


app.get(
  '/health',
  async (req, res) => {

    try {

      await pool.query(
        'SELECT 1'
      );

      res.json({
        ok: true,
        database: true,
      });

    } catch (err) {

      console.error(
        'Health check error:',
        err
      );

      res
        .status(500)
        .json({
          ok: false,
          database: false,
        });
    }
  }
);


// =====================================================
// Webhook verification
// =====================================================

app.get(
  '/webhook',
  (req, res) => {

    const mode =
      req.query['hub.mode'];

    const token =
      req.query['hub.verify_token'];

    const challenge =
      req.query['hub.challenge'];

    if (
      mode === 'subscribe' &&
      token === VERIFY_TOKEN
    ) {

      console.log(
        'Webhook verified'
      );

      return res
        .status(200)
        .send(challenge);
    }

    return res.sendStatus(
      403
    );
  }
);


// =====================================================
// WhatsApp helpers
// =====================================================

function normalizePhone(
  phone
) {

  return String(
    phone || ''
  ).replace(
    /\D/g,
    ''
  );
}


function isAdminPhone(
  phone
) {

  const normalized =
    normalizePhone(
      phone
    );

  return ADMIN_WHATSAPP_NUMBERS.includes(
    normalized
  );
}


// =====================================================
// تتبع حالة التسليم (وصلت / فشلت / اتقرأت)
// واتساب يرد "تم" لما يقبل الطلب، وبعدها يبعت حالة الرسالة
// الفعلية على الويب هوك. هنا نسجّلها في اللوجات.
// =====================================================

// رسائل القوالب اللي أرسلناها (نتابع كل حالاتها)
// المفتاح: رقم الرسالة عند واتساب (wamid)
const trackedMessages =
  new Map();

const MAX_TRACKED_MESSAGES = 2000;


function trackMessage(
  id,
  to,
  templateName
) {

  if (!id) {
    return;
  }

  trackedMessages.set(
    id,
    {
      to,
      template: templateName,
      at: Date.now(),
    }
  );

  // نحافظ على حجم الذاكرة: نحذف أقدم رسالة لو زاد العدد
  if (trackedMessages.size > MAX_TRACKED_MESSAGES) {

    const oldest =
      trackedMessages.keys().next().value;

    trackedMessages.delete(oldest);
  }
}


// تفسير أشهر أكواد الفشل (للمساعدة فقط، والكود الأصلي يظهر دائمًا)
const FAILURE_HINTS = {
  131026: 'غالبًا الرقم ليس على واتساب، أو لم يقبل شروط واتساب، أو تطبيقه قديم.',
  131042: 'غالبًا مشكلة في وسيلة الدفع أو أهلية الحساب. راجع وسيلة الدفع في Meta Business.',
  131049: 'واتساب قرر عدم التسليم للحفاظ على جودة التجربة (غالبًا حد رسائل التسويق لهذا العميل).',
  130472: 'رقم العميل ضمن تجربة من واتساب تمنع وصول رسائل التسويق إليه.',
  131047: 'مرّت أكثر من 24 ساعة على آخر رسالة من هذا الرقم، فالرسالة العادية لا تصل (يلزم قالب).',
  131048: 'تجاوز حد الرسائل المصنّفة كسبام.',
  131056: 'تجاوز الحد المسموح للمراسلة بين الرقمين في وقت قصير.',
  131053: 'مشكلة في تحميل الوسائط (فيديو أو صورة). تحقق من الرابط والحجم والصيغة.',
  132001: 'القالب غير موجود بهذا الاسم أو اللغة.',
  132012: 'متغيرات القالب لا تطابق ما تم إرساله.',
  132015: 'القالب موقوف مؤقتًا بسبب انخفاض الجودة.',
  132016: 'القالب معطّل.',
  133010: 'رقم واتساب الخاص بالبوت غير مسجّل.',
};


function handleStatusUpdate(
  status
) {

  if (!status) {
    return;
  }

  const tracked =
    trackedMessages.get(
      status.id
    );

  const failed =
    status.status === 'failed';

  // الرسائل العادية (ردود البوت): نسجّل فشلها فقط، عشان اللوجات ما تزدحم
  if (!failed && !tracked) {
    return;
  }

  const who =
    status.recipient_id ||
    tracked?.to ||
    'غير معروف';

  const templateLabel =
    tracked
      ? ` (قالب ${tracked.template})`
      : '';

  if (failed) {

    const err =
      (status.errors && status.errors[0]) ||
      {};

    const detail =
      err.error_data?.details ||
      err.message ||
      err.title ||
      '';

    console.error(
      `❌ فشل التسليم إلى ${who}${templateLabel} — الكود ${err.code ?? 'غير معروف'}: ${err.title || ''} ${detail}`.trim()
    );

    const hint =
      FAILURE_HINTS[err.code];

    if (hint) {
      console.error(
        `   ↳ السبب المحتمل: ${hint}`
      );
    }

    console.error(
      '   التفاصيل الكاملة:',
      JSON.stringify(
        status.errors || status
      )
    );

    return;
  }

  const labels = {
    sent: '📤 واتساب أرسلها',
    delivered: '✅ وصلت لجهاز العميل',
    read: '👁️ العميل قرأها',
  };

  const category =
    status.pricing?.category
      ? ` — تصنيف: ${status.pricing.category}`
      : '';

  console.log(
    `${labels[status.status] || status.status}: ${who}${templateLabel}${category}`
  );
}


// نخزّن حالة رسالة القالب في قاعدة البيانات (لعرض علامات الصح في اللوحة)
const STATUS_RANK = {
  sent: 1,
  delivered: 2,
  read: 3,
};

async function persistStatus(
  status
) {

  if (!status || !status.id) {
    return;
  }

  if (status.status === 'failed') {

    const err =
      (status.errors && status.errors[0]) ||
      {};

    const text =
      [
        err.title,
        err.error_data?.details || err.message,
      ]
        .filter(Boolean)
        .join(' — ')
        .slice(0, 500);

    await pool.query(
      `
      UPDATE template_messages
      SET status = 'failed',
          error_code = $2,
          error_text = $3,
          failed_at = CURRENT_TIMESTAMP
      WHERE wamid = $1
        AND status IN ('queued', 'sending', 'sent')
      `,
      [
        status.id,
        err.code || null,
        text,
      ]
    );

    return;
  }

  const rank =
    STATUS_RANK[status.status];

  if (!rank) {
    return;
  }

  const column = {
    sent: 'sent_at',
    delivered: 'delivered_at',
    read: 'read_at',
  }[status.status];

  const epoch =
    Number(status.timestamp) || null;

  // الحالة ما ترجع لورا أبدًا (مثلًا "قُرئت" ما تتحول لـ "وصلت" لو الإشعارات وصلت مبعثرة)
  await pool.query(
    `
    UPDATE template_messages
    SET status = CASE
          WHEN $2::int > CASE status
                           WHEN 'sent' THEN 1
                           WHEN 'delivered' THEN 2
                           WHEN 'read' THEN 3
                           ELSE 0
                         END
          THEN $3::text
          ELSE status
        END,
        ${column} = COALESCE(
          ${column},
          to_timestamp(
            COALESCE(
              $4::double precision,
              EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)
            )
          )
        )
    WHERE wamid = $1
      AND status <> 'failed'
    `,
    [
      status.id,
      rank,
      status.status,
      epoch,
    ]
  );
}


// =====================================================
// إرسال رسالة نصية
// =====================================================

async function sendWhatsAppText(
  to,
  body
) {

  if (
    !WHATSAPP_TOKEN ||
    !PHONE_NUMBER_ID
  ) {

    console.error(
      'WhatsApp credentials missing'
    );

    return false;
  }

  try {

    await axios.post(

      `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,

      {
        messaging_product:
          'whatsapp',

        recipient_type:
          'individual',

        to:
          normalizePhone(to),

        type:
          'text',

        text: {
          preview_url:
            false,

          body:
            String(body || ''),
        },
      },

      {
        headers: {
          Authorization:
            `Bearer ${WHATSAPP_TOKEN}`,

          'Content-Type':
            'application/json',
        },

        timeout:
          30000,
      }
    );

    return true;

  } catch (err) {

    console.error(
      'WhatsApp send text error:',
      JSON.stringify(
        err.response?.data ||
          err.message,
        null,
        2
      )
    );

    return false;
  }
}


// =====================================================
// معلومات ملف WhatsApp Media
// =====================================================

async function getWhatsAppMediaInfo(
  mediaId
) {

  if (
    !mediaId ||
    !WHATSAPP_TOKEN
  ) {
    return null;
  }

  try {

    const response =
      await axios.get(

        `https://graph.facebook.com/v23.0/${mediaId}`,

        {
          headers: {
            Authorization:
              `Bearer ${WHATSAPP_TOKEN}`,
          },

          timeout:
            30000,
        }
      );

    return response.data;

  } catch (err) {

    console.error(
      'Get WhatsApp media info error:',
      JSON.stringify(
        err.response?.data ||
          err.message,
        null,
        2
      )
    );

    return null;
  }
}


// =====================================================
// تحميل WhatsApp Media
// =====================================================

async function downloadWhatsAppMedia(
  mediaId
) {

  const info =
    await getWhatsAppMediaInfo(
      mediaId
    );

  if (
    !info ||
    !info.url
  ) {
    return null;
  }

  try {

    const response =
      await axios.get(
        info.url,
        {
          headers: {
            Authorization:
              `Bearer ${WHATSAPP_TOKEN}`,
          },

          responseType:
            'arraybuffer',

          timeout:
            60000,
        }
      );

    return {
      buffer:
        Buffer.from(
          response.data
        ),

      mimeType:
        info.mime_type ||
        response.headers['content-type'] ||
        'application/octet-stream',

      sha256:
        info.sha256 ||
        null,

      fileSize:
        info.file_size ||
        null,
    };

  } catch (err) {

    console.error(
      'Download WhatsApp media error:',
      JSON.stringify(
        err.response?.data ||
          err.message,
        null,
        2
      )
    );

    return null;
  }
}


// =====================================================
// تحويل الريكورد إلى نص
// =====================================================

function extensionFromMimeType(
  mimeType = ''
) {

  const type =
    String(
      mimeType
    ).toLowerCase();

  if (type.includes('ogg')) {
    return 'ogg';
  }

  if (
    type.includes('mpeg') ||
    type.includes('mp3')
  ) {
    return 'mp3';
  }

  if (
    type.includes('mp4') ||
    type.includes('m4a')
  ) {
    return 'm4a';
  }

  if (type.includes('wav')) {
    return 'wav';
  }

  if (type.includes('webm')) {
    return 'webm';
  }

  return 'ogg';
}


async function transcribeAudio(
  audioBuffer,
  mimeType
) {

  if (!OPENAI_API_KEY) {

    console.error(
      'OPENAI_API_KEY is missing'
    );

    return null;
  }

  if (
    !audioBuffer ||
    !audioBuffer.length
  ) {
    return null;
  }

  try {

    const extension =
      extensionFromMimeType(
        mimeType
      );

    const form =
      new FormData();

    const blob =
      new Blob(
        [audioBuffer],
        {
          type:
            mimeType ||
            'audio/ogg',
        }
      );

    form.append(
      'file',
      blob,
      `voice.${extension}`
    );

    form.append(
      'model',
      'gpt-4o-mini-transcribe'
    );

    const response =
      await axios.post(

        'https://api.openai.com/v1/audio/transcriptions',

        form,

        {
          headers: {
            Authorization:
              `Bearer ${OPENAI_API_KEY}`,
          },

          timeout:
            120000,

          maxBodyLength:
            Infinity,

          maxContentLength:
            Infinity,
        }
      );

    const text =
      response.data?.text;

    if (
      !text ||
      !String(text).trim()
    ) {
      return null;
    }

    console.log(
      'Voice transcription:',
      String(text).trim()
    );

    return String(
      text
    ).trim();

  } catch (err) {

    console.error(
      'Audio transcription error:',
      JSON.stringify(
        err.response?.data ||
          err.message,
        null,
        2
      )
    );

    return null;
  }
}


// =====================================================
// Sticker → وصف نصي
// =====================================================

async function describeSticker(
  stickerBuffer,
  mimeType
) {

  if (!OPENAI_API_KEY) {

    console.error(
      'OPENAI_API_KEY is missing'
    );

    return null;
  }

  if (
    !stickerBuffer ||
    !stickerBuffer.length
  ) {
    return null;
  }

  try {

    const actualMime =
      mimeType ||
      'image/webp';

    const base64 =
      stickerBuffer.toString(
        'base64'
      );

    const dataUrl =
      `data:${actualMime};base64,${base64}`;

    const response =
      await axios.post(

        'https://api.openai.com/v1/responses',

        {
          model:
            'gpt-4.1-mini',

          input: [
            {
              role:
                'user',

              content: [
                {
                  type:
                    'input_text',

                  text:
`حلل هذا الاستيكر المرسل في محادثة واتساب.

اكتب وصفًا مختصرًا جدًا لمعناه أو التعبير الذي يوصله.

ركز على:
- هل هو ضحك؟
- تحية؟
- شكر؟
- موافقة؟
- استغراب؟
- حزن؟
- فرح؟
- رفض؟
- أو يحتوي على كلام مكتوب؟

إذا كان فيه كلام عربي أو إنجليزي، اذكر الكلام في الوصف.

لا ترد على صاحب الاستيكر.
فقط صف معنى الاستيكر لكي يستخدمه مساعد آخر للرد.`,
                },

                {
                  type:
                    'input_image',

                  image_url:
                    dataUrl,
                },
              ],
            },
          ],

          max_output_tokens:
            150,
        },

        {
          headers: {
            Authorization:
              `Bearer ${OPENAI_API_KEY}`,

            'Content-Type':
              'application/json',
          },

          timeout:
            60000,

          maxBodyLength:
            Infinity,
        }
      );

    const directText =
      response.data?.output_text;

    if (
      directText &&
      String(directText).trim()
    ) {
      return String(
        directText
      ).trim();
    }

    const output =
      response.data?.output ||
      [];

    for (
      const item
      of output
    ) {

      const content =
        item.content ||
        [];

      for (
        const part
        of content
      ) {

        if (
          part.type === 'output_text' &&
          part.text
        ) {
          return String(
            part.text
          ).trim();
        }
      }
    }

    return null;

  } catch (err) {

    console.error(
      'Sticker analysis error:',
      JSON.stringify(
        err.response?.data ||
          err.message,
        null,
        2
      )
    );

    return null;
  }
}


// =====================================================
// حفظ المحادثة
// =====================================================

async function saveConversation(
  customerPhone,
  role,
  message,
  templateMsgId = null
) {

  try {

    await pool.query(
      `
      INSERT INTO conversations
      (
        customer_phone,
        role,
        message,
        template_msg_id
      )
      VALUES ($1, $2, $3, $4)
      `,
      [
        normalizePhone(
          customerPhone
        ),

        role,

        String(
          message || ''
        ),

        templateMsgId,
      ]
    );

  } catch (err) {

    console.error(
      'Save conversation error:',
      err
    );
  }
}


// =====================================================
// جلب المحادثة
// =====================================================

async function getConversationHistory(
  customerPhone,
  limit = 20
) {

  try {

    const result =
      await pool.query(
        `
        SELECT
          role,
          message,
          created_at
        FROM conversations
        WHERE customer_phone = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2
        `,
        [
          normalizePhone(
            customerPhone
          ),

          limit,
        ]
      );

    return result.rows
      .reverse()
      .map(
        (row) => ({
          role:
            row.role === 'assistant'
              ? 'assistant'
              : 'user',

          content:
            row.message,
        })
      );

  } catch (err) {

    console.error(
      'Get conversation history error:',
      err
    );

    return [];
  }
}


// =====================================================
// Viewing sessions
// =====================================================

async function getViewingSession(
  customerPhone
) {

  try {

    const result =
      await pool.query(
        `
        SELECT *
        FROM viewing_sessions
        WHERE customer_phone = $1
          AND status = 'active'
        LIMIT 1
        `,
        [
          normalizePhone(
            customerPhone
          ),
        ]
      );

    return (
      result.rows[0] ||
      null
    );

  } catch (err) {

    console.error(
      'Get viewing session error:',
      err
    );

    return null;
  }
}


async function startViewingSession(
  customerPhone,
  propertyName
) {

  try {

    const result =
      await pool.query(
        `
        INSERT INTO viewing_sessions
        (
          customer_phone,
          property_name,
          requested_day,
          requested_time,
          customer_type,
          status,
          created_at,
          updated_at
        )
        VALUES
        (
          $1,
          $2,
          NULL,
          NULL,
          NULL,
          'active',
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )

        ON CONFLICT
        (customer_phone)

        DO UPDATE SET
          property_name = EXCLUDED.property_name,
          requested_day = NULL,
          requested_time = NULL,
          customer_type = NULL,
          status = 'active',
          created_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP

        RETURNING *
        `,
        [
          normalizePhone(
            customerPhone
          ),

          propertyName ||
          'العقار الحالي',
        ]
      );

    return (
      result.rows[0] ||
      null
    );

  } catch (err) {

    console.error(
      'Start viewing session error:',
      err
    );

    return null;
  }
}


async function updateViewingSession(
  customerPhone,
  fields = {}
) {

  const updates = [];
  const values = [];
  let index = 1;

  if (fields.propertyName !== undefined) {
    updates.push(`property_name = $${index++}`);
    values.push(fields.propertyName);
  }

  if (fields.day !== undefined) {
    updates.push(`requested_day = $${index++}`);
    values.push(fields.day);
  }

  if (fields.time !== undefined) {
    updates.push(`requested_time = $${index++}`);
    values.push(fields.time);
  }

  if (fields.customerType !== undefined) {
    updates.push(`customer_type = $${index++}`);
    values.push(fields.customerType);
  }

  if (!updates.length) {
    return getViewingSession(
      customerPhone
    );
  }

  updates.push(
    'updated_at = CURRENT_TIMESTAMP'
  );

  values.push(
    normalizePhone(
      customerPhone
    )
  );

  try {

    const result =
      await pool.query(
        `
        UPDATE viewing_sessions
        SET
          ${updates.join(', ')}
        WHERE
          customer_phone =
          $${index}
          AND status = 'active'
        RETURNING *
        `,
        values
      );

    return (
      result.rows[0] ||
      null
    );

  } catch (err) {

    console.error(
      'Update viewing session error:',
      err
    );

    return null;
  }
}


async function closeViewingSession(
  customerPhone
) {

  try {

    await pool.query(
      `
      UPDATE viewing_sessions
      SET
        status = 'completed',
        updated_at = CURRENT_TIMESTAMP
      WHERE customer_phone = $1
        AND status = 'active'
      `,
      [
        normalizePhone(
          customerPhone
        ),
      ]
    );

  } catch (err) {

    console.error(
      'Close viewing session error:',
      err
    );
  }
}


// =====================================================
// حفظ طلب المعاينة
// =====================================================

async function saveViewingRequest(
  request
) {

  try {

    const result =
      await pool.query(
        `
        INSERT INTO viewing_requests
        (
          customer_phone,
          property_name,
          requested_day,
          requested_time,
          customer_type
        )
        VALUES
        ($1, $2, $3, $4, $5)
        RETURNING *
        `,
        [
          normalizePhone(
            request.customerPhone
          ),

          request.propertyName,

          request.day,

          request.time,

          request.customerType,
        ]
      );

    return (
      result.rows[0] ||
      null
    );

  } catch (err) {

    console.error(
      'Save viewing request error:',
      err
    );

    return null;
  }
}


// =====================================================
// تنبيه الإدارة بطلب المعاينة
// =====================================================

async function notifyAdminsAboutViewing(
  request
) {

  if (!ADMIN_WHATSAPP_NUMBERS.length) {
    return;
  }

  const message =
`🏠 طلب معاينة جديد

العقار:
${request.propertyName}

العميل:
${request.customerPhone}

اليوم:
${request.day}

الوقت:
${request.time}

الصفة:
${request.customerType}`;

  for (
    const adminPhone
    of ADMIN_WHATSAPP_NUMBERS
  ) {

    await sendWhatsAppText(
      adminPhone,
      message
    );
  }
}


// =====================================================
// التحويل للمدير العام
// =====================================================

function managerLineForCustomer() {

  return (
`للتواصل المباشر مع المدير العام:
${MANAGER_DISPLAY_NUMBER} 📞`
  );
}


async function escalateToManager(
  customerPhone,
  question,
  urgent = false
) {

  const phone =
    normalizePhone(
      customerPhone
    );

  // لو المدير نفسه هو اللي يكلم البوت، ما نبلغه عن نفسه
  if (
    !MANAGER_WHATSAPP_NUMBER ||
    phone === MANAGER_WHATSAPP_NUMBER
  ) {
    return;
  }

  // منع الإزعاج: تنبيه واحد لنفس العميل كل 30 دقيقة
  const now =
    Date.now();

  const last =
    lastManagerAlert.get(phone) ||
    0;

  if (
    !urgent &&
    now - last <
    MANAGER_ALERT_COOLDOWN_MS
  ) {

    console.log(
      `⏳ تم تبليغ المدير عن ${phone} قبل شوي — ما نعيد`
    );

    return;
  }

  lastManagerAlert.set(
    phone,
    now
  );

  const message =
`${urgent ? '🔥 عميل جاهز للشراء' : '🔔 عميل يحتاج تواصل'}

${urgent ? 'العميل طلب الحجز، تواصل معه بأسرع وقت.' : 'البوت ما قدر يجاوب على سؤال العميل.'}

رقم العميل:
+${phone}

للتواصل معه مباشرة:
https://wa.me/${phone}

${urgent ? 'التفاصيل' : 'سؤاله'}:
${String(question || '').slice(0, 800)}`;

  const sent =
    await sendWhatsAppText(
      MANAGER_WHATSAPP_NUMBER,
      message
    );

  console.log(
    sent
      ? `📨 تم تبليغ المدير عن العميل ${phone}`
      : `❌ ما قدرنا نبلغ المدير عن العميل ${phone} (غالبًا المدير ما راسل رقم البوت آخر 24 ساعة)`
  );

  try {

    await pool.query(
      `
      INSERT INTO manager_escalations
      (
        customer_phone,
        question,
        manager_notified
      )
      VALUES ($1, $2, $3)
      `,
      [
        phone,
        String(question || ''),
        sent,
      ]
    );

  } catch (err) {

    console.error(
      'Save manager escalation error:',
      err
    );
  }
}


// =====================================================
// تحويل أي رقم سعودي للصيغة الدولية
// 0551234567 / 551234567 / +966551234567 / 00966551234567 → 966551234567
// =====================================================

function toInternationalSaudi(
  raw
) {

  let n =
    normalizePhone(raw);

  if (n.startsWith('00')) {
    n = n.slice(2);
  }

  if (/^05\d{8}$/.test(n)) {
    return `966${n.slice(1)}`;
  }

  if (/^5\d{8}$/.test(n)) {
    return `966${n}`;
  }

  if (/^9665\d{8}$/.test(n)) {
    return n;
  }

  // أرقام دولية ثانية (مو سعودية)
  if (n.length >= 10 && n.length <= 15 && !n.startsWith('0')) {
    return n;
  }

  return null;
}


function convertDigitsToEnglish(
  text
) {

  return String(text || '')
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
}


// =====================================================
// إرسال قالب واتساب
// =====================================================

async function sendWhatsAppTemplate(
  to,
  template
) {

  const components = [];

  if (template.videoFile) {
    components.push({
      type: 'header',
      parameters: [
        {
          type: 'video',
          video: {
            link:
              `${PUBLIC_BASE_URL}/media/${template.videoFile}`,
          },
        },
      ],
    });
  }

  try {

    const response =
      await axios.post(

        `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,

        {
          messaging_product: 'whatsapp',
          to: normalizePhone(to),
          type: 'template',
          template: {
            name: template.name,
            language: {
              code: template.language,
            },
            components,
          },
        },

        {
          headers: {
            Authorization:
              `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type':
              'application/json',
          },
          timeout: 30000,
        }
      );

    // رقم الرسالة عند واتساب (نتابع حالتها لاحقًا على الويب هوك)
    const messageId =
      response?.data?.messages?.[0]?.id ||
      null;

    trackMessage(
      messageId,
      normalizePhone(to),
      template.name
    );

    return { ok: true, id: messageId };

  } catch (err) {

    const details =
      err.response?.data?.error ||
      err.message;

    console.error(
      'WhatsApp send template error:',
      JSON.stringify(details, null, 2)
    );

    return {
      ok: false,
      code: details?.code || null,
      detail: details?.message || null,
      error:
        details?.error_user_msg ||
        details?.message ||
        String(details),
    };
  }
}


// =====================================================
// أوامر الإدارة لإرسال القوالب
// مثال: 102030 رونق 0551234567 0559876543
// =====================================================

function parseAdminCommand(
  text
) {

  if (!ADMIN_REPORT_CODE) {
    return null;
  }

  const value =
    convertDigitsToEnglish(text).trim();

  if (!value.startsWith(ADMIN_REPORT_CODE)) {
    return null;
  }

  const rest =
    value.slice(ADMIN_REPORT_CODE.length).trim();

  if (!rest) {
    return null;
  }

  if (
    rest === 'مساعدة' ||
    rest === 'مساعده' ||
    rest === 'help'
  ) {
    return { type: 'help' };
  }

  const firstWord =
    rest.split(/\s+/)[0];

  const template =
    TEMPLATES[firstWord];

  if (!template) {
    return null;
  }

  return {
    type: 'send_template',
    templateKey: firstWord,
    template,
    numbers: extractNumbers(
      rest.slice(firstWord.length)
    ),
  };
}


function adminHelpText() {

  return (
`📋 أوامر الإدارة

📊 التقرير:
${ADMIN_REPORT_CODE}

📤 إرسال قالب لعميل أو أكثر:
${ADMIN_REPORT_CODE} رونق 0551234567

لأكثر من عميل، اكتب كل رقم في سطر أو بينهم مسافة (حتى ${MAX_NUMBERS_PER_COMMAND} رقم).
الإرسال يتم في الخلفية: رسالة كل ${DEFAULT_SEND_DELAY_SECONDS} ثواني، وبيوصلك ملخص لما ينتهي.

القوالب المتاحة:
${Object.keys(TEMPLATES).join('، ')}`
  );
}


// استخراج الأرقام من نص (كل رقم في سطر، أو أكثر من رقم بينهم مسافة أو فاصلة)
function extractNumbers(text) {

  const value =
    convertDigitsToEnglish(text);

  const numbers = [];

  const lines =
    value
      .split(/[\n,،;؛]+/)
      .map((l) => l.trim())
      .filter(Boolean);

  for (const line of lines) {

    const compact =
      line.replace(/[\s\-()]/g, '');

    const whole =
      /^\+?\d{9,15}$/.test(compact)
        ? toInternationalSaudi(compact)
        : null;

    if (whole) {
      numbers.push(whole);
      continue;
    }

    for (const token of line.split(/\s+/)) {

      const n =
        toInternationalSaudi(token);

      if (n) {
        numbers.push(n);
      }
    }
  }

  return [...new Set(numbers)];
}


// =====================================================
// طابور الإرسال (حملات القوالب)
// الإرسال يتم في الخلفية على السيرفر: رسالة كل X ثانية،
// ويكمل حتى لو قفلت اللوحة أو الصفحة.
// =====================================================

const sleep =
  (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

let wakeWorker = null;

// انتظار قابل للإيقاظ: يُستخدم فقط لما الطابور فاضي
function idleWait(ms) {

  return new Promise((resolve) => {

    const timer =
      setTimeout(() => {
        wakeWorker = null;
        resolve();
      }, ms);

    wakeWorker = () => {
      clearTimeout(timer);
      wakeWorker = null;
      resolve();
    };
  });
}


function clampDelaySeconds(value) {

  const n =
    Math.round(Number(value));

  if (!Number.isFinite(n)) {
    return DEFAULT_SEND_DELAY_SECONDS;
  }

  return Math.min(3600, Math.max(1, n));
}


async function createCampaign(
  templateKey,
  numbers,
  options = {}
) {

  const template =
    TEMPLATES[templateKey];

  if (!template) {
    throw new Error('unknown_template');
  }

  const list =
    [...new Set(numbers || [])];

  if (!list.length) {
    throw new Error('no_numbers');
  }

  const delay =
    clampDelaySeconds(
      options.delaySeconds ?? DEFAULT_SEND_DELAY_SECONDS
    );

  const campaign =
    await pool.query(
      `
      INSERT INTO campaigns
      (
        template_key,
        template_name,
        delay_seconds,
        notify_phone
      )
      VALUES ($1, $2, $3, $4)
      RETURNING id
      `,
      [
        templateKey,
        template.name,
        delay,
        options.notifyPhone
          ? normalizePhone(options.notifyPhone)
          : null,
      ]
    );

  const campaignId =
    campaign.rows[0].id;

  await pool.query(
    `
    INSERT INTO template_messages
    (
      campaign_id,
      customer_phone,
      template_key,
      template_name
    )
    SELECT $1::int, phone, $3::text, $4::text
    FROM unnest($2::text[]) AS phone
    `,
    [
      campaignId,
      list,
      templateKey,
      template.name,
    ]
  );

  console.log(
    `🗓️ حملة #${campaignId}: قالب ${template.name} إلى ${list.length} رقم، رسالة كل ${delay} ثانية`
  );

  if (wakeWorker) {
    wakeWorker();
  }

  return {
    id: campaignId,
    total: list.length,
    delaySeconds: delay,
  };
}


async function setCampaignStatus(
  campaignId,
  action
) {

  if (action === 'pause') {

    await pool.query(
      `UPDATE campaigns SET status = 'paused' WHERE id = $1 AND status = 'running'`,
      [campaignId]
    );

  } else if (action === 'resume') {

    await pool.query(
      `UPDATE campaigns SET status = 'running' WHERE id = $1 AND status = 'paused'`,
      [campaignId]
    );

    if (wakeWorker) {
      wakeWorker();
    }

  } else if (action === 'cancel') {

    await pool.query(
      `
      UPDATE campaigns
      SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status IN ('running', 'paused')
      `,
      [campaignId]
    );

    await pool.query(
      `UPDATE template_messages SET status = 'cancelled' WHERE campaign_id = $1 AND status = 'queued'`,
      [campaignId]
    );

  } else {

    throw new Error('unknown_action');
  }
}


// نحجز الرسالة التالية في الطابور (حجز واحد فقط حتى لو فيه أكثر من نسخة من السيرفر)
async function claimNextMessage() {

  const result =
    await pool.query(`
      UPDATE template_messages
      SET status = 'sending'
      WHERE id = (
        SELECT tm.id
        FROM template_messages tm
        JOIN campaigns c ON c.id = tm.campaign_id
        WHERE tm.status = 'queued'
          AND c.status = 'running'
        ORDER BY tm.id
        LIMIT 1
        FOR UPDATE OF tm SKIP LOCKED
      )
      AND status = 'queued'
      RETURNING
        id,
        campaign_id,
        customer_phone,
        template_key,
        template_name,
        (
          SELECT delay_seconds
          FROM campaigns
          WHERE id = template_messages.campaign_id
        ) AS delay_seconds
    `);

  return result.rows[0] || null;
}


async function processQueuedMessage(job) {

  const template =
    TEMPLATES[job.template_key];

  if (!template) {

    await pool.query(
      `
      UPDATE template_messages
      SET status = 'failed',
          error_text = $2,
          failed_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [job.id, 'القالب غير موجود في السيرفر']
    );

    return;
  }

  const result =
    await sendWhatsAppTemplate(
      job.customer_phone,
      template
    );

  if (result.ok) {

    await pool.query(
      `
      UPDATE template_messages
      SET status = 'sent',
          wamid = $2,
          sent_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [job.id, result.id]
    );

    // نحفظ في محادثة العميل عشان البوت يعرف إنه وصله العرض
    await saveConversation(
      job.customer_phone,
      'assistant',
      template.logText ||
        `[قالب مرسل: ${template.name}]`,
      job.id
    );

    console.log(
      `📤 قالب ${template.name} إلى ${job.customer_phone}: قبلته واتساب`
    );

  } else {

    await pool.query(
      `
      UPDATE template_messages
      SET status = 'failed',
          error_code = $2,
          error_text = $3,
          failed_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [
        job.id,
        result.code || null,
        [
          result.error,
          result.detail && result.detail !== result.error
            ? result.detail
            : null,
        ]
          .filter(Boolean)
          .join(' — ')
          .slice(0, 500),
      ]
    );

    console.log(
      `❌ قالب ${template.name} إلى ${job.customer_phone}: رفضته واتساب (${result.error})`
    );
  }
}


// لما تخلص رسائل حملة، نعلّمها "اكتملت" ونرسل ملخص لمن طلبها بأمر الواتساب
async function finishCompletedCampaigns() {

  const finished =
    await pool.query(`
      UPDATE campaigns c
      SET status = 'done', finished_at = CURRENT_TIMESTAMP
      WHERE c.status = 'running'
        AND NOT EXISTS (
          SELECT 1
          FROM template_messages tm
          WHERE tm.campaign_id = c.id
            AND tm.status IN ('queued', 'sending')
        )
      RETURNING c.id, c.template_name, c.notify_phone
    `);

  for (const campaign of finished.rows) {

    console.log(
      `✅ انتهت الحملة #${campaign.id}`
    );

    if (!campaign.notify_phone) {
      continue;
    }

    const counts =
      await pool.query(
        `
        SELECT status, COUNT(*)::int AS n
        FROM template_messages
        WHERE campaign_id = $1
        GROUP BY status
        `,
        [campaign.id]
      );

    const n = {};

    for (const row of counts.rows) {
      n[row.status] = row.n;
    }

    const accepted =
      (n.sent || 0) +
      (n.delivered || 0) +
      (n.read || 0);

    await sendWhatsAppText(
      campaign.notify_phone,
      `✅ انتهى إرسال القالب "${campaign.template_name}"\n\nقبلتها واتساب: ${accepted}\nرفضتها واتساب: ${n.failed || 0}\n\nتابع حالة كل رسالة (وصلت / قُرئت) من لوحة التحكم.`
    );
  }
}


async function campaignWorkerLoop() {

  while (true) {

    try {

      const job =
        await claimNextMessage();

      if (!job) {

        await finishCompletedCampaigns();

        await idleWait(3000);

        continue;
      }

      await processQueuedMessage(job);

      await finishCompletedCampaigns();

      await sleep(
        clampDelaySeconds(job.delay_seconds) * 1000
      );

    } catch (err) {

      console.error(
        'Campaign worker error:',
        err
      );

      await sleep(5000);
    }
  }
}


async function startCampaignQueue() {

  // رسائل كانت قيد الإرسال لما توقف السيرفر: ما نعيد إرسالها (حتى ما نكرر الرسالة للعميل)
  const interrupted =
    await pool.query(`
      UPDATE template_messages
      SET status = 'failed',
          error_text = 'توقف السيرفر أثناء إرسال هذه الرسالة، تحقق من العميل قبل إعادة الإرسال',
          failed_at = CURRENT_TIMESTAMP
      WHERE status = 'sending'
      RETURNING id
    `);

  const queued =
    await pool.query(`
      SELECT COUNT(*)::int AS n
      FROM template_messages tm
      JOIN campaigns c ON c.id = tm.campaign_id
      WHERE tm.status = 'queued'
        AND c.status = 'running'
    `);

  console.log(
    `Campaign queue: enabled (${queued.rows[0].n} queued, ${interrupted.rows.length} interrupted)`
  );

  campaignWorkerLoop();
}


async function runAdminSendTemplate(
  adminPhone,
  command
) {

  if (!command.numbers.length) {

    await sendWhatsAppText(
      adminPhone,
      `ما لقيت أرقام في الرسالة ❌\n\nاكتبها كذا:\n${ADMIN_REPORT_CODE} ${command.templateKey} 0551234567`
    );

    return;
  }

  if (command.numbers.length > MAX_NUMBERS_PER_COMMAND) {

    await sendWhatsAppText(
      adminPhone,
      `العدد كبير ❌ أقصى شي ${MAX_NUMBERS_PER_COMMAND} رقم في المرة الوحدة.`
    );

    return;
  }

  await createCampaign(
    command.templateKey,
    command.numbers,
    {
      delaySeconds: DEFAULT_SEND_DELAY_SECONDS,
      notifyPhone: adminPhone,
    }
  );

  const minutes =
    Math.max(
      1,
      Math.round(
        command.numbers.length *
        DEFAULT_SEND_DELAY_SECONDS / 60
      )
    );

  await sendWhatsAppText(
    adminPhone,
    `⏳ تمت جدولة إرسال قالب "${command.templateKey}" إلى ${command.numbers.length} رقم، رسالة كل ${DEFAULT_SEND_DELAY_SECONDS} ثواني (حوالي ${minutes} دقيقة).\n\nيكمل في الخلفية وبيوصلك ملخص لما ينتهي. وتقدر تتابع حالة كل رسالة من لوحة التحكم.`
  );
}


// =====================================================
// معالجة المعاينة
// =====================================================

async function processViewingFlow({
  customerPhone,
  userText,
  history,
}) {

  let session =
    await getViewingSession(
      customerPhone
    );

  const newViewingRequest =
    isViewingRequest(
      userText
    );

  // لا يوجد موعد نشط
  // والعميل لم يبدأ معاينة جديدة
  if (
    !session &&
    !newViewingRequest
  ) {
    return null;
  }

  // بدء جلسة جديدة
  if (
    !session &&
    newViewingRequest
  ) {

    const propertyName =
      detectCurrentProperty(
        history,
        userText
      );

    session =
      await startViewingSession(
        customerPhone,
        propertyName
      );

    if (!session) {
      return null;
    }
  }

  // نقرأ الرسالة الحالية فقط.
  const extracted =
    extractViewingData(
      [],
      userText
    );

  const updates = {};

  if (extracted.day) {
    updates.day = extracted.day;
  }

  if (extracted.time) {
    updates.time = extracted.time;
  }

  if (extracted.customerType) {
    updates.customerType = extracted.customerType;
  }

  if (Object.keys(updates).length) {

    const updatedSession =
      await updateViewingSession(
        customerPhone,
        updates
      );

    if (updatedSession) {
      session = updatedSession;
    }
  }

  if (!session.requested_day) {

    return {
      handled: true,
      completed: false,
      reply:
        'أبشر 👍 حدد لي أي يوم حاب توقف على العقار؟',
    };
  }

  if (!session.requested_time) {

    return {
      handled: true,
      completed: false,
      reply:
`تمام 👍 يوم ${session.requested_day}. الساعة كم يناسبك؟`,
    };
  }

  if (!session.customer_type) {

    return {
      handled: true,
      completed: false,
      reply:
        'تمام 👍 هل أنت المشتري ولا مكتب عقاري؟',
    };
  }

  const completedRequest =
    {
      customerPhone:
        normalizePhone(
          customerPhone
        ),

      propertyName:
        session.property_name ||
        'العقار الحالي',

      day:
        session.requested_day,

      time:
        session.requested_time,

      customerType:
        session.customer_type,
    };

  // مهم:
  // نقفل الجلسة قبل الرد النهائي
  // حتى لا ترجع تفتح بعد "السلام عليكم".
  await closeViewingSession(
    customerPhone
  );

  return {
    handled: true,
    completed: true,
    request:
      completedRequest,
    reply:
`تم تسجيل طلب الوقوف على ${completedRequest.propertyName} 👍

اليوم: ${completedRequest.day}
الوقت: ${completedRequest.time}
الصفة: ${completedRequest.customerType}

تواصل على الرقم ${CONTACT_NUMBER} لإكمال التنسيق.`,
  };
}


// =====================================================
// تقارير الإدارة
// =====================================================

function isAdminReportCommand(
  text
) {

  // نحول الأرقام العربية عشان "١٠٢٠٣٠" تشتغل زي "102030"
  const value =
    String(text || '')
      .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
      .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
      .trim();

  if (!ADMIN_REPORT_CODE) {
    return false;
  }

  return (
    value === ADMIN_REPORT_CODE ||
    value === `${ADMIN_REPORT_CODE} تقرير` ||
    value === `${ADMIN_REPORT_CODE} report`
  );
}


async function buildAdminSummary() {

  const [
    conversationResult,
    customerResult,
    viewingResult,
    todayViewingResult,
    escalationResult,
    todayEscalationResult,
  ] =
    await Promise.all([

      pool.query(`
        SELECT COUNT(*)::int AS count
        FROM conversations
      `),

      pool.query(`
        SELECT COUNT(
          DISTINCT customer_phone
        )::int AS count
        FROM conversations
        WHERE role = 'user'
      `),

      pool.query(`
        SELECT COUNT(*)::int AS count
        FROM viewing_requests
      `),

      pool.query(`
        SELECT COUNT(*)::int AS count
        FROM viewing_requests
        WHERE created_at >= CURRENT_DATE
      `),

      pool.query(`
        SELECT COUNT(*)::int AS count
        FROM manager_escalations
      `),

      pool.query(`
        SELECT COUNT(*)::int AS count
        FROM manager_escalations
        WHERE created_at >= CURRENT_DATE
      `),
    ]);

  return (
`📊 تقرير استثمارات طيبة

إجمالي الرسائل المسجلة:
${conversationResult.rows[0]?.count || 0}

عدد العملاء:
${customerResult.rows[0]?.count || 0}

إجمالي طلبات المعاينة:
${viewingResult.rows[0]?.count || 0}

طلبات المعاينة اليوم:
${todayViewingResult.rows[0]?.count || 0}

أسئلة تحولت للمدير (الإجمالي):
${escalationResult.rows[0]?.count || 0}

أسئلة تحولت للمدير اليوم:
${todayEscalationResult.rows[0]?.count || 0}`
  );
}


// =====================================================
// إنشاء Excel
// =====================================================

async function createReportWorkbook() {

  const conversations =
    await pool.query(`
      SELECT
        id,
        customer_phone,
        role,
        message,
        created_at
      FROM conversations
      ORDER BY created_at DESC
    `);

  const viewings =
    await pool.query(`
      SELECT
        id,
        customer_phone,
        property_name,
        requested_day,
        requested_time,
        customer_type,
        created_at
      FROM viewing_requests
      ORDER BY created_at DESC
    `);

  const escalations =
    await pool.query(`
      SELECT
        id,
        customer_phone,
        question,
        manager_notified,
        created_at
      FROM manager_escalations
      ORDER BY created_at DESC
    `);

  const templateMessages =
    await pool.query(`
      SELECT
        id,
        campaign_id,
        customer_phone,
        template_name,
        status,
        error_code,
        error_text,
        queued_at,
        sent_at,
        delivered_at,
        read_at,
        failed_at
      FROM template_messages
      ORDER BY id DESC
    `);

  const workbook =
    XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(conversations.rows),
    'Conversations'
  );

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(viewings.rows),
    'Viewing Requests'
  );

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(escalations.rows),
    'Manager Escalations'
  );

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(templateMessages.rows),
    'Template Messages'
  );

  return XLSX.write(
    workbook,
    {
      type: 'buffer',
      bookType: 'xlsx',
    }
  );
}


// =====================================================
// رفع ملف Excel إلى WhatsApp
// =====================================================

async function uploadWhatsAppDocument(
  buffer,
  filename
) {

  try {

    const form =
      new FormData();

    form.append(
      'messaging_product',
      'whatsapp'
    );

    const blob =
      new Blob(
        [buffer],
        {
          type:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }
      );

    form.append(
      'file',
      blob,
      filename
    );

    const response =
      await axios.post(

        `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/media`,

        form,

        {
          headers: {
            Authorization:
              `Bearer ${WHATSAPP_TOKEN}`,
          },

          timeout:
            60000,

          maxBodyLength:
            Infinity,

          maxContentLength:
            Infinity,
        }
      );

    return (
      response.data?.id ||
      null
    );

  } catch (err) {

    console.error(
      'Upload WhatsApp document error:',
      JSON.stringify(
        err.response?.data ||
          err.message,
        null,
        2
      )
    );

    return null;
  }
}


// =====================================================
// إرسال ملف واتساب
// =====================================================

async function sendWhatsAppDocument(
  to,
  mediaId,
  filename,
  caption = ''
) {

  try {

    await axios.post(

      `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,

      {
        messaging_product:
          'whatsapp',

        to:
          normalizePhone(to),

        type:
          'document',

        document: {
          id: mediaId,
          filename,
          caption:
            caption || undefined,
        },
      },

      {
        headers: {
          Authorization:
            `Bearer ${WHATSAPP_TOKEN}`,

          'Content-Type':
            'application/json',
        },

        timeout:
          30000,
      }
    );

    return true;

  } catch (err) {

    console.error(
      'Send WhatsApp document error:',
      JSON.stringify(
        err.response?.data ||
          err.message,
        null,
        2
      )
    );

    return false;
  }
}


// =====================================================
// إرسال تقرير Excel للإدارة
// =====================================================

async function sendAdminExcelReport(
  adminPhone
) {

  try {

    const buffer =
      await createReportWorkbook();

    const filename =
      `taibah-report-${Date.now()}.xlsx`;

    const mediaId =
      await uploadWhatsAppDocument(
        buffer,
        filename
      );

    if (!mediaId) {

      await sendWhatsAppText(
        adminPhone,
        'تعذر إنشاء تقرير Excel حاليًا.'
      );

      return;
    }

    await sendWhatsAppDocument(
      adminPhone,
      mediaId,
      filename,
      '📊 تقرير استثمارات طيبة الكامل'
    );

  } catch (err) {

    console.error(
      'Admin Excel report error:',
      err
    );

    await sendWhatsAppText(
      adminPhone,
      'تعذر إرسال تقرير Excel حاليًا.'
    );
  }
}


// =====================================================
// تحويل رسالة WhatsApp إلى نص قابل للمعالجة
// =====================================================

async function extractIncomingContent(
  message
) {

  if (
    !message ||
    !message.type
  ) {
    return {
      type: 'unsupported',
      text: null,
    };
  }

  // Text
  if (message.type === 'text') {

    return {
      type: 'text',
      text:
        message.text?.body ||
        '',
    };
  }

  // ضغطة زر في قالب (رد سريع)
  if (message.type === 'button') {

    return {
      type: 'button',
      text:
        message.button?.text ||
        message.button?.payload ||
        '',
    };
  }

  // ضغطة زر أو اختيار من قائمة (رسائل تفاعلية)
  if (message.type === 'interactive') {

    return {
      type: 'button',
      text:
        message.interactive?.button_reply?.title ||
        message.interactive?.list_reply?.title ||
        '',
    };
  }

  // Voice / Audio
  if (message.type === 'audio') {

    const mediaId =
      message.audio?.id;

    if (!mediaId) {
      return {
        type: 'audio',
        text: null,
      };
    }

    console.log(
      'Voice message received:',
      mediaId
    );

    const media =
      await downloadWhatsAppMedia(
        mediaId
      );

    if (!media) {
      return {
        type: 'audio',
        text: null,
      };
    }

    const transcription =
      await transcribeAudio(
        media.buffer,
        media.mimeType
      );

    return {
      type: 'audio',
      text: transcription,
    };
  }

  // Sticker
  if (message.type === 'sticker') {

    const mediaId =
      message.sticker?.id;

    if (!mediaId) {
      return {
        type: 'sticker',
        text: null,
        stickerDescription: null,
      };
    }

    console.log(
      'Sticker received:',
      mediaId
    );

    const media =
      await downloadWhatsAppMedia(
        mediaId
      );

    if (!media) {
      return {
        type: 'sticker',
        text: null,
        stickerDescription: null,
      };
    }

    const description =
      await describeSticker(
        media.buffer,
        media.mimeType
      );

    return {
      type: 'sticker',
      text: null,
      stickerDescription: description,
    };
  }

  return {
    type: 'unsupported',
    text: null,
  };
}


// =====================================================
// معالجة رسالة عميل واحدة
// =====================================================

async function processCustomerMessage(
  message
) {

  const from =
    normalizePhone(
      message.from
    );

  if (!from) {
    return;
  }

  const incoming =
    await extractIncomingContent(
      message
    );

  // Sticker
  if (incoming.type === 'sticker') {

    console.log(
      'Sticker description:',
      incoming.stickerDescription
    );

    const reply =
      await generateStickerReply(
        incoming.stickerDescription
      );

    // نخزن وصف الاستيكر في السجل بدل تخزين binary.
    await saveConversation(
      from,
      'user',
      incoming.stickerDescription
        ? `[Sticker] ${incoming.stickerDescription}`
        : '[Sticker]'
    );

    await sendWhatsAppText(
      from,
      reply
    );

    await saveConversation(
      from,
      'assistant',
      reply
    );

    return;
  }

  // Unsupported
  if (incoming.type === 'unsupported') {

    console.log(
      'Unsupported WhatsApp message:',
      message.type
    );

    return;
  }

  // فشل تحويل الصوت
  if (
    incoming.type === 'audio' &&
    !incoming.text
  ) {

    const reply =
      'ما قدرت أسمع التسجيل بوضوح 🌹 ممكن تعيد إرسال الريكورد أو تكتب لي طلبك؟';

    await sendWhatsAppText(
      from,
      reply
    );

    await saveConversation(
      from,
      'assistant',
      reply
    );

    return;
  }

  const userText =
    String(
      incoming.text ||
      ''
    ).trim();

  if (!userText) {
    return;
  }

  console.log(
    `${incoming.type} from ${from}:`,
    userText
  );

  // =================================================
  // أوامر الإدارة (كلمة السر من أرقام الإدارة فقط)
  // =================================================

  if (
    isAdminPhone(from) &&
    isAdminReportCommand(userText)
  ) {

    console.log(
      `📊 طلب تقرير من الإدارة: ${from}`
    );

    const summary =
      await buildAdminSummary();

    await sendWhatsAppText(
      from,
      summary
    );

    await sendAdminExcelReport(
      from
    );

    return;
  }

  // أوامر الإدارة الثانية (إرسال قوالب / مساعدة)
  if (isAdminPhone(from)) {

    const command =
      parseAdminCommand(userText);

    if (command?.type === 'help') {

      await sendWhatsAppText(
        from,
        adminHelpText()
      );

      return;
    }

    if (command?.type === 'send_template') {

      await runAdminSendTemplate(
        from,
        command
      );

      return;
    }
  }

  // history قبل حفظ الرسالة الحالية
  const history =
    await getConversationHistory(
      from,
      20
    );

  // حفظ الرسالة (الريكورد يتم حفظ النص الناتج منه)
  await saveConversation(
    from,
    'user',
    incoming.type === 'audio'
      ? `[Voice] ${userText}`
      : userText
  );

  // نظام المعاينة
  const viewingResult =
    await processViewingFlow({
      customerPhone: from,
      userText,
      history,
    });

  if (viewingResult?.handled) {

    await sendWhatsAppText(
      from,
      viewingResult.reply
    );

    await saveConversation(
      from,
      'assistant',
      viewingResult.reply
    );

    if (
      viewingResult.completed &&
      viewingResult.request
    ) {

      await saveViewingRequest(
        viewingResult.request
      );

      await notifyAdminsAboutViewing(
        viewingResult.request
      );
    }

    return;
  }

  // =================================================
  // AI reply
  // =================================================

  const result =
    await generateReplyDetailed(
      history,
      userText
    );

  let reply =
    result?.reply;

  if (!reply) {
    return;
  }

  // لو البوت ما عرف يجاوب: نعطي العميل رقم المدير ونبلغ المدير
  if (result.needsManager) {

    console.log(
      `🙋 البوت يحتاج المدير للعميل ${from}`
    );

    reply =
      `${reply}\n\n${managerLineForCustomer()}`;
  }

  // الرد دائمًا Text حتى لو رسالة العميل كانت Voice.
  await sendWhatsAppText(
    from,
    reply
  );

  await saveConversation(
    from,
    'assistant',
    reply
  );

  if (result.needsManager) {

    await escalateToManager(
      from,
      result.managerNote
        ? `${result.managerNote}\n(رسالة العميل: ${userText})`
        : userText,
      Boolean(result.managerNote)
    );
  }
}


// =====================================================
// Webhook POST
// =====================================================

app.post(
  '/webhook',
  async (req, res) => {

    // Meta يحتاج 200 بسرعة. لذلك نرجع الرد أولًا.
    res.sendStatus(
      200
    );

    try {

      const body =
        req.body;

      if (
        body?.object !==
        'whatsapp_business_account'
      ) {
        return;
      }

      const entries =
        body.entry ||
        [];

      for (const entry of entries) {

        const changes =
          entry.changes ||
          [];

        for (const change of changes) {

          const value =
            change.value;

          // حالات التسليم (أُرسلت / وصلت / قُرئت / فشلت)
          const statuses =
            value?.statuses ||
            [];

          for (const status of statuses) {

            try {

              handleStatusUpdate(
                status
              );

              await persistStatus(
                status
              );

            } catch (statusError) {

              console.error(
                'Handle status update error:',
                statusError
              );
            }
          }

          const messages =
            value?.messages ||
            [];

          for (const message of messages) {

            try {

              await processCustomerMessage(
                message
              );

            } catch (messageError) {

              console.error(
                'Process customer message error:',
                messageError
              );
            }
          }
        }
      }

    } catch (err) {

      console.error(
        'Webhook processing error:',
        err
      );
    }
  }
);


// =====================================================
// الداشبورد
// =====================================================

registerDashboard(app, {
  pool,
  normalizePhone,
  toInternationalSaudi,
  TEMPLATES,
  createCampaign,
  setCampaignStatus,
  extractNumbers,
  createReportWorkbook,
  password: DASHBOARD_PASSWORD,
  maxNumbersPerCampaign: MAX_NUMBERS_PER_CAMPAIGN,
  defaultDelaySeconds: DEFAULT_SEND_DELAY_SECONDS,
});


// =====================================================
// 404
// =====================================================

app.use(
  (req, res) => {
    res
      .status(404)
      .json({
        error: 'Not found',
      });
  }
);


// =====================================================
// تشغيل السيرفر
// =====================================================

async function startServer() {

  try {

    if (!DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is missing'
      );
    }

    await initializeDatabase();

    app.listen(
      PORT,
      () => {

        console.log(
          `Taibah AI Agent running on port ${PORT}`
        );

        console.log(
          'WhatsApp text: enabled'
        );

        console.log(
          `Voice transcription: ${
            OPENAI_API_KEY
              ? 'enabled'
              : 'disabled - OPENAI_API_KEY missing'
          }`
        );

        console.log(
          `Sticker understanding: ${
            OPENAI_API_KEY
              ? 'enabled'
              : 'disabled - OPENAI_API_KEY missing'
          }`
        );

        console.log(
          `Admin report: ${
            ADMIN_REPORT_CODE && ADMIN_WHATSAPP_NUMBERS.length
              ? `enabled (${ADMIN_WHATSAPP_NUMBERS.length} admin numbers)`
              : 'disabled - ADMIN_REPORT_CODE or ADMIN_WHATSAPP_NUMBERS missing'
          }`
        );

        console.log(
          `Manager escalation: ${MANAGER_WHATSAPP_NUMBER}`
        );

        console.log(
          `Templates: ${Object.keys(TEMPLATES).join(', ')}`
        );

        console.log(
          `Dashboard: ${DASHBOARD_PASSWORD ? 'enabled at /admin' : 'disabled - no password'}`
        );

        console.log(
          'Delivery status tracking: enabled'
        );

        startCampaignQueue().catch((err) => {

          console.error(
            'Campaign queue start error:',
            err
          );
        });
      }
    );

  } catch (err) {

    console.error(
      'Server startup error:',
      err
    );

    process.exit(1);
  }
}


startServer();
