/**
 * 最小的 GAS 全域物件模擬，只涵蓋 src/ 用到的 API。
 * 每個 Sheet 記錄 API 呼叫次數，讓測試能斷言「整表讀取只呼叫一次 getValues」（沒有 N+1）。
 */
const crypto = require('crypto');

class MockRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
    this.sheet.calls.getValues++;
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const src = this.sheet.data[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = src[this.col - 1 + c];
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  getValue() {
    this.sheet.calls.getValue++;
    return this.getValues()[0][0];
  }
  setValues(values) {
    this.sheet.calls.setValues++;
    if (values.length !== this.numRows || values.some(r => r.length !== this.numCols)) {
      throw new Error('setValues dimension mismatch');
    }
    values.forEach((line, r) => {
      const target = (this.sheet.data[this.row - 1 + r] = this.sheet.data[this.row - 1 + r] || []);
      line.forEach((v, c) => { target[this.col - 1 + c] = v; });
    });
    return this;
  }
  setNumberFormat() { return this; }
  // 公式另存在 sheet.formulas（key 為「列,欄」），測試只需要知道哪一格有公式、內容是什麼。
  getFormulas() { return this.getFormulasR1C1(); }
  getFormulasR1C1() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) line.push(this.sheet.formulas[(this.row + r) + ',' + (this.col + c)] || '');
      out.push(line);
    }
    return out;
  }
  setFormulasR1C1(values) {
    values.forEach((line, r) => line.forEach((f, c) => {
      if (f) this.sheet.formulas[(this.row + r) + ',' + (this.col + c)] = f;
    }));
    return this;
  }
}

class MockSheet {
  constructor(name) {
    this.name = name;
    this.data = [];
    this.formulas = {};
    this.resetCalls();
  }
  resetCalls() { this.calls = { getValues: 0, getValue: 0, setValues: 0 }; }
  getName() { return this.name; }
  getLastRow() { return this.data.length; }
  getLastColumn() { return this.data.reduce((m, r) => Math.max(m, r.length), 0); }
  getDataRange() {
    return new MockRange(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()));
  }
  getRange(row, col, numRows, numCols) {
    if (numCols === 0) throw new Error('number of columns must be at least 1');
    return new MockRange(this, row, col, numRows || 1, numCols || 1);
  }
  getRangeList() { return { setNumberFormat() { return this; } }; }
  setFrozenRows() {}
}

class MockSpreadsheet {
  constructor(id) { this.id = id || 'mock'; this.sheets = {}; }
  getId() { return this.id; }
  getSheetByName(name) { return this.sheets[name] || null; }
  insertSheet(name) {
    if (this.sheets[name]) throw new Error('sheet exists: ' + name);
    return (this.sheets[name] = new MockSheet(name));
  }
  getSheets() { return Object.values(this.sheets); }
  deleteSheet(sheet) { delete this.sheets[sheet.getName()]; }
}

function createGasGlobals() {
  const spreadsheet = new MockSpreadsheet();
  const cacheStore = new Map();
  const cacheCalls = { get: 0, put: 0, remove: 0 };
  let lockHeld = false;
  let activeEmail = 'pm@example.com';
  const properties = {};
  const created = [];
  const fetchCalls = [];

  const env = {
    spreadsheet,
    fetchCalls,
    urlFetchHandler: null,
    mails: [],
    docs: [],
    cacheStore,
    cacheCalls,
    properties,
    created,
    setActiveEmail(email) { activeEmail = email; },
    // 給測試建立其他試算表（例如活動進度追蹤表），openById 就找得到。
    addSpreadsheet(id) {
      const ss = new MockSpreadsheet(id);
      created.push(ss);
      return ss;
    },
    globals: {
      console,
      SpreadsheetApp: {
        openById: id => {
          const found = id === spreadsheet.getId() ? spreadsheet : created.find(s => s.getId() === id);
          if (!found) throw new Error('not found: ' + id);
          return found;
        },
        getActiveSpreadsheet: () => spreadsheet,
        create: () => {
          const ss = new MockSpreadsheet('temp' + (created.length + 1));
          created.push(ss);
          return ss;
        },
      },
      PropertiesService: {
        getScriptProperties: () => ({
          getProperty: k => (k in properties ? properties[k] : null),
          setProperty: (k, v) => { properties[k] = v; },
        }),
      },
      Utilities: {
        getUuid: () => crypto.randomUUID(),
        DigestAlgorithm: { SHA_256: 'sha256' },
        Charset: { UTF_8: 'utf8' },
        computeDigest: (alg, text) => [...crypto.createHash('sha256').update(String(text), 'utf8').digest()].map(b => (b > 127 ? b - 256 : b)),
        // 測試一律以 UTC 當腳本時區，「今天」和測試裡用 toISOString 算的日期一致。
        formatDate: (d, tz, pattern) => {
          const iso = d.toISOString();
          return String(pattern || 'yyyy-MM-dd').replace('yyyy', iso.slice(0, 4)).replace('MM', iso.slice(5, 7))
            .replace('dd', iso.slice(8, 10)).replace('HH', iso.slice(11, 13)).replace('mm', iso.slice(14, 16)).replace('ss', iso.slice(17, 19));
        },
      },
      Session: {
        getActiveUser: () => ({ getEmail: () => activeEmail }),
        getEffectiveUser: () => ({ getEmail: () => activeEmail }),
        getScriptTimeZone: () => 'Asia/Taipei',
      },
      LockService: {
        getScriptLock: () => ({
          tryLock: () => (lockHeld = true),
          hasLock: () => lockHeld,
          releaseLock: () => { lockHeld = false; },
        }),
      },
      // 測試以 env.urlFetchHandler 決定帳號中心的回應；預設模擬連不上。
      UrlFetchApp: {
        fetch: (url, opts) => {
          fetchCalls.push({ url, opts });
          const body = env.urlFetchHandler ? env.urlFetchHandler(url, opts) : null;
          if (body === null) throw new Error('network');
          return { getResponseCode: () => 200, getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) };
        },
      },
      // 寄信與建立文件只記錄下來，讓測試檢查寄給誰、寫了什麼。
      MailApp: { sendEmail: msg => { env.mails.push(msg); } },
      DocumentApp: {
        ParagraphHeading: { HEADING1: 'H1', HEADING2: 'H2', HEADING3: 'H3' },
        create: title => {
          const paras = [];
          const doc = { title, paras, getBody: () => ({ appendParagraph: t => { const p = { t, setHeading(h) { p.h = h; return p; } }; paras.push(p); return p; } }),
            saveAndClose() {}, getUrl: () => 'https://docs.google.com/document/d/mock-' + env.docs.length };
          env.docs.push(doc);
          return doc;
        },
      },
      ContentService: {
        MimeType: { JSON: 'json' },
        createTextOutput: text => ({ text, setMimeType() { return this; } }),
      },
      CacheService: {
        getScriptCache: () => ({
          get: k => { cacheCalls.get++; return cacheStore.has(k) ? cacheStore.get(k) : null; },
          put: (k, v) => { cacheCalls.put++; cacheStore.set(k, v); },
          remove: k => { cacheCalls.remove++; cacheStore.delete(k); },
        }),
      },
    },
  };
  return env;
}

module.exports = { createGasGlobals };
