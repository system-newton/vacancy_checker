// GitHub Actions等で定期実行されるスクレイピング処理
// 結果を docs/data.json に保存します。

const { chromium } = require('playwright');
const https = require('https');
const fs = require('fs');
const path = require('path');

const SHOPS = [
  { key: 'shimbashi', label: '新橋駅前店',     kind: '男性専用',
    rakuten: '128267', jalan: '368296', yahoo: '00901085', rurubu: 'tokyo/anshin-oyado-tokyo-man-ginza-shimbashi-station', booking: 'capsule-anshin-oyado-shinbashi' },
  { key: 'akihabara', label: '秋葉原電気街店', kind: '男性専用',
    rakuten: '142653', jalan: '386755', yahoo: '00901086', rurubu: 'tokyo/anshin-oyado-tokyo-man-akihabara', booking: 'capsule-anshin-oyado-akihabara' },
  { key: 'shinjuku',  label: '新宿駅南口店',   kind: '男性専用',
    rakuten: '147662', jalan: '319308', yahoo: '00901087', rurubu: 'tokyo/anshin-oyado-tokyo-man-shinjuku', booking: 'capsule-anshin-oyado-shinjuku-tokyo' },
  { key: 'ogikubo',   label: '新宿荻窪店',     kind: '女性専用',
    rakuten: '153603', jalan: '345855', yahoo: '00901088', rurubu: 'musashino/anshin-oyado-tokyo-woman-shinjuku-ogikubo', booking: 'capsule-anshin-oyado-ogikubo' },
  { key: 'shiodome',  label: '銀座汐留店',     kind: '女性専用',
    rakuten: '158890', jalan: '301118', yahoo: '00901089', rurubu: 'tokyo/anshin-oyado-tokyo-woman-ginza-shiodome', booking: 'capsule-anshin-oyado-shinbashi-shiodome' },
  { key: 'nagoya',    label: '名古屋栄店',     kind: '男女別専用',
    rakuten: '178541', jalan: '378358', yahoo: '00910525', rurubu: 'nagoya/anshin-oyado-nagoya-man-woman-nagoya', booking: 'capsule-hotel-anshin-oyado-premium-nagoya-sakae' },
];

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

const urlBuilders = {
  rakuten: (shop, ci) => {
    const co = addDays(ci, 1);
    const [y1, m1, d1] = ci.split('-'); const [y2, m2, d2] = co.split('-');
    return `https://hotel.travel.rakuten.co.jp/hotelinfo/plan/${shop.rakuten}?f_nen1=${y1}&f_tuki1=${+m1}&f_hi1=${+d1}&f_nen2=${y2}&f_tuki2=${+m2}&f_hi2=${+d2}&f_heya_su=1&f_otona_su=1&f_flg=PLAN&f_static=1`;
  },
  jalan: (shop, ci) => {
    const [y, m, d] = ci.split('-');
    return `https://www.jalan.net/yad${shop.jalan}/plan/?stayYear=${y}&stayMonth=${+m}&stayDay=${+d}&stayCount=1&roomCount=1&adultNum=1`;
  },
  yahoo: (shop, ci) => {
    const co = addDays(ci, 1);
    return `https://travel.yahoo.co.jp/${shop.yahoo}/?ppc=2&rc=1&checkinDate=${ci.replace(/-/g, '')}&checkoutDate=${co.replace(/-/g, '')}`;
  },
  rurubu: (shop, ci) => {
    return `https://www.rurubu.travel/hotel/japan/${shop.rurubu}?adults=1&children=0&rooms=1&checkin=${ci}&los=1&currencyCode=JPY`;
  },
  booking: (shop, ci) => {
    const co = addDays(ci, 1);
    return `https://www.booking.com/hotel/jp/${shop.booking}.ja.html?checkin=${ci}&checkout=${co}&group_adults=1&no_rooms=1&group_children=0`;
  }
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SITE_RULES = {
  rakuten: { soldOut: ['空室が見つかりませんでした', '空室が見つかりません', 'ご指定の条件に一致する', '満室です'], avail: ['このプランの詳細', '予約する', 'を選択', '詳細・予約', '残り'] },
  jalan: { soldOut: ['0件の宿泊プラン', '宿泊プランがありませんでした', '条件に合う宿泊プランが見つかりません', '満室', '予約できるプランがありません'], avail: ['件の宿泊プランがありました', '空室わずか', 'このプランを見ています', '部屋タイプ・詳細'] },
  yahoo: { soldOut: ['空室が見つかりませんでした', '空室が見つかりません', '満室', 'ご希望の条件に合う', '予約できるプランがありません', '別の日程'], avail: ['予約する', 'このプラン', '残り', 'ポイント', 'プランを見る', '部屋・プランを見る'] },
  rurubu: { soldOut: ['空室は見つかりませんでした', '空室が見つかりませんでした', '選択された日付で空室', '別の日付で検索', 'この宿泊施設は満室です', '現在予約を受け付けていません'], avail: ['この料金を見る', '予約できる料金プラン', '最安値', '種類のルームタイプ', 'るるぶトラベルでの最安値'] },
  booking: { soldOut: ['選択された日程に空室がありません', '空室がありません', '満室です', 'この宿泊施設は現在ご利用いただけません', '別の日程で検索', '空室状況を検索してください'], avail: ['予約可能なお部屋', '残り', '空室を確認', 'この料金で予約', '1泊あたり', '合計金額', '予約する'] },
};

async function judgeOne(page, site, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    const rule = SITE_RULES[site];
    const MAX_WAIT = 5000, STEP = 400;
    let text = '', elapsed = 0;
    while (true) {
      text = await page.evaluate(() => document.body.innerText || '');
      const soldHit = rule.soldOut.find(p => text.includes(p));
      if (soldHit) return { status: 'soldout', hit: soldHit };
      const availHit = rule.avail.find(p => text.includes(p));
      if (availHit) return { status: 'available', hit: availHit };
      if (elapsed >= MAX_WAIT) break;
      await page.waitForTimeout(STEP);
      elapsed += STEP;
    }
    return { status: 'unknown', hit: null };
  } catch (e) {
    return { status: 'error', hit: e.message };
  }
}

