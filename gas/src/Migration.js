/**
 * 搬舊資料：從各舊系統的試算表讀取，寫進新資料庫。從 Apps Script 編輯器手動執行：
 * - migrateDryRun()：只讀不寫，列出每一步會新增幾筆、略過幾筆（已存在）、哪些人名對不上。
 * - migrateAll()：真的寫入。可重複執行：每張表用自然鍵（活動編號、工作編號、名稱、打卡日＋上下班…）判斷已存在就略過，
 *   所以切換日再跑一次只會補上試用期間舊系統新增的資料。
 *
 * 執行前：
 * 1. 在新系統「人員」頁按「從帳號中心同步」：舊資料的負責人要對應到新系統的帳號。
 * 2. 舊系統的試算表 ID 填在 Script Properties（下方 MIGRATION_SOURCES_ 已知的不用填）。
 */

// 已知的舊資料庫。出勤、CRM 綁在各自的試算表，ID 要從網址複製到 Script Properties。
const MIGRATION_SOURCES_ = {
  tracker: { label: '活動進度追蹤表', id: '1Fckp1WwVp8WM7d3tuu-yNyXviDVBn1zr0huhHiJTAP8' },
  resource: { label: '物資系統', id: '1k6Hq11F4LUt73e2fSIi1iV4RhHQmFg36N-2TQ3H-S74' },
  eventops: { label: '活動與任務追蹤（event-ops）', id: '1ys8mvLU44otmToYvjPrAaPWciiRCY_Vpq2reJxQADzM' },
  // 出勤、CRM 已在雲端硬碟找到；Script Properties 有填就以屬性為準。
  attendance: { label: '公司同仁出勤', prop: 'OLD_ATTENDANCE_SHEET_ID', id: '1ClgEtJGbR02L5gMGUx6PGqOz9B2jlWDHtn4xHTFmf5U' },
  crm: { label: '客戶與供應商管理（CRM）', prop: 'OLD_CRM_SHEET_ID', id: '1IUEnDVRdyJY8hCI4X4TdHGWCNffVdHG8XxiKG3PYvH0' },
};

function migrateDryRun() {
  const report = runMigration_(true);
  console.log(formatMigrationReport_(report));
  return report;
}

function migrateAll() {
  const report = runMigration_(false);
  console.log(formatMigrationReport_(report));
  return report;
}

function runMigration_(dry) {
  const people = repo_('people').findAll();
  if (!people.length) throw new Error('新系統還沒有人員資料：請先在「人員」頁按「從帳號中心同步」，舊資料的負責人才對得上帳號');
  const m = new MigrationContext_(dry, people);
  const steps = [
    ['工作範本', () => migrateTemplates_(m)],
    ['專案（活動總表）', () => migrateTrackerProjects_(m)],
    ['工作（工作進度）', () => migrateTrackerTasks_(m)],
    ['供應商', () => migrateSuppliers_(m)],
    ['標案', () => migrateTenders_(m)],
    ['客戶、聯絡人、往來紀錄', () => migrateCrm_(m)],
    ['資材、SOP、媒體、案例、帳密、派遣名冊', () => migrateResource_(m)],
    ['考勤', () => migrateAttendance_(m)],
  ];
  steps.forEach(([name, fn]) => {
    try {
      fn();
    } catch (e) {
      m.note(name, '失敗：' + (e && e.message ? e.message : e));
    }
  });
  m.note('派遣勤務（PT-member）、工時週報', '舊系統欄位與新系統差異大，未自動搬；切換後從新系統開始記錄，舊紀錄保留在原試算表供查詢');
  return m.report;
}

function migrationSourceId_(key) {
  const src = MIGRATION_SOURCES_[key];
  return (src.prop && PropertiesService.getScriptProperties().getProperty(src.prop)) || src.id || null;
}

/**
 * 從網頁「系統設定 → 搬舊資料」執行（只有 admin）。新系統還沒有人員時先自動從帳號中心同步，
 * 舊資料的負責人才對得上帳號。
 */
