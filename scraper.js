// GitHub Actions等で定期実行されるスクレイピング処理 (公式API & OTA)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');

const SHOPS = [
  { key: 'shimbashi', label: '安心お宿 Tokyo Man 新橋駅前店',     kind: 'Man',
    rakuten: '128267', jalan: '368296', yahoo: '00901085', rurubu: 'tokyo/anshin-oyado-tokyo-man-ginza-shimbashi-station', booking: 'capsule-anshin-oyado-shinbashi' },
  { key: 'akihabara', label: '安心お宿 Tokyo Man 秋葉原電気街店', kind: 'Man',
    rakuten: '142653', jalan: '386755', yahoo: '00901086', rurubu: 'tokyo/anshin-oyado-tokyo-man-akihabara', booking: 'capsule-anshin-oyado-akihabara' },
  { key: 'shinjuku',  label: '安心お宿 Tokyo Man 新宿駅南口店',   kind: 'Man',
    rakuten: '147662', jalan: '319308', yahoo: '00901087', rurubu: 'tokyo/anshin-oyado-tokyo-man-shinjuku', booking: 'capsule-anshin-oyado-shinjuku-tokyo' },
  { key: 'ogikubo',   label: '安心お宿 Tokyo Woman 新宿荻窪店',     kind: 'Woman',
    rakuten: '153603', jalan: '345855', yahoo: '00901088', rurubu: 'musashino/anshin-oyado-tokyo-woman-shinjuku-ogikubo', booking: 'capsule-anshin-oyado-ogikubo' },
  { key: 'shiodome',  label: '安心お宿 Tokyo Woman 銀座汐留店',     kind: 'Woman',
    rakuten: '158890', jalan: '301118', yahoo: '00901089', rurubu: 'tokyo/anshin-oyado-tokyo-woman-ginza-shiodome', booking: 'capsule-anshin-oyado-shinbashi-shiodome' },
  { key: 'nagoya',    label: '安心お宿 Nagoya Man＆Woman 栄駅前店', kind: 'Man&Woman',
    rakuten: '178541', jalan: '378358', yahoo: '00910525', rurubu: 'nagoya/anshin-oyado-nagoya-man-woman-nagoya', booking: 'capsule-hotel-anshin-oyado-premium-nagoya-sakae' },
];

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const SITE_RULES = {
  rakuten: { soldOut: ['空室が見つかりません', 'ご指定の条件に一致する', '満室です', '販売終了'], avail: ['このプランの詳細', '予約する', 'を選択', '残り', '空室あり', '円'] },
  jalan: { soldOut: ['0件の宿泊プラン', '条件に合う宿泊プランが見つかりません', '満室', '予約できるプランがありません', '受付を終了'], avail: ['件の宿泊プラン', '空室わずか', 'プランを見る', '予約へ進む', '残り', '予約', '円', '○', '△', '室'] },
  yahoo: { soldOut: ['空室が見つかりません', '満室', 'ご希望の条件に合う', '予約できるプランがありません', '販売終了'], avail: ['予約する', 'このプラン', '残り', 'プランを見る', '選択する', '円', '空室'] },
  rurubu: { soldOut: ['空室は見つかりませんでした', '選択された日付で空室', 'この宿泊施設は満室です', '販売終了'], avail: ['この料金を見る', '予約できる料金プラン', '最安値', '種類のルームタイプ', '円'] },
  booking: { soldOut: ['選択された日程に空室がありません', '空室がありません', '満室です', '予約できません'], avail: ['予約可能なお部屋', '残り', '空室を確認', 'この料金で予約', '1泊あたり', '予約する'] }
};

// =========================================================
// 公式APIデータの取得 (7日ごと5回呼び出し)
// =========================================================
function fetchJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve(data ? JSON.parse(data) : null));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
  });
}

function salesTypeToSymbol(t) {
  if (t === null || t === undefined) return { sym: '－', cls: 'none', text: '設定なし' };
  const n = Number(t);
  if (n === 0 || n === 9) return { sym: '×', cls: 'cross', text: '満室' };
  if (n === 1) return { sym: '○', cls: 'circle', text: '空室あり' };
  return { sym: '△', cls: 'tri', text: '残りわずか' };
}

