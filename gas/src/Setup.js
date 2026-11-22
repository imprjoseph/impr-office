/**
 * 建立資料庫與資料表。setupDatabase 從 Apps Script 編輯器手動執行一次；之後欄位變動由 ensureSchema_ 自動補。
 */

// 預設設定：可以在 settings 分頁直接改。
const DEFAULT_SETTINGS_ = [
  ['margin_threshold', '0.2', '專案毛利率低於這個比例就標示毛利警示（0.2 = 20%）'],
  ['remind_due_days', '3', '工作截止前幾天開始提醒'],
  ['remind_stale_days', '3', '工作幾天沒更新就提醒'],
  ['remind_cooldown_days', '2', '同一件工作提醒後隔幾天才再提醒'],
  ['escalate_overdue_days', '3', '逾期幾天後副本給主管'],
  ['work_start', '09:00', '上班時間（遲到判斷）'],
  ['work_end', '18:30', '下班時間（早退判斷）'],
  ['lunch_start', '12:00', '午休開始（請假、加班時數扣除）'],
  ['lunch_end', '13:30', '午休結束'],
  ['flex_min', '30', '彈性上班分鐘數：晚到幾分鐘就晚走幾分鐘'],
  ['ot_threshold_min', '30', '超過應下班時間幾分鐘才算延時'],
  ['ot_unit_hours', '0.5', '加班時數計算單位（小時，無條件捨去）'],
  ['office_ips', '', '辦公室對外 IP，多個用逗號分隔；IP 與登記設備都符合才算辦公室打卡'],
  ['openai_image_model', 'gpt-image-1', 'AI 平面設計用的 OpenAI GPT 生圖模型名稱；OpenAI 推出新版時改這裡'],
  ['inventory_categories', '3C、錄音設備、音響設備、攝影器材、投影簡報、影音轉接、通訊設備、電力照明、展架、儀式、工具、報到設備、現場用品、文具、印刷耗材、電池、包材、清潔用品、其他',
    '資材的中項分類（用頓號分隔）；資產、耗材共用這份清單，要新增或改名直接改這裡'],
  ['quote_markup', '0', '報價參考沒填「對客戶報價」時，用成本加成多少當參考報價（0.3 = 加 30%；0 = 不自動加成）'],
  ['ai_monthly_token_limit', '2000000', 'AI 每月 token 用量上限，超過就暫停 AI 功能'],
];

/**
 * 第一次部署時執行：沒有資料庫就建一份新的試算表，建立全部分頁並寫入預設設定。可重複執行。
 */
function setupDatabase() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SHEET_ID')) {
    const ss = SpreadsheetApp.create('imPR 公司系統資料庫');
    props.setProperty('SHEET_ID', ss.getId());
  }
  spreadsheet_ = null;
  const report = withScriptLock_(() => {
    const r = setupSheets();
    seedSettings_();
    seedHolidays_();
    return r;
  });
  props.setProperty('SCHEMA_SIGNATURE', schemaSignature_());
  console.log('資料庫：https://docs.google.com/spreadsheets/d/' + props.getProperty('SHEET_ID') + '/edit');
  return report;
}

/** 建立全部分頁與表頭。已存在的分頁只補缺少的欄位、不刪不改既有資料。 */
function setupSheets() {
  const ss = getSpreadsheet_();
  const result = Object.keys(TABLES).map(name => ensureSheet_(ss, TABLES[name]));
  ensureTemplateSeed_();
  return result;
}

function schemaSignature_() {
  return Object.keys(TABLES).map(n => n + ':' + tableColumns_(TABLES[n]).map(c => c.name).join(',')).join('|');
}

/**
 * 欄位定義改變後自動補欄位：每次請求比對 schema 簽章，不同才執行 setupSheets。
 * 升級程式後不必記得手動跑，否則新欄位缺漏時整個模組都會讀取失敗。
 */
/** 基本事項與各類型參考工作項目：版本變了才補（只補缺的），之後以主管在工作範本增修的為準。 */
function ensureTemplateSeed_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('TEMPLATE_SEED_VERSION') === TEMPLATE_SEED_VERSION_) return;
  withScriptLock_(() => { retireOldTemplates_(); seedTypeTemplates_('system'); });
  props.setProperty('TEMPLATE_SEED_VERSION', TEMPLATE_SEED_VERSION_);
}

