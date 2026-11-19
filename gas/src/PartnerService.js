/**
 * 往來對象：客戶、聯絡人、往來紀錄、供應商、供應商檔期與評分。
 *
 * 供應商檔期衝突（findDateConflicts_）是獨立函式，專案預約供應商、派遣排班都要經過它；
 * 不寫在前端或某條路由裡，多個入口各自實作遲早會不一致。
 */

const CLIENT_FIELDS_ = ['name', 'tax_id', 'industry', 'address', 'phone', 'website', 'owner_account', 'tags', 'note'];
const CONTACT_FIELDS_ = ['client_id', 'supplier_id', 'name', 'title', 'phone', 'email', 'note'];
const CLIENT_ACTIVITY_FIELDS_ = ['client_id', 'project_id', 'activity_date', 'kind', 'summary', 'owner_account'];
// avg_rating / rating_count 不開放輸入：只能由專案結案評分重算。
const SUPPLIER_FIELDS_ = ['name', 'category', 'service_items', 'tax_id', 'contact_name', 'contact_phone', 'contact_email', 'note'];
const SUPPLIER_CATEGORIES = ['場地', '音響', '燈光', '舞台', '視訊／LED', '攝影／錄影', '印刷／輸出', '佈置／花藝',
  '餐飲', '交通', '住宿', '主持／表演', '口譯', '人力', '設計', '其他'];

const BOOKING_STATUS = { CONFIRMED: 'confirmed', CANCELLED: 'cancelled' };
const RATING_MIN_ = 1;
const RATING_MAX_ = 5;

const SupplierService = {
  /**
   * 預約檔期：檢查與寫入在同一個 script lock 內，否則兩人同時預約同一檔期都會檢查通過。
   */
  book(input, ctx) {
    assertDateRange_(input.start_date, input.end_date);
    return withScriptLock_(() => {
      if (!repo_('suppliers').findById(input.supplier_id)) throw new AppError(ERROR_CODES.NOT_FOUND, '找不到供應商');
      if (!repo_('projects').findById(input.project_id)) throw new AppError(ERROR_CODES.NOT_FOUND, '找不到專案');
      const result = findDateConflicts_(repo_('supplier_bookings').findAll(), input.supplier_id, input);
      if (result.hasConflict) {
        throw new AppError(ERROR_CODES.SCHEDULE_CONFLICT, '這家供應商在這段期間已有預約', { conflicts: result.conflicts });
      }
      return repo_('supplier_bookings').insert(Object.assign({}, input, { status: BOOKING_STATUS.CONFIRMED }), ctx.account);
    });
  },

  // 取消改狀態而不是刪除：保留曾經預約過的紀錄，取消後就不再佔用檔期。
  cancelBooking(id, expected, ctx) {
    return updateRecord_('supplier_bookings', id, expected, { status: BOOKING_STATUS.CANCELLED }, ctx.account);
  },

  /**
   * 結案評分：一個專案對一家供應商只評一次，評完從全部評分重算平均。
   * 整個重算而不是累加：累加只要漏一次或重複一次就永遠錯下去，重算可以重跑修復。
   */
  rate(projectId, ratings, ctx) {
    return withScriptLock_(() => {
      const existing = repo_('supplier_ratings').findWhere(r => r.project_id === projectId);
      const rows = ratings.map(r => {
        const score = Number(r.score);
        if (!(score >= RATING_MIN_ && score <= RATING_MAX_)) throw new AppError(ERROR_CODES.VALIDATION, '評分必須是 1 到 5');
        if (existing.some(e => e.supplier_id === r.supplier_id)) throw new AppError(ERROR_CODES.VALIDATION, '這家供應商在本專案已經評過分');
        return { supplier_id: r.supplier_id, project_id: projectId, score, comment: r.comment || null };
      });
      repo_('supplier_ratings').insertMany(rows, ctx.account);
      return this.recalcRatings(rows.map(r => r.supplier_id), ctx.account);
    });
  },

  recalcRatings(supplierIds, actor) {
    const ids = supplierIds.filter((id, i) => supplierIds.indexOf(id) === i);
    if (!ids.length) return [];
    const ratings = repo_('supplier_ratings').findWhere(r => ids.indexOf(r.supplier_id) !== -1);
    const patches = {};
    ids.forEach(id => {
      const list = ratings.filter(r => r.supplier_id === id);
      const total = sum_(list, 'score');
      patches[id] = { rating_count: list.length, avg_rating: list.length ? Math.round(total / list.length * 100) / 100 : null };
    });
    return repo_('suppliers').updateMany(patches, actor);
  },
};

