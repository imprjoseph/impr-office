import { useState } from "react";
import { call } from "../api";
import { Badge, Field, Loading, Modal, Page, RecordForm, Table, Tabs, money, shortDate, useAction, useLoad, useLookups } from "../ui";
import { EXPENSE_LABEL } from "./Dashboard";

export default function Expenses() {
  const lk = useLookups();
  const tabs: [string, string][] = [["mine", "我的請款"]];
  if (lk.can("admin", "manager")) tabs.push(["approve", "待我核准"]);
  if (lk.can("admin", "accountant")) tabs.push(["pay", "待付款"]);
  if (lk.can("admin", "manager", "accountant")) tabs.push(["all", "全部"]);
  const [scope, setScope] = useState("mine");
  const { data, error, loading, reload } = useLoad<any[]>("expense.list", { scope });
  const cats = useLoad<string[]>("expense.categories");
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const [viewing, setViewing] = useState<any | null>(null);
  const [lines, setLines] = useState<any[]>([]);
  const { busy, run } = useAction();

  const fields: Field[] = [
    { name: "description", label: "內容", required: true, full: true },
    { name: "category", label: "類別", type: "select", options: cats.data || [], required: true },
    { name: "amount", label: "金額（含稅）", type: "number", required: true },
    { name: "project_id", label: "掛哪個專案", type: "project", hint: "掛專案的費用核准後會計入專案成本" },
    { name: "budget_line_id", label: "預算科目", type: "select", options: lines.map(l => [l.id, l.category + "／" + l.item] as [string, string]) },
    { name: "receipt_date", label: "單據日期", type: "date" }, { name: "receipt_no", label: "發票或收據號碼" },
    { name: "receipt_url", label: "單據照片連結（雲端硬碟）", type: "url", full: true },
    { name: "payee", label: "付款對象", type: "select", options: ["代墊（付給我）", "付給供應商"] }, { name: "supplier_id", label: "供應商", type: "supplier" },
  ];
  const loadLines = async (projectId?: string | null) => {
    if (!projectId) return setLines([]);
    try { setLines((await call<any>("budget.get", { project_id: projectId })).lines); } catch { setLines([]); }
  };
  const open = (e: any | null) => { setEditing(e); loadLines(e?.project_id); };
  const save = async (v: any) => {
    const r = await run(() => editing ? call("expense.update", { id: editing.id, expectedUpdatedAt: editing.updated_at, patch: v }) : call("expense.create", { record: v }), "已儲存草稿");
    if (r) { setEditing(undefined); reload(); }
  };
  const act = async (e: any, action: string, ok: string, needNote?: string) => {
    let note: string | null = null;
    if (needNote) { note = prompt(needNote); if (note === null) return; }
    const r = await run(() => call("expense." + action, { id: e.id, expectedUpdatedAt: e.updated_at, note }), ok);
    if (r) { setViewing(null); reload(); }
  };
  const total = (data || []).reduce((s, e) => s + (Number(e.amount) || 0), 0);
  return (
    <Page title="請款與報帳" sub="申請人送出 → 直屬主管核准 → 會計付款；掛專案的費用核准後自動計入專案成本。"
      actions={<button className="btn primary" onClick={() => open(null)}>＋ 新增請款</button>}>
      <Tabs tabs={tabs} value={scope} onChange={setScope} />
      <Loading error={error} loading={loading && !data} />
      {data && <>
        <p className="muted">{data.length} 筆，合計 {money(total)} 元</p>
        <Table rows={data} onRow={e => setViewing(e)} empty="沒有請款。" columns={[
          { key: "status", label: "狀態", render: e => <Badge text={EXPENSE_LABEL[e.status]} /> },
          { key: "description", label: "內容", render: e => <><b>{e.description}</b><small className="muted block">{e.category}・{lk.projectName(e.project_id)}</small></> },
          { key: "who", label: "申請人", hideSm: true, render: e => lk.nameOf(e.claimant_account) },
          { key: "date", label: "日期", hideSm: true, render: e => shortDate(e.receipt_date || (e.created_at || "").slice(0, 10)) },
          { key: "amount", label: "金額", num: true, render: e => money(e.amount) },
        ]} />
      </>}
      {viewing && (
        <Modal title={viewing.description} onClose={() => setViewing(null)}>
          <dl className="dl">
            <dt>狀態</dt><dd><Badge text={EXPENSE_LABEL[viewing.status]} /></dd>
            <dt>金額</dt><dd>{money(viewing.amount)} 元</dd>
            <dt>申請人</dt><dd>{lk.nameOf(viewing.claimant_account)}</dd>
            <dt>專案</dt><dd>{lk.projectName(viewing.project_id)}</dd>
            <dt>單據</dt><dd>{viewing.receipt_no || "—"} {viewing.receipt_url && <a href={viewing.receipt_url} target="_blank" rel="noopener noreferrer">查看單據 ↗</a>}</dd>
            {viewing.review_note && <><dt>審核意見</dt><dd>{viewing.review_note}</dd></>}
            {viewing.pay_note && <><dt>付款備註</dt><dd>{viewing.pay_note}</dd></>}
          </dl>
          <div className="modal-foot">
            {viewing.claimant_account === lk.me.account && ["draft", "rejected"].includes(viewing.status) && <>
              <button className="btn" onClick={() => { setViewing(null); open(viewing); }}>修改</button>
              <button className="btn primary" disabled={busy} onClick={() => act(viewing, "submit", "已送出，等待主管核准")}>送出</button>
            </>}
            {scope === "approve" && viewing.status === "submitted" && <>
              <button className="btn" disabled={busy} onClick={() => act(viewing, "reject", "已退回", "退回原因（申請人會看到）")}>退回</button>
              <button className="btn primary" disabled={busy} onClick={() => act(viewing, "approve", "已核准")}>核准</button>
            </>}
            {scope === "pay" && viewing.status === "approved" && <button className="btn primary" disabled={busy} onClick={() => act(viewing, "pay", "已付款", "付款備註（例如匯款日期、帳號末五碼）")}>標記已付款</button>}
          </div>
        </Modal>
      )}
      {editing !== undefined && (
        <Modal title={editing ? "修改請款" : "新增請款"} onClose={() => setEditing(undefined)}>
          <RecordForm busy={busy} initial={editing || undefined} onSubmit={save} onCancel={() => setEditing(undefined)} submitLabel="存成草稿"
            fields={fields} onValuesChange={(name, v) => { if (name === "project_id") loadLines(v); }} />
        </Modal>
      )}
    </Page>
  );
}
