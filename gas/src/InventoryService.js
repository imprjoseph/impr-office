/**
 * 資材管理。先分大項，再分管理方式：
 *
 *   大項 kind      管理方式 track_mode   怎麼算數量                     怎麼用
 *   資產           逐台                  每台一筆 inventory_units        借用時挑「哪幾台」，每台有財產編號、序號、狀態
 *   資產           整批                  quantity 是總數                借用時填數量（延長線、對講機這類不必分台的）
 *   耗材           整批（固定）           quantity 是目前庫存             領用扣庫存、入庫加庫存、盤點調整；不歸還
 *
 * 逐台的單台狀態：可用、借出（只由借還流程改）、維修、報廢。報廢的不算在總數裡。
 * 耗材有安全存量：庫存 ≤ 安全存量就標「庫存不足」。
 */

const INVENTORY_KIND = { ASSET: '資產', CONSUMABLE: '耗材' };
const TRACK_MODE = { UNIT: '逐台', BATCH: '整批' };
const UNIT_STATUS = { AVAILABLE: '可用', ON_LOAN: '借出', REPAIR: '維修', RETIRED: '報廢' };
const LOAN_STATUS = { OUT: '借出中', RETURNED: '已歸還' };
const STOCK_MOVE = { IN: '入庫', OUT: '領用', ADJUST: '盤點調整' };

const ASSET_CATEGORIES = ['電腦與周邊設備', '攝影與錄影設備', '錄音與音響設備', '簡報與投影設備', '影音轉接與訊號設備',
  '網路與通訊設備', '電力與照明設備', '展示與輸出器材', '測量與場勘工具', '報到與識別設備', '現場執行與管控設備', '其他設備'];
const CONSUMABLE_CATEGORIES = ['文具', '印刷與輸出耗材', '電池與電料', '識別證與名牌耗材', '包材與膠帶', '清潔與衛生用品', '活動小物', '其他耗材'];

const INVENTORY_FIELDS_ = ['name', 'kind', 'track_mode', 'category', 'spec', 'quantity', 'unit', 'safety_stock', 'location',
  'manager_account', 'photo_url', 'note'];
const UNIT_FIELDS_ = ['asset_tag', 'serial_no', 'status', 'location', 'custodian_account', 'purchase_date', 'cost', 'warranty_until', 'note'];

/** 舊資料沒有 kind / track_mode：一律當整批資產（原本物資系統就是這樣管）。 */
function itemKind_(item) { return item.kind === INVENTORY_KIND.CONSUMABLE ? INVENTORY_KIND.CONSUMABLE : INVENTORY_KIND.ASSET; }
function itemMode_(item) { return itemKind_(item) === INVENTORY_KIND.ASSET && item.track_mode === TRACK_MODE.UNIT ? TRACK_MODE.UNIT : TRACK_MODE.BATCH; }

function normalizeItem_(record, current) {
  const merged = Object.assign({}, current || {}, record);
  if (!current && !String(merged.category || '').trim()) throw new AppError(ERROR_CODES.VALIDATION, '請選擇資材的分類');
  const kind = merged.kind || INVENTORY_KIND.ASSET;
  if ([INVENTORY_KIND.ASSET, INVENTORY_KIND.CONSUMABLE].indexOf(kind) === -1) throw new AppError(ERROR_CODES.VALIDATION, '大項只能是資產或耗材');
  const mode = kind === INVENTORY_KIND.CONSUMABLE ? TRACK_MODE.BATCH : (merged.track_mode || TRACK_MODE.BATCH);
  if ([TRACK_MODE.UNIT, TRACK_MODE.BATCH].indexOf(mode) === -1) throw new AppError(ERROR_CODES.VALIDATION, '管理方式只能是逐台或整批');
  if (merged.quantity !== null && merged.quantity !== undefined && merged.quantity !== '' && Number(merged.quantity) < 0) {
    throw new AppError(ERROR_CODES.VALIDATION, '數量不能小於 0');
  }
  const out = Object.assign({}, record);
  if (!current || 'kind' in record) out.kind = kind;
  if (!current || 'kind' in record || 'track_mode' in record) out.track_mode = mode;
  return out;
}

