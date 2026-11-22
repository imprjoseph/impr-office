/**
 * 從 Excel 匯入：檔案在使用者瀏覽器裡讀成 { 工作表名稱, 每列 { 表頭: 值 } }，送到這裡依表頭對應欄位。
 * 已存在的（供應商同名、帳密同項目＋帳號）更新，不重複新增；回傳新增、更新、略過的筆數。
 * 帳密只有 admin 能匯入，並記稽核紀錄（不記內容）。
 */

// 工作表名稱 → 供應商類別（廠商資料 Excel 一個類別一個分頁）
const SUPPLIER_SHEET_CATEGORY_ = {
  '展場布置大圖輸出': '印刷／輸出', '展覽桌椅租賃': '桌椅租賃', '活動音響燈光': '音響', '攝影': '攝影／錄影', '影像製作': '影像製作',
  '主持人': '主持／表演', '動畫製作': '動畫', '印刷設計排版': '印刷／輸出', '媒體廣告行銷': '媒體廣告', '視覺設計': '設計',
  '網頁製作': '網頁製作', '口譯筆譯': '口譯', '人像修圖': '修圖',
};

/** 從一列裡取第一個有值的欄位（不同分頁表頭寫法不同）。 */
function pickCol_(row, names) {
  for (let i = 0; i < names.length; i++) {
    const v = row[names[i]];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

/** Excel 把電話存成數字時會吃掉開頭的 0（0912… 變 912…），補回來。 */
function fixPhone_(v) {
  if (!v) return v;
  const s = String(v).trim();
  return /^[1-9]\d{7,8}$/.test(s) ? '0' + s : s;
}

function supplierFromRow_(sheetName, row) {
  const name = pickCol_(row, ['廠商名稱', '名稱', '公司名稱']);
  if (!name) return null;
  const email = pickCol_(row, ['電子郵件', 'Email', 'email', '電子郵件或line']);
  const extras = [
    ['語言', pickCol_(row, ['語言'])], ['主持經歷', pickCol_(row, ['主持經歷'])], ['主持範例', pickCol_(row, ['主持範例'])],
    ['接案地點', pickCol_(row, ['接案地點'])], ['作品', [row['作品1'], row['作品2'], row['作品3']].filter(Boolean).join(' ') || null],
    ['備註', pickCol_(row, ['備註'])],
  ].filter(([, v]) => v).map(([k, v]) => k + '：' + v);
  return {
    name,
    category: SUPPLIER_SHEET_CATEGORY_[sheetName] || (SUPPLIER_CATEGORIES.indexOf(sheetName) !== -1 ? sheetName : '其他'),
    service_items: pickCol_(row, ['專業項目', '服務項目']),
    phone: fixPhone_(pickCol_(row, ['電話', '公司電話'])),
    address: pickCol_(row, ['地址']),
    business_hours: pickCol_(row, ['營業時間']),
    contact_name: pickCol_(row, ['業務承辦人', '聯絡人', '窗口']),
    contact_phone: fixPhone_(pickCol_(row, ['業務電話', '業務承辦人電話', '聯絡電話'])),
    contact_email: email && /@/.test(email) ? email : null,
    website: pickCol_(row, ['官方網站', '網站']),
    note: [email && !/@/.test(email) ? 'LINE：' + email : null].concat(extras).filter(Boolean).join('\n') || null,
  };
}

const ImportService = {
  /** 供應商：同名的只補空白欄位（不覆蓋同仁已改過的資料），新的就新增。 */
  suppliers(sheets, ctx) {
    return withScriptLock_(() => {
      const repo = repo_('suppliers');
      const byName = {};
      repo.findAll().forEach(s => { byName[normName_(s.name)] = s; });
      const inserts = [], patches = {};
      let skipped = 0;
      (sheets || []).forEach(sh => (sh.rows || []).forEach(row => {
        const rec = supplierFromRow_(String(sh.name || ''), row);
        if (!rec) { skipped++; return; }
        const key = normName_(rec.name);
        const cur = byName[key];
        if (!cur) {
          inserts.push(rec);
          byName[key] = rec;
          return;
        }
        if (!cur.id) { skipped++; return; } // 同一個檔案裡重複出現
        const patch = {};
        Object.keys(rec).forEach(k => { if (rec[k] && (cur[k] === null || cur[k] === undefined || cur[k] === '')) patch[k] = rec[k]; });
        if (Object.keys(patch).length) patches[cur.id] = Object.assign(patches[cur.id] || {}, patch); else skipped++;
      }));
      if (inserts.length) repo.insertMany(inserts, ctx.account);
      if (Object.keys(patches).length) repo.updateMany(patches, ctx.account);
      return { inserted: inserts.length, updated: Object.keys(patches).length, skipped };
    });
  },

  /** 帳密：同「項目＋帳號」的更新密碼與備註，新的新增。 */
  credentials(sheets, ctx) {
    return withScriptLock_(() => {
      const repo = repo_('credentials');
      const key = c => normName_(c.service) + '|' + normName_(c.username || '');
      const existing = {};
      repo.findAll().forEach(c => { existing[key(c)] = c; });
      const inserts = [], patches = {};
      let skipped = 0;
      (sheets || []).forEach(sh => (sh.rows || []).forEach(row => {
        const rec = {
          category: pickCol_(row, ['類別', '分類']),
          service: pickCol_(row, ['項目', '服務', '名稱', '系統']),
          url: pickCol_(row, ['網址', '連結', 'URL', 'url']),
          username: pickCol_(row, ['帳號', '使用者名稱', 'username']),
          password: pickCol_(row, ['密碼', 'password']),
          note: pickCol_(row, ['備註', '說明']),
        };
        if (!rec.service) { skipped++; return; }
        Object.keys(rec).forEach(k => { if (rec[k] === null) delete rec[k]; });
        const cur = existing[key(rec)];
        if (!cur) { inserts.push(rec); existing[key(rec)] = rec; return; }
        if (!cur.id) { skipped++; return; }
        const patch = {};
        Object.keys(rec).forEach(k => { if (String(cur[k] == null ? '' : cur[k]) !== String(rec[k])) patch[k] = rec[k]; });
        if (Object.keys(patch).length) patches[cur.id] = patch; else skipped++;
      }));
      if (inserts.length) repo.insertMany(inserts, ctx.account);
      if (Object.keys(patches).length) repo.updateMany(patches, ctx.account);
      audit_(ctx, 'credential.import', 'credentials', null, { inserted: inserts.length, updated: Object.keys(patches).length });
      return { inserted: inserts.length, updated: Object.keys(patches).length, skipped };
    });
  },
};

function importRoutes_() {
  return {
    'import.suppliers': { roles: [ROLES.ADMIN, ROLES.MANAGER], handler: (p, ctx) => ImportService.suppliers(requireArray_(p, 'sheets'), ctx) },
    'import.credentials': { roles: [ROLES.ADMIN], handler: (p, ctx) => ImportService.credentials(requireArray_(p, 'sheets'), ctx) },
  };
}