/**
 * 純函式：日期含頭含尾，所以同一天交接也算衝突——撤場與進場同日時，同一組人力設備無法兩邊都到。
 */
function findDateConflicts_(bookings, supplierId, range, options) {
  const excludeId = options && options.excludeBookingId;
  const conflicts = bookings
    .filter(b => b.supplier_id === supplierId && b.status !== BOOKING_STATUS.CANCELLED && b.id !== excludeId
      && b.start_date <= range.end_date && range.start_date <= b.end_date)
    .map(b => ({ booking_id: b.id, project_id: b.project_id, start_date: b.start_date, end_date: b.end_date }));
  return { hasConflict: conflicts.length > 0, conflicts };
}

function assertDateRange_(start, end) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(String(start)) || !re.test(String(end))) throw new AppError(ERROR_CODES.VALIDATION, '日期必須是 yyyy-MM-dd');
  if (start > end) throw new AppError(ERROR_CODES.VALIDATION, '結束日不能早於開始日');
}

/** 統一編號：8 位數字、不重複。只檢查格式不驗檢查碼，避免財政部調整規則時誤擋真實統編。 */
function assertTaxId_(table, record, label) {
  if (!record.tax_id) return;
  if (!/^\d{8}$/.test(String(record.tax_id))) throw new AppError(ERROR_CODES.VALIDATION, '統一編號必須是 8 位數字');
  const dup = repo_(table).findAll().find(r => r.tax_id === String(record.tax_id) && r.id !== record.id);
  if (dup) throw new AppError(ERROR_CODES.VALIDATION, '統一編號 ' + record.tax_id + ' 已用於' + label + '「' + dup.name + '」');
}

function clientRoutes_() {
  const base = { read: INTERNAL_ROLES_, write: INTERNAL_ROLES_ };
  return Object.assign(
    crudRoutes_('client', 'clients', Object.assign({}, base, { fields: CLIENT_FIELDS_, label: '客戶',
      validate: r => { assertUniqueName_('clients', 'name', r, '客戶'); assertTaxId_('clients', r, '客戶'); } })),
    crudRoutes_('contact', 'contacts', Object.assign({}, base, { fields: CONTACT_FIELDS_, label: '聯絡人' })),
    crudRoutes_('clientActivity', 'client_activities', Object.assign({}, base, { fields: CLIENT_ACTIVITY_FIELDS_, label: '往來紀錄' })),
  );
}

function supplierRoutes_() {
  return Object.assign(
    crudRoutes_('supplier', 'suppliers', { read: INTERNAL_ROLES_, write: INTERNAL_ROLES_, fields: SUPPLIER_FIELDS_, label: '供應商',
      validate: r => { assertUniqueName_('suppliers', 'name', r, '供應商'); assertTaxId_('suppliers', r, '供應商'); } }),
    {
      'supplier.categories': { roles: INTERNAL_ROLES_, handler: () => SUPPLIER_CATEGORIES },
      'supplier.bookings': { roles: INTERNAL_ROLES_, handler: () => repo_('supplier_bookings').findAll() },
      'supplier.checkConflict': { roles: INTERNAL_ROLES_, handler: p => {
        assertDateRange_(p.start_date, p.end_date);
        return findDateConflicts_(repo_('supplier_bookings').findAll(), requireString_(p, 'supplier_id'), p,
          { excludeBookingId: p.exclude_booking_id || null });
      } },
      'supplier.book': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
        SupplierService.book(pickAllowed_(p, ['supplier_id', 'project_id', 'start_date', 'end_date', 'note'], '預約'), ctx) },
      'supplier.cancelBooking': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
        SupplierService.cancelBooking(requireString_(p, 'id'), requireString_(p, 'expectedUpdatedAt'), ctx) },
    });
}
