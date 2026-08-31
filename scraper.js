// GitHub Actions等で定期実行されるスクレイピング処理
// 当月から来年の同月（計13ヶ月分）のデータを取得し docs/data.json に保存します。

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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const SITE_RULES = {
  rakuten: {
    soldOut: ['空室が見つかりませんでした', '空室が見つかりません', 'ご指定の条件に一致する', '満室です', '該当するプランがありません', '予約可能なプランがありません'],
    avail: ['このプランの詳細', '予約する', 'を選択', '詳細・予約', '残り', '空室あり', 'プラン一覧', '空室カレンダー', '円', 'プラン']
  },
  jalan: {
    soldOut: ['0件の宿泊プラン', '宿泊プランがありませんでした', '条件に合う宿泊プランが見つかりません', '満室', '予約できるプランがありません', '空室がありません', '該当するプランがありません'],
    avail: ['件の宿泊プランがありました', '空室わずか', '残室わずか', 'このプランを見ています', '部屋タイプ・詳細', 'プランを見る', '予約へ進む', '部屋', 'プラン', '残り', '残室', '空室', '予約', '円', 'プラン詳細', '▲']
  },
  yahoo: {
    soldOut: ['空室が見つかりませんでした', '空室が見つかりません', '満室', 'ご希望の条件に合う', '予約できるプランがありません', '別の日程', '該当するプランがありません', 'お探しの条件に該当する'],
    avail: ['予約する', 'このプラン', '残り', 'ポイント', 'プランを見る', '部屋・プランを見る', '選択する', '料金プラン', 'PayPay', '予約手続きへ', '円', '空室']
  },
  rurubu: {
    soldOut: ['空室は見つかりませんでした', '選択された日付で空室', '別の日付で検索', 'この宿泊施設は満室です', '現在予約を受け付けていません', 'お探しの条件に該当するプラン'],
    avail: ['この料金を見る', '予約できる料金プラン', '最安値', '種類のルームタイプ', 'るるぶトラベルでの最安値', '選択する', '円', 'プラン']
  },
  booking: {
    soldOut: ['選択された日程に空室がありません', '空室がありません', '満室です', 'この宿泊施設は現在ご利用いただけません', '別の日程で検索', '空室状況を検索してください', '予約できません'],
    avail: ['予約可能なお部屋', '残り', '空室を確認', 'この料金で予約', '1泊あたり', '合計金額', '予約する', '空室状況を表示', '部屋']
  },
};

async function judgeOne(page, site, url) {
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 35000 });
    await page.waitForTimeout(1500);

    const rule = SITE_RULES[site];
    const MAX_WAIT = 6000, STEP = 500;
    let text = '', elapsed = 0;
    
    while (true) {
      text = await page.evaluate(() => document.body ? document.body.innerText || '' : '');
      
      const availHit = rule.avail.find(p => text.includes(p));
      if (availHit) return { status: 'available', hit: availHit };

      const soldHit = rule.soldOut.find(p => text.includes(p));
      if (soldHit) return { status: 'soldout', hit: soldHit };

      if (elapsed >= MAX_WAIT) break;
      await page.waitForTimeout(STEP);
      elapsed += STEP;
    }
    return { status: 'unknown', hit: null };
  } catch (e) {
    return { status: 'error', hit: e.message };
  }
}

function sampleDates(year, month, count = 3) {
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
  console.log(`[Scrape] ${site} (${year}年${month}月) を巡回中...`);
  const dates = sampleDates(year, month, 3);
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: 'ja-JP',
    viewport: { width: 1280, height: 800 }
  });
  const page = await ctx.newPage();
  const results = [];

  for (const shop of SHOPS) {
    const perDay = [];
    for (const ci of dates) {
      const url = urlBuilders[site](shop, ci);
      const r = await judgeOne(page, site, url);
      perDay.push({ date: ci, status: r.status, hit: r.hit, url });
      await page.waitForTimeout(400); 
    }
    const availCount = perDay.filter(x => x.status === 'available').length;
    const soldCount = perDay.filter(x => x.status === 'soldout').length;
    
    let overall;
    if (availCount > 0) {
      overall = 'available'; // 空室/▲あり
    } else if (soldCount === perDay.length) {
      overall = 'nosetting'; // すべて×の場合は設定なし判定
    } else {
      overall = 'mostlysoldout'; // それ以外の場合は満室扱い
    }
    
    results.push({ shop: shop.label, kind: shop.kind, overall, availCount, soldCount, samples: perDay });
  }
  await ctx.close();
  return { site, year, month, dates, results };
}

