/**
 * 共用工具：統一錯誤、ID、時間戳。
 */

const ERROR_CODES = {
  VALIDATION: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND_ERROR',
  CONFLICT: 'CONFLICT_ERROR',
  // 與 CONFLICT_ERROR 分開：那個代表「請重新整理」，檔期衝突則要讓使用者看到撞到哪些專案。
  SCHEDULE_CONFLICT: 'SCHEDULE_CONFLICT_ERROR',
  SCHEMA: 'SCHEMA_ERROR',
  AUTH: 'AUTH_ERROR',
  LOCK: 'LOCK_ERROR',
  FORBIDDEN: 'FORBIDDEN_ERROR',
};

// 所有層都丟 AppError，Controller 才能用同一個格式包成錯誤回應，前端不必猜錯誤長相。
class AppError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details || null;
  }
}

// 前綴 + 去掉連字號的 UUID；前綴讓人一眼看出 id 屬於哪張表，跨表關聯填錯時容易發現。
function newId_(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '');
}

function nowIso_() {
  return new Date().toISOString();
}

// 「今天」以腳本時區為準（appsscript.json 設為台北），不用 UTC，否則台北早上 8 點前會算成前一天。
function todayIso_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function addDays_(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 新的 updated_at 必須嚴格大於舊值，否則同一毫秒內的兩次寫入會有相同時間戳，樂觀鎖就分辨不出來。
function nextTimestamp_(previousIso) {
  const now = Date.now();
  const previous = Date.parse(previousIso);
  const next = !isNaN(previous) && now <= previous ? previous + 1 : now;
  return new Date(next).toISOString();
}

// 不用 instanceof Date：跨執行環境（例如測試用的 vm）傳進來的 Date 會判斷失敗。
function isDate_(value) {
  return Object.prototype.toString.call(value) === '[object Date]';
}

function columnLetter_(columnNumber) {
  let letter = '';
  let n = columnNumber;
  while (n > 0) {
    const r = (n - 1) % 26;
    letter = String.fromCharCode(65 + r) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}