function unitsOf_(itemId) {
  return repo_('inventory_units').findWhere(u => u.inventory_id === itemId);
}

function nextAssetTag_() {
  const max = repo_('inventory_units').findAll({ includeDeleted: true })
    .map(u => Number((String(u.asset_tag || '').match(/^A-(\d+)$/) || [])[1]) || 0).reduce((a, b) => Math.max(a, b), 0);
  return n => 'A-' + ('0000' + (max + n)).slice(-4);
}

const InventoryService = {
  /** 清單：每項附上總數、可用數、借出數、庫存不足，前端依大項與管理方式顯示不同操作。 */
  list() {
    const units = repo_('inventory_units').findAll();
    const loans = repo_('loans').findWhere(l => l.status === LOAN_STATUS.OUT);
    const out = {};
    loans.forEach(l => { out[l.inventory_id] = (out[l.inventory_id] || 0) + (Number(l.quantity) || 0); });
    return sortBy_(repo_('inventory').findAll(), 'name').map(i => {
      const kind = itemKind_(i), mode = itemMode_(i);
      let total, available, onLoan;
      if (mode === TRACK_MODE.UNIT) {
        const mine = units.filter(u => u.inventory_id === i.id && u.status !== UNIT_STATUS.RETIRED);
        total = mine.length;
        available = mine.filter(u => u.status === UNIT_STATUS.AVAILABLE).length;
        onLoan = mine.filter(u => u.status === UNIT_STATUS.ON_LOAN).length;
      } else if (kind === INVENTORY_KIND.CONSUMABLE) {
        total = Number(i.quantity) || 0;
        available = total;
        onLoan = 0;
      } else {
        total = Number(i.quantity) || 0;
        onLoan = out[i.id] || 0;
        available = total - onLoan;
      }
      const low = kind === INVENTORY_KIND.CONSUMABLE && i.safety_stock !== null && i.safety_stock !== undefined && i.safety_stock !== '' &&
        total <= Number(i.safety_stock);
      return Object.assign({}, i, { kind, track_mode: mode, total, available, on_loan: onLoan, low_stock: low });
    });
  },

  options() {
    return { kinds: [INVENTORY_KIND.ASSET, INVENTORY_KIND.CONSUMABLE], modes: [TRACK_MODE.UNIT, TRACK_MODE.BATCH],
      assetCategories: ASSET_CATEGORIES, consumableCategories: CONSUMABLE_CATEGORIES,
      unitStatuses: [UNIT_STATUS.AVAILABLE, UNIT_STATUS.REPAIR, UNIT_STATUS.RETIRED] };
  },

  create(record, ctx) {
    const data = normalizeItem_(record, null);
    return withScriptLock_(() => {
      assertUniqueName_('inventory', 'name', data, '資材');
      const item = repo_('inventory').insert(data, ctx.account);
      if (itemKind_(item) === INVENTORY_KIND.CONSUMABLE && Number(item.quantity) > 0) {
        repo_('stock_moves').insert({ inventory_id: item.id, kind: STOCK_MOVE.IN, quantity: Number(item.quantity), balance: Number(item.quantity),
          account: ctx.account, move_date: todayIso_(), note: '建立時的期初庫存' }, ctx.account);
      }
      return item;
    });
  },

  /**
   * 修改：大項、管理方式要用 setMode 轉換（會建立或收掉單台資料），這裡不能直接改；
   * 耗材的庫存要用入庫、領用、盤點，才留得下紀錄。
   */
  update(id, expected, patch, ctx) {
    return withScriptLock_(() => {
      const repo = repo_('inventory');
      const snapshot = loadCurrentForWrite_(repo, id, expected);
      const item = snapshot.record;
      if ('kind' in patch && (patch.kind || INVENTORY_KIND.ASSET) !== itemKind_(item)) throw new AppError(ERROR_CODES.VALIDATION, '大項要用「轉換管理方式」修改');
      if ('track_mode' in patch && (patch.track_mode || TRACK_MODE.BATCH) !== itemMode_(item)) throw new AppError(ERROR_CODES.VALIDATION, '管理方式要用「轉換管理方式」修改');
      if ('quantity' in patch && itemKind_(item) === INVENTORY_KIND.CONSUMABLE && Number(patch.quantity) !== Number(item.quantity)) {
        throw new AppError(ERROR_CODES.VALIDATION, '耗材庫存請用入庫、領用或盤點調整，才留得下紀錄');
      }
      if ('quantity' in patch && itemMode_(item) === TRACK_MODE.BATCH && itemKind_(item) === INVENTORY_KIND.ASSET) {
        const onLoan = repo_('loans').findWhere(l => l.inventory_id === id && l.status === LOAN_STATUS.OUT).reduce((s, l) => s + (Number(l.quantity) || 0), 0);
        if (Number(patch.quantity) < onLoan) throw new AppError(ERROR_CODES.VALIDATION, '總數不能少於借出中的 ' + onLoan);
      }
      if ('name' in patch) assertUniqueName_('inventory', 'name', { id, name: patch.name }, '資材');
      const clean = Object.assign({}, patch);
      delete clean.kind; delete clean.track_mode;
      return repo.writeSnapshot(snapshot, clean, ctx.account);
    });
  },

  /**
   * 轉換大項或管理方式：
   * - 整批資產 → 逐台：依目前總數建立單台資料（財產編號自動給 A-0001…，之後再補序號）；有借出中的不能轉。
   * - 逐台 → 整批：總數改成未報廢的台數，單台資料收起來（邏輯刪除）；有台借出中不能轉。
   * - 資產 ↔ 耗材：有借出或單台資料時不能轉。
   */
  setMode(id, expected, kind, mode, ctx) {
    return withScriptLock_(() => {
      const repo = repo_('inventory');
      const snapshot = loadCurrentForWrite_(repo, id, expected);
      const item = snapshot.record;
      const target = normalizeItem_({ kind, track_mode: mode }, item);
      const fromMode = itemMode_(item), toMode = target.track_mode;
      const openLoans = repo_('loans').findWhere(l => l.inventory_id === id && l.status === LOAN_STATUS.OUT);
      if (openLoans.length) throw new AppError(ERROR_CODES.VALIDATION, '還有借出中的紀錄，請先歸還再轉換');
      const patch = { kind: target.kind, track_mode: toMode };
      if (fromMode === TRACK_MODE.BATCH && toMode === TRACK_MODE.UNIT) {
        const n = Number(item.quantity) || 0;
        const tag = nextAssetTag_();
        const rows = [];
        for (let k = 1; k <= n; k++) rows.push({ inventory_id: id, asset_tag: tag(k), status: UNIT_STATUS.AVAILABLE, location: item.location || null });
        if (rows.length) repo_('inventory_units').insertMany(rows, ctx.account);
      } else if (fromMode === TRACK_MODE.UNIT && toMode === TRACK_MODE.BATCH) {
        const units = unitsOf_(id);
        patch.quantity = units.filter(u => u.status !== UNIT_STATUS.RETIRED).length;
        const ur = repo_('inventory_units');
        units.forEach(u => ur.markDeleted(ur.readForWrite(u.id), ctx.account));
      }
      return repo.writeSnapshot(snapshot, patch, ctx.account);
    });
  },

  // ---------- 逐台 ----------

  units(itemId) {
    const loans = indexBy_(repo_('loans').findWhere(l => l.status === LOAN_STATUS.OUT && l.inventory_id === itemId), 'id');
    const byUnit = {};
    Object.keys(loans).forEach(id => String(loans[id].unit_ids || '').split(',').filter(Boolean).forEach(u => { byUnit[u] = loans[id]; }));
    return sortBy_(unitsOf_(itemId), 'asset_tag').map(u => Object.assign({}, u, {
      borrower_account: byUnit[u.id] ? byUnit[u.id].borrower_account : null,
      due_date: byUnit[u.id] ? byUnit[u.id].due_date : null,
    }));
  },

  addUnit(itemId, record, ctx) {
    return withScriptLock_(() => {
      const item = repo_('inventory').findById(itemId);
      if (!item) throw new AppError(ERROR_CODES.NOT_FOUND, '找不到資材');
      if (itemMode_(item) !== TRACK_MODE.UNIT) throw new AppError(ERROR_CODES.VALIDATION, '「' + item.name + '」是整批管理，不用建單台資料');
      const data = Object.assign({ status: UNIT_STATUS.AVAILABLE, location: item.location || null }, record);
      if (!data.asset_tag) data.asset_tag = nextAssetTag_()(1);
      assertUnitValues_(data, null);
      return repo_('inventory_units').insert(Object.assign(data, { inventory_id: itemId }), ctx.account);
    });
  },

  updateUnit(id, expected, patch, ctx) {
    return withScriptLock_(() => {
      const repo = repo_('inventory_units');
      const snapshot = loadCurrentForWrite_(repo, id, expected);
      if ('status' in patch && patch.status !== snapshot.record.status &&
        (snapshot.record.status === UNIT_STATUS.ON_LOAN || patch.status === UNIT_STATUS.ON_LOAN)) {
        throw new AppError(ERROR_CODES.VALIDATION, '「借出」狀態由借用、歸還自動改，請用借還功能');
      }
      assertUnitValues_(patch, id);
      return repo.writeSnapshot(snapshot, patch, ctx.account);
    });
  },

  deleteUnit(id, expected, ctx) {
    return withScriptLock_(() => {
      const repo = repo_('inventory_units');
      const snapshot = loadCurrentForWrite_(repo, id, expected);
      if (snapshot.record.status === UNIT_STATUS.ON_LOAN) throw new AppError(ERROR_CODES.VALIDATION, '借出中的不能刪除；不用了請改成「報廢」');
      return repo.markDeleted(snapshot, ctx.account);
    });
  },

  // ---------- 借還（資產） ----------

  /**
   * 借用：逐台要指定哪幾台（unit_ids），每台都要是「可用」；整批填數量，不能超過可借數。
   * 耗材不能借，要用領用。檢查與寫入同一把 lock，兩人同時借最後一台才不會都成功。
   */
  borrow(input, ctx) {
    if (input.due_date && input.due_date < todayIso_()) throw new AppError(ERROR_CODES.VALIDATION, '歸還日不能早於今天');
    return withScriptLock_(() => {
      const item = repo_('inventory').findById(input.inventory_id);
      if (!item) throw new AppError(ERROR_CODES.NOT_FOUND, '找不到資材');
      if (itemKind_(item) === INVENTORY_KIND.CONSUMABLE) throw new AppError(ERROR_CODES.VALIDATION, '耗材用完不歸還，請用「領用」');
      const base = Object.assign({ loan_date: todayIso_() }, input, { borrower_account: input.borrower_account || ctx.account, status: LOAN_STATUS.OUT });
      if (itemMode_(item) === TRACK_MODE.UNIT) {
        const ids = (Array.isArray(input.unit_ids) ? input.unit_ids : String(input.unit_ids || '').split(',')).map(String).filter(Boolean);
        if (!ids.length) throw new AppError(ERROR_CODES.VALIDATION, '請勾選要借哪幾台');
        const units = indexBy_(unitsOf_(item.id), 'id');
        ids.forEach(id => {
          const u = units[id];
          if (!u) throw new AppError(ERROR_CODES.VALIDATION, '有一台不屬於「' + item.name + '」，請重新整理');
          if (u.status !== UNIT_STATUS.AVAILABLE) throw new AppError(ERROR_CODES.VALIDATION, u.asset_tag + ' 目前是「' + u.status + '」，不能借');
        });
        const patches = {};
        ids.forEach(id => { patches[id] = { status: UNIT_STATUS.ON_LOAN }; });
        repo_('inventory_units').updateMany(patches, ctx.account);
        return repo_('loans').insert(Object.assign(base, { quantity: ids.length, unit_ids: ids.join(',') }), ctx.account);
      }
      const qty = Number(input.quantity);
      if (!(qty > 0)) throw new AppError(ERROR_CODES.VALIDATION, '借用數量必須大於 0');
      const available = this.list().find(i => i.id === item.id).available;
      if (qty > available) throw new AppError(ERROR_CODES.VALIDATION, '「' + item.name + '」目前只剩 ' + available + ' ' + (item.unit || '件') + '可借');
      const record = Object.assign(base, { quantity: qty });
      delete record.unit_ids;
      return repo_('loans').insert(record, ctx.account);
    });
  },

  /** 歸還；逐台的可註明哪幾台有損壞，那幾台改成「維修」，其他回到「可用」。 */
  giveBack(id, expected, damagedUnitIds, ctx) {
    return withScriptLock_(() => {
      const repo = repo_('loans');
      const snapshot = loadCurrentForWrite_(repo, id, expected);
      if (snapshot.record.status !== LOAN_STATUS.OUT) throw new AppError(ERROR_CODES.VALIDATION, '這筆已經歸還了');
      const unitIds = String(snapshot.record.unit_ids || '').split(',').filter(Boolean);
      if (unitIds.length) {
        const damaged = {};
        (damagedUnitIds || []).forEach(u => { damaged[u] = true; });
        const patches = {};
        unitIds.forEach(u => { patches[u] = { status: damaged[u] ? UNIT_STATUS.REPAIR : UNIT_STATUS.AVAILABLE }; });
        repo_('inventory_units').updateMany(patches, ctx.account);
      }
      return repo.writeSnapshot(snapshot, { status: LOAN_STATUS.RETURNED, returned_at: nowIso_() }, ctx.account);
    });
  },

  loans() {
    const today = todayIso_();
    const items = indexBy_(repo_('inventory').findAll(), 'id');
    const units = indexBy_(repo_('inventory_units').findAll({ includeDeleted: true }), 'id');
    return sortBy_(repo_('loans').findAll(), 'loan_date').reverse().map(l => Object.assign({}, l, {
      item_name: items[l.inventory_id] ? items[l.inventory_id].name : '',
      unit: items[l.inventory_id] ? items[l.inventory_id].unit : '',
      unit_tags: String(l.unit_ids || '').split(',').filter(Boolean).map(u => units[u] ? units[u].asset_tag : '?'),
      overdue: l.status === LOAN_STATUS.OUT && !!l.due_date && l.due_date < today,
    }));
  },

  // ---------- 耗材 ----------

  /** 入庫、領用、盤點調整。盤點填的是實際清點的數量，系統算差額。 */
  moveStock(input, ctx) {
    const kind = input.kind;
    if ([STOCK_MOVE.IN, STOCK_MOVE.OUT, STOCK_MOVE.ADJUST].indexOf(kind) === -1) throw new AppError(ERROR_CODES.VALIDATION, '異動類型不正確');
    const qty = Number(input.quantity);
    if (!(kind === STOCK_MOVE.ADJUST ? qty >= 0 : qty > 0)) throw new AppError(ERROR_CODES.VALIDATION, kind === STOCK_MOVE.ADJUST ? '盤點數量不能小於 0' : '數量必須大於 0');
    return withScriptLock_(() => {
      const repo = repo_('inventory');
      const item = repo.findById(input.inventory_id);
      if (!item) throw new AppError(ERROR_CODES.NOT_FOUND, '找不到資材');
      if (itemKind_(item) !== INVENTORY_KIND.CONSUMABLE) throw new AppError(ERROR_CODES.VALIDATION, '「' + item.name + '」是資產，請用借用與歸還');
      const stock = Number(item.quantity) || 0;
      let delta = kind === STOCK_MOVE.IN ? qty : kind === STOCK_MOVE.OUT ? -qty : qty - stock;
      if (stock + delta < 0) throw new AppError(ERROR_CODES.VALIDATION, '「' + item.name + '」庫存只有 ' + stock + ' ' + (item.unit || '') + '，不夠領用');
      const balance = stock + delta;
      repo.updateMany({ [item.id]: { quantity: balance } }, ctx.account);
      return repo_('stock_moves').insert({ inventory_id: item.id, kind, quantity: delta, balance, project_id: input.project_id || null,
        account: input.account || ctx.account, move_date: input.move_date || todayIso_(), note: input.note || null }, ctx.account);
    });
  },

  moves(itemId) {
    return sortBy_(repo_('stock_moves').findWhere(m => !itemId || m.inventory_id === itemId), 'created_at').reverse();
  },
};

