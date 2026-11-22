import { useState } from "react";
import { call } from "../api";
import { PROJECT_TYPES } from "./Projects";
import Inventory from "./Inventory";
import { Badge, CrudPage, Loading, Modal, Page, RecordForm, Table, Tabs, shortDate, useAction, useLoad, useLookups } from "../ui";

export default function Resources() {
  const lk = useLookups();
  const tabs: [string, string][] = [["inventory", "資材"], ["sops", "SOP"], ["cases", "案例"]];
  if (lk.can("admin")) tabs.push(["credentials", "帳密大全"]);
  const [tab, setTab] = useState("inventory");
  return (
    <>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === "inventory" && <Inventory />}
      {tab === "sops" && <Sops />}
      {tab === "cases" && <CrudPage title="案例" prefix="case" canWrite fields={[
        { name: "title", label: "案例名稱", required: true, full: true }, { name: "client_name", label: "客戶" }, { name: "year", label: "年度" },
        { name: "category", label: "類別" }, { name: "project_id", label: "對應專案", type: "project" }, { name: "link", label: "成果連結", type: "url", full: true },
        { name: "summary", label: "摘要", type: "textarea" },
      ]} columns={[{ key: "title", label: "案例" }, { key: "client_name", label: "客戶" }, { key: "year", label: "年度" }, { key: "category", label: "類別", hideSm: true }]} />}
      {tab === "credentials" && <CrudPage title="帳密大全" sub="只有管理者看得到；每次開啟都會留下查看紀錄。" prefix="credential" canWrite
        importAction="import.credentials" importHint="表頭要有「項目」，可有「類別」「帳號」「密碼」「網址」「備註」。檔案只在這台電腦的瀏覽器裡讀取，直接存進公司資料庫；同項目＋帳號的會更新密碼。"
        searchKeys={["category", "service", "username", "note"]} fields={[
        { name: "category", label: "類別" }, { name: "service", label: "項目", required: true }, { name: "url", label: "網址", type: "url" }, { name: "username", label: "帳號" },
        { name: "password", label: "密碼" }, { name: "owner", label: "負責人" }, { name: "note", label: "備註", type: "textarea" },
      ]} columns={[{ key: "service", label: "項目", render: c => <><b>{c.service}</b><small className="muted block">{c.category || ""}</small></> }, { key: "username", label: "帳號" }, { key: "password", label: "密碼" }, { key: "note", label: "備註", hideSm: true }]} />}
    </>
  );
}


function Sops() {
  const lk = useLookups();
  const { data, error, loading, reload } = useLoad<any[]>("sop.list");
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const { busy, run } = useAction();
  const canWrite = lk.can("admin", "manager");
  const save = async (v: any) => {
    const r = await run(() => editing ? call("sop.update", { id: editing.id, expectedUpdatedAt: editing.updated_at, patch: v }) : call("sop.create", { record: v }), "已儲存草稿");
    if (r) { setEditing(undefined); reload(); }
  };
  const publish = async (s: any) => {
    if (!confirm("發布「" + s.title + "」第 " + (s.version || "?") + " 版？同名的舊版會改成已停用。")) return;
    const r = await run(() => call("sop.publish", { id: s.id, expectedUpdatedAt: s.updated_at }), "已發布");
    if (r) reload();
  };
  const LABEL: Record<string, string> = { draft: "草稿", active: "生效中", superseded: "已停用" };
  return (
    <Page title="SOP 標準作業" sub="新版發布後舊版自動停用（保留不刪），同一份 SOP 永遠只有一個生效版本。"
      actions={canWrite && <button className="btn primary" onClick={() => setEditing(null)}>＋ 新增 SOP</button>}>
      <Loading error={error} loading={loading && !data} />
      {data && <Table rows={data.slice().sort((a, b) => (a.status === "active" ? -1 : 1) - (b.status === "active" ? -1 : 1))} empty="還沒有 SOP。" columns={[
        { key: "s", label: "狀態", render: s => <Badge text={LABEL[s.status] || s.status} tone={s.status === "active" ? "green" : s.status === "draft" ? "yellow" : ""} /> },
        { key: "title", label: "SOP", render: s => <><b>{s.title}</b><small className="muted block">第 {s.version || "?"} 版・{s.category || ""}{s.project_types ? "・適用：" + s.project_types : ""}</small></> },
        { key: "file", label: "檔案", render: s => s.file_url ? <a href={s.file_url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>開啟 ↗</a> : "—" },
        { key: "x", label: "", render: s => canWrite ? <>{s.status === "draft" && <button className="btn small primary" disabled={busy} onClick={() => publish(s)}>發布</button>} <button className="btn small" onClick={() => setEditing(s)}>編輯</button></> : null },
      ]} />}
      {editing !== undefined && <Modal title={editing ? editing.title : "新增 SOP（草稿）"} onClose={() => setEditing(undefined)}>
        <RecordForm busy={busy} initial={editing || undefined} onCancel={() => setEditing(undefined)} onSubmit={save} fields={[
          { name: "title", label: "名稱", required: true, full: true }, { name: "version", label: "版本" }, { name: "category", label: "類別" },
          { name: "effective_date", label: "生效日", type: "date" }, { name: "project_types", label: "適用活動類型（不勾＝全部）", type: "multi", options: PROJECT_TYPES, full: true },
          { name: "file_url", label: "檔案連結（雲端硬碟）", type: "url", full: true }, { name: "note", label: "備註", type: "textarea" },
        ]} />
      </Modal>}
    </Page>
  );
}
