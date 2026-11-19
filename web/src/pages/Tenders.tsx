import { useState } from "react";
import { call } from "../api";
import { Badge, Field, Loading, Modal, Page, RecordForm, Table, Tabs, money, shortDate, useAction, useLoad, useLookups } from "../ui";

const LABEL: Record<string, string> = { evaluating: "評估中", preparing: "準備中", submitted: "已投標", won: "得標", lost: "未得標", skipped: "不投標" };
const NEXT: Record<string, string[]> = { evaluating: ["preparing", "skipped"], preparing: ["evaluating", "submitted", "skipped"], submitted: ["won", "lost"], won: [], lost: [], skipped: ["evaluating"] };
const FIELDS: Field[] = [
  { name: "title", label: "標案名稱", required: true, full: true },
  { name: "agency", label: "機關", required: true },
  { name: "tender_no", label: "案號" },
  { name: "source_url", label: "公告網址", type: "url", full: true },
  { name: "budget_amount", label: "預算金額", type: "number" },
  { name: "announce_date", label: "公告日", type: "date" },
  { name: "deadline_date", label: "截標日", type: "date" },
  { name: "opening_date", label: "開標日", type: "date" },
  { name: "owner_account", label: "負責人", type: "person" },
  { name: "bid_bond", label: "押標金", type: "number" },
  { name: "bid_amount", label: "投標金額", type: "number" },
  { name: "award_amount", label: "決標金額", type: "number" },
  { name: "documents", label: "文件清單", type: "textarea" },
  { name: "decision_note", label: "評估說明", type: "textarea" },
  { name: "competitors", label: "競爭廠商", type: "textarea" },
  { name: "result_note", label: "結果檢討", type: "textarea" },
];

export default function Tenders() {
  const lk = useLookups();
  const { data, error, loading, reload } = useLoad<any[]>("tender.list");
  const [tab, setTab] = useState("active");
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const [converting, setConverting] = useState<any | null>(null);
  const { busy, run } = useAction();
  const year = new Date().getFullYear().toString();
  const rows = (data || []).filter(t => tab === "all" || (tab === "active" ? ["evaluating", "preparing", "submitted"].includes(t.status) : !["evaluating", "preparing", "submitted"].includes(t.status)));
  const decided = (data || []).filter(t => (t.opening_date || t.updated_at || "").startsWith(year) && ["won", "lost"].includes(t.status));
  const won = decided.filter(t => t.status === "won").length;
  const save = async (v: any) => {
    const r = await run(() => editing ? call("tender.update", { id: editing.id, expectedUpdatedAt: editing.updated_at, patch: v }) : call("tender.create", { record: v }), "已儲存");
    if (r) { setEditing(undefined); reload(); }
  };
  const setStatus = async (t: any, status: string) => {
    const r = await run(() => call<any>("tender.setStatus", { id: t.id, expectedUpdatedAt: t.updated_at, status }), "已改成「" + LABEL[status] + "」");
    if (r) { setEditing(r); reload(); }
  };
  const convert = async (v: any) => {
    const r = await run(() => call<any>("tender.convertToProject", { id: converting.id, expectedUpdatedAt: converting.updated_at, project: v }), "已建立專案");
    if (r) { setConverting(null); setEditing(undefined); lk.refresh(["projects"]); location.hash = "#/projects/" + r.project.id; }
  };
  return (
    <Page title="標案" sub="評估 → 準備 → 投標 → 開標結果；得標一鍵建立專案並套用 T-60 工作範本。"
      actions={<button className="btn primary" onClick={() => setEditing(null)}>＋ 新增標案</button>}>
      <div className="stats">
        <div className="stat"><b>{(data || []).filter(t => ["evaluating", "preparing"].includes(t.status)).length}</b><span>評估、準備中</span></div>
        <div className="stat"><b>{won}</b><span>今年得標</span></div>
        <div className="stat"><b>{decided.length ? Math.round(won / decided.length * 100) + "%" : "—"}</b><span>今年得標率</span></div>
      </div>
      <Tabs tabs={[["active", "進行中"], ["done", "已結束"], ["all", "全部"]]} value={tab} onChange={setTab} />
      <Loading error={error} loading={loading && !data} />
      {data && <Table rows={rows} onRow={t => setEditing(t)} empty="沒有標案。" columns={[
        { key: "status", label: "狀態", render: t => <Badge text={LABEL[t.status]} /> },
        { key: "title", label: "標案", render: t => <><b>{t.title}</b><small className="muted block">{t.agency}{t.tender_no ? "・" + t.tender_no : ""}</small></> },
        { key: "deadline", label: "截標", render: t => shortDate(t.deadline_date) },
        { key: "budget", label: "預算", num: true, hideSm: true, render: t => money(t.budget_amount) },
        { key: "owner", label: "負責人", hideSm: true, render: t => lk.nameOf(t.owner_account) },
      ]} />}
      {editing !== undefined && (
        <Modal title={editing ? editing.title : "新增標案"} onClose={() => setEditing(undefined)} wide>
          {editing && (
            <div className="toolbar">
              <Badge text={LABEL[editing.status]} />
              {NEXT[editing.status].map(s => <button key={s} className="btn small" disabled={busy} onClick={() => setStatus(editing, s)}>改成「{LABEL[s]}」</button>)}
              {editing.status === "won" && !editing.project_id && <button className="btn primary small" onClick={() => setConverting(editing)}>轉成專案</button>}
              {editing.project_id && <a className="btn small" href={"#/projects/" + editing.project_id}>開啟專案</a>}
            </div>
          )}
          <RecordForm key={editing ? editing.updated_at : "new"} fields={FIELDS} initial={editing || undefined} onSubmit={save} onCancel={() => setEditing(undefined)} busy={busy} />
        </Modal>
      )}
      {converting && (
        <Modal title="轉成專案" onClose={() => setConverting(null)}>
          <p className="muted">會建立專案「{converting.title}」，客戶 {converting.agency}，PM 為標案負責人，並依活動日期套用工作範本。</p>
          <RecordForm busy={busy} initial={undefined} onSubmit={convert} onCancel={() => setConverting(null)} submitLabel="建立專案" fields={[
            { name: "start_date", label: "活動日期", type: "date" }, { name: "end_date", label: "結束日期", type: "date" },
            { name: "venue", label: "地點" }, { name: "project_type", label: "活動類型" }, { name: "client_id", label: "客戶", type: "client" },
          ]} />
        </Modal>
      )}
    </Page>
  );
}
