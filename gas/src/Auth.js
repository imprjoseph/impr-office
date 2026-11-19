/**
 * 身分：向帳號中心驗證憑證，得到「誰、什麼角色」。
 *
 * 不在本地驗簽章：共用密鑰複製到各系統，任何一個系統外洩就能偽造所有人的身分。
 * 驗證結果用憑證的雜湊當 key 暫存幾分鐘，憑證本身不進快取。
 */

function authenticate_(token) {
  if (!token) throw new AppError(ERROR_CODES.AUTH, '請先登入', { authCode: 'TOKEN' });
  const key = 'sso:' + sha256Hex_(token);
  const cache = CacheService.getScriptCache();
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const ctx = contextFromVerify_(verifyWithAccountCenter_(token));
  cache.put(key, JSON.stringify(ctx), SSO_CACHE_SECONDS_);
  return ctx;
}

function verifyWithAccountCenter_(token) {
  let text;
  try {
    text = UrlFetchApp.fetch(AUTH_SERVICE_URL_, {
      method: 'post',
      contentType: 'text/plain',
      payload: JSON.stringify({ action: 'verify', token, system: SSO_SYSTEM_ID_ }),
      muteHttpExceptions: true,
    }).getContentText();
  } catch (e) {
    throw new AppError(ERROR_CODES.AUTH, '暫時無法連線帳號中心，請稍後再試');
  }
  let res;
  try {
    res = JSON.parse(text);
  } catch (e) {
    throw new AppError(ERROR_CODES.AUTH, '帳號中心暫時無法使用，請稍後再試');
  }
  if (!res.ok) throw new AppError(ERROR_CODES.AUTH, res.error.message, { authCode: res.error.code });
  return res.data;
}

/**
 * 派遣帳號一律當成 dispatch 角色：帳號中心若誤填成 staff，派遣人員也看不到客戶、成本等內部資料。
 */
function contextFromVerify_(data) {
  const u = data.user || {};
  const isDispatch = u.type === '派遣';
  const role = isDispatch ? ROLES.DISPATCH : String(data.role || '');
  if (ALL_ROLES_.indexOf(role) === -1) {
    throw new AppError(ERROR_CODES.AUTH, '帳號中心的 office 角色「' + role + '」無效，請聯絡管理者', { authCode: 'FORBIDDEN' });
  }
  return {
    account: String(u.account || '').toLowerCase(),
    name: String(u.name || u.account || ''),
    email: String(u.email || ''),
    dept: String(u.dept || ''),
    manager: String(u.manager || '').toLowerCase(),
    type: isDispatch ? '派遣' : '正職',
    role,
  };
}

function sha256Hex_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

// ---- 權限判斷：Service 層用，不只靠前端隱藏按鈕 ----

function hasRole_(ctx, roles) {
  return roles.indexOf(ctx.role) !== -1;
}

function requireRole_(ctx, roles, what) {
  if (!hasRole_(ctx, roles)) throw new AppError(ERROR_CODES.FORBIDDEN, '你沒有權限' + (what || '執行這個操作'));
}

function canSeeFinance_(ctx) {
  return hasRole_(ctx, FINANCE_ROLES_);
}

/** 是不是 account 的直屬主管：主管關係以人員資料（從帳號中心同步）為準。admin 視同所有人的主管。 */
function isManagerOf_(ctx, account) {
  if (ctx.role === ROLES.ADMIN) return true;
  if (ctx.role !== ROLES.MANAGER) return false;
  const person = PeopleService.byAccount(account);
  return !!person && person.manager_account === ctx.account;
}
