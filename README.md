# imPR 公司系統（impr-office）

一個網站、一個資料庫、帳號統一由帳號中心管理。取代出勤、派遣、物資、event-ops、活動進度追蹤表、CRM、工時週報等分散的系統。

| 模組 | 內容 |
|---|---|
| 專案 | 專案（EVT-年度-流水號）、工作追蹤（狀態／最新進度／下一步／卡關原因、燈號）、T-60 工作範本、會議與待辦、供應商檔期、結案評分 |
| 標案 | 評估 → 準備 → 投標 → 結果；得標一鍵建立專案並套範本 |
| 預算與費用 | 預算科目、增減項、毛利即時重算與警示；請款與報帳（申請人 → 直屬主管 → 會計付款），核准後計入專案成本 |
| 人力 | 考勤（辦公室／出差打卡、請假、加班、補卡、主管審核、月報）、派遣（排班、現場打卡、回報；工時 × 時薪計入專案成本）、工時週報 |
| 資源 | 客戶、聯絡人、往來紀錄、供應商、資材借還、SOP（版本控制）、媒體名單、案例、帳密大全（限管理者） |
| AI | 新聞稿、致詞稿、建議書初稿、結案報告（Claude）；每日待辦提醒、主管週報；AI 平面設計（Claude 寫文案與生圖提示詞，同仁貼到生圖工具使用） |

## 架構

- `gas/`：Apps Script 後端（以部署者身分執行、匿名可呼叫，身分一律由帳號中心的憑證證明）。Controller → Service → Repository 三層，沿用 event-ops 的 Repository／樂觀鎖。
- `web/`：React + Vite 前端，部署到 GitHub Pages（與入口網站同網域，共用登入）。
- 角色在帳號中心的 `office` 欄：`admin`、`manager`、`accountant`、`staff`、`dispatch`。派遣帳號一律當 dispatch。

## 開發

```bash
node gas/test/run.js                       # 後端測試（模擬試算表）
node gas/test/dev-server.js 8795           # 本機後端＋示範資料
cd web && VITE_API_URL=http://localhost:8795 npx vite   # 前端
```

## 部署

1. `cd gas && npx @google/clasp push --force`，再 `clasp deploy -i <部署 ID>`。
2. 第一次：在 Apps Script 編輯器執行 `setupDatabase()`（建立資料庫）、`installTriggers()`（每日提醒、週報）。
3. 指令碼屬性：`ANTHROPIC_API_KEY`（AI 功能）、`OLD_ATTENDANCE_SHEET_ID`、`OLD_CRM_SHEET_ID`（搬資料）。
4. 前端：`cd web && VITE_API_URL=<部署網址> npm run build`，把 `web/dist` 推到 GitHub Pages。

## 搬資料與切換

1. 新系統「人員」頁按「從帳號中心同步」。
2. 編輯器執行 `migrateDryRun()` 看報告（新增幾筆、對不上的人名），補好帳號後執行 `migrateAll()`。可重複執行，不會重複新增。
3. 切換日：舊系統設唯讀 → 再跑一次 `migrateAll()` → 入口網站改連新系統。