function sampleDates(year, month, count = 4) {
  const last = new Date(year, month, 0).getDate();
  const today = new Date();
  const isCurrentMonth = (today.getFullYear() === year && (today.getMonth() + 1) === month);
  const startDay = isCurrentMonth ? Math.max(1, today.getDate()) : 1;
  const pool = [];
  for (let d = startDay; d <= last; d++) pool.push(d);
  if (pool.length === 0) return [];
  const picks = [];
  const step = Math.max(1, Math.floor(pool.length / count));
  for (let i = 0; i < pool.length && picks.length < count; i += step) picks.push(pool[i]);
  if (!picks.includes(pool[pool.length - 1])) picks.push(pool[pool.length - 1]);
  return picks.map(d => `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
}

async function checkSite(site, year, month, browser) {
  console.log(`[Scrape] ${site} を巡回中...`);
  const dates = sampleDates(year, month, 4);
  const ctx = await browser.newContext({ userAgent: UA, locale: 'ja-JP' });
  const page = await ctx.newPage();
  const results = [];

  for (const shop of SHOPS) {
    const perDay = [];
    for (const ci of dates) {
      const url = urlBuilders[site](shop, ci);
      const r = await judgeOne(page, site, url);
      perDay.push({ date: ci, status: r.status, hit: r.hit, url });
      await page.waitForTimeout(1000); 
    }
    const availCount = perDay.filter(x => x.status === 'available').length;
    const soldCount = perDay.filter(x => x.status === 'soldout').length;
    
    let overall;
    if (availCount > 0) overall = 'available';
    else if (soldCount === perDay.length) overall = 'allsoldout';
    else if (soldCount > 0) overall = 'mostlysoldout';
    else overall = 'unknown';
    
    results.push({ shop: shop.label, kind: shop.kind, overall, availCount, soldCount, samples: perDay });
  }
  await ctx.close();
  return { site, year, month, dates, results };
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
  });
}

function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function salesTypeToSymbol(t) {
  if (t === null || t === undefined) return { sym: '－', cls: 'none', text: '設定なし' };
  const n = Number(t);
  if (n === 0 || n === 9) return { sym: '×', cls: 'cross', text: '満室' };
  if (n === 1) return { sym: '○', cls: 'circle', text: '空室あり' };
  return { sym: '△', cls: 'tri', text: '残りわずか' };
}

async function fetchOfficialMonth(year, month) {
  console.log(`[Scrape] 公式APIを取得中...`);
  const daysInMonth = new Date(year, month, 0).getDate();
  const froms = [];
  for (let d = 1; d <= daysInMonth; d += 7) froms.push(fmt(new Date(year, month - 1, d)));

  const byShop = SHOPS.map(() => ({}));
  let shopNames = SHOPS.map(s => s.label);

  for (const from of froms) {
    const url = `https://api.489pro-x.com/api_public/anshinoyado/group/facility/calendar?lang=1&from=${from}&num=1`;
    const j = await fetchJson(url);
    if (!j || !j.res || !j.res.facility_list) continue;
    
    j.res.facility_list.forEach((f, idx) => {
      if (idx >= SHOPS.length) return;
      if (f.name) shopNames[idx] = f.name;
      for (const x of (f.date_list || [])) {
        if (x.date && x.date.startsWith(`${year}-${String(month).padStart(2, '0')}`)) {
          byShop[idx][x.date] = { sales_type: x.sales_type, stock_num: x.stock_num };
        }
      }
    });
    await new Promise(r => setTimeout(r, 500));
  }

  const dates = [];
  for (let d = 1; d <= daysInMonth; d++) dates.push(fmt(new Date(year, month - 1, d)));

  const rows = SHOPS.map((s, idx) => {
    const cells = dates.map(date => {
      const rec = byShop[idx][date];
      const sym = salesTypeToSymbol(rec ? rec.sales_type : null);
      return {
        date, symbol: sym.sym, cls: sym.cls, text: sym.text, 
        isNone: (!rec || rec.sales_type == null), stock: rec ? rec.stock_num : null,
      };
    });
    const noneCount = cells.filter(c => c.isNone).length;
    return { shop: shopNames[idx] || s.label, kind: s.kind, cells, noneCount };
  });

  return { year, month, dates, rows };
}

async function main() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 当月のみ対象とする

  const browser = await chromium.launch({ headless: true });
  
  try {
    const officialData = await fetchOfficialMonth(year, month);
    const sitesData = {};
    const sites = ['rakuten', 'jalan', 'yahoo', 'rurubu', 'booking'];
    
    for (const site of sites) {
      sitesData[site] = await checkSite(site, year, month, browser);
    }

    const finalData = {
      updatedAt: new Date().toISOString(),
      year,
      month,
      official: officialData,
      sites: sitesData
    };

    // docsフォルダ（公開用）がなければ作成して保存
    if (!fs.existsSync('docs')) fs.mkdirSync('docs');
    fs.writeFileSync(path.join('docs', 'data.json'), JSON.stringify(finalData, null, 2));
    
    console.log('✅ データ取得完了: docs/data.json を生成しました。');
  } catch(e) {
    console.error('❌ エラー発生:', e);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();