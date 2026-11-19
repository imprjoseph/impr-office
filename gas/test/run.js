/**
 * 本機測試：用模擬的 SpreadsheetApp 跑 gas/src 的真實程式碼。
 * 執行：node gas/test/run.js（可加關鍵字只跑名稱含該字的測試）
 *
 * 模擬環境驗證不了 Sheets 的自動型別轉換與真實效能；上線前要在試用版用真實資料跑一遍。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { load } = require('./harness');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const ctx = { assert, test };

fs.readdirSync(__dirname).filter(f => /^t-.*\.js$/.test(f)).sort()
  .forEach(f => require(path.join(__dirname, f))(test, ctx));

const filter = process.argv[2];
let passed = 0;
const run = tests.filter(t => !filter || t.name.includes(filter));
run.forEach(t => {
  try {
    t.fn(load());
    passed++;
    console.log('PASS ' + t.name);
  } catch (e) {
    console.log('FAIL ' + t.name + '\n     ' + String(e.stack).split('\n').slice(0, 6).join('\n     '));
  }
});
console.log('\n' + passed + '/' + run.length + ' passed');
process.exit(passed === run.length ? 0 : 1);