function fetchJson(url, redirectCount = 0) {
  if (redirectCount > 5) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.anshinoyado.jp/'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let nextUrl = res.headers.location;
        if (!nextUrl.startsWith('http')) {
          const u = new URL(url);
          nextUrl = `${u.protocol}//${u.host}${nextUrl}`;
        }
        return fetchJson(nextUrl, redirectCount + 1).then(resolve);
      }

      if (res.statusCode !== 200) {
        console.warn(`[HTTP Error ${res.statusCode}] ${url}`);
        return resolve(null);
      }

      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          console.warn(`[JSON Parse Fail] ${url}: ${e.message}`);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      console.warn(`[Network Fail] ${url}: ${e.message}`);
      resolve(null);
    });

    req.setTimeout(10000, () => {
      req.destroy();
      resolve(null);
    });
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
  console.log(`[Scrape] 公式API (${year}年${month}月) を取得中...`);
  const daysInMonth = new Date(year, month, 0).getDate();
  const froms = [];
  for (let d = 1; d <= daysInMonth; d += 7) froms.push(fmt(new Date(year, month - 1, d)));

  const byShop = SHOPS.map(() => ({}));
  let shopNames = SHOPS.map(s => s.label);

  for (const from of froms) {
    const primaryUrl = `https://api.489pro-x.com/api_public/anshinoyado/group/facility/calendar?lang=1&from=${from}&num=1`;
    let j = await fetchJson(primaryUrl);
    
    if (!j || !j.res || !j.res.facility_list) {
      const backupUrl = `https://api.489pro.com/api_public/anshinoyado/group/facility/calendar?lang=1&from=${from}&num=1`;
      j = await fetchJson(backupUrl);
    }

    if (!j || !j.res || !j.res.facility_list) {
      console.warn(`[Official API] Data missing for ${from}`);
      continue;
    }
    
    j.res.facility_list.forEach((f, idx) => {
      if (idx >= SHOPS.length) return;
      if (f.name) shopNames[idx] = f.name;
      for (const x of (f.date_list || [])) {
        if (x.date && x.date.startsWith(`${year}-${String(month).padStart(2, '0')}`)) {
          byShop[idx][x.date] = { sales_type: x.sales_type, stock_num: x.stock_num };
        }
      }
    });
    await new Promise(r => setTimeout(r, 150));
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

function getTargetMonths() {
  const now = new Date();
  const targetMonths = [];
  for (let i = 0; i <= 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    targetMonths.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }
  return targetMonths;
}

async function main() {
  const targetMonths = getTargetMonths();
  console.log(`🚀 合計 ${targetMonths.length} ヶ月分（${targetMonths[0].year}/${targetMonths[0].month} 〜 ${targetMonths[targetMonths.length-1].year}/${targetMonths[targetMonths.length-1].month}）のデータを取得します。`);

  const browser = await chromium.launch({ headless: true });
  const monthsData = [];
  const sites = ['rakuten', 'jalan', 'yahoo', 'rurubu', 'booking'];

  try {
    for (const { year, month } of targetMonths) {
      console.log(`\n-----------------------------------`);
      console.log(`📅 【${year}年${month}月】処理開始`);
      
      const officialData = await fetchOfficialMonth(year, month);
      const sitesData = {};
      
      for (const site of sites) {
        sitesData[site] = await checkSite(site, year, month, browser);
      }

      monthsData.push({
        year,
        month,
        official: officialData,
        sites: sitesData
      });
    }

    const finalData = {
      updatedAt: new Date().toISOString(),
      months: monthsData
    };

    if (!fs.existsSync('docs')) fs.mkdirSync('docs');
    fs.writeFileSync(path.join('docs', 'data.json'), JSON.stringify(finalData, null, 2));
    
    console.log('\n✅ 全月データの取得・保存が完了しました: docs/data.json');
  } catch(e) {
    console.error('❌ エラー発生:', e);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