const MigrationService = {
  status() {
    return {
      people: repo_('people').findAll().length,
      sources: Object.keys(MIGRATION_SOURCES_).map(key => {
        const id = migrationSourceId_(key);
        return { key, label: MIGRATION_SOURCES_[key].label, id, url: id ? 'https://docs.google.com/spreadsheets/d/' + id + '/edit' : null };
      }),
    };
  },

  run(dry, ctx) {
    let synced = null;
    if (!repo_('people').findAll().length) synced = PeopleService.syncFromAccountCenter(ctx);
    const report = runMigration_(!!dry);
    return { dry: !!dry, synced, report, text: formatMigrationReport_(report) };
  },
};

function migrationRoutes_() {
  const admin = [ROLES.ADMIN];
  return {
    'migration.status': { roles: admin, handler: () => MigrationService.status() },
    'migration.run': { roles: admin, handler: (p, ctx) => MigrationService.run(p.dry !== false, ctx) },
  };
}

class MigrationContext_ {
  constructor(dry, people) {
    this.dry = dry;
    this.report = [];
    this.unresolved = {};
    this.byEmail = {};
    this.byName = {};
    people.forEach(p => {
      if (p.email) this.byEmail[p.email.toLowerCase()] = p.account;
      this.byName[normName_(p.account)] = p.account;
      this.byName[normName_(p.name)] = p.account;
    });
  }

  /** 舊資料的人：email 優先，再比帳號、姓名（忽略大小寫空白）。對不上的記進報告，欄位留空。 */
  person(value, step) {
    const v = String(value || '').trim();
    if (!v) return null;
    const hit = this.byEmail[v.toLowerCase()] || this.byName[normName_(v)];
    if (!hit) (this.unresolved[step] = this.unresolved[step] || {})[v] = true;
    return hit || null;
  }

  open(key) {
    const src = MIGRATION_SOURCES_[key];
    const id = migrationSourceId_(key);
    if (!id) return null;
    return SpreadsheetApp.openById(id);
  }

  /** 讀一個分頁成物件陣列；表頭不一定在第 1 列（追蹤表上面有標題），用 keyHeader 找表頭列。 */
  rows(ss, sheetName, keyHeader) {
    const sheet = ss && ss.getSheetByName(sheetName);
    if (!sheet) return [];
    const values = sheet.getDataRange().getValues();
    const hi = keyHeader ? values.findIndex(r => r.some(v => String(v).trim() === keyHeader)) : 0;
    if (hi === -1) return [];
    const header = values[hi].map(h => String(h).trim());
    return values.slice(hi + 1).filter(r => r.some(v => v !== '' && v !== null)).map(r => {
      const o = {};
      header.forEach((h, i) => { if (h) o[h] = r[i]; });
      return o;
    });
  }

  /** 寫入（或試跑時只計數）。keyOf 判斷已存在；回傳實際（或預計）新增的列。 */
  insert(step, table, records, keyOf) {
    const existing = {};
    repo_(table).findAll().forEach(r => { existing[keyOf(r)] = true; });
    const fresh = [];
    let skipped = 0;
    records.forEach(r => {
      const k = keyOf(r);
      if (!k || existing[k]) { skipped++; return; }
      existing[k] = true;
      fresh.push(r);
    });
    let saved = fresh;
    if (!this.dry && fresh.length) saved = withScriptLock_(() => repo_(table).insertMany(fresh, 'migration'));
    this.report.push({ step, table, read: records.length, insert: fresh.length, skipped,
      unresolved: Object.keys(this.unresolved[step] || {}) });
    return saved;
  }

  note(step, text) {
    this.report.push({ step, note: text });
  }
}

function cellDate_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (isDate_(v)) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const m = String(v).match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})/);
  return m ? m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : null;
}

function cellDateTime_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (isDate_(v)) return v.toISOString();
  const t = Date.parse(v);
  return isNaN(t) ? null : new Date(t).toISOString();
}

function cellTime_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (isDate_(v)) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'HH:mm:ss');
  const m = String(v).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  return m ? ('0' + m[1]).slice(-2) + ':' + m[2] + ':' + (m[3] || '00') : null;
}

