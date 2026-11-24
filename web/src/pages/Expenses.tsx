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
  const payees = useLoad<string[]>("expense.payees");
  const [payee, setPayee] = useState<string>("");
  const { busy, run } = useAction();

  const fields: Field[] = [
    { name: "description", label: "內容", required: true, full: true },
    { name: "category", label: "類別", type: "select", options: cats.data || [], required: true },
    { name: "amount", label: "金額（含稅）", type: "number", required: true },
    { name: "project_id", label: "掛哪個專案", type: "project", hint: "掛專案的費用核准後會計入專案成本" },
    { name: "budget_line_id", label: "對沖哪一筆成本（報價單項目）", type: "select", full: true,
      options: lines.map(l => [l.id, l.category + "／" + l.item + (l.remaining != null ? "（預估 " + money(l.cost_estimate) + "，剩 " + money(l.remaining) + "）" : "")] as [string, string]),
      hint: lines.length ? "核准後這筆金額會算進該科目的實際成本；不確定可以先空白，之後由 PM 指定" : "先選專案；專案還沒有預算科目時請 PM 先建立，或先空白" },
    { name: "receipt_date", label: "費用日期（空白＝今天）", type: "date" }, { name: "receipt_no", label: "發票或收據號碼" },
    { name: "receipt_url", label: "單據照片連結（雲端硬碟）", type: "url", full: true },
    { name: "payee", label: "付款方式", type: "select", options: payees.data || ["代墊（付給我）", "付給廠商", "公司卡支付"],
      hint: payee === "公司卡支付" ? "公司卡已付款，會計核對刷卡帳單即可" : payee === "代墊（付給我）" ? "公司會把錢付給你" : undefined },
    ...(payee === "付給廠商" || payee === "付給供應商" ? [
      { name: "supplier_id", label: "廠商（從清單選）", type: "supplier" } as Field,
      { name: "payee_name", label: "清單沒有的廠商：直接填名稱", hint: "送出時會自動加進供應商清單，下次可以直接選" } as Field,
      { name: "payee_bank", label: "匯款資料（銀行、分行、帳號、戶名）", full: true } as Field,
    ] : []),
  ];
  const loadLines = async (projectId?: string | null) => {
    if (!projectId) return setLines([]);
    // 同仁看不到專案預算，這裡只拿科目名稱（PM 與財務角色另外有預估與剩餘）
    try { setLines(await call<any[]>("budget.lineOptions", { project_id: projectId })); } catch { setLines([]); }
  };
  const open = (e: any | null) => { setEditing(e); setPayee(e?.payee || ""); loadLines(e?.project_id); };
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
          { key: "status", label: "狀態", render: e => <span className="quote-list"><Badge text={EXPENSE_LABEL[e.status]} />{e.over_budget && <Badge text={e.over_budget.draft ? "送出會超出核定" : "超出核定"} tone="red" />}</span> },
          { key: "description", label: "內容", render: e => <><b>{e.description}</b><small className="muted block">{e.category}・{lk.projectName(e.project_id)}</small></> },
          { key: "who", label: "申請人", hideSm: true, render: e => lk.nameOf(e.claimant_account) },
          { key: "date", label: "日期", hideSm: true, render: e => shortDate(e.receipt_date || (e.created_at || "").slice(0, 10)) },
          { key: "amount", label: "金額", num: true, render: e => money(e.amount) },
        ]} />
      </>}
      {viewing && (
        <Modal title={viewing.description} onClose={() => setViewing(null)}>
          {viewing.over_budget && <p className="error">
            {viewing.over_budget.hidden
              ? (viewing.over_budget.draft ? "注意：這筆送出後，這一項的請款會超過主管核定的金額。" : "這筆請款讓這一項超過主管核定的金額。")
              : "超出核定：這一項核定 " + money(viewing.over_budget.approved) + "，累計申請 " + money(viewing.over_budget.claimed) + "（含這筆），超出 " + money(viewing.over_budget.over) + " 元。"}
          </p>}
          <dl className="dl">
            <dt>狀態</dt><dd><Badge text={EXPENSE_LABEL[viewing.status]} /></dd>
            <dt>金額</dt><dd>{money(viewing.amount)} 元</dd>
            <dt>申請人</dt><dd>{lk.nameOf(viewing.claimant_account)}</dd>
            <dt>專案</dt><dd>{lk.projectName(viewing.project_id)}</dd>
            {viewing.project_id && <><dt>對沖項目</dt><dd>{viewing.budget_line_label || <span className="muted">未指定</span>}</dd></>}
            <dt>費用日期</dt><dd>{viewing.receipt_date ? shortDate(viewing.receipt_date) : "—"}</dd>
            <dt>付款方式</dt><dd>{viewing.payee || "—"}{viewing.supplier_id ? "：" + (lk.suppliers.find(s => s.id === viewing.supplier_id)?.name || viewing.payee_name || "") : viewing.payee_name ? "：" + viewing.payee_name : ""}
              {viewing.payee_bank && <small className="muted block">{viewing.payee_bank}</small>}</dd>
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
            fields={fields} onValuesChange={(name, v) => { if (name === "project_id") loadLines(v); if (name === "payee") setPayee(v || ""); }} />
        </Modal>
      )}
    </Page>
  );
}
