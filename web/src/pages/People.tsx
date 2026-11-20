import { useState } from "react";
import { call } from "../api";
import { ROLE_LABEL } from "../App";
import { Badge, Loading, Modal, Page, RecordForm, Table, useAction, useLoad, useLookups } from "../ui";

export default function People() {
  const lk = useLookups();
  const { data, error, loading, reload } = useLoad<any[]>("people.list");
  const [editing, setEditing] = useState<any | null>(null);
  const [kind, setKind] = useState("");
  const { busy, run } = useAction();
  const canEdit = lk.can("admin", "manager");
  const sync = async () => {
    const r = await run(() => call<any>("people.sync"));
    if (r) { alert("已從帳號中心同步：新增 " + r.added + " 人、更新 " + r.updated + " 人"); reload(); lk.refresh(["people"]); }
  };
  const save = async (v: any) => {
    const r = await run(() => call("people.update", { id: editing.id, expectedUpdatedAt: editing.updated_at, patch: v }), "已儲存");
    if (r) { setEditing(null); reload(); lk.refresh(["people"]); }
  };
  const rows = (data || []).filter(p => !kind || p.kind === kind);
  return (
    <Page title="人員" sub="帳號、姓名、部門、主管在帳號中心維護，主管開啟系統時自動同步；「未開通」的人要在帳號中心的 office 欄填角色才能登入。地區、合約等人事資料在這裡補。"
      actions={canEdit && <button className="btn" onClick={sync} disabled={busy}>從帳號中心同步</button>}>
      <div className="toolbar">
        <select value={kind} onChange={e => setKind(e.target.value)} aria-label="類型"><option value="">全部</option><option>正職</option><option>派遣</option></select>
        <span className="muted">{rows.length} 人</span>
      </div>
      <Loading error={error} loading={loading && !data} />
      {data && <Table rows={rows} onRow={canEdit ? p => setEditing(p) : undefined} columns={[
        { key: "name", label: "姓名", render: p => <><b>{p.name}</b><small className="muted block">{p.account}</small></> },
        { key: "kind", label: "類型" }, { key: "dept", label: "部門", hideSm: true },
        { key: "manager", label: "主管", hideSm: true, render: p => lk.nameOf(p.manager_account) },
        { key: "role", label: "新系統", render: p => p.office_role ? <Badge text={ROLE_LABEL[p.office_role] || p.office_role} tone="green" /> : <Badge text="未開通" tone="yellow" /> },
      ]} />}
      {editing && (
        <Modal title={editing.name} onClose={() => setEditing(null)}>
          <RecordForm busy={busy} initial={editing} onSubmit={save} onCancel={() => setEditing(null)} fields={[
            { name: "phone", label: "電話" }, { name: "region", label: "地區" },
            { name: "rating", label: "評價（1–5）", type: "number" },
            { name: "contract_start", label: "合約開始", type: "date" }, { name: "contract_end", label: "合約結束", type: "date" },
            { name: "note", label: "備註", type: "textarea" },
          ]} />
        </Modal>
      )}
    </Page>
  );
}
