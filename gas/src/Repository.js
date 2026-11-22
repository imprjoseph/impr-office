/**
 * Repository 層：只做 Sheet I/O，不做業務判斷。
 *
 * 讀取一律 getDataRange().getValues() 一次取回再在記憶體過濾，
 * 因為每次 SpreadsheetApp 呼叫都是一次遠端往返，逐列讀取到幾百列就會逼近 6 分鐘上限。
 *
 * 寫入必須在呼叫端持有 script lock 時進行（見 ServiceSupport.js），
 * 因為新增是「最後一列 + 1」，兩個請求同時新增會寫進同一列互相覆蓋。
 */

const CACHE_TTL_SECONDS_ = 6 * 60 * 60;
const CACHE_VERSION_ = 'v1';

// 每次 GAS 執行都是全新的全域環境，所以這裡的實例就是「請求內記憶體」那一層快取。
let repositories_ = {};

function repo_(tableName) {
  if (!repositories_[tableName]) repositories_[tableName] = new SheetRepository(tableName);
  return repositories_[tableName];
}

function resetRepositories_() {
  repositories_ = {};
}

class SheetRepository {
  constructor(tableName) {
    const def = TABLES[tableName];
    if (!def) throw new AppError(ERROR_CODES.SCHEMA, '未定義的資料表：' + tableName);
    this.tableName = tableName;
    this.def = def;
    this.columns = tableColumns_(def);
    this.memo_ = null;
  }

  // ---------- 讀取 ----------

  findAll(options) {
    const includeDeleted = !!(options && options.includeDeleted);
    return this.readRecords_()
      .filter(r => includeDeleted || !r.is_deleted)
      .map(r => Object.assign({}, r));
  }

  findById(id, options) {
    return this.findAll(options).find(r => r.id === id) || null;
  }

  // Service 要查多筆時用這個或 findAll 後自建索引，不要在迴圈裡呼叫 findById，交易表每次都會重讀整張 Sheet。
  findWhere(predicate, options) {
    return this.findAll(options).filter(predicate);
  }

  // ---------- 寫入 ----------

  insert(data, actor) {
    return this.insertMany([data], actor)[0];
  }

  insertMany(list, actor) {
    this.assertWritable_(actor);
    if (!list.length) return [];
    const sheet = this.sheet_();
    const lastColumn = sheet.getLastColumn();
    const header = lastColumn ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0] : [];
    const index = this.indexHeader_(header);
    const now = nowIso_();

