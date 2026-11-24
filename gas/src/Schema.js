/**
 * 資料模型：imPR 公司系統的全部資料表。一份試算表、一張表一個分頁。
 *
 * 欄位寫成 'name:type!' 字串：! 代表必填，型別省略就是 text。用短寫法是因為表很多，
 * 物件寫法會讓整份 schema 長到看不出每張表有哪些欄位。
 *
 * 型別決定讀寫轉換（見 Repository.js）：
 * - text / date / datetime 在 Sheet 上設成純文字格式，否則 Sheets 會把日期、ISO 時間自動轉成 Date，
 *   讀回來不等於原字串，樂觀鎖比對 updated_at 就會永遠失敗；電話也會被吃掉開頭的 0。
 * - date 存 yyyy-MM-dd，datetime 存 ISO 8601（UTC）。
 */

const COLUMN_TYPES = {
  TEXT: 'text',
  DATE: 'date',
  DATETIME: 'datetime',
  NUMBER: 'number',
  BOOL: 'bool',
};

const TEXT_FORMAT_TYPES_ = [COLUMN_TYPES.TEXT, COLUMN_TYPES.DATE, COLUMN_TYPES.DATETIME];

// 這些欄位只能由 Repository 寫入，呼叫端傳進來就拒絕，免得有人以為自己能改 id 或稽核欄位。
const SYSTEM_COLUMNS = ['id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'is_deleted'];

const AUDIT_COLUMNS_ = [
  { name: 'created_at', type: COLUMN_TYPES.DATETIME },
  { name: 'created_by', type: COLUMN_TYPES.TEXT },
  { name: 'updated_at', type: COLUMN_TYPES.DATETIME },
  { name: 'updated_by', type: COLUMN_TYPES.TEXT },
  { name: 'is_deleted', type: COLUMN_TYPES.BOOL },
];

const TYPE_ALIASES_ = { text: 'text', date: 'date', dt: 'datetime', num: 'number', bool: 'bool' };

function cols_(spec) {
  return spec.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const required = s.endsWith('!');
    const [name, t] = (required ? s.slice(0, -1) : s).split(':');
    const type = TYPE_ALIASES_[t || 'text'];
    if (!type) throw new Error('未知的欄位型別：' + s);
    return required ? { name, type, required: true } : { name, type };
  });
}

/**
 * cache: true 只給很少變動的主資料（供應商、範本、假日、設定）。
 * 交易資料不快取：檔期衝突、預算數字、打卡讀到舊值會直接造成業務事故。
 */
