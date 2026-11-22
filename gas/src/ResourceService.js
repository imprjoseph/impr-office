/**
 * 資材與知識：SOP（版本控制）、媒體名單、案例、帳密大全，以及工時週報。資材在 InventoryService.js。
 */

const SOP_STATUS = { DRAFT: 'draft', ACTIVE: 'active', SUPERSEDED: 'superseded' };
const SOP_FIELDS_ = ['title', 'category', 'version', 'effective_date', 'file_url', 'project_types', 'note'];
const MEDIA_FIELDS_ = ['outlet', 'name', 'title', 'beat', 'phone', 'mobile', 'email', 'line_id', 'last_contact', 'note'];
const CASE_FIELDS_ = ['title', 'client_name', 'year', 'category', 'summary', 'link', 'project_id'];
const CREDENTIAL_FIELDS_ = ['category', 'service', 'url', 'username', 'password', 'owner', 'note'];

const ResourceService = {
  /**
   * 發布 SOP：同名的舊版自動改成 superseded（不刪除），任何時候同一份 SOP 只有一個生效版本，
   * 同仁才不會照著舊版做事。
   */
  publishSop(id, expected, ctx) {
    return withScriptLock_(() => {
      const repo = repo_('sops');
      const snapshot = loadCurrentForWrite_(repo, id, expected);
      const sop = snapshot.record;
      const older = repo.findWhere(s => s.id !== id && normName_(s.title) === normName_(sop.title) && s.status === SOP_STATUS.ACTIVE);
      const patches = {};
      older.forEach(s => { patches[s.id] = { status: SOP_STATUS.SUPERSEDED }; });
      repo.updateMany(patches, ctx.account);
      return repo.writeSnapshot(snapshot, { status: SOP_STATUS.ACTIVE, effective_date: sop.effective_date || todayIso_() }, ctx.account);
    });
  },

  /** 專案類型適用的生效 SOP：project_types 留空代表所有類型都適用。 */
  sopsFor(projectType) {
    return repo_('sops').findWhere(s => s.status === SOP_STATUS.ACTIVE &&
      (!s.project_types || !projectType || templateTypes_(s).indexOf(PROJECT_TYPE_ALIASES_[projectType] || projectType) !== -1));
  },
};

const TimesheetService = {
  /**
   * 一週一次填報：送出的內容整週取代（舊的邏輯刪除），重填不會重複累加。
   * week_start 必須是週一，整個公司才對得起來同一週。
   */
  save(weekStart, entries, ctx) {
    const p = String(weekStart).split('-').map(Number);
    if (new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay() !== 1) throw new AppError(ERROR_CODES.VALIDATION, '週別請選週一');
    entries.forEach(e => {
      const h = Number(e.hours);
      if (!(h > 0 && h <= 80)) throw new AppError(ERROR_CODES.VALIDATION, '每筆時數要在 0 到 80 小時之間');
    });
    return withScriptLock_(() => {
      const repo = repo_('timesheets');
      const old = repo.findWhere(t => t.account === ctx.account && t.week_start === weekStart);
      // is_deleted 是系統欄位，updateMany 不接受，所以逐筆走 markDeleted；一個人一週頂多十幾筆。
      old.forEach(t => repo.markDeleted(repo.readForWrite(t.id), ctx.account));
      return repo.insertMany(entries.map(e => Object.assign({}, e, { account: ctx.account, week_start: weekStart })), ctx.account);
    });
  },

  mine(ctx) {
    return sortBy_(repo_('timesheets').findWhere(t => t.account === ctx.account), 'week_start').reverse();
  },

  /** 某週全部人的工時：主管看部屬、admin 看全部；附上還沒填的人。 */
  week(weekStart, ctx) {
    const people = repo_('people').findAll().filter(p => p.kind !== '派遣' && p.active !== false &&
      (ctx.role === ROLES.ADMIN || p.manager_account === ctx.account));
    const rows = repo_('timesheets').findWhere(t => t.week_start === weekStart);
    return people.map(p => {
      const mine = rows.filter(t => t.account === p.account);
      return { account: p.account, name: p.name, hours: sum_(mine, 'hours'), entries: mine, missing: !mine.length };
    });
  },
};

function resourceRoutes_() {
  const internal = { read: INTERNAL_ROLES_, write: INTERNAL_ROLES_ };
  const idArgs = p => [requireString_(p, 'id'), requireString_(p, 'expectedUpdatedAt')];
  const sopRoutes = crudRoutes_('sop', 'sops', { read: INTERNAL_ROLES_, write: [ROLES.ADMIN, ROLES.MANAGER], fields: SOP_FIELDS_, label: 'SOP' });
  // 新增的 SOP 一律先是草稿，發布才生效。
  sopRoutes['sop.create'] = { roles: sopRoutes['sop.create'].roles, handler: (p, ctx) => {
    const record = pickAllowed_(p.record || {}, SOP_FIELDS_, 'SOP');
    return withScriptLock_(() => repo_('sops').insert(Object.assign({}, record, { status: SOP_STATUS.DRAFT }), ctx.account));
  } };
  const credentials = crudRoutes_('credential', 'credentials', { read: [ROLES.ADMIN], write: [ROLES.ADMIN], fields: CREDENTIAL_FIELDS_, label: '帳密' });
  // 每次讀帳密都留紀錄：帳密外洩時才查得到誰在什麼時候看過。
  const listCred = credentials['credential.list'].handler;
  credentials['credential.list'] = { roles: [ROLES.ADMIN], handler: (p, ctx) => {
    withScriptLock_(() => audit_(ctx, 'credential.view', 'credentials', null, null));
    return listCred(p, ctx);
  } };
  return Object.assign(
    crudRoutes_('media', 'media', Object.assign({ fields: MEDIA_FIELDS_, label: '媒體' }, internal)),
    crudRoutes_('case', 'cases', Object.assign({ fields: CASE_FIELDS_, label: '案例' }, internal)),
    sopRoutes,
    credentials,
    {
      'sop.publish': { roles: [ROLES.ADMIN, ROLES.MANAGER], handler: (p, ctx) => ResourceService.publishSop(...idArgs(p), ctx) },
      'sop.forProjectType': { roles: INTERNAL_ROLES_, handler: p => ResourceService.sopsFor(p.project_type || null) },
    });
}

function timesheetRoutes_() {
  return {
    'timesheet.save': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
      TimesheetService.save(requireString_(p, 'week_start'),
        requireArray_(p, 'entries').map((e, i) => pickAllowed_(e, ['project_id', 'hours', 'overtime_reason', 'blocker'], '第 ' + (i + 1) + ' 筆工時')), ctx) },
    'timesheet.mine': { roles: INTERNAL_ROLES_, handler: (p, ctx) => TimesheetService.mine(ctx) },
    'timesheet.week': { roles: [ROLES.ADMIN, ROLES.MANAGER], handler: (p, ctx) => TimesheetService.week(requireString_(p, 'week_start'), ctx) },
  };
}
