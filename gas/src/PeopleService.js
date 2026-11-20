/**
 * 人員：帳號中心管帳號、密碼、角色；這裡是人事資料（部門、主管、正職或派遣、合約）。
 * 姓名、email、部門、主管從帳號中心同步，不在這裡重填（帳號中心有的資料不重覆輸入）。
 */

const PEOPLE_FIELDS_ = ['phone', 'region', 'contract_start', 'contract_end', 'rating', 'note'];
// 評價只有財務角色看得到。人員資料不放時薪：時薪在派遣排班時逐筆填，只有財務角色看得到。
const PEOPLE_FINANCE_FIELDS_ = ['rating'];

const PeopleService = {
  byAccount(account) {
    const key = String(account || '').toLowerCase();
    return repo_('people').findAll().find(p => p.account === key) || null;
  },

  nameOf(account) {
    const p = this.byAccount(account);
    return p ? p.name : (account || '');
  },

  list(ctx) {
    const rows = repo_('people').findAll().filter(p => p.active !== false);
    if (canSeeFinance_(ctx)) return rows;
    return rows.map(p => {
      const c = Object.assign({}, p);
      PEOPLE_FINANCE_FIELDS_.forEach(f => { delete c[f]; });
      return c;
    });
  },

  /**
   * 從帳號中心的 office 名單同步：新帳號新增、既有帳號更新姓名等欄位、名單上消失的標成停用。
   * 只有 admin / manager 拿得到完整名單（含 email、主管），所以限定由他們執行。
   */
  syncFromAccountCenter(ctx) {
    requireRole_(ctx, [ROLES.ADMIN, ROLES.MANAGER], '同步人員');
    const res = callAccountCenter_('directory', { token: ctx.token_, system: SSO_SYSTEM_ID_ });
    return withScriptLock_(() => applyDirectory_(res.users || [], ctx.account));
  },
};

function applyDirectory_(users, actor) {
  const repo = repo_('people');
  const existing = indexBy_(repo.findAll({ includeDeleted: true }), 'account');
  const seen = {};
  const inserts = [];
  const patches = {};
  users.forEach(u => {
    const account = String(u.account || '').toLowerCase();
    if (!account) return;
    seen[account] = true;
    const fields = {
      name: u.name || account,
      email: u.email || null,
      dept: u.dept || null,
      manager_account: String(u.manager || '').toLowerCase() || null,
      kind: u.type === '派遣' ? '派遣' : '正職',
      office_role: u.role || null,
      active: true,
    };
    const cur = existing[account];
    if (!cur) {
      inserts.push(Object.assign({ account }, fields));
    } else if (Object.keys(fields).some(k => String(cur[k] == null ? '' : cur[k]) !== String(fields[k] == null ? '' : fields[k]))) {
      patches[cur.id] = fields;
    }
  });
  Object.keys(existing).forEach(account => {
    const cur = existing[account];
    if (!seen[account] && cur.active !== false && !cur.is_deleted) patches[cur.id] = { active: false };
  });
  repo.insertMany(inserts, actor);
  repo.updateMany(patches, actor);
  return { added: inserts.length, updated: Object.keys(patches).length };
}

function callAccountCenter_(action, body) {
  let text;
  try {
    text = UrlFetchApp.fetch(AUTH_SERVICE_URL_, {
      method: 'post',
      contentType: 'text/plain',
      payload: JSON.stringify(Object.assign({ action }, body)),
      muteHttpExceptions: true,
    }).getContentText();
  } catch (e) {
    throw new AppError(ERROR_CODES.AUTH, '暫時無法連線帳號中心，請稍後再試');
  }
  const res = JSON.parse(text);
  if (!res.ok) throw new AppError(ERROR_CODES.AUTH, res.error.message, { authCode: res.error.code });
  return res.data;
}

function peopleRoutes_() {
  return {
    'people.list': { roles: INTERNAL_ROLES_, handler: (p, ctx) => PeopleService.list(ctx) },
    'people.sync': { roles: [ROLES.ADMIN, ROLES.MANAGER], handler: (p, ctx) => PeopleService.syncFromAccountCenter(ctx) },
    // 人事資料（地區、合約）只有主管與管理者能改；姓名、部門等改帳號中心。
    'people.update': { roles: [ROLES.ADMIN, ROLES.MANAGER], handler: (p, ctx) => {
      const a = updateArgs_(p, PEOPLE_FIELDS_, '人員');
      return updateRecord_('people', a.id, a.expected, a.patch, ctx.account);
    } },
  };
}
