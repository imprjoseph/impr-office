import { useState } from "react";
import { call } from "../api";
import { CrudPage, Loading, Page, Table, Tabs, useAction, useLoad } from "../ui";

export default function Admin() {
  const [tab, setTab] = useState("settings");
  return (
    <>
      <Tabs tabs={[["settings", "設定值"], ["templates", "工作範本"], ["holidays", "假日"], ["devices", "打卡設備"], ["audit", "稽核紀錄"], ["ai", "AI 用量"]]} value={tab} onChange={setTab} />
      {tab === "settings" && <Settings />}
      {tab === "templates" && <CrudPage title="工作範本（T-60）" sub="新專案或標案得標時，依活動日期自動產生這些工作；offset 以活動日為 T 日，T-60 填 -60。" prefix="template" canWrite fields={[
        { name: "category", label: "工作分類", required: true }, { name: "title", label: "標準工作項目", required: true, full: true },
        { name: "offset_days", label: "期限（T 日加減天數）", type: "number", required: true }, { name: "priority", label: "重要性", type: "select", options: ["關鍵", "高", "中", "低"] },
        { name: "role", label: "建議負責角色" }, { name: "sort", label: "排序", type: "number" },
        { name: "done_criteria", label: "完成判斷", type: "textarea" }, { name: "tip", label: "實務提醒", type: "textarea" },
      ]} columns={[
        { key: "offset_days", label: "期限", render: t => "T" + (t.offset_days >= 0 ? "+" : "") + t.offset_days },
        { key: "category", label: "分類" }, { key: "title", label: "工作項目" }, { key: "priority", label: "重要性", hideSm: true },
      ]} />}
      {tab === "holidays" && <CrudPage title="假日" sub="HOLIDAY 放假、WORKDAY 補班；沒列的日子依週一到週五判斷。" prefix="holiday" canWrite fields={[
        { name: "holiday_date", label: "日期", type: "date", required: true }, { name: "name", label: "名稱", required: true },
        { name: "kind", label: "類型", type: "select", options: [["HOLIDAY", "放假"], ["WORKDAY", "補班"]], required: true },
      ]} columns={[{ key: "holiday_date", label: "日期" }, { key: "name", label: "名稱" }, { key: "kind", label: "類型", render: h => h.kind === "WORKDAY" ? "補班" : "放假" }]} />}
      {tab === "devices" && <CrudPage title="打卡設備" sub="辦公室打卡要「辦公室 IP」加上這裡登記的設備；設備識別碼在該設備的考勤頁可以看到。" prefix="device" canWrite fields={[
        { name: "device_key", label: "設備識別碼", required: true, full: true }, { name: "name", label: "名稱（例如：櫃台桌機）" },
        { name: "registered_by", label: "登記人" }, { name: "active", label: "啟用", type: "checkbox" },
      ]} columns={[{ key: "name", label: "名稱" }, { key: "device_key", label: "識別碼" }, { key: "active", label: "啟用", render: d => d.active ? "是" : "否" }]} />}
      {tab === "audit" && <Audit />}
      {tab === "ai" && <AiUsage />}
    </>
  );
}

function Settings() {
  const { data, error, loading, reload } = useLoad<any[]>("settings.list");
  const { busy, run } = useAction();
  const edit = async (s: any) => {
    const value = prompt(s.note || s.key, s.value ?? "");
    if (value === null) return;
    const r = await run(() => call("settings.update", { id: s.id, expectedUpdatedAt: s.updated_at, patch: { value } }), "已儲存");
    if (r) reload();
  };
  return (
    <Page title="設定值">
      <Loading error={error} loading={loading && !data} />
      {data && <Table rows={data} onRow={busy ? undefined : edit} columns={[{ key: "note", label: "說明" }, { key: "value", label: "設定值" }, { key: "key", label: "代號", hideSm: true }]} />}
    </Page>
  );
}

function Audit() {
  const { data, error, loading } = useLoad<any[]>("audit.list");
  return (
    <Page title="稽核紀錄" sub="核准、付款、查看帳密等敏感操作。">
      <Loading error={error} loading={loading && !data} />
      {data && <Table rows={data} columns={[{ key: "t", label: "時間", render: a => (a.created_at || "").replace("T", " ").slice(0, 16) }, { key: "created_by", label: "操作者" }, { key: "action", label: "動作" }, { key: "detail", label: "內容", hideSm: true }]} />}
    </Page>
  );
}

function AiUsage() {
  const { data, error, loading } = useLoad<any>("ai.usage");
  return (
    <Page title="AI 用量">
      <Loading error={error} loading={loading && !data} />
      {data && <p>{data.month}：{data.jobs} 次，共 {data.tokens.toLocaleString()} tokens（上限 {data.limit.toLocaleString()}）。</p>}
    </Page>
  );
}