const TABLES = {
  // ---- 人員與往來對象 ----
  // 帳號、密碼、角色在帳號中心；這裡是人事資料，account 對應帳號中心，派遣人員的合約也在這裡；時薪不放人員資料，排班時逐筆填。
  people: { prefix: 'per', cache: true, columns: cols_(
    'account!, name!, email, dept, manager_account, kind!, phone, region, ' +
    'contract_start:date, contract_end:date, rating:num, active:bool, note, ' +
    // 帳號中心 office 欄的角色；空白代表還沒開通，登入新系統會被擋
    'office_role') },
  clients: { prefix: 'cli', cache: true, columns: cols_(
    'name!, tax_id, industry, address, phone, website, owner_account, tags, note, ' +
    // 主要窗口直接放在客戶資料上，打開客戶就看得到；其他聯絡人放 contacts。
    'contact_name, contact_title, contact_phone, contact_mobile, contact_email') },
  contacts: { prefix: 'con', cache: false, columns: cols_(
    'client_id, supplier_id, name!, title, phone, email, note') },
  client_activities: { prefix: 'cac', cache: false, columns: cols_(
    'client_id!, project_id, activity_date:date!, kind, summary!, owner_account') },
  suppliers: { prefix: 'sup', cache: true, columns: cols_(
    'name!, category, service_items, tax_id, contact_name, contact_phone, contact_email, note, ' +
    'avg_rating:num, rating_count:num, phone, address, business_hours, website') },
  supplier_bookings: { prefix: 'bkg', cache: false, columns: cols_(
    'supplier_id!, project_id!, start_date:date!, end_date:date!, status!, note') },
  supplier_ratings: { prefix: 'srt', cache: false, columns: cols_(
    'supplier_id!, project_id!, score:num!, comment') },

  // ---- 標案與專案 ----
  tenders: { prefix: 'tnd', cache: false, columns: cols_(
    'title!, agency!, tender_no, source_url, budget_amount:num, announce_date:date, deadline_date:date, ' +
    'opening_date:date, owner_account, status!, decision_note, bid_bond:num, documents, bid_amount:num, ' +
    'award_amount:num, competitors, result_note, project_id') },
  // code 沿用活動總表的 EVT-年度-流水號，同仁已經習慣用它溝通。
  projects: { prefix: 'prj', cache: true, columns: cols_(
    'code!, name!, client_id, client_name, project_type, venue, start_date:date, end_date:date, ' +
    'pm_account, stage!, tender_id, contract_amount:num, margin_threshold:num, margin_alert:bool, ' +
    'quote_total:num, cost_estimate_total:num, cost_actual_total:num, margin_rate:num, ' +
    'drive_folder_url, success_notes, improve_notes, ' +
    // 客戶窗口（姓名、職稱、電話或 Email）
    'client_contact, client_contact_title, client_contact_info, ' +
    // 報價單審核：草稿 → 送審中 → 已核定（主管核定後鎖住，要改請主管退回成草稿）；退回 = 主管要求修改
    'quote_status, quote_submitted_at:dt, quote_approved_by, quote_approved_at:dt, quote_review_note, ' +
    'quote_approved_total:num, cost_approved_total:num, quote_date:date, quote_valid_until:date, quote_terms') },
  // 欄位對應追蹤表「工作進度」：每天只需更新狀態、最新進度、下一步、卡關原因。
  project_tasks: { prefix: 'tsk', cache: false, columns: cols_(
    'project_id!, code, category, title!, owner_account, assistant_account, start_date:date, due_date:date, ' +
    'priority, status!, progress_note, next_step, blocker, waiting_on, last_update_at:dt, done_at:dt, ' +
    'meeting_id, note') },
  // offset_days 以活動日為 T 日，T-60 存 -60。
  task_templates: { prefix: 'tpl', cache: true, columns: cols_(
    'category!, title!, offset_days:num!, priority, role, done_criteria, tip, sort:num, ' +
    // 適用的活動類型（頓號分隔）；空白＝所有類型都套用
    'project_types') },
  meetings: { prefix: 'mtg', cache: false, columns: cols_(
    'project_id, title!, meeting_date:date!, attendees, notes') },

  // ---- 預算、毛利、費用 ----
  budget_lines: { prefix: 'bdl', cache: false, columns: cols_(
    'project_id!, category!, item!, quote_amount:num, cost_estimate:num, cost_actual:num, supplier_id, ' +
    'source, note, ' +
    // 報價單欄位：總價 = 單價 × 數量；quote_amount（對客戶的金額）= 優惠價，沒有優惠價就是總價
    'spec, description, unit_price:num, quantity:num, unit, discount_price:num') },
  // 報價參考：公司估算單價（vendor_name 空白）與各廠商報價，做預算時帶入。
  price_refs: { prefix: 'prc', cache: false, columns: cols_(
    'item!, type, vendor_name, supplier_id, unit_price:num, unit, note, quoted_at:date, ' +
    // 對客戶報價參考單價（填在公司估算那一列）；做預算時帶入「報價」欄
    'quote_price:num') },
  project_changes: { prefix: 'chg', cache: false, columns: cols_(
    'project_id!, kind!, description!, quote_delta:num, cost_delta:num, change_date:date, note') },
  expense_claims: { prefix: 'exp', cache: false, columns: cols_(
    'claimant_account!, project_id, budget_line_id, dept, category!, description!, amount:num!, ' +
    'receipt_date:date, receipt_no, receipt_url, payee, supplier_id, status!, submitted_at:dt, ' +
    'approver_account, approved_at:dt, review_note, paid_by, paid_at:dt, pay_note, ' +
    // 付款對象名稱（清單沒有的廠商申請時直接填，會自動加進供應商）與匯款資料；公司卡支付時不用填
    'payee_name, payee_bank') },

  // ---- 考勤 ----
  // punch：IN 上班 / OUT 下班；punch_time 是台北時間 HH:mm:ss，遲到早退以它判斷。
  attendance: { prefix: 'att', cache: false, columns: cols_(
    'account!, work_date:date!, punch!, punch_time!, mode!, ip, device_key, location, lat:num, lng:num, ' +
    'reason, project_id, status!, flag, over_min:num, reviewer_account, review_note, reviewed_at:dt') },
  leaves: { prefix: 'lev', cache: false, columns: cols_(
    'account!, leave_type!, start_date:date!, start_time!, end_date:date!, end_time!, hours:num, reason!, status!, ' +
    'approver_account, review_note, reviewed_at:dt') },
  overtime: { prefix: 'ovt', cache: false, columns: cols_(
    'account!, work_date:date!, plan_start!, plan_end!, reason!, project_id, status!, approver_account, ' +
    'review_note, reviewed_at:dt, actual_hours:num') },
  corrections: { prefix: 'cor', cache: false, columns: cols_(
    'account!, work_date:date!, punch!, request_time!, reason!, status!, approver_account, ' +
    'review_note, reviewed_at:dt') },
  // kind：HOLIDAY 放假、WORKDAY 補班；沒列的日子依週一至週五判斷。
  holidays: { prefix: 'hol', cache: true, columns: cols_('holiday_date:date!, name!, kind!') },
  devices: { prefix: 'dev', cache: true, columns: cols_('device_key!, name, registered_by, active:bool') },

  // ---- 派遣 ----
  dispatch_assignments: { prefix: 'dsp', cache: false, columns: cols_(
    'account!, project_id!, start_date:date!, end_date:date!, role, hourly_wage:num, status!, note') },
  dispatch_reports: { prefix: 'dsr', cache: false, columns: cols_(
    'account!, project_id, report_date:date!, content!, hours:num') },
  dispatch_issues: { prefix: 'dsi', cache: false, columns: cols_(
    'account!, project_id, title!, detail, status!, reply') },

  // ---- 工時 ----
  timesheets: { prefix: 'tms', cache: false, columns: cols_(
    'account!, week_start:date!, project_id, hours:num!, overtime_reason, blocker') },

  // ---- 資材與知識 ----
  // 資材：kind 資產／耗材；track_mode 逐台（每台一筆 inventory_units）／整批（只記數量）。
  // 整批資產的 quantity 是總數；耗材的 quantity 是目前庫存（領用扣、入庫加）；逐台的數量由 units 算，不看 quantity。
  inventory: { prefix: 'inv', cache: false, columns: cols_(
    'name!, category, quantity:num, unit, location, manager_account, photo_url, note, ' +
    'kind, track_mode, spec, safety_stock:num, ' +
    // code：資材編號（R-0001 起自動給，可改）；photo：瀏覽器壓縮後的小圖（data URL，約 30KB 內），photo_url 放原圖連結
    'code, photo, ' +
    // 需定期保養：勾選後依週期（天）算下次保養日；maintenance_note 寫要保養什麼（例如：電池充放電、鏡頭清潔）
    'needs_maintenance:bool, maintenance_cycle_days:num, maintenance_note') },
  inventory_units: { prefix: 'inu', cache: false, columns: cols_(
    'inventory_id!, asset_tag!, serial_no, status!, location, purchase_date:date, cost:num, warranty_until:date, note, ' +
    // 這一台的保管人（例如配給某同仁的筆電）；空白就由資材的保管人負責
    'custodian_account') },
  loans: { prefix: 'lon', cache: false, columns: cols_(
    'inventory_id!, borrower_account!, project_id, quantity:num!, loan_date:date!, due_date:date, ' +
    'returned_at:dt, status!, note, unit_ids') },
  // 工讀生名冊（不一定有系統帳號）；合作紀錄每次活動一筆，含評價。
  part_timers: { prefix: 'ptm', cache: false, columns: cols_(
    'name!, phone, mobile, email, line_id, region, school, skills, languages, status, account, note') },
  part_timer_jobs: { prefix: 'ptj', cache: false, columns: cols_(
    'part_timer_id!, project_id, work_date:date!, role, rating:num, comment, rated_by') },
  // 耗材進出紀錄：入庫、領用、盤點調整。balance 是異動後庫存，方便對帳。
  stock_moves: { prefix: 'stm', cache: false, columns: cols_(
    'inventory_id!, kind!, quantity:num!, balance:num, project_id, account, move_date:date!, note') },
  // 保養紀錄：每次保養、檢查、維修一筆；逐台的可記是哪幾台（unit_ids）。next_due_date 空白時依週期推算。
  maintenance_logs: { prefix: 'mnt', cache: false, columns: cols_(
    'inventory_id!, unit_ids, maint_date:date!, kind!, performer_account, vendor, content!, cost:num, result, next_due_date:date, note') },
  sops: { prefix: 'sop', cache: false, columns: cols_(
    'title!, category, version, effective_date:date, status!, file_url, project_types, note') },
  media: { prefix: 'med', cache: false, columns: cols_(
    'outlet!, name, title, beat, phone, mobile, email, line_id, last_contact:date, note') },
  cases: { prefix: 'cas', cache: false, columns: cols_(
    'title!, client_name, year, category, summary, link, project_id') },
  // 帳密大全：只有 admin 讀得到（見 ResourceService）。
  credentials: { prefix: 'crd', cache: false, columns: cols_(
    'service!, url, username, password, owner, note, category') },

  // ---- AI 與系統 ----
  ai_jobs: { prefix: 'aij', cache: false, columns: cols_(
    'kind!, project_id, prompt, output, output_url, model, input_tokens:num, output_tokens:num, status!, error') },
  reminder_log: { prefix: 'rmd', cache: false, columns: cols_(
    'account!, ref_id, reason, sent_on:date!') },
  audit_log: { prefix: 'aud', cache: false, columns: cols_('action!, entity, entity_id, detail') },
  settings: { prefix: 'set', cache: true, columns: cols_('key!, value, note') },
};

// 分頁名稱就是表名；集中在這裡設定，避免 Repository 和 Setup 各自猜。
Object.keys(TABLES).forEach(name => { TABLES[name].sheet = name; });

// 欄位順序：id、業務欄位、稽核欄位。實際讀寫依表頭名稱對應，手動調整欄位順序不會壞。
function tableColumns_(def) {
  return [{ name: 'id', type: COLUMN_TYPES.TEXT, required: true }]
    .concat(def.columns)
    .concat(AUDIT_COLUMNS_);
}