    const rows = list.map(data => {
      this.rejectSystemOrUnknownFields_(data);
      const record = Object.assign({}, data, {
        id: newId_(this.def.prefix),
        created_at: now,
        created_by: actor,
        updated_at: now,
        updated_by: actor,
        is_deleted: false,
      });
      this.validate_(record);
      return this.toRow_(record, index, new Array(header.length).fill(''));
    });

    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, header.length).setValues(rows);
    this.invalidate_();
    return rows.map(row => this.toRecord_(row, index));
  }

  /**
   * 只驗證不寫入。跨表一次建立多筆時（會議 + 待辦）先全部驗過再寫，
   * 因為 Sheets 沒有交易，寫到一半失敗會留下沒有待辦的會議或沒有會議的待辦。
   */
  assertInsertable(list) {
    list.forEach(data => {
      this.rejectSystemOrUnknownFields_(data);
      this.validate_(Object.assign({}, data, { id: this.def.prefix + '_pending' }));
    });
  }

  /**
   * 為寫入而讀：一定直接讀 Sheet、不走快取，因為快取裡的列號可能已經因手動插刪列而失效。
   * 回傳的 snapshot 交給 Service 比對 updated_at 後再呼叫 writeSnapshot / markDeleted。
   */
  readForWrite(id) {
    const values = this.sheet_().getDataRange().getValues();
    const index = this.indexHeader_(values[0]);
    for (let i = 1; i < values.length; i++) {
      if (values[i][index.id] === id) {
        return { rowNumber: i + 1, row: values[i], index, record: this.toRecord_(values[i], index) };
      }
    }
    return null;
  }

  writeSnapshot(snapshot, patch, actor) {
    this.rejectSystemOrUnknownFields_(patch);
    return this.writeRow_(snapshot, patch, actor);
  }

  markDeleted(snapshot, actor) {
    return this.writeRow_(snapshot, { is_deleted: true }, actor);
  }

  /**
   * 一次更新多筆：讀一次、寫一次。只給系統推導的彙總寫入用（例如供應商評分重算），
   * 不比對 expectedUpdatedAt；使用者發起的修改必須走 ServiceSupport 的樂觀鎖流程。
   * patchesById = { id: patch }
   */
  updateMany(patchesById, actor) {
    Object.keys(patchesById).forEach(id => this.rejectSystemOrUnknownFields_(patchesById[id]));
    return this.writeMany_(patchesById, actor);
  }

  /** 一次邏輯刪除多筆（刪專案時連帶刪工作、會議、預算科目）；讀一次、寫一次。 */
  markDeletedMany(ids, actor) {
    const patches = {};
    ids.forEach(id => { patches[id] = { is_deleted: true }; });
    return this.writeMany_(patches, actor);
  }

  writeMany_(patchesById, actor) {
    this.assertWritable_(actor);
    const ids = Object.keys(patchesById);
    if (!ids.length) return [];

    const sheet = this.sheet_();
    const values = sheet.getDataRange().getValues();
    const index = this.indexHeader_(values[0]);
    const rowIndexById = {};
    for (let i = 1; i < values.length; i++) {
      if (patchesById[values[i][index.id]]) rowIndexById[values[i][index.id]] = i;
    }
    const missing = ids.filter(id => rowIndexById[id] === undefined);
    if (missing.length) throw new AppError(ERROR_CODES.NOT_FOUND, '找不到資料：' + missing.join(', '), { missing });

    const records = ids.map(id => {
      const i = rowIndexById[id];
      const current = this.toRecord_(values[i], index);
      const merged = Object.assign({}, current, patchesById[id], {
        updated_at: nextTimestamp_(current.updated_at),
        updated_by: actor,
      });
      this.validate_(merged);
      values[i] = this.toRow_(merged, index, values[i].slice());
      return this.toRecord_(values[i], index);
    });

    // 寫回涵蓋所有目標列的連續區塊，只呼叫一次 setValues；區塊內沒改的列寫回剛讀到的原值，在 script lock 內是安全的。
    const rowIndexes = ids.map(id => rowIndexById[id]);
    const first = Math.min.apply(null, rowIndexes);
    const last = Math.max.apply(null, rowIndexes);
    const block = values.slice(first, last + 1);
    // 和單筆寫入一樣，寫入前確認區塊內的 id 沒有因手動插刪列而偏移。
    const liveIds = sheet.getRange(first + 1, index.id + 1, block.length, 1).getValues().map(r => r[0]);
    if (liveIds.some((id, k) => id !== block[k][index.id])) {
      throw new AppError(ERROR_CODES.CONFLICT, '資料列位置已變動，請重新整理後再試');
    }
    sheet.getRange(first + 1, 1, block.length, values[0].length).setValues(block);
    this.invalidate_();
    return records;
  }

  // ---------- 內部 ----------

  writeRow_(snapshot, patch, actor) {
    this.assertWritable_(actor);
    const sheet = this.sheet_();
    const idColumn = snapshot.index.id + 1;
    // 讀完到寫入之間若有人手動插入/刪除列，列號會偏移；寫入前再確認一次該列仍是同一筆，避免蓋到別的記錄。
    if (sheet.getRange(snapshot.rowNumber, idColumn).getValue() !== snapshot.record.id) {
      throw new AppError(ERROR_CODES.CONFLICT, '資料列位置已變動，請重新整理後再試', { id: snapshot.record.id });
    }
    const merged = Object.assign({}, snapshot.record, patch, {
      updated_at: nextTimestamp_(snapshot.record.updated_at),
      updated_by: actor,
    });
    this.validate_(merged);
    // 從原列複製再覆寫，保留 Sheet 上 schema 以外的手動欄位。
    const row = this.toRow_(merged, snapshot.index, snapshot.row.slice());
    sheet.getRange(snapshot.rowNumber, 1, 1, row.length).setValues([row]);
    this.invalidate_();
    return this.toRecord_(row, snapshot.index);
  }

  readRecords_() {
    if (this.memo_) return this.memo_;
    if (this.def.cache) {
      const cached = this.cacheGet_();
      if (cached) return (this.memo_ = cached);
    }
    const values = this.sheet_().getDataRange().getValues();
    const index = this.indexHeader_(values[0]);
    const records = [];
    for (let i = 1; i < values.length; i++) {
      // 跳過整列清空的空白列（手動刪內容但沒刪列時會出現）。
      if (values[i][index.id] === '') continue;
      records.push(this.toRecord_(values[i], index));
    }
    // 交易表不留 memo：同一請求內讀第二次也要拿到最新值，避免檔期/預算判斷用到舊資料。
    if (this.def.cache) {
      this.memo_ = records;
      this.cachePut_(records);
    }
    return records;
  }

  sheet_() {
    const sheet = getSpreadsheet_().getSheetByName(this.def.sheet);
    if (!sheet) {
      throw new AppError(ERROR_CODES.SCHEMA, '找不到分頁 ' + this.def.sheet + '，請先執行 setupSheets()');
    }
    return sheet;
  }

  indexHeader_(header) {
    const index = {};
    (header || []).forEach((name, i) => {
      const key = String(name).trim();
      if (key && index[key] === undefined) index[key] = i;
    });
    const missing = this.columns.filter(c => index[c.name] === undefined).map(c => c.name);
    if (missing.length) {
      throw new AppError(ERROR_CODES.SCHEMA,
        '分頁 ' + this.def.sheet + ' 缺少欄位：' + missing.join(', ') + '，請執行 setupSheets()', { missing });
    }
    return index;
  }

  assertWritable_(actor) {
    // 空的 actor 會讓稽核軌跡失去意義，寧可擋下寫入。
    if (!actor) throw new AppError(ERROR_CODES.AUTH, '寫入必須帶操作者帳號');
    if (!LockService.getScriptLock().hasLock()) {
      throw new AppError(ERROR_CODES.LOCK, '寫入 ' + this.tableName + ' 前必須先取得 script lock');
    }
  }

  rejectSystemOrUnknownFields_(data) {
    const known = this.def.columns.map(c => c.name);
    const bad = Object.keys(data || {}).filter(k => known.indexOf(k) === -1);
    // 拼錯的欄位名稱若默默忽略，資料會「看似存了其實沒存」；系統欄位則只能由 Repository 決定。
    if (bad.length) {
      throw new AppError(ERROR_CODES.VALIDATION, '不允許寫入的欄位：' + bad.join(', '), { fields: bad });
    }
  }

  validate_(record) {
    const errors = [];
    this.columns.forEach(col => {
      const v = record[col.name];
      const empty = v === null || v === undefined || v === '';
      if (empty) {
        if (col.required) errors.push(col.name + ' 必填');
        return;
      }
      if (col.type === COLUMN_TYPES.NUMBER && !isFinite(Number(v))) errors.push(col.name + ' 必須是數字');
      if (col.type === COLUMN_TYPES.DATE && !(isDate_(v)) && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) {
        errors.push(col.name + ' 必須是 yyyy-MM-dd');
      }
      if (col.type === COLUMN_TYPES.DATETIME && !(isDate_(v)) && isNaN(Date.parse(v))) {
        errors.push(col.name + ' 必須是 ISO 時間');
      }
    });
    if (errors.length) throw new AppError(ERROR_CODES.VALIDATION, errors.join('；'), { errors });
  }

  toRow_(record, index, baseRow) {
    this.columns.forEach(col => {
      baseRow[index[col.name]] = serializeValue_(col.type, record[col.name]);
    });
    return baseRow;
  }

  toRecord_(row, index) {
    const record = {};
    this.columns.forEach(col => {
      record[col.name] = deserializeValue_(col.type, row[index[col.name]]);
    });
    return record;
  }

  // key 帶試算表 ID：CacheService 是整個腳本共用，驗證用的暫存試算表若共用 key，會把假資料留給正式庫讀 6 小時。
  cacheKey_() {
    return cacheKeyFor_(getSpreadsheet_().getId(), this.tableName);
  }

  cacheGet_() {
    const json = CacheService.getScriptCache().get(this.cacheKey_());
    return json ? JSON.parse(json) : null;
  }

  cachePut_(records) {
    try {
      CacheService.getScriptCache().put(this.cacheKey_(), JSON.stringify(records), CACHE_TTL_SECONDS_);
    } catch (e) {
      // CacheService 單值上限 100KB，超過就只用請求內記憶體；快取失敗不應讓讀取失敗。
      console.warn('cache skipped for ' + this.tableName + ': ' + e.message);
    }
  }

  invalidate_() {
    this.memo_ = null;
    if (this.def.cache) CacheService.getScriptCache().remove(this.cacheKey_());
  }
}