function cellText_(v) {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s || null;
}

function cellNum_(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[,\s元]/g, ''));
  return isFinite(n) ? n : null;
}

// ---------------- 活動進度追蹤表 ----------------

/** 期限基準「T-60」「T+14」「T」轉成天數。 */
function parseOffset_(v) {
  const m = String(v || '').replace(/\s/g, '').match(/^T([+-]\d+)?$/i);
  return m ? Number(m[1] || 0) : null;
}

function migrateTemplates_(m) {
  const rows = m.rows(m.open('tracker'), '活動工作範本', '工作分類');
  const records = rows.map((r, i) => ({
    category: cellText_(r['工作分類']), title: cellText_(r['標準工作項目']), offset_days: parseOffset_(r['期限基準']),
    priority: TASK_PRIORITIES.indexOf(cellText_(r['預設重要性'])) !== -1 ? cellText_(r['預設重要性']) : '中',
    role: cellText_(r['建議負責角色']), done_criteria: cellText_(r['完成判斷']), tip: cellText_(r['實務提醒']), sort: i + 1,
  })).filter(r => r.category && r.title && r.offset_days !== null);
  m.insert('工作範本', 'task_templates', records, r => normName_(r.category + '|' + r.title));
}

function migrateTrackerProjects_(m) {
  const step = '專案（活動總表）';
  const rows = m.rows(m.open('tracker'), '活動總表', '活動編號');
  const records = rows.filter(r => /^EVT-/.test(String(r['活動編號']))).map(r => ({
    code: cellText_(r['活動編號']), name: cellText_(r['活動名稱']) || cellText_(r['活動編號']), client_name: cellText_(r['客戶／主辦單位']),
    start_date: cellDate_(r['活動日期']), end_date: cellDate_(r['活動日期']), pm_account: m.person(r['PM'], step),
    stage: PROJECT_STAGES.indexOf(cellText_(r['執行階段'])) !== -1 ? cellText_(r['執行階段']) : '規劃中',
    success_notes: cellText_(r['成功經驗']), improve_notes: cellText_(r['待改進事項']),
  }));
  m.insert(step, 'projects', records, r => r.code);
}

function migrateTrackerTasks_(m) {
  const step = '工作（工作進度）';
  const projectByCode = {};
  repo_('projects').findAll().forEach(p => { projectByCode[p.code] = p.id; });
  // 試跑時專案還沒真的寫入：活動總表上有的編號先用暫時的 id 對應，筆數才算得準。
  if (m.dry) {
    m.rows(m.open('tracker'), '活動總表', '活動編號').forEach(r => {
      const code = cellText_(r['活動編號']);
      if (code && !projectByCode[code]) projectByCode[code] = 'pending:' + code;
    });
  }
  const rows = m.rows(m.open('tracker'), '工作進度', '工作編號');
  let orphan = 0;
  const records = rows.filter(r => /^T-/.test(String(r['工作編號']))).map(r => {
    const code = cellText_(r['活動編號']);
    const projectId = projectByCode[code] || null;
    if (!projectId) { orphan++; return null; }
    const status = TASK_STATUSES.indexOf(cellText_(r['狀態'])) !== -1 ? cellText_(r['狀態']) : '未開始';
    return {
      project_id: projectId, code: cellText_(r['工作編號']), category: cellText_(r['工作分類']), title: cellText_(r['工作項目']) || '（未命名工作）',
      owner_account: m.person(r['負責人Email'] || r['負責人'], step), assistant_account: m.person(r['協辦人'], step),
      start_date: cellDate_(r['開始日']), due_date: cellDate_(r['截止日']),
      priority: TASK_PRIORITIES.indexOf(cellText_(r['重要性'])) !== -1 ? cellText_(r['重要性']) : '中', status,
      progress_note: cellText_(r['最新進度']), next_step: cellText_(r['下一步']), blocker: cellText_(r['卡關原因']),
      waiting_on: cellText_(r['等待對象']), last_update_at: cellDateTime_(r['最後更新日']), done_at: cellDateTime_(r['完成日']),
      note: cellText_(r['備註']),
    };
  }).filter(Boolean);
  m.insert(step, 'project_tasks', records, r => r.code);
  if (orphan) m.note(step, orphan + ' 筆工作找不到對應的活動編號，未搬');
}

