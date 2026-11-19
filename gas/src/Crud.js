/**
 * 一般主資料的增刪改查：客戶、聯絡人、媒體、案例、資材、SOP 等規則單純的表共用。
 * 有業務規則的表（專案、費用、打卡…）各自寫 Service，不走這裡。
 *
 * 寫入一律經 ServiceSupport（script lock + 樂觀鎖），刪除是邏輯刪除。
 */

/**
 * opts:
 * - fields：可寫欄位白名單
 * - read / write：可讀、可寫的角色
 * - hide(ctx)：回傳這個人看不到的欄位名稱（逐欄過濾，例如時薪、成本）
 * - validate(record)：寫入前的額外檢查
 */
function crudRoutes_(prefix, table, opts) {
  const label = opts.label || table;
  const strip = (ctx, rows) => {
    const hidden = opts.hide ? opts.hide(ctx) : [];
    if (!hidden.length) return rows;
    return rows.map(r => { const c = Object.assign({}, r); hidden.forEach(h => { delete c[h]; }); return c; });
  };
  const check = (record) => { if (opts.validate) opts.validate(record); };
  return {
    [prefix + '.list']: { roles: opts.read, handler: (p, ctx) => strip(ctx, repo_(table).findAll()) },
    [prefix + '.create']: { roles: opts.write, handler: (p, ctx) => {
      const data = pickAllowed_(p.record || {}, opts.fields, label);
      // 檢查（例如重名）和寫入在同一把 lock 內，兩人同時新增同名資料才擋得住。
      return strip(ctx, [withScriptLock_(() => { check(data); return repo_(table).insert(data, ctx.account); })])[0];
    } },
    [prefix + '.update']: { roles: opts.write, handler: (p, ctx) => {
      const a = updateArgs_(p, opts.fields, label);
      return strip(ctx, [withScriptLock_(() => {
        const repo = repo_(table);
        const snapshot = loadCurrentForWrite_(repo, a.id, a.expected);
        check(Object.assign({}, snapshot.record, a.patch));
        return repo.writeSnapshot(snapshot, a.patch, ctx.account);
      })])[0];
    } },
    [prefix + '.delete']: { roles: opts.write, handler: (p, ctx) =>
      softDeleteRecord_(table, requireString_(p, 'id'), requireString_(p, 'expectedUpdatedAt'), ctx.account).id },
  };
}

/** 名稱重複檢查（不分大小寫、忽略空白）：同一家公司分成兩筆，往來紀錄與評分就各算各的。 */
function assertUniqueName_(table, field, record, label) {
  const key = normName_(record[field]);
  const dupe = repo_(table).findAll().find(r => r.id !== record.id && normName_(r[field]) === key);
  if (dupe) throw new AppError(ERROR_CODES.VALIDATION, '已經有同名的' + label + '「' + dupe[field] + '」，請直接修改那一筆');
}

function normName_(v) {
  return String(v || '').replace(/\s+/g, '').toLowerCase();
}

function indexBy_(rows, key) {
  const out = {};
  rows.forEach(r => { out[r[key]] = r; });
  return out;
}

/** 依欄位排序：空值排最後；數字比大小（不用字串比，否則 10 會排在 2 前面），其餘比字串。 */
function sortBy_(rows, key) {
  const empty = v => v === null || v === undefined || v === '';
  return rows.slice().sort((a, b) => {
    const x = a[key], y = b[key];
    if (empty(x) || empty(y)) return empty(x) === empty(y) ? 0 : (empty(x) ? 1 : -1);
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x).localeCompare(String(y));
  });
}

function sum_(rows, key) {
  return rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
}

function audit_(ctx, action, entity, entityId, detail) {
  repo_('audit_log').insert({ action, entity, entity_id: entityId, detail: detail ? JSON.stringify(detail) : null }, ctx.account);
}