async function fetchOfficialMonth(year, month) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const froms = [];
  for (let d = 1; d <= daysInMonth; d += 7) {
    froms.push(`${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }

  const byShop = SHOPS.map(() => ({}));
  let shopNames = SHOPS.map(s => s.label);

  const responses = await Promise.all(
    froms.map(from => fetchJson(`https://api.489pro-x.com/api_public/anshinoyado/group/facility/calendar?lang=1&from=${from}&num=1`))
  );

  const ym = `${year}-${String(month).padStart(2, '0')}`;
  for (const j of responses) {
    if (!j || !j.res || !j.res.facility_list) continue;
    j.res.facility_list.forEach((f, idx) => {
      if (idx >= SHOPS.length) return;
      if (f.name) shopNames[idx] = f.name;
      for (const x of (f.date_list || [])) {
        if (x.date && x.date.startsWith(ym)) byShop[idx][x.date] = { sales_type: x.sales_type, stock_num: x.stock_num };
      }
    });
  }

  const dates = [];
  for (let d = 1; d <= daysInMonth; d++) dates.push(`${ym}-${String(d).padStart(2, '0')}`);

  const rows = SHOPS.map((s, idx) => {
    const cells = dates.map(date => {
      const rec = byShop[idx][date];
      // 厳密な null/undefined チェック
      const isNone = !rec || rec.sales_type === null || rec.sales_type === undefined;
      const sym = salesTypeToSymbol(rec ? rec.sales_type : null);
      return { date, symbol: sym.sym, cls: sym.cls, text: sym.text, isNone: isNone, stock: rec ? rec.stock_num : null };
    });
    
    const noneCount = cells.filter(c => c.isNone).length;
    let overall = 'unknown';
    // 判定ロジックの修正: 厳密に個数を比較
    if (noneCount === cells.length) {
      overall = 'nosetting';
    } else if (noneCount > 0) {
      overall = 'mostlysoldout';
    } else {
      overall = 'available';
    }

    return { shop: shopNames[idx] || s.label, kind: s.kind, cells, overall, noneCount };
  });

  return { year, month, dates, rows };
}

// =========================================================
// OTAデータの取得 (Playwright)
// =========================================================
async function judgeOne(page, site, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(3000);
    const rule = SITE_RULES[site];
    let elapsed = 0;
    while (true) {
      if (site === 'jalan') {
        const domAvail = await page.evaluate(() => document.querySelector('.calendar-cell.has-stock, .calendar-stock.in-stock') ? 'dom:has-stock' : null);
        if (domAvail) return { status: 'available', hit: domAvail };
      }
      const text = await page.evaluate(() => document.body ? document.body.innerText || '' : '');
      const availHit = rule.avail.find(p => text.includes(p));
      if (availHit) return { status: 'available', hit: availHit };
      const soldHit = rule.soldOut.find(p => text.includes(p));
      if (soldHit) return { status: 'soldout', hit: soldHit };
      if (elapsed >= 8000) break;
      await page.waitForTimeout(400);
      elapsed += 400;
    }
    return { status: 'unknown', hit: null };
  } catch (e) {
    return { status: 'error', hit: e.message };
  }
}

function sampleDates(year, month, count = 5) {
  const last = new Date(year, month, 0).getDate();
  const today = new Date();
  const isCurrentMonth = (today.getFullYear() === year && (today.getMonth()+1) === month);
  const startDay = isCurrentMonth ? today.getDate() : 1;
  const pool = [];
  for (let d = startDay; d <= last; d++) pool.push(d);
  if (pool.length === 0) return [];
  const picks = [];
  const step = Math.max(1, Math.floor(pool.length / count));
  for (let i = 0; i < pool.length && picks.length < count; i += step) picks.push(pool[i]);
  if (!picks.includes(pool[pool.length-1])) picks.push(pool[pool.length-1]);
  return picks.map(d => `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
}

async function checkSite(site, year, month, browser) {
  console.log(`[Scrape] ${site} (${year}/${month})`);
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
      await page.waitForTimeout(500 + Math.random()*500); 
    }
    const availCount = perDay.filter(x => x.status === 'available').length;
    const soldCount  = perDay.filter(x => x.status === 'soldout').length;
    
    let overall = 'unknown';
    if (availCount > 0) overall = 'available';
    else if (soldCount === perDay.length) overall = 'allsoldout'; 
    else if (soldCount > 0) overall = 'mostlysoldout';
    
    results.push({ shop: shop.label, kind: shop.kind, overall, availCount, soldCount, samples: perDay });
  }
  await ctx.close();
  return { site, year, month, dates, results };
}

async function main() {
  const now = new Date();
  const targetMonths = [];
  for (let i = 0; i <= 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    targetMonths.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }

  const browser = await chromium.launch({ headless: true });
  const monthsData = [];

  try {
    for (const { year, month } of targetMonths) {
      console.log(`\n📅 【${year}年${month}月】処理開始`);
      const official = await fetchOfficialMonth(year, month);
      const sites = {};
      for (const site of ['rakuten', 'jalan', 'yahoo', 'rurubu', 'booking']) {
        sites[site] = await checkSite(site, year, month, browser);
      }
      monthsData.push({ year, month, official, sites });
    }

    const finalData = { updatedAt: new Date().toISOString(), months: monthsData };
    if (!fs.existsSync('docs')) fs.mkdirSync('docs');
    fs.writeFileSync(path.join('docs', 'data.json'), JSON.stringify(finalData, null, 2));
    console.log('\n✅ 完了');
  } catch(e) {
    console.error('❌ エラー:', e);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
