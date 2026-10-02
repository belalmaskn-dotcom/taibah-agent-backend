// search.js
// البحث في عقارات استثمارات طيبة — يقرأ مباشرة من API موقع طيبة
// العقارات تُحفظ مؤقتًا في الذاكرة 10 دقائق ثم تتحدث تلقائيًا

const axios = require('axios');

const SITE_URL =
  (
    process.env.TAIBAH_SITE_URL ||
    'https://taibah-realestate.onrender.com'
  ).replace(/\/$/, '');

const CACHE_MS = 10 * 60 * 1000;

let cache = {
  items: [],
  fetchedAt: 0,
};


// =====================================================
// أدوات النص
// =====================================================

function convertArabicDigits(text = '') {
  return String(text || '').replace(
    /[٠-٩]/g,
    (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))
  );
}

function normalizeArabicText(text = '') {
  return convertArabicDigits(text)
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}


// =====================================================
// جلب كل العقارات من الموقع
// =====================================================

async function fetchAllProperties(force = false) {

  if (
    !force &&
    cache.items.length &&
    Date.now() - cache.fetchedAt < CACHE_MS
  ) {
    return cache.items;
  }

  try {

    const all = [];
    let page = 1;
    let totalPages = 1;

    do {

      const response =
        await axios.get(
          `${SITE_URL}/api/properties`,
          {
            params: {
              page,
              limit: 50,
            },
            timeout: 60000,
          }
        );

      const data =
        response.data?.data || [];

      all.push(...data);

      totalPages =
        Number(
          response.data?.pagination?.totalPages
        ) || 1;

      page++;

    } while (
      page <= totalPages &&
      page <= 60
    );

    const items =
      all.filter(
        (p) =>
          !p.status ||
          p.status === 'approved'
      );

    cache = {
      items,
      fetchedAt: Date.now(),
    };

    console.log(
      `✅ تم تحديث عقارات طيبة: ${items.length} عقار`
    );

    return items;

  } catch (err) {

    console.error(
      '❌ خطأ في جلب عقارات طيبة:',
      err.message
    );

    // لو فيه نسخة قديمة نستخدمها بدل ما نوقف
    if (cache.items.length) {
      return cache.items;
    }

    throw err;
  }
}


// =====================================================
// أنواع العقارات
// =====================================================

function getTypeVariants(type = '') {

  const t = normalizeArabicText(type);

  if (!t) return [];

  const groups = [
    ['شقه', 'شقق', 'apartment'],
    ['فيلا', 'فله', 'فلل', 'villa'],
    ['دور', 'ادوار', 'floor'],
    ['ارض تجاريه', 'commercial land'],
    ['ارض خام', 'raw land'],
    ['ارض', 'اراضي', 'land'],
    ['عماره تجاريه', 'commercial building'],
    ['عماره', 'عمائر', 'building'],
    ['استراحه', 'استراحات', 'rest house'],
    ['مزرعه', 'مزارع', 'farm'],
    ['قصر', 'قصور', 'palace'],
    ['فندق', 'فنادق', 'hotel'],
    ['محطه وقود', 'محطه', 'محطات', 'gas station'],
  ];

  for (const group of groups) {
    if (
      group.some((v) =>
        t.includes(normalizeArabicText(v))
      )
    ) {
      return group.map(normalizeArabicText);
    }
  }

  return [t];
}


function purposeMatches(listingType, purpose) {

  if (!purpose) return true;

  const p = normalizeArabicText(purpose);
  const lt = String(listingType || '').toLowerCase();

  if (['sale', 'بيع', 'للبيع', 'شراء'].includes(p)) {
    return !lt || lt.includes('sale');
  }

  if (['rent', 'ايجار', 'للايجار'].includes(p)) {
    return lt.includes('rent');
  }

  return true;
}


function purposeArabic(listingType) {
  const lt = String(listingType || '').toLowerCase();
  if (lt.includes('rent')) return 'إيجار';
  if (lt.includes('sale')) return 'بيع';
  return null;
}