// ---------------- event-ops 與 CRM ----------------

function migrateSuppliers_(m) {
  const records = m.rows(m.open('eventops'), 'suppliers').filter(r => r.is_deleted !== true && String(r.is_deleted).toUpperCase() !== 'TRUE').map(r => ({
    name: cellText_(r.name), category: cellText_(r.category), service_items: cellText_(r.service_items), tax_id: cellText_(r.tax_id),
    contact_name: cellText_(r.contact_name), contact_phone: cellText_(r.contact_phone), contact_email: cellText_(r.contact_email), note: cellText_(r.note),
  }));
  m.rows(m.open('crm'), 'Vendors').forEach(r => records.push({
    name: cellText_(r.name), category: cellText_(r.category), tax_id: cellText_(r.taxId), contact_name: cellText_(r.contactName),
    contact_phone: cellText_(r.contactPhone), contact_email: cellText_(r.contactEmail), note: cellText_(r.notes),
  }));
  m.insert('供應商', 'suppliers', records.filter(r => r.name), r => normName_(r.name));
}

function migrateTenders_(m) {
  const step = '標案';
  const records = m.rows(m.open('eventops'), 'tenders').filter(r => String(r.is_deleted).toUpperCase() !== 'TRUE').map(r => ({
    title: cellText_(r.title), agency: cellText_(r.agency), tender_no: cellText_(r.tender_no), source_url: cellText_(r.source_url),
    budget_amount: cellNum_(r.budget_amount), announce_date: cellDate_(r.announce_date), deadline_date: cellDate_(r.deadline_date),
    opening_date: cellDate_(r.opening_date), owner_account: m.person(r.owner_email, step), status: cellText_(r.status) || 'evaluating',
    decision_note: cellText_(r.decision_note), bid_bond: cellNum_(r.bid_bond), documents: cellText_(r.documents), bid_amount: cellNum_(r.bid_amount),
    award_amount: cellNum_(r.award_amount), competitors: cellText_(r.competitors), result_note: cellText_(r.result_note),
  })).filter(r => r.title && r.agency);
  m.insert(step, 'tenders', records, r => normName_(r.title + '|' + r.agency));
}

function migrateCrm_(m) {
  const ss = m.open('crm');
  if (!ss) return m.note('客戶、聯絡人、往來紀錄', '未設定 OLD_CRM_SHEET_ID，略過');
  const clients = m.rows(ss, 'Clients');
  m.insert('客戶', 'clients', clients.filter(r => cellText_(r.name)).map(r => ({
    name: cellText_(r.name), tax_id: cellText_(r.taxId), industry: cellText_(r.industry), address: cellText_(r.address), phone: cellText_(r.phone),
    website: cellText_(r.website), tags: cellText_(r.tags), note: [cellText_(r.level), cellText_(r.status), cellText_(r.notes)].filter(Boolean).join('；') || null,
  })), r => normName_(r.name));
  // 舊 id → 新 id：以客戶名稱對應（試跑時新資料還沒寫入，就用舊 id 暫代，只為了算筆數）。
  const newByName = {};
  repo_('clients').findAll().forEach(c => { newByName[normName_(c.name)] = c.id; });
  const idOf = {};
  clients.forEach(r => { idOf[r.id] = newByName[normName_(r.name)] || (m.dry ? 'pending:' + r.id : null); });
  m.insert('聯絡人', 'contacts', m.rows(ss, 'Contacts').filter(r => r.companyType !== 'vendor' && idOf[r.companyId]).map(r => ({
    client_id: idOf[r.companyId], name: cellText_(r.name) || '（未填姓名）', title: cellText_(r.title), phone: cellText_(r.phone), email: cellText_(r.email),
    note: cellText_(r.notes),
  })), r => r.client_id + '|' + normName_(r.name));
  m.insert('往來紀錄', 'client_activities', m.rows(ss, 'Activities').filter(r => idOf[r.clientId]).map(r => ({
    client_id: idOf[r.clientId], activity_date: cellDate_(r.date) || todayIso_(), kind: cellText_(r.type),
    summary: [cellText_(r.title), cellText_(r.content), r.nextAction ? '下一步：' + r.nextAction : ''].filter(Boolean).join('\n') || '（無內容）',
  })), r => r.client_id + '|' + r.activity_date + '|' + String(r.summary).slice(0, 40));
}