function assertUnitValues_(data, selfId) {
  if ('status' in data && [UNIT_STATUS.AVAILABLE, UNIT_STATUS.ON_LOAN, UNIT_STATUS.REPAIR, UNIT_STATUS.RETIRED].indexOf(data.status) === -1) {
    throw new AppError(ERROR_CODES.VALIDATION, '狀態只能是可用、維修或報廢');
  }
  if ('asset_tag' in data) {
    const tag = String(data.asset_tag || '').trim();
    if (!tag) throw new AppError(ERROR_CODES.VALIDATION, '請填財產編號');
    const dupe = repo_('inventory_units').findWhere(u => u.id !== selfId && normName_(u.asset_tag) === normName_(tag))[0];
    if (dupe) throw new AppError(ERROR_CODES.VALIDATION, '財產編號 ' + tag + ' 已經用過了');
  }
}

function inventoryRoutes_() {
  const r = INTERNAL_ROLES_;
  const idArgs = p => [requireString_(p, 'id'), requireString_(p, 'expectedUpdatedAt')];
  return {
    'inventory.options': { roles: r, handler: () => InventoryService.options() },
    'inventory.withStock': { roles: r, handler: () => InventoryService.list() },
    'inventory.create': { roles: r, handler: (p, ctx) => InventoryService.create(pickAllowed_(p.record || {}, INVENTORY_FIELDS_, '資材'), ctx) },
    'inventory.update': { roles: r, handler: (p, ctx) => {
      const a = updateArgs_(p, INVENTORY_FIELDS_, '資材');
      return InventoryService.update(a.id, a.expected, a.patch, ctx);
    } },
    'inventory.delete': { roles: r, handler: (p, ctx) => withScriptLock_(() => {
      const [id, expected] = idArgs(p);
      if (repo_('loans').findWhere(l => l.inventory_id === id && l.status === LOAN_STATUS.OUT).length) throw new AppError(ERROR_CODES.VALIDATION, '還有借出中的紀錄，不能刪除');
      const repo = repo_('inventory');
      return repo.markDeleted(loadCurrentForWrite_(repo, id, expected), ctx.account);
    }) },
    'inventory.setMode': { roles: r, handler: (p, ctx) => InventoryService.setMode(...idArgs(p), p.kind || null, p.track_mode || null, ctx) },
    'inventory.units': { roles: r, handler: p => InventoryService.units(requireString_(p, 'inventory_id')) },
    'inventory.addUnit': { roles: r, handler: (p, ctx) =>
      InventoryService.addUnit(requireString_(p, 'inventory_id'), pickAllowed_(p.record || {}, UNIT_FIELDS_, '單台資料'), ctx) },
    'inventory.updateUnit': { roles: r, handler: (p, ctx) => {
      const a = updateArgs_(p, UNIT_FIELDS_, '單台資料');
      return InventoryService.updateUnit(a.id, a.expected, a.patch, ctx);
    } },
    'inventory.deleteUnit': { roles: r, handler: (p, ctx) => InventoryService.deleteUnit(...idArgs(p), ctx) },
    'loan.list': { roles: r, handler: () => InventoryService.loans() },
    'loan.borrow': { roles: r, handler: (p, ctx) =>
      InventoryService.borrow(pickAllowed_(p.record || {}, ['inventory_id', 'borrower_account', 'project_id', 'quantity', 'unit_ids', 'loan_date', 'due_date', 'note'], '借用'), ctx) },
    'loan.return': { roles: r, handler: (p, ctx) => InventoryService.giveBack(...idArgs(p), Array.isArray(p.damaged_unit_ids) ? p.damaged_unit_ids.map(String) : [], ctx) },
    'stock.move': { roles: r, handler: (p, ctx) =>
      InventoryService.moveStock(pickAllowed_(p.record || {}, ['inventory_id', 'kind', 'quantity', 'project_id', 'account', 'move_date', 'note'], '庫存異動'), ctx) },
    'stock.moves': { roles: r, handler: p => InventoryService.moves(p.inventory_id || null) },
  };
}
