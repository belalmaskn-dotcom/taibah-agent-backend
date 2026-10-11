// agentBrain.js
// Taibah AI Agent — استثمارات طيبة العقارية
// مسؤول عن فهم العميل والرد العقاري
// العقارات تُقرأ مباشرة من موقع طيبة (search.js)
// حالة المعاينة نفسها يتم حفظها وإدارتها من server.js

const axios = require('axios');
const { searchProperties } = require('./search');

const ANTHROPIC_API_KEY =
  process.env.ANTHROPIC_API_KEY;

const MODEL = 'claude-sonnet-5';

const COMPANY_NAME = 'استثمارات طيبة العقارية';


// =====================================================
// بيانات التواصل
// =====================================================

const CONTACT_NUMBER =
  process.env.CONTACT_NUMBER ||
  '0564685620';

const SITE_URL =
  (
    process.env.TAIBAH_SITE_URL ||
    'https://taibah-realestate.onrender.com'
  ).replace(/\/$/, '');

const DETAILS_REPLY =
`أبشر وحياك الله 🌹

للتفاصيل والاستفسار تقدر تتواصل معنا على الرقم:
${CONTACT_NUMBER} 📞

وتقدر تتصفح جميع عروضنا على موقعنا:
${SITE_URL} 🏠`;


// =====================================================
// تنظيف وتحويل الأرقام
// =====================================================