// ---------------- 物資系統 ----------------

function migrateResource_(m) {
  const ss = m.open('resource');
  const step = '資材';
  m.insert(step, 'inventory', m.rows(ss, 'inventory').filter(r => cellText_(r.name)).map(r => ({
    name: cellText_(r.name), category: cellText_(r.category), quantity: cellNum_(r.quantity), location: cellText_(r.location),
    manager_account: m.person(r.manager, step), note: cellText_(r.note),
  })), r => normName_(r.name));
  m.insert('SOP', 'sops', m.rows(ss, 'sops').filter(r => cellText_(r.title)).map(r => ({
    title: cellText_(r.title), category: cellText_(r.type), version: '1', file_url: cellText_(r.fileUrl), note: cellText_(r.description),
    status: SOP_STATUS.ACTIVE,
  })), r => normName_(r.title + '|' + (r.version || '')));
  m.insert('媒體名單', 'media', m.rows(ss, 'media').filter(r => cellText_(r.media) || cellText_(r.name)).map(r => ({
    outlet: cellText_(r.media) || '（未填媒體）', name: cellText_(r.name), title: cellText_(r.title), phone: cellText_(r.phone), email: cellText_(r.email),
    last_contact: cellDate_(r.lastContact),
  })), r => normName_(r.outlet + '|' + (r.name || '')));
  m.insert('案例', 'cases', m.rows(ss, 'cases').filter(r => cellText_(r.title)).map(r => ({
    title: cellText_(r.title), category: cellText_(r.type), year: cellText_(r.year), link: cellText_(r.fileUrl), summary: cellText_(r.description),
  })), r => normName_(r.title));
  m.insert('帳密大全', 'credentials', m.rows(ss, 'credentials').filter(r => cellText_(r.name)).map(r => ({
    service: cellText_(r.name), url: cellText_(r.url), username: cellText_(r.account), password: cellText_(r.password), note: cellText_(r.period),
  })), r => normName_(r.service + '|' + (r.username || '')));
  // 派遣名冊：補到人員資料（地區、合約）；舊名冊的時薪不搬，排班時再填。帳號要先在帳號中心建好、同步過來，這裡只更新不新增。
  const personnel = m.rows(ss, 'personnel');
  const patches = {};
  let unmatched = 0;
  personnel.forEach(r => {
    const account = m.person(r.email || r.name, '派遣名冊');
    const p = account && PeopleService.byAccount(account);
    if (!p) { unmatched++; return; }
    patches[p.id] = { region: cellText_(r.area), phone: cellText_(r.phone) || p.phone || null,
      contract_start: cellDate_(r.startDate), contract_end: cellDate_(r.endDate), rating: cellNum_(r.rating), note: cellText_(r.note) };
  });
  if (!m.dry) withScriptLock_(() => repo_('people').updateMany(patches, 'migration'));
  m.report.push({ step: '派遣名冊 → 人員資料', table: 'people', read: personnel.length, insert: 0, updated: Object.keys(patches).length,
    skipped: unmatched, unresolved: Object.keys(m.unresolved['派遣名冊'] || {}) });
  m.note('物資系統的借用紀錄、預算', '舊借用紀錄是自由文字、預算沒有對應到預算科目，未自動搬；保留在原試算表供查詢');
}

// ---------------- 出勤 ----------------

