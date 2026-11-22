/**
 * Controller 層：身分、角色檢查、輸入正規化、錯誤包裝。不做業務判斷。
 *
 * 前端（GitHub Pages）以 text/plain POST { action, token, payload }，回傳 { ok, data } 或 { ok:false, error }。
 * 用 text/plain 是為了避開 Apps Script 不支援的 CORS 預檢。
 * 單一入口：每個操作都一定經過同一套身分檢查與錯誤包裝，不會有漏掉檢查的後門函式。
 */

// 本部署以擁有者身分執行、匿名可呼叫，所以不回傳任何網頁或資料；身分只認帳號中心的憑證。
function doGet() {
  return jsonOutput_({ ok: true, data: { service: 'imPR 公司系統 API' } });
}

function doPost(e) {
  try {
    let body;
    try {
      body = JSON.parse((e && e.postData && e.postData.contents) || '');
    } catch (err) {
      throw new AppError(ERROR_CODES.VALIDATION, '請求格式錯誤');
    }
    return jsonOutput_({ ok: true, data: dispatchAction_(body.action, body.token, body.payload) });
  } catch (err) {
    return jsonOutput_(errorBody_(err));
  }
}

function dispatchAction_(action, token, payload) {
  const route = allRoutes_()[action];
  if (!route) throw new AppError(ERROR_CODES.VALIDATION, '未知的操作：' + action);
  const ctx = Object.assign({}, authenticate_(token));
  // 憑證只給需要代替使用者呼叫帳號中心的功能用（例如同步人員）；不可列舉，回傳 ctx 時不會帶出去。
  Object.defineProperty(ctx, 'token_', { value: token, enumerable: false });
  ensureSchema_();
  // 每條路由都要宣告 roles；沒宣告視為設定錯誤而不是預設開放，避免新路由忘了設權限就對所有人開放。
  if (!route.roles || !route.roles.length) throw new AppError(ERROR_CODES.FORBIDDEN, '操作未設定權限：' + action);
  requireRole_(ctx, route.roles);
  return route.handler(normalizeInput_(payload || {}), ctx);
}

/**
 * 各模組在自己的檔案定義 xxxRoutes_()，這裡合併。用函式而不是頂層常數：
 * GAS 依檔案順序載入，頂層引用其他檔案的物件時對方可能還沒定義。
 */
function allRoutes_() {
  const providers = [
    'sessionRoutes_', 'peopleRoutes_', 'clientRoutes_', 'supplierRoutes_', 'tenderRoutes_',
    'projectRoutes_', 'budgetRoutes_', 'expenseRoutes_', 'attendanceRoutes_', 'dispatchRoutes_',
    'timesheetRoutes_', 'resourceRoutes_', 'inventoryRoutes_', 'partTimerRoutes_', 'importRoutes_', 'priceRefRoutes_', 'aiRoutes_', 'dashboardRoutes_', 'adminRoutes_', 'migrationRoutes_', 'publicTenderRoutes_',
  ];
  const routes = {};
  providers.forEach(name => {
    const fn = globalThis[name];
    if (typeof fn !== 'function') return;
    const part = fn();
    Object.keys(part).forEach(k => {
      if (routes[k]) throw new Error('重複的路由：' + k);
      routes[k] = part[k];
    });
  });
  return routes;
}

function sessionRoutes_() {
  return {
    'session.me': { roles: ALL_ROLES_, handler: (p, ctx) => ctx },
  };
}

function errorBody_(e) {
  if (e && e.name === 'AppError') {
    return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
  }
  // 非預期錯誤只回通用訊息，堆疊留在 log；避免把內部結構或試算表 ID 暴露給前端。
  console.error(e && e.stack ? e.stack : e);
  return { ok: false, error: { code: 'INTERNAL_ERROR', message: '系統錯誤，請稍後再試', details: null } };
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * 字串去頭尾空白、空字串轉 null；*_date 欄位把 2026/1/5 這類輸入統一成 2026-01-05。
 * 在入口統一做，Service 與 Repository 就只需要處理一種格式。
 */
function normalizeInput_(value, key) {
  if (Array.isArray(value)) return value.map(v => normalizeInput_(v));
  if (value && typeof value === 'object' && !isDate_(value)) {
    const out = {};
    Object.keys(value).forEach(k => { out[k] = normalizeInput_(value[k], k); });
    return out;
  }
  if (typeof value !== 'string') return value;
  const s = value.trim();
  if (s === '') return null;
  if (key && /_date$|^week_start$/.test(key)) {
    const m = s.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})$/);
    if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  }
  return s;
}

// 白名單外的欄位直接拒絕而不是默默丟掉，前端欄位拼錯時才會馬上發現；也擋住直接改狀態、金額彙總等欄位。
function pickAllowed_(obj, allowed, label) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new AppError(ERROR_CODES.VALIDATION, label + '資料格式錯誤');
  }
  const bad = Object.keys(obj).filter(k => allowed.indexOf(k) === -1);
  if (bad.length) throw new AppError(ERROR_CODES.VALIDATION, label + '不接受欄位：' + bad.join(', '));
  const out = {};
  allowed.forEach(k => { if (obj[k] !== undefined) out[k] = obj[k]; });
  return out;
}

function requireString_(obj, key) {
  const v = obj[key];
  if (typeof v !== 'string' || !v) throw new AppError(ERROR_CODES.VALIDATION, '缺少參數：' + key);
  return v;
}

function requireArray_(obj, key) {
  const v = obj[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new AppError(ERROR_CODES.VALIDATION, key + ' 必須是陣列');
  return v;
}

/** 更新類路由的共同參數：id、expectedUpdatedAt、patch（白名單過濾）。 */
function updateArgs_(p, allowed, label) {
  return {
    id: requireString_(p, 'id'),
    expected: requireString_(p, 'expectedUpdatedAt'),
    patch: pickAllowed_(p.patch || {}, allowed, label),
  };
}