function cacheKeyFor_(spreadsheetId, tableName) {
  return 'repo:' + CACHE_VERSION_ + ':' + spreadsheetId + ':' + tableName;
}

function serializeValue_(type, value) {
  if (value === null || value === undefined || value === '') {
    return type === COLUMN_TYPES.BOOL ? false : '';
  }
  switch (type) {
    case COLUMN_TYPES.BOOL:
      return value === true || String(value).toUpperCase() === 'TRUE';
    case COLUMN_TYPES.NUMBER:
      return Number(value);
    case COLUMN_TYPES.DATE:
      return isDate_(value)
        ? Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : String(value);
    case COLUMN_TYPES.DATETIME:
      return isDate_(value) ? value.toISOString() : new Date(value).toISOString();
    default:
      return String(value);
  }
}

function deserializeValue_(type, value) {
  if (type === COLUMN_TYPES.BOOL) return value === true || String(value).toUpperCase() === 'TRUE';
  if (value === null || value === undefined || value === '') return null;
  switch (type) {
    case COLUMN_TYPES.NUMBER:
      return Number(value);
    // 正常情況下這兩種欄位是純文字；若有人把格式改掉讓 Sheets 轉成 Date，這裡轉回字串保持一致。
    case COLUMN_TYPES.DATE:
      return isDate_(value)
        ? Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : String(value);
    case COLUMN_TYPES.DATETIME:
      return isDate_(value) ? value.toISOString() : String(value);
    default:
      return String(value);
  }
}