function parseLinks(links) {
  try {
    const arr =
      typeof links === 'string'
        ? JSON.parse(links || '[]')
        : links || [];
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}


function toPublic(p) {
  return {
    offer_no: p.offer_no ?? null,
    title: p.title || null,
    type: p.type || null,
    purpose_ar: purposeArabic(p.listing_type),
    city: p.city || null,
    district: p.district ? String(p.district).trim() : null,
    price: p.price ?? null,
    area: p.area ?? null,
    description: String(p.description || '')
      .replace(/\r/g, '')
      .slice(0, 2000),
    links: parseLinks(p.links),
  };
}


// =====================================================
// البحث
// =====================================================

async function searchProperties(criteria = {}) {

  const items = await fetchAllProperties();

  let limit = Number(criteria.limit) || 5;
  limit = Math.min(Math.max(limit, 1), 10);

  // ---- رقم عرض محدد ----
  if (
    criteria.offer_no !== undefined &&
    criteria.offer_no !== null &&
    criteria.offer_no !== ''
  ) {
    const no = Number(
      convertArabicDigits(String(criteria.offer_no)).replace(/\D/g, '')
    );

    const found = items.filter(
      (p) => Number(p.offer_no) === no
    );

    if (found.length) {
      return found.map(toPublic);
    }
  }

  const typeVariants = getTypeVariants(criteria.property_type);

  const district = criteria.district
    ? normalizeArabicText(criteria.district).replace(/^حي\s+/, '')
    : null;

  const city = criteria.city
    ? normalizeArabicText(criteria.city)
    : null;

  const keyword = criteria.keyword
    ? normalizeArabicText(criteria.keyword)
    : null;

  const num = (v) =>
    v === undefined || v === null || v === ''
      ? null
      : Number(v);

  const minPrice = num(criteria.min_price);
  const maxPrice = num(criteria.max_price);
  const minArea = num(criteria.min_area);
  const maxArea = num(criteria.max_area);

  const results = items.filter((p) => {

    const type = normalizeArabicText(p.type);
    const text = normalizeArabicText(
      `${p.title || ''} ${p.district || ''} ${p.description || ''}`
    );

    // النوع
    if (typeVariants.length) {
      const ok = typeVariants.some(
        (v) =>
          type.includes(v) ||
          normalizeArabicText(p.title).includes(v)
      );
      if (!ok) return false;
    }

    // بيع / إيجار
    if (!purposeMatches(p.listing_type, criteria.purpose)) {
      return false;
    }

    // المدينة
    if (city && p.city) {
      const c = normalizeArabicText(p.city);
      if (!c.includes(city) && !city.includes(c)) {
        return false;
      }
    }

    // الحي (في خانة الحي أو داخل الوصف)
    if (district && !text.includes(district)) {
      return false;
    }

    // كلمة مميزة
    if (keyword && !text.includes(keyword)) {
      return false;
    }

    // السعر (العقارات بدون سعر لا تُستبعد)
    const price = Number(p.price) || null;
    if (price) {
      if (minPrice !== null && price < minPrice) return false;
      if (maxPrice !== null && price > maxPrice) return false;
    }

    // المساحة (فقط لو مسجلة)
    const area = Number(p.area) || null;
    if (area) {
      if (minArea !== null && area < minArea) return false;
      if (maxArea !== null && area > maxArea) return false;
    }

    return true;
  });

  // العقارات اللي سعرها مسجل أولًا لو العميل حدد ميزانية، ثم الأحدث
  results.sort((a, b) => {
    if (minPrice !== null || maxPrice !== null) {
      const ap = Number(a.price) ? 0 : 1;
      const bp = Number(b.price) ? 0 : 1;
      if (ap !== bp) return ap - bp;
    }
    return (Number(b.id) || 0) - (Number(a.id) || 0);
  });

  return results.slice(0, limit).map(toPublic);
}


// =====================================================
// اختبار مباشر:  node search.js
// =====================================================

if (require.main === module) {
  (async () => {
    try {
      const r = await searchProperties({
        property_type: 'فيلا',
        purpose: 'sale',
        limit: 3,
      });
      console.log(JSON.stringify(r, null, 2));
    } catch (e) {
      console.error(e.message);
    }
  })();
}

module.exports = {
  searchProperties,
  fetchAllProperties,
};