function ensureSchema_() {
  const props = PropertiesService.getScriptProperties();
  const signature = schemaSignature_();
  if (props.getProperty('SCHEMA_SIGNATURE') === signature) { ensureTemplateSeed_(); return false; }
  // 升級時補欄位，也補新加入的設定值（只補沒有的，不動管理者改過的）
  withScriptLock_(() => { setupSheets(); seedSettings_(); });
  props.setProperty('SCHEMA_SIGNATURE', signature);
  return true;
}

function seedSettings_() {
  const existing = repo_('settings').findAll().map(s => s.key);
  const rows = DEFAULT_SETTINGS_.filter(([key]) => existing.indexOf(key) === -1)
    .map(([key, value, note]) => ({ key, value, note }));
  if (rows.length) repo_('settings').insertMany(rows, 'system');
}

function ensureSheet_(ss, def) {
  const columns = tableColumns_(def);
  let sheet = ss.getSheetByName(def.sheet);
  const created = !sheet;
  if (created) sheet = ss.insertSheet(def.sheet);
  const lastColumn = sheet.getLastColumn();
  const header = lastColumn
    ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(h => String(h).trim())
    : [];
  const missing = columns.filter(c => header.indexOf(c.name) === -1).map(c => c.name);
  if (missing.length) {
    // 缺的欄位一律補在最右邊：Repository 依表頭名稱對應，不需要移動既有欄位。
    sheet.getRange(1, header.length + 1, 1, missing.length).setValues([missing]);
    missing.forEach(name => header.push(name));
  }
  const textRanges = columns
    .filter(c => TEXT_FORMAT_TYPES_.indexOf(c.type) !== -1)
    .map(c => {
      const letter = columnLetter_(header.indexOf(c.name) + 1);
      return letter + ':' + letter;
    });
  if (textRanges.length) sheet.getRangeList(textRanges).setNumberFormat('@');
  if (created) sheet.setFrozenRows(1);
  return { table: def.sheet, created, addedColumns: missing };
}

/** 讀設定值；settings 分頁沒有就用預設值。 */
function setting_(key) {
  const row = repo_('settings').findAll().find(s => s.key === key);
  if (row && row.value !== null) return row.value;
  const d = DEFAULT_SETTINGS_.find(([k]) => k === key);
  return d ? d[1] : null;
}

/** 行政院人事行政總處 115、116 年辦公日曆表中落在週一至週五的放假日（沿用舊出勤系統）。 */
const HOLIDAYS_SEED_ = [
  ['2026-01-01', '開國紀念日'], ['2026-02-16', '除夕'], ['2026-02-17', '春節'], ['2026-02-18', '春節'], ['2026-02-19', '春節'],
  ['2026-02-20', '春節補假'], ['2026-02-27', '和平紀念日補假'], ['2026-04-03', '兒童節補假'], ['2026-04-06', '清明節補假'],
  ['2026-05-01', '勞動節'], ['2026-06-19', '端午節'], ['2026-09-25', '中秋節'], ['2026-09-28', '教師節'],
  ['2026-10-09', '國慶日補假'], ['2026-10-26', '臺灣光復暨金門古寧頭大捷紀念日補假'], ['2026-12-25', '行憲紀念日'],
  ['2027-01-01', '開國紀念日'], ['2027-02-04', '小年夜'], ['2027-02-05', '除夕'], ['2027-02-08', '春節補假'],
  ['2027-02-09', '春節補假'], ['2027-02-10', '春節補假'], ['2027-03-01', '和平紀念日補假'], ['2027-04-05', '清明節'],
  ['2027-04-06', '兒童節補假'], ['2027-04-30', '勞動節補假'], ['2027-06-09', '端午節'], ['2027-09-15', '中秋節'],
  ['2027-09-28', '教師節'], ['2027-10-11', '國慶日補假'], ['2027-10-25', '臺灣光復暨金門古寧頭大捷紀念日'],
  ['2027-12-24', '行憲紀念日補假'], ['2027-12-31', '開國紀念日補假'],
];

function seedHolidays_() {
  const existing = repo_('holidays').findAll().map(h => h.holiday_date);
  const rows = HOLIDAYS_SEED_.filter(([d]) => existing.indexOf(d) === -1)
    .map(([holiday_date, name]) => ({ holiday_date, name, kind: 'HOLIDAY' }));
  if (rows.length) repo_('holidays').insertMany(rows, 'system');
}
