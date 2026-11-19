/**
 * 資料庫位置與外部服務設定。
 *
 * SHEET_ID 放在 Script Properties 而不是寫死成常數：試用版與正式版是兩份試算表、同一份程式，
 * 寫死很容易把試用資料寫進正式庫。
 */

let spreadsheet_ = null;

function getSpreadsheet_() {
  if (spreadsheet_) return spreadsheet_;
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new AppError(ERROR_CODES.SCHEMA, '尚未設定資料庫，請在 Apps Script 編輯器執行 setupDatabase()');
  try {
    spreadsheet_ = SpreadsheetApp.openById(id);
  } catch (e) {
    throw new AppError(ERROR_CODES.SCHEMA, '打不開資料庫試算表，請確認部署者對它有編輯權限');
  }
  return spreadsheet_;
}

// 帳號中心（imPR 共用登入）。網址不是秘密：憑證的有效性由帳號中心的簽章保證。
const AUTH_SERVICE_URL_ = 'https://script.google.com/macros/s/AKfycbzBEXIU7diy0fdpz4p-N-pKCDem4xL5BnNSptSzRLYi8Hd3ccvLcLAPTY-K2WrLDclYZQ/exec';
// 帳號中心 accounts 表上本系統的角色欄名。
const SSO_SYSTEM_ID_ = 'office';
// 帳號中心驗證結果暫存秒數：每個操作都回頭問帳號中心會多 1 秒以上；停用帳號最晚 5 分鐘後失效。
const SSO_CACHE_SECONDS_ = 300;

const ROLES = {
  ADMIN: 'admin',
  MANAGER: 'manager',
  ACCOUNTANT: 'accountant',
  STAFF: 'staff',
  DISPATCH: 'dispatch',
};
// 一般內部同仁（不含派遣）：大部分讀寫路由的預設對象。
const INTERNAL_ROLES_ = [ROLES.ADMIN, ROLES.MANAGER, ROLES.ACCOUNTANT, ROLES.STAFF];
const ALL_ROLES_ = INTERNAL_ROLES_.concat([ROLES.DISPATCH]);
// 看得到成本、毛利、時薪等財務欄位的角色；專案 PM 另外在 Service 層放行自己的專案。
const FINANCE_ROLES_ = [ROLES.ADMIN, ROLES.MANAGER, ROLES.ACCOUNTANT];
