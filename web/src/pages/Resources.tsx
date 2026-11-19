import { useState } from "react";
import { call } from "../api";
import { Badge, CrudPage, Loading, Modal, Page, RecordForm, Table, Tabs, shortDate, useAction, useLoad, useLookups } from "../ui";

export default function Resources() {
  const lk = useLookups();
  const tabs: [string, string][] = [["inventory", "資材借還"], ["sops", "SOP"], ["media", "媒體名單"], ["cases", "案例"]];
  if (lk.can("admin")) tabs.push(["credentials", "帳密大全"]);
  const [tab, setTab] = useState("inventory");
  return (
    <>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === "inventory" && <Inventory />}
      {tab === "sops" && <Sops />}
      {tab === "media" && <CrudPage title="媒體名單" prefix="media" canWrite fields={[
        { name: "outlet", label: "媒體", required: true }, { name: "name", label: "記者" }, { name: "title", label: "職稱" }, { name: "beat", label: "路線" },
        { name: "phone", label: "電話" }, { name: "email", label: "Email", type: "email" }, { name: "note", label: "備註", type: "textarea" },
      ]} columns={[{ key: "outlet", label: "媒體" }, { key: "name", label: "記者" }, { key: "beat", label: "路線", hideSm: true }, { key: "phone", label: "電話" }]} />}
      {tab === "cases" && <CrudPage title="案例" prefix="case" canWrite fields={[
        { name: "title", label: "案例名稱", required: true, full: true }, { name: "client_name", label: "客戶" }, { name: "year", label: "年度" },
        { name: "category", label: "類別" }, { name: "project_id", label: "對應專案", type: "project" }, { name: "link", label: "成果連結", type: "url", full: true },
        { name: "summary", label: "摘要", type: "textarea" },
      ]} columns={[{ key: "title", label: "案例" }, { key: "client_name", label: "客戶" }, { key: "year", label: "年度" }, { key: "category", label: "類別", hideSm: true }]} />}
      {tab === "credentials" && <CrudPage title="帳密大全" sub="只有管理者看得到；每次開啟都會留下查看紀錄。" prefix="credential" canWrite fields={[
        { name: "service", label: "服務", required: true }, { name: "url", label: "網址", type: "url" }, { name: "username", label: "帳號" },
        { name: "password", label: "密碼" }, { name: "owner", label: "負責人" }, { name: "note", label: "備註", type: "textarea" },
      ]} columns={[{ key: "service", label: "服務" }, { key: "username", label: "帳號" }, { key: "password", label: "密碼" }, { key: "owner", label: "負責人", hideSm: true }]} />}
    </>
  );
}

function Inventory() {
  const lk = useLookups();
  const items = useLoad<any[]>("inventory.withStock");
  const loans = useLoad<any[]>("loan.list");
  const [borrowing, setBorrowing] = useState<any | null>(null);
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const { busy, run } = useAction();
  const reload = () => { items.reload(); loans.reload(); };
  const borrow = async (v: any) => {
    const r = await run(() => call("loan.borrow", { record: Object.assign({ inventory_id: borrowing.id }, v) }), "已登記借用");
    if (r) { setBorrowing(null); reload(); }
  };
  const giveBack = async (l: any) => {
    const r = await run(() => call("loan.return", { id: l.id, expectedUpdatedAt: l.updated_at }), "已歸還");
    if (r) reload();
  };
  const save = async (v: any) => {
    const r = await run(() => editing ? call("inventory.update", { id: editing.id, expectedUpdatedAt: editing.updated_at, patch: v }) : call("inventory.create", { record: v }), "已儲存");
    if (r) { setEditing(undefined); reload(); }
  };
  return (
    <Page title="資材借還" actions={<button className="btn primary" onClick={() => setEditing(null)}>＋ 新增資材</button>}>
      <Loading error={items.error} loading={items.loading && !items.data} />
      {items.data && <Table rows={items.data} empty="還沒有資材。" columns={[
        { key: "name", label: "資材", render: i => <><b>{i.name}</b><small className="muted block">{i.category || ""}{i.location ? "・" + i.location : ""}</small></> },
        { key: "q", label: "可借／總數", num: true, render: i => <span className={i.available <= 0 ? "red" : ""}>{i.available}/{i.quantity ?? 0} {i.unit || ""}</span> },
        { key: "m", label: "管理人", hideSm: true, render: i => lk.nameOf(i.manager_account) },
        { key: "x", label: "", render: i => <><button className="btn small" disabled={i.available <= 0} onClick={() => setBorrowing(i)}>借用</button> <button className="btn small" onClick={() => setEditing(i)}>編輯</button></> },
      ]} />}
      <h3>借用紀錄</h3>
      {loans.data && <Table rows={loans.data} empty="沒有借用紀錄。" columns={[
        { key: "s", label: "狀態", render: l => l.overdue ? <Badge text="已逾期" /> : <Badge text={l.status} tone={l.status === "已歸還" ? "green" : "yellow"} /> },
        { key: "item", label: "資材", render: l => l.item_name + " × " + l.quantity },
        { key: "who", label: "借用人", render: l => lk.nameOf(l.borrower_account) },
        { key: "p", label: "專案", hideSm: true, render: l => l.project_id ? lk.projectName(l.project_id) : "—" },
        { key: "due", label: "歸還日", render: l => shortDate(l.due_date) },
        { key: "x", label: "", render: l => l.status === "借出中" ? <button className="btn small" disabled={busy} onClick={() => giveBack(l)}>歸還</button> : null },
      ]} />}
      {borrowing && <Modal title={"借用：" + borrowing.name} onClose={() => setBorrowing(null)}>
        <RecordForm busy={busy} initial={undefined} onCancel={() => setBorrowing(null)} onSubmit={borrow} submitLabel="登記借用" fields={[
          { name: "quantity", label: "數量（可借 " + borrowing.available + "）", type: "number", required: true },
          { name: "borrower_account", label: "借用人（空白是自己）", type: "person" }, { name: "project_id", label: "用在哪個專案", type: "project" },
          { name: "due_date", label: "預計歸還日", type: "date" }, { name: "note", label: "備註", type: "textarea" },
        ]} />
      </Modal>}
      {editing !== undefined && <Modal title={editing ? editing.name : "新增資材"} onClose={() => setEditing(undefined)}>
        <RecordForm busy={busy} initial={editing || undefined} onCancel={() => setEditing(undefined)} onSubmit={save} fields={[
          { name: "name", label: "名稱", required: true }, { name: "category", label: "類別" }, { name: "quantity", label: "總數量", type: "number" },
          { name: "unit", label: "單位" }, { name: "location", label: "存放位置" }, { name: "manager_account", label: "管理人", type: "person" },
          { name: "photo_url", label: "照片連結", type: "url" }, { name: "note", label: "備註", type: "textarea" },
        ]} />
      </Modal>}
    </Page>
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
          { name: "effective_date", label: "生效日", type: "date" }, { name: "project_types", label: "適用活動類型（逗號分隔，空白＝全部）" },
          { name: "file_url", label: "檔案連結（雲端硬碟）", type: "url", full: true }, { name: "note", label: "備註", type: "textarea" },
        ]} />
      </Modal>}
    </Page>
  );
}