function migrateAttendance_(m) {
  const ss = m.open('attendance');
  if (!ss) return m.note('考勤', '未設定 OLD_ATTENDANCE_SHEET_ID，略過');
  const step = '考勤';
  const accountOf = {};
  m.rows(ss, 'Employees').forEach(e => { accountOf[e.empId] = m.person(e.email || e.account || e.name, step); });
  const missing = Object.keys(m.unresolved[step] || {});
  if (missing.length) m.note(step, '這些舊出勤帳號對不上新系統的人員，他們的紀錄不會搬：' + missing.join('、'));
  const acc = r => accountOf[r.empId] || null;
  const status = s => ({ '待審': '待審', '核准': '核准', '駁回': '駁回', '已取消': '已取消' }[String(s)] || '核准');
  m.insert('打卡紀錄', 'attendance', m.rows(ss, 'Attendance').filter(acc).map(r => ({
    account: acc(r), work_date: cellDate_(r.date), punch: r.type === 'OUT' ? 'OUT' : 'IN', punch_time: cellTime_(r.time) || '00:00:00',
    mode: cellText_(r.mode) || 'OFFICE', ip: cellText_(r.ip), device_key: cellText_(r.deviceId), location: cellText_(r.location),
    lat: cellNum_(r.lat), lng: cellNum_(r.lng), reason: cellText_(r.reason), status: cellText_(r.status) || '正常',
    flag: cellText_(r.flag), over_min: cellNum_(r.overMin), review_note: cellText_(r.reviewNote),
  })).filter(r => r.work_date), r => r.account + '|' + r.work_date + '|' + r.punch);
  m.insert('請假', 'leaves', m.rows(ss, 'Leaves').filter(acc).map(r => ({
    account: acc(r), leave_type: cellText_(r.type) || '事假', start_date: cellDate_(r.startDate), start_time: String(cellTime_(r.startTime) || '09:00').slice(0, 5),
    end_date: cellDate_(r.endDate), end_time: String(cellTime_(r.endTime) || '18:30').slice(0, 5), hours: cellNum_(r.hours),
    reason: cellText_(r.reason) || '（舊系統未填）', status: status(r.status), review_note: cellText_(r.approveReason),
  })).filter(r => r.start_date && r.end_date), r => r.account + '|' + r.start_date + r.start_time + '|' + r.leave_type);
  m.insert('加班', 'overtime', m.rows(ss, 'Overtime').filter(acc).map(r => ({
    account: acc(r), work_date: cellDate_(r.date), plan_start: String(cellTime_(r.planStart) || '18:30').slice(0, 5),
    plan_end: String(cellTime_(r.planEnd) || '19:00').slice(0, 5), reason: cellText_(r.reason) || '（舊系統未填）',
    status: status(r.status), review_note: cellText_(r.approveReason), actual_hours: cellNum_(r.actualHours),
  })).filter(r => r.work_date), r => r.account + '|' + r.work_date + '|' + r.plan_start);
  m.insert('補卡', 'corrections', m.rows(ss, 'Corrections').filter(acc).map(r => ({
    account: acc(r), work_date: cellDate_(r.date), punch: r.type === 'OUT' ? 'OUT' : 'IN', request_time: String(cellTime_(r.requestTime) || '09:00').slice(0, 5),
    reason: cellText_(r.reason) || '（舊系統未填）', status: status(r.status), review_note: cellText_(r.approveReason),
  })).filter(r => r.work_date), r => r.account + '|' + r.work_date + '|' + r.punch);
  m.insert('假日', 'holidays', m.rows(ss, 'Holidays').map(r => ({
    holiday_date: cellDate_(r.date), name: cellText_(r.name) || '假日', kind: r.type === 'WORKDAY' ? 'WORKDAY' : 'HOLIDAY',
  })).filter(r => r.holiday_date), r => r.holiday_date);
}

function formatMigrationReport_(report) {
  return report.map(r => r.note
    ? '・' + r.step + '：' + r.note
    : '・' + r.step + '：讀到 ' + r.read + '，' + (r.updated !== undefined ? '更新 ' + r.updated : '新增 ' + r.insert) + '，略過 ' + r.skipped +
      (r.unresolved && r.unresolved.length ? '；對不上的人：' + r.unresolved.join('、') : '')).join('\n');
}