function convertArabicDigits(text = '') {

  const arabicDigits = {
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
    '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',

    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
    '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  };

  return String(text).replace(
    /[٠-٩۰-۹]/g,
    (digit) =>
      arabicDigits[digit] ||
      digit
  );
}


// =====================================================
// تنظيف النص العربي
// =====================================================

function normalizeArabicText(
  text = ''
) {

  return convertArabicDigits(
    String(text)
  )
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/[ًٌٍَُِّْ]/g, '')
    .replace(/[؟?!.,،]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


// =====================================================
// دالة مساعدة: هل النص يحتوي على أي عبارة من القائمة
// =====================================================

function containsAnyPhrase(
  text = '',
  phrases = []
) {

  const t =
    normalizeArabicText(text);

  return phrases.some(
    (phrase) =>
      t.includes(
        normalizeArabicText(
          phrase
        )
      )
  );
}


// =====================================================
// طلب تفاصيل أكثر
// =====================================================

function customerAskedForMoreDetails(
  text = ''
) {

  return containsAnyPhrase(text, [
    'ممكن تفاصيل اكثر',
    'تفاصيل اكثر',
    'ابي تفاصيل اكثر',
    'ابغى تفاصيل اكثر',
    'اريد تفاصيل اكثر',
    'ودي بتفاصيل اكثر',
    'more details',
    'send me more details',
    'i need more details',
    'need more details',
  ]);
}


// =====================================================
// التمويل
// =====================================================

function customerAskedAboutFinance(
  text = ''
) {

  return containsAnyPhrase(text, [
    'في تمويل',
    'فيه تمويل',
    'هل في تمويل',
    'هل فيه تمويل',
    'يقبل تمويل',
    'يقبل التمويل',
    'عن طريق البنك',
    'تمويل بنكي',
    'التمويل',
    'finance',
    'financing',
    'bank finance',
    'bank financing',
  ]);
}


// =====================================================
// الرهن
// =====================================================

function customerAskedAboutMortgage(
  text = ''
) {

  return containsAnyPhrase(text, [
    'عليه رهن',
    'عليها رهن',
    'هل عليه رهن',
    'هل عليها رهن',
    'العقار مرهون',
    'مرهون',
    'مرهونة',
    'فيه رهن',
    'في رهن',
    'mortgage',
    'mortgaged',
  ]);
}


// =====================================================
// الإيجار
// =====================================================

function customerAskedAboutRent(
  text = ''
) {

  return containsAnyPhrase(text, [
    'في ايجار',
    'فيه ايجار',
    'عندكم ايجار',
    'عندكم للايجار',
    'ابي ايجار',
    'ابغى ايجار',
    'عقار للايجار',
    'عقارات للايجار',
    'for rent',
    'rent',
    'rental',
    'i want to rent',
    'property for rent',
  ]);
}


// =====================================================
// اكتشاف طلب الوقوف / المعاينة
// =====================================================

function isViewingRequest(
  text = ''
) {

  return containsAnyPhrase(text, [
    'اوقف على العقار',
    'اوقف عالعقار',
    'اوقف عليه',
    'اوقف عليها',
    'اوقف على الشقه',
    'اوقف على الشقة',
    'اوقف على الفيلا',
    'اوقف على العماره',
    'اوقف على العمارة',
    'ابي اوقف',
    'ابغى اوقف',
    'ودي اوقف',
    'محتاج اوقف',
    'احتاج اوقف',
    'عايز اوقف',
    'عاوز اوقف',
    'ابي اشوف العقار',
    'ابغى اشوف العقار',
    'محتاج اشوف العقار',
    'احتاج اشوف العقار',
    'عايز اشوف العقار',
    'اشوف العقار',
    'اشوفها',
    'اشوفه',
    'ابي اعاين',
    'ابغى اعاين',
    'محتاج اعاين',
    'احتاج اعاين',
    'عايز اعاين',
    'اعاين العقار',
    'اعاينها',
    'اعاينه',
    'معاينه',
    'معاينة',
    'موعد معاينه',
    'موعد معاينة',
    'احجز معاينه',
    'احجز معاينة',
    'احجز موعد',
    'ابي موعد',
    'ابغى موعد',
    'محتاج موعد',
    'احتاج موعد',
    'موعد للوقوف',
    'موعد للمعاينه',
    'موعد للمعاينة',
    'ابي ازور العقار',
    'ابغى ازور العقار',
    'محتاج ازور العقار',
    'احتاج ازور العقار',
    'زيارة العقار',
    'زياره العقار',

    // English
    'view the property',
    'see the property',
    'visit the property',
    'property viewing',
    'book a viewing',
    'schedule a viewing',
    'book an appointment',
    'schedule an appointment',
    'want to see it',
    'want to view it',
    'want to visit it',
    'can i see it',
    'can i view it',
  ]);
}


// =====================================================
// الأرقام المكتوبة بالكلمات (للساعة)
// =====================================================

function extractWrittenHour(
  text = ''
) {

  const t =
    normalizeArabicText(text);


  const hourWords = [

    { hour: 1,  words: ['واحد', 'وحدة', 'الواحده', 'الواحدة', 'one'] },
    { hour: 2,  words: ['اثنين', 'اثنتين', 'الثانيه', 'الثانية', 'two'] },
    { hour: 3,  words: ['ثلاثه', 'ثلاثة', 'الثالثه', 'الثالثة', 'three'] },
    { hour: 4,  words: ['اربعه', 'اربعة', 'الرابعه', 'الرابعة', 'four'] },
    { hour: 5,  words: ['خمسه', 'خمسة', 'خامسه', 'خامسة', 'الخامسه', 'الخامسة', 'five'] },
    { hour: 6,  words: ['سته', 'ستة', 'السادسه', 'السادسة', 'six'] },
    { hour: 7,  words: ['سبعه', 'سبعة', 'السابعه', 'السابعة', 'seven'] },
    { hour: 8,  words: ['ثمانيه', 'ثمانية', 'الثامنه', 'الثامنة', 'eight'] },
    { hour: 9,  words: ['تسعه', 'تسعة', 'التاسعه', 'التاسعة', 'nine'] },
    { hour: 10, words: ['عشره', 'عشرة', 'العاشره', 'العاشرة', 'ten'] },
    { hour: 11, words: ['احد عشر', 'احدى عشر', 'الحاديه عشر', 'الحادية عشر', 'eleven'] },
    { hour: 12, words: ['اثنا عشر', 'اثني عشر', 'الثانيه عشر', 'الثانية عشر', 'twelve'] },
  ];


  // نبدأ من 12 نزولًا إلى 1
  // عشان "الثانية عشر" ما تنقرأ غلط على إنها "الثانية"
  const ordered =
    [...hourWords].reverse();


  for (
    const item
    of ordered
  ) {

    for (
      const word
      of item.words
    ) {

      const w =
        normalizeArabicText(
          word
        );


      // الكلمات الإنجليزية لازم تكون كلمة مستقلة
      // عشان كلمة مثل "someone" ما تنقرأ "one"
      const isEnglish =
        /^[a-z ]+$/.test(w);


      const found =
        isEnglish
          ? new RegExp(`\\b${w}\\b`).test(t)
          : t.includes(w);


      if (found) {

        return String(
          item.hour
        );
      }
    }
  }


  return null;
}


// =====================================================
// استخراج الساعة
// =====================================================

function extractViewingTime(
  text = ''
) {

  const raw =
    convertArabicDigits(
      String(text || '')
    );


  const normalized =
    normalizeArabicText(
      raw
    );


  // -----------------------------------------------
  // الساعة 5
  // الساعة 5:30
  // الساعة 5 مساء
  // at 5
  // at 5 pm
  // -----------------------------------------------

  const explicitPatterns = [

    /(?:الساعة|الساعه)\s*(\d{1,2})(?::(\d{2}))?\s*(صباحا|صباح|مساء|العصر|الظهر|المغرب|الليل|م|ص)?/i,

    /\bat\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i,

    /\b(\d{1,2}):(\d{2})\s*(am|pm|صباحا|صباح|مساء|العصر|الظهر|المغرب|الليل|م|ص)?\b/i,

    // 5 مساء / 5 العصر / 5pm (بدون كلمة الساعة)
    /\b(\d{1,2})\s*(صباحا|صباح|مساء|العصر|الظهر|المغرب|الليل|am|pm)/i,
  ];


  for (
    const pattern
    of explicitPatterns
  ) {

    const match =
      raw.match(pattern);


    if (match) {

      return match[0].trim();
    }
  }


  // -----------------------------------------------
  // الخامسة
  // خمسة
  // five
  // الساعة الخامسة
  // -----------------------------------------------

  const writtenHour =
    extractWrittenHour(
      normalized
    );


  if (writtenHour) {

    let suffix = '';

    if (
      normalized.includes('مساء') ||
      normalized.includes('pm')
    ) {
      suffix = ' مساء';
    }

    else if (
      normalized.includes('صباح') ||
      normalized.includes('am')
    ) {
      suffix = ' صباح';
    }

    else if (normalized.includes('العصر')) {
      suffix = ' العصر';
    }

    else if (normalized.includes('الظهر')) {
      suffix = ' الظهر';
    }

    else if (normalized.includes('المغرب')) {
      suffix = ' المغرب';
    }

    else if (normalized.includes('الليل')) {
      suffix = ' الليل';
    }

    return `${writtenHour}${suffix}`;
  }


  // -----------------------------------------------
  // لو البوت سأل عن الساعة
  // والعميل رد فقط:
  //
  // 5
  // ٥
  // -----------------------------------------------

  const onlyNumber =
    normalized.match(
      /^(\d{1,2})(?:\s*(am|pm|م|ص|مساء|صباح))?$/
    );


  if (onlyNumber) {

    const hour =
      Number(
        onlyNumber[1]
      );

    if (
      hour >= 1 &&
      hour <= 24
    ) {
      return normalized;
    }
  }


  return null;
}


// =====================================================
// استخراج بيانات المعاينة
// =====================================================

function extractViewingData(
  history = [],
  userText = ''
) {

  // مهم:
  // البيانات الجديدة تُقرأ من الرسالة الحالية فقط.
  //
  // server.js هو الذي يحتفظ بما قاله العميل
  // في الرسائل السابقة داخل viewing_sessions.

  const raw =
    String(
      userText || ''
    );


  const text =
    normalizeArabicText(
      raw
    );


  let customerType =
    null;


  // -----------------------------------------------
  // مشتري
  // -----------------------------------------------

  const buyerPhrases = [
    'انا المشتري',
    'مشتري',
    'المشتري',
    'مشتري مباشر',
    'انا شاري',
    'شاري',
    'buyer',
    'i am the buyer',
    "i'm the buyer",
    'direct buyer',
  ];

  if (
    containsAnyPhrase(
      text,
      buyerPhrases
    )
  ) {
    customerType =
      'مشتري';
  }


  // -----------------------------------------------
  // مكتب / وسيط
  // -----------------------------------------------

  const officePhrases = [
    'انا مكتب',
    'مكتب عقار',
    'مكتب عقاري',
    'وسيط',
    'مسوق عقاري',
    'real estate office',
    'real estate agent',
    'broker',
    'agent',
    'i am an agent',
    "i'm an agent",
  ];

  if (
    containsAnyPhrase(
      text,
      officePhrases
    )
  ) {
    customerType =
      'مكتب';
  }


  // -----------------------------------------------
  // اليوم
  // -----------------------------------------------

  let day =
    null;


  const dayPatterns = [
    'اليوم',
    'بكره',
    'بكرة',
    'غدا',
    'غداً',
    'السبت',
    'الاحد',
    'الأحد',
    'الاثنين',
    'الإثنين',
    'الثلاثاء',
    'الثلاثا',
    'الاربعاء',
    'الأربعاء',
    'الاربع',
    'الأربع',
    'الخميس',
    'الجمعه',
    'الجمعة',

    // English
    'today',
    'tomorrow',
    'saturday',
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
  ];


  for (
    const d
    of dayPatterns
  ) {

    if (
      text.includes(
        normalizeArabicText(
          d
        )
      )
    ) {

      day = d;

      break;
    }
  }


  // -----------------------------------------------
  // تاريخ رقمي
  // 26/9
  // 26-9
  // 26/09/2026
  // -----------------------------------------------

  const convertedRaw =
    convertArabicDigits(
      raw
    );


  const dateMatch =
    convertedRaw.match(
      /\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/
    );


  if (
    !day &&
    dateMatch
  ) {

    day =
      dateMatch[0];
  }


  // -----------------------------------------------
  // الساعة
  // -----------------------------------------------

  const time =
    extractViewingTime(
      raw
    );


  return {
    day,
    time,
    customerType,
  };
}


// =====================================================
// هل المعاينة فعالة؟
// =====================================================

function viewingFlowIsActive(
  history = [],
  userText = ''
) {

  // لا نعتمد على history هنا.
  //
  // منعًا لمشكلة:
  // العميل يكمل المعاينة
  // ثم يقول "السلام عليكم"
  // فيرجع البوت يفتح الموعد القديم.

  return isViewingRequest(
    userText
  );
}


// =====================================================
// تحديد العقار الحالي (برقم العرض)
// =====================================================

function detectCurrentProperty(
  history = [],
  userText = ''
) {

  const messages = [
    ...history.map(
      (message) =>
        message.content || ''
    ),
    userText,
  ];

  // نبدأ من أحدث رسالة
  for (
    let i = messages.length - 1;
    i >= 0;
    i--
  ) {

    const t =
      convertArabicDigits(
        messages[i]
      );

    const match =
      t.match(
        /(?:عرض|العرض)\s*(?:رقم|رقم:|#)?\s*:?\s*(\d{1,6})/
      );

    if (match) {
      return `عرض رقم ${match[1]}`;
    }
  }

  return 'العقار الحالي';
}


// =====================================================
// تعليمات Claude — فهم الطلب
// =====================================================

const EXTRACTION_SYSTEM_PROMPT = `
أنت موظف مبيعات عقاري سعودي محترف تابع لـ "${COMPANY_NAME}" في المدينة المنورة.

العميل قد يرسل رسالة مكتوبة أو نصًا محولًا تلقائيًا من تسجيل صوتي. تعامل معه كرسالة عادية، وإذا فيه أخطاء بسيطة من التحويل حاول فهم المقصود من السياق.

افهم العربية والإنجليزية. الرد يكون باللهجة السعودية الطبيعية، إلا إذا كان واضحًا أن العميل لا يفهم العربية فرد بالإنجليزية. لا تستخدم اللهجة المصرية.

=====================================================
مهم جدًا:

أنت لا تملك قائمة عقارات في ذاكرتك.
كل العقارات موجودة في قاعدة بيانات موقع ${COMPANY_NAME}، والكود يبحث فيها بعد ما ترجع له معايير البحث.

لذلك:
ممنوع تذكر أي عقار أو سعر أو مساحة أو حي من عندك.
ممنوع تقول إن عقارًا متوفر أو غير متوفر بدون بحث.

=====================================================
متى تبحث (ready_to_search = true):

1) إذا العميل يبحث عن عقار ومعه معيار واحد على الأقل:
نوع العقار، بيع أو إيجار، الحي، السعر، المساحة، أو كلمة مميزة (مثل: مسبح، مصعد، داخل الحرم، واجهتين).
مثال: "أبي فيلا للبيع" ← ابحث مباشرة.
مثال: "عندكم أراضي في شوران؟" ← ابحث مباشرة.

2) إذا العميل يسأل عن تفصيلة في عقار تم عرضه عليه سابقًا في المحادثة (مثلًا: كم مساحتها؟ وين موقعها؟ عليها رهن؟ كم غرفة؟ فيها مصعد؟):
ابحث برقم العرض المذكور في المحادثة (offer_no).
إذا ما تعرف رقم العرض، ابحث بنفس المعايير السابقة (النوع والحي).

3) إذا ذكر العميل رقم عرض مباشرة (مثل: "عرض رقم 105") ← offer_no = 105.

4) إذا العميل رد برقم فقط (مثل "750" أو "٧٥٠" أو "مليون") بعد كلام عن عقار أو ميزانية:
اعتبره ميزانية، وكمّل بنفس نوع العقار المذكور قبل في المحادثة، وابحث مباشرة.
مثال: العميل قال "عندكم أرض؟" ثم "750" ← property_type = "أرض" و max_price = 750000.
إذا الرقم صغير ومعه "ألف" (مثل "750 ألف") ← 750000.

لا تشترط أن يذكر العميل كل المعايير.

ممنوع تكتب في reply كلام مثل "بنبحث لك" أو "جاري البحث" أو "خلني أشوف".
إذا فيه أي معيار بحث، لازم ready_to_search = true، والكود هو اللي يبحث ويرد بالنتائج.

لا تبحث (ready_to_search = false) إذا كانت الرسالة تحية أو شكر أو سؤال عام ليس عن عقار.
في هذه الحالة اكتب ردًا طبيعيًا قصيرًا في reply، ويمكنك سؤال العميل وش نوع العقار اللي يبحث عنه.

=====================================================
أنواع العقارات في الموقع:
فيلا، شقة، دور، أرض، أرض خام، أرض تجارية، عمارة، عمارة تجارية، استراحة، مزرعة، قصر، فندق، محطة وقود.

=====================================================
فهم الأرقام (مهم جدًا):

العميل ممكن يكتب الأرقام بأي شكل، ولازم تفهمها كلها وتحولها لأرقام:
- أرقام إنجليزية: 500000
- أرقام عربية: ٥٠٠٠٠٠ (نفس 500000)
- بالحروف: "خمسمية ألف" أو "خمسمائة ألف"
- مختلط: "٥٠٠ ألف" أو "500 الف" أو "نص مليون"
- بالإنجليزي: "half a million" أو "2 million" أو "500k"

انتبه للهجات:
"مية / ميه / مائة" = 100
"ميتين / مئتين / مائتين" = 200
"تلات / ثلاث" = 3
"تمن / ثمان" = 8
"نص" = نصف، "ربع" = ربع

=====================================================
تحويل السعر:

"500 ألف" أو "ميزانيتي 500 ألف" أو "ما يتجاوز 500 ألف" ← max_price = 500000
"من 500 إلى 700 ألف" ← min_price = 500000 و max_price = 700000
"نص مليون" ← 500000
"مليون" ← 1000000
"مليون ونص" ← 1500000
"مليون وربع" ← 1250000
"مليونين" ← 2000000
"ثلاث ملايين" أو "٣ مليون" ← 3000000
"سبعمية وخمسين ألف" ← 750000
"ميتين ألف" ← 200000
"تحت المليون" ← max_price = 1000000
"فوق المليونين" ← min_price = 2000000

=====================================================
تحويل المساحة:

"ستمية متر" أو "٦٠٠ م" ← 600
"ألف متر" ← 1000
"من 300 إلى 500 متر" ← min_area = 300 و max_area = 500

=====================================================
رقم العرض:

"عرض رقم مية وخمسة" أو "العرض ١٠٥" أو "عرض 105" ← offer_no = 105

اكتب الأرقام في JSON كأرقام وليس نصوصًا.

=====================================================
ممنوع في reply:
إرسال رقم هاتف أو روابط تواصل. الكود الخارجي مسؤول عنها.
اختراع خصم أو سعر أو موافقة مالك.

=====================================================
أرجع JSON صالح فقط بالشكل التالي بدون أي كلام قبله أو بعده:

{
  "reply": "رد قصير مناسب للعميل (يستخدم فقط إذا لم يكن هناك بحث)",
  "criteria": {
    "offer_no": null,
    "property_type": null,
    "purpose": null,
    "city": null,
    "district": null,
    "keyword": null,
    "min_price": null,
    "max_price": null,
    "min_area": null,
    "max_area": null
  },
  "ready_to_search": false,
  "needs_manager": false
}

purpose يكون "sale" أو "rent" أو null.
keyword: كلمة مميزة واحدة يبحث عنها العميل داخل وصف العقار (مثل "مسبح" أو "مصعد" أو "الحرم")، أو null.

=====================================================
needs_manager (تحويل للمدير العام):

خلّي needs_manager = true إذا:
- العميل طلب يكلم المدير أو مسؤول أو شخص حقيقي.
- العميل عنده شكوى أو مشكلة.
- سؤال ما تقدر تجاوب عليه من البحث في العقارات (مثل: العمولة، العقود، الإجراءات القانونية، طلب خصم أو تفاوض جدي على السعر، عرض عقار يبي يبيعه عن طريقنا، شراكة أو توظيف).
- أي سؤال ما تعرف جوابه بشكل أكيد.

في هذه الحالة اكتب في reply رد قصير ولطيف إن طلبه وصل وراح يتواصل معه المسؤول.
لا تكتب رقم المدير، الكود هو اللي يضيفه.

غير كذا خلّي needs_manager = false.
`;


// =====================================================
// تعليمات الرد المبني على نتائج البحث
// =====================================================

const GROUNDED_REPLY_SYSTEM_PROMPT = `
أنت موظف مبيعات عقاري سعودي تابع لـ "${COMPANY_NAME}" في المدينة المنورة.

تكلم باللهجة السعودية الطبيعية. افهم العربية والإنجليزية.

اعتمد فقط على نتائج البحث الموجودة أمامك، وهي عقارات حقيقية من موقع ${COMPANY_NAME}.
ممنوع اختراع أي عقار أو معلومة.

=====================================================
طريقة العرض:

كل عقار له "رقم العرض". اذكره دائمًا مع كل عقار بصيغة: عرض رقم X
(هذا مهم حتى يقدر العميل يرجع له، وحتى يعرف الفريق العقار المقصود).

إذا وجدت أكثر من عقار:
اعرض أفضلها (حتى 5) بشكل مختصر: رقم العرض، النوع، الحي، السعر، والمساحة إذا موجودة.
ثم اسأل العميل أي واحد يناسبه.

إذا العميل يسأل عن عقار واحد أو طلب التفاصيل:
اعرض تفاصيله من الوصف بشكل مرتب ومختصر.

إذا سأل عن تفصيلة واحدة (مساحة، موقع، رهن، مصعد...):
جاوب عنها فقط.

=====================================================
السعر:

إذا "السعر" مذكور في النتيجة استخدمه.
إذا السعر غير مذكور، ابحث عنه في الوصف (مثل: "المطلوب 2100 ريال للمتر").
إذا ما فيه سعر نهائيًا قل: "السعر على السوم" أو "السعر يتحدد بالتواصل".

=====================================================
التمويل والرهن:

لا تقل إن العقار عليه رهن أو ليس عليه رهن إلا إذا كان مذكورًا في الوصف.
لا تقل إن التمويل متاح أو غير متاح إلا إذا كان مذكورًا في الوصف.
إذا مو مذكور قل: "المعلومة هذي مو متوفرة عندي حاليًا، وبنحوّل سؤالك للمسؤول 🌹"
وابدأ ردك في هذه الحالة بالعلامة [MANAGER] (الكود يشيلها قبل ما توصل للعميل).

=====================================================
التحويل للمدير:

إذا العميل سأل سؤال ما تقدر تجاوبه من النتائج اللي قدامك، أو طلب يكلم مسؤول، أو عنده شكوى:
ابدأ ردك بالعلامة [MANAGER] ثم اكتب رد قصير إن سؤاله وصل وراح يتواصل معه المسؤول.
لا تكتب رقم المدير، الكود هو اللي يضيفه.

=====================================================
الموقع:

إذا سأل العميل عن موقع العقار بالتحديد وكان فيه "رابط الموقع" في النتيجة، تقدر ترسله له.
غير كذا لا ترسل روابط.

=====================================================
ممنوع:

إرسال رقم هاتف أو قناة واتساب أو رابط تواصل (الكود الخارجي مسؤول عنها).
ذكر أكواد داخلية مكتوبة في الوصف مثل "رقم العرض M135" أو "رمز العرض M115" — استخدم فقط "رقم العرض" الرسمي الموجود في النتيجة.
اختراع خصم أو سعر جديد أو موافقة مالك.

=====================================================
التفاوض:

إذا قال "غالية" أو "يمدي نتفاهم؟":
"أتفهمك 👍 وممكن يكون فيه مجال للنقاش حسب الجدية."

=====================================================
إذا لم توجد نتائج مطابقة:
قل بشكل طبيعي إنه ما ظهر لك حاليًا عقار مطابق للمواصفات، واقترح عليه يغيّر شرط واحد (مثل الحي أو الميزانية).
لا تدّعي عدم وجود العقار في السوق كله.

رجع نصًا طبيعيًا مناسبًا للعميل فقط.
`;


// =====================================================
// Claude API
// =====================================================

async function callClaude(
  system,
  messages,
  maxTokens = 1200
) {

  try {

    const response =
      await axios.post(

        'https://api.anthropic.com/v1/messages',

        {
          model:
            MODEL,

          max_tokens:
            maxTokens,

          system,

          messages,
        },

        {
          headers: {

            'Content-Type':
              'application/json',

            'x-api-key':
              ANTHROPIC_API_KEY,

            'anthropic-version':
              '2023-06-01',
          },

          timeout:
            30000,
        }
      );


    return response.data.content
      .map(
        (block) =>
          block.text || ''
      )
      .join('')
      .trim();

  } catch (err) {

    console.error(
      'تفاصيل خطأ Claude API:',
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
// قراءة JSON من Claude
// =====================================================

function tryParseClaudeResponse(
  rawText
) {

  if (
    !rawText ||
    typeof rawText !== 'string'
  ) {
    return null;
  }


  let cleaned =
    rawText
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();


  try {

    return JSON.parse(
      cleaned
    );

  } catch (_) {
    // نكمل
  }


  const firstBrace =
    cleaned.indexOf('{');

  const lastBrace =
    cleaned.lastIndexOf('}');


  if (
    firstBrace !== -1 &&
    lastBrace !== -1 &&
    lastBrace > firstBrace
  ) {

    const possibleJson =
      cleaned.slice(
        firstBrace,
        lastBrace + 1
      );

    try {

      return JSON.parse(
        possibleJson
      );

    } catch (_) {
      // نص عادي
    }
  }


  return null;
}


// =====================================================
// الرد على Sticker
// =====================================================

async function generateStickerReply(
  stickerDescription = ''
) {

  const description =
    String(
      stickerDescription || ''
    ).trim();

  if (!description) {
    return '😂🌹';
  }

  const system = `
أنت موظف واتساب سعودي تابع لـ "${COMPANY_NAME}".

العميل أرسل Sticker على واتساب، وسيتم إعطاؤك وصفًا لمعناه.

رد برسالة نصية قصيرة جدًا وطبيعية ومناسبة لمعنى الاستيكر.

لا تقل "الاستيكر يظهر" أو "الصورة تحتوي". تصرف كأنك رأيته بنفسك.

تكلم باللهجة السعودية الطبيعية.
لا تحول المحادثة إلى بيع عقاري بدون سبب.
لا ترسل رقم هاتف أو روابط.

أرسل الرد فقط.
`;

  const result =
    await callClaude(
      system,
      [
        {
          role: 'user',
          content:
`وصف الاستيكر:
${description}`,
        },
      ],
      150
    );

  if (!result) {
    return '😂🌹';
  }

  return result.trim();
}


// =====================================================
// تجهيز نتائج البحث كنص لـ Claude
// =====================================================

function formatResultsForClaude(
  matches = []
) {

  return matches
    .map(
      (p, index) => {

        const price =
          p.price !== null &&
          p.price !== undefined &&
          Number(p.price) > 0
            ? `${Number(p.price).toLocaleString('en-US')} ريال`
            : 'غير مذكور (راجع الوصف)';

        const area =
          p.area !== null &&
          p.area !== undefined &&
          Number(p.area) > 0
            ? `${p.area} م²`
            : null;

        const location =
          [
            p.city,
            p.district,
          ]
            .filter(Boolean)
            .join(' - ');

        const mapLinks =
          (p.links || [])
            .map(
              (l) =>
                l.url
            )
            .filter(Boolean);

        return [
          `النتيجة ${index + 1}`,
          p.offer_no
            ? `رقم العرض: ${p.offer_no}`
            : null,
          p.title
            ? `العنوان: ${p.title}`
            : null,
          p.type
            ? `نوع العقار: ${p.type}`
            : null,
          p.purpose_ar
            ? `الغرض: ${p.purpose_ar}`
            : null,
          location
            ? `الموقع: ${location}`
            : null,
          `السعر: ${price}`,
          area
            ? `المساحة: ${area}`
            : null,
          mapLinks.length
            ? `رابط الموقع: ${mapLinks[0]}`
            : null,
          p.description
            ? `الوصف:\n${p.description}`
            : null,
        ]
          .filter(Boolean)
          .join('\n');
      }
    )
    .join(
      '\n\n-----------------------------\n\n'
    );
}


// =====================================================
// علامة التحويل للمدير
// =====================================================

const MANAGER_MARKER =
  '[MANAGER]';

function stripManagerMarker(
  text = ''
) {

  const value =
    String(text || '');

  return {
    text:
      value
        .split(MANAGER_MARKER)
        .join('')
        .trim(),

    hasMarker:
      value.includes(
        MANAGER_MARKER
      ),
  };
}


// =====================================================
// إنشاء الرد الأساسي (مع معرفة هل يحتاج تحويل للمدير)
// يرجع: { reply, needsManager }
// =====================================================

async function generateReplyDetailed(
  history,
  userText
) {

  const done = (
    reply,
    needsManager = false
  ) => {

    const cleaned =
      stripManagerMarker(
        reply
      );

    return {
      reply:
        cleaned.text,

      needsManager:
        needsManager ||
        cleaned.hasMarker,
    };
  };

  try {

    // طلب تفاصيل أكثر / تواصل
    if (
      customerAskedForMoreDetails(
        userText
      )
    ) {
      return done(DETAILS_REPLY);
    }

    // تحويل الأرقام العربية (٥٠٠) إلى إنجليزية (500)
    // قبل ما تروح الرسالة لعقل البوت
    const cleanUserText =
      convertArabicDigits(
        userText
      );

    const messages = [
      ...history,
      {
        role: 'user',
        content: cleanUserText,
      },
    ];

    // 1) فهم الطلب
    const rawExtraction =
      await callClaude(
        EXTRACTION_SYSTEM_PROMPT,
        messages
      );

    if (!rawExtraction) {
      return done('ياهلا فيك 🌹 ممكن تعيد رسالتك مرة ثانية؟');
    }

    console.log(
      '🧠 فهم الطلب (رد Claude الخام):',
      rawExtraction
    );

    let parsed =
      tryParseClaudeResponse(
        rawExtraction
      );

    // لو Claude رد بكلام عادي بدل JSON، نطلب منه مرة ثانية JSON فقط
    if (!parsed) {

      console.log(
        '⚠️ الرد مو JSON — نعيد المحاولة'
      );

      const retryRaw =
        await callClaude(
          EXTRACTION_SYSTEM_PROMPT,
          [
            ...messages,
            {
              role: 'assistant',
              content: rawExtraction,
            },
            {
              role: 'user',
              content:
                '[تنبيه داخلي — العميل لا يرى هذه الرسالة] رجع JSON صالح فقط بالشكل المطلوب، بدون أي كلام قبله أو بعده.',
            },
          ]
        );

      console.log(
        '🧠 إعادة المحاولة:',
        retryRaw
      );

      parsed =
        tryParseClaudeResponse(
          retryRaw
        );
    }

    if (!parsed) {
      return done(rawExtraction.trim());
    }

    const extractionNeedsManager =
      parsed.needs_manager === true;

    // هل فيه أي معيار بحث فعلي؟ (نوع، سعر، حي، ...)
    // لو فيه، نبحث حتى لو Claude نسي يحط ready_to_search = true
    const criteria =
      parsed.criteria &&
      typeof parsed.criteria ===
        'object'
        ? parsed.criteria
        : {};

    const hasCriteria =
      Object.values(
        criteria
      ).some(
        (v) =>
          v !== null &&
          v !== undefined &&
          String(v).trim() !== ''
      );

    if (
      parsed.ready_to_search !==
        true &&
      !hasCriteria
    ) {

      if (
        typeof parsed.reply ===
          'string' &&
        parsed.reply.trim()
      ) {
        return done(
          parsed.reply.trim(),
          extractionNeedsManager
        );
      }

      return done(
        extractionNeedsManager
          ? 'وصلني طلبك 🌹 وبحوّله للمسؤول.'
          : 'ياهلا فيك 🌹 وش نوع العقار اللي تدور عليه؟',
        extractionNeedsManager
      );
    }

    // 2) البحث في موقع طيبة
    let matches = [];

    try {

      console.log(
        '🔎 البحث في عقارات طيبة:',
        JSON.stringify(criteria)
      );

      matches =
        (await searchProperties({
          ...criteria,
          limit: 5,
        })) || [];

      console.log(
        `🏠 عدد نتائج البحث: ${matches.length}`
      );

    } catch (searchError) {

      console.error(
        'خطأ أثناء البحث في عقارات طيبة:',
        searchError.message
      );

      return done('ما قدرت أوصل للعروض حاليًا 🌹 جرب مرة ثانية بعد شوي.');
    }

    const resultsContext =
      matches.length
        ? `العقارات المتاحة فعليًا من موقع ${COMPANY_NAME}:\n\n${formatResultsForClaude(matches)}`
        : `لا توجد نتائج مطابقة حاليًا في عروض ${COMPANY_NAME} لهذه المعايير:\n${JSON.stringify(criteria)}`;

    // 3) الرد المبني على النتائج
    const groundedMessages = [
      ...messages,
      {
        role: 'assistant',
        content: JSON.stringify(parsed),
      },
      {
        role: 'user',
        content:
`[نتائج البحث الداخلية — العميل لا يرى هذه الرسالة]

${resultsContext}

اكتب الرد النهائي للعميل بناءً على النتائج فقط، وحافظ على سياق العقار اللي يتكلم عنه.`,
      },
    ];

    const finalReply =
      await callClaude(
        GROUNDED_REPLY_SYSTEM_PROMPT,
        groundedMessages,
        1500
      );

    if (
      !finalReply ||
      !String(finalReply).trim()
    ) {
      return done('ما قدرت أوصل للنتيجة حاليًا 🌹 جرب مرة ثانية بعد شوي.');
    }

    return done(
      finalReply.trim(),
      extractionNeedsManager
    );

  } catch (err) {

    console.error(
      'خطأ غير متوقع في generateReply:',
      err
    );

    return done('ياهلا فيك 🌹 ممكن تعيد رسالتك مرة ثانية؟');
  }
}


// =====================================================
// نسخة قديمة ترجع نص فقط (للتوافق مع أي كود قديم)
// =====================================================

async function generateReply(
  history,
  userText
) {

  const result =
    await generateReplyDetailed(
      history,
      userText
    );

  return result.reply;
}


// =====================================================
// التصدير
// =====================================================

module.exports = {
  generateReply,
  generateReplyDetailed,
  generateStickerReply,
  isViewingRequest,
  extractViewingData,
  detectCurrentProperty,
  normalizeArabicText,
  convertArabicDigits,
};
