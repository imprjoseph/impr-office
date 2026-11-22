/**
 * 報價參考：每個品項有公司估算單價（vendor_name 空白）與各廠商報價。
 * 比價表依「品項＋類型」分組，列出估算價與每家廠商的報價、標出最低價；做專案預算時直接挑品項、填數量帶入。
 */
const PRICE_REF_FIELDS_ = ['item', 'type', 'vendor_name', 'supplier_id', 'unit_price', 'quote_price', 'unit', 'note', 'quoted_at'];

/** 品項的對客戶參考報價：有填就用；沒填且設定了加成比例，用成本 × (1 + 加成)；都沒有就是 null。 */
function quoteFor_(quotePrice, cost) {
  if (quotePrice !== null && quotePrice !== undefined && quotePrice !== '') return Number(quotePrice);
  const markup = Number(setting_('quote_markup')) || 0;
  return markup > 0 && cost ? Math.round(cost * (1 + markup)) : null;
}

function priceKey_(r) {
  return normName_(r.item) + '|' + normName_(r.type || '') + '|' + normName_(r.vendor_name || '');
}

/** 廠商名稱對到供應商：完全相同優先，再找「供應商名稱包含報價上的簡稱」的唯一一家。 */
function matchSupplier_(name, suppliers) {
  const n = normName_(name);
  if (!n) return null;
  const exact = suppliers.find(s => normName_(s.name) === n);
  if (exact) return exact.id;
  const partial = suppliers.filter(s => normName_(s.name).indexOf(n) !== -1);
  return partial.length === 1 ? partial[0].id : null;
}

const PriceRefService = {
  list() {
    const suppliers = indexBy_(repo_('suppliers').findAll(), 'id');
    return sortBy_(repo_('price_refs').findAll(), 'item').map(r => Object.assign({}, r, {
      supplier_name: r.supplier_id && suppliers[r.supplier_id] ? suppliers[r.supplier_id].name : null,
    }));
  },

  /** 比價：同品項＋類型一組，estimate 是公司估算，quotes 是各廠商報價（由低到高），lowest 是最低的廠商報價。 */
  compare() {
    const groups = {};
    this.list().forEach(r => {
      const k = normName_(r.item) + '|' + normName_(r.type || '');
      const g = groups[k] = groups[k] || { item: r.item, type: r.type || null, unit: r.unit || null, estimate: null, quotes: [] };
      if (r.vendor_name) g.quotes.push(r); else g.estimate = r;
      if (!g.unit && r.unit) g.unit = r.unit;
    });
    return Object.keys(groups).map(k => {
      const g = groups[k];
      g.quotes.sort((a, b) => (a.unit_price == null ? 1e15 : a.unit_price) - (b.unit_price == null ? 1e15 : b.unit_price));
      g.lowest = g.quotes.find(q => q.unit_price != null) || null;
      // 對客戶報價：品項任一列有填就用（通常填在公司估算那列）；沒填就依設定的加成比例，從估算價（或最低廠商價）推算。
      const filled = [g.estimate].concat(g.quotes).find(r => r && r.quote_price !== null && r.quote_price !== undefined && r.quote_price !== '');
      const base = g.estimate && g.estimate.unit_price != null ? g.estimate.unit_price : g.lowest ? g.lowest.unit_price : null;
      g.quote_price = quoteFor_(filled ? filled.quote_price : null, base);
      g.quote_is_markup = !filled && g.quote_price !== null;
      return g;
    }).sort((a, b) => String(a.type || '').localeCompare(String(b.type || '')) || String(a.item).localeCompare(String(b.item)));
  },

  /** 匯入：有「廠商」欄的是廠商報價，沒有的是公司估算。同品項＋類型＋廠商已存在就更新單價、單位、備註。 */
  importRows(sheets, ctx) {
    return withScriptLock_(() => {
      const repo = repo_('price_refs');
      const suppliers = repo_('suppliers').findAll();
      const existing = {};
      repo.findAll().forEach(r => { existing[priceKey_(r)] = r; });
      const inserts = [], patches = {};
      let skipped = 0;
      (sheets || []).forEach(sh => (sh.rows || []).forEach(row => {
        const item = pickCol_(row, ['品項', '項目', '名稱']);
        if (!item) { skipped++; return; }
        const priceText = pickCol_(row, ['估價', '單價', '報價', '價格']);
        const price = priceText === null ? null : Number(String(priceText).replace(/[,\s元$]/g, ''));
        const vendor = pickCol_(row, ['廠商', '供應商']);
        const qText = pickCol_(row, ['對客戶報價', '對外報價', '建議報價', '售價']);
        const qPrice = qText === null ? null : Number(String(qText).replace(/[,\s元$]/g, ''));
        const rec = { item, type: pickCol_(row, ['類型', '類別']), vendor_name: vendor, unit_price: isFinite(price) ? price : null,
          quote_price: qText !== null && isFinite(qPrice) ? qPrice : null, unit: pickCol_(row, ['單位']), note: pickCol_(row, ['備註']) };
        if (vendor) rec.supplier_id = matchSupplier_(vendor, suppliers);
        Object.keys(rec).forEach(k => { if (rec[k] === null || rec[k] === undefined) delete rec[k]; });
        const cur = existing[priceKey_(rec)];
        if (!cur) { inserts.push(rec); existing[priceKey_(rec)] = rec; return; }
        if (!cur.id) { skipped++; return; }
        const patch = {};
        ['unit_price', 'quote_price', 'unit', 'note', 'supplier_id'].forEach(k => { if (k in rec && String(cur[k] == null ? '' : cur[k]) !== String(rec[k])) patch[k] = rec[k]; });
        if (Object.keys(patch).length) patches[cur.id] = patch; else skipped++;
      }));
      if (inserts.length) repo.insertMany(inserts, ctx.account);
      if (Object.keys(patches).length) repo.updateMany(patches, ctx.account);
      return { inserted: inserts.length, updated: Object.keys(patches).length, skipped };
    });
  },
};

function priceRefRoutes_() {
  const r = INTERNAL_ROLES_;
  return Object.assign(
    crudRoutes_('priceRef', 'price_refs', { read: r, write: r, fields: PRICE_REF_FIELDS_, label: '報價參考',
      validate: x => { if (x.unit_price !== null && x.unit_price !== undefined && x.unit_price !== '' && Number(x.unit_price) < 0) throw new AppError(ERROR_CODES.VALIDATION, '單價不能小於 0'); } }),
    {
      'priceRef.list': { roles: r, handler: () => PriceRefService.list() },
      'priceRef.compare': { roles: r, handler: () => PriceRefService.compare() },
      'import.priceRefs': { roles: [ROLES.ADMIN, ROLES.MANAGER], handler: (p, ctx) => PriceRefService.importRows(requireArray_(p, 'sheets'), ctx) },
    });
}
