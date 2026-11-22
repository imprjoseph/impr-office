/**
 * 資材：先分大項（資產／耗材），資產再分逐台（每台有財產編號）或整批（只記數量）。
 * - 逐台資產：開「單台清單」看每台狀態，勾選要借的台。
 * - 整批資產：借用填數量。
 * - 耗材：領用、入庫、盤點；低於安全存量標紅。
 */
import { useState } from "react";
import { call } from "../api";
import { Badge, Field, Loading, Modal, Page, RecordForm, Table, Tabs, shortDate, useAction, useLoad, useLookups } from "../ui";

const kindLabel = (i: any) => i.kind === "耗材" ? "耗材" : "資產・" + i.track_mode;

export default function Inventory() {
  const lk = useLookups();
  const items = useLoad<any[]>("inventory.withStock");
  const loans = useLoad<any[]>("loan.list");
  const opts = useLoad<any>("inventory.options");
  const [view, setView] = useState("master");
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const [borrowing, setBorrowing] = useState<any | null>(null);
  const [unitsOf, setUnitsOf] = useState<any | null>(null);
  const [stockOf, setStockOf] = useState<{ item: any; kind: string } | null>(null);
  const [returning, setReturning] = useState<any | null>(null);
  const { busy, run } = useAction();
  const reload = () => { items.reload(); loans.reload(); };
  const giveBack = async (l: any, damaged: string[]) => {
    const r = await run(() => call("loan.return", { id: l.id, expectedUpdatedAt: l.updated_at, damaged_unit_ids: damaged }), "已歸還");
    if (r) { setReturning(null); reload(); }
  };
  const out = (loans.data || []).filter(l => l.status === "借出中");
  const overdue = out.filter(l => l.overdue).length;
  return (
    <Page title="資材" sub="資材總檔依分類列出每項資材與保管人；借用檔記錄每一次借出與歸還。資產要歸還（逐台：每台有財產編號；整批：只記數量），耗材用掉就扣庫存。"
      actions={<button className="btn primary" onClick={() => setEditing(null)}>＋ 新增資材</button>}>
      <Tabs tabs={[["master", "資材總檔"], ["loans", "借用檔" + (out.length ? "（借出中 " + out.length + (overdue ? "・逾期 " + overdue : "") + "）" : "")]]} value={view} onChange={setView} />
      {view === "master"
        ? <Master items={items} categories={opts.data?.categories || []} onEdit={setEditing} onBorrow={setBorrowing} onUnits={setUnitsOf} onStock={(item, kind) => setStockOf({ item, kind })} />
        : <Loans loans={loans} busy={busy} onReturn={l => l.unit_ids ? setReturning(l) : giveBack(l, [])} />}
      {editing !== undefined && opts.data && <ItemForm item={editing} opts={opts.data} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); reload(); }} />}
      {borrowing && <BorrowForm item={borrowing} unitIds={null} onClose={() => setBorrowing(null)} onDone={() => { setBorrowing(null); reload(); }} />}
      {unitsOf && opts.data && <Units item={unitsOf} opts={opts.data} onClose={() => { setUnitsOf(null); reload(); }} />}
      {stockOf && <StockMove item={stockOf.item} initialKind={stockOf.kind} onClose={() => setStockOf(null)} onDone={() => { setStockOf(null); reload(); }} />}
      {returning && <ReturnUnits loan={returning} busy={busy} onClose={() => setReturning(null)} onReturn={d => giveBack(returning, d)} />}
          </Page>
  );
}

// 狀態篩選：和大項、中項分開，是資材「現在的狀況」
const STATUS_FILTERS: [string, string, (i: any) => boolean][] = [
  ["", "全部狀態", () => true],
  ["available", "可借用", i => i.kind !== "耗材" && i.available > 0],
  ["onloan", "借出中", i => i.on_loan > 0],
  ["none", "已全部借出", i => i.kind !== "耗材" && i.total > 0 && i.available <= 0],
  ["repair", "維修中", i => i.repair > 0],
  ["low", "庫存不足", i => !!i.low_stock],
  ["nokeeper", "未指定保管人", i => !i.manager_account],
];

/** 資材總檔：大項（資產／耗材）→ 中項（文具、3C、展架…）分組；狀態、保管人另外篩選。 */
function Master({ items, categories, onEdit, onBorrow, onUnits, onStock }: { items: any; categories: string[]; onEdit: (i: any) => void; onBorrow: (i: any) => void; onUnits: (i: any) => void; onStock: (i: any, kind: string) => void }) {
  const lk = useLookups();
  const [kind, setKind] = useState("全部");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [keeper, setKeeper] = useState("");
  const [place, setPlace] = useState("");
  const [q, setQ] = useState("");
  const all: any[] = items.data || [];
  const places = Array.from(new Set(all.map(i => i.location).filter(Boolean))).sort();
  // 有照片的項目一次讀縮圖
  const photoIds = all.filter(i => i.has_photo).map(i => i.id);
  const photos = useLoad<Record<string, string>>(photoIds.length ? "inventory.photos" : null, { ids: photoIds });
  const cats = Array.from(new Set(categories.concat(all.filter(i => kind === "全部" || i.kind === kind).map(i => i.category || "未分類"))))
    .filter(c => all.some(i => (kind === "全部" || i.kind === kind) && (i.category || "未分類") === c));
  const keepers = Array.from(new Set(all.map(i => i.manager_account).filter(Boolean)));
  const statusTest = (STATUS_FILTERS.find(f => f[0] === status) || STATUS_FILTERS[0])[2];
  const count = (key: string) => all.filter((STATUS_FILTERS.find(f => f[0] === key) as any)[2]).length;
  const rows = all.filter(i => (kind === "全部" || i.kind === kind) && (!category || (i.category || "未分類") === category) && statusTest(i) &&
    (!keeper || i.manager_account === keeper) && (!place || i.location === place) &&
    (!q || [i.name, i.code, i.category, i.spec, i.location].some(v => String(v || "").toLowerCase().includes(q.toLowerCase()))));
  // 分組：大項 › 中項，中項依系統設定的清單順序
  const order = (c: string) => { const k = categories.indexOf(c); return k < 0 ? 999 : k; };
  const groups: Record<string, any[]> = {};
  rows.forEach(i => { const g = i.kind + "|" + (i.category || "未分類"); (groups[g] = groups[g] || []).push(i); });
  const keys = Object.keys(groups).sort((a, b) => {
    const [ka, ca] = a.split("|"), [kb, cb] = b.split("|");
    return ka === kb ? order(ca) - order(cb) || ca.localeCompare(cb) : ka === "資產" ? -1 : 1;
  });
  return <>
    <div className="toolbar">
      <Tabs tabs={[["全部", "全部"], ["資產", "資產"], ["耗材", "耗材"]]} value={kind} onChange={v => { setKind(v); setCategory(""); }} />
      <select value={category} onChange={e => setCategory(e.target.value)} aria-label="中項"><option value="">全部中項</option>{cats.map(c => <option key={c}>{c}</option>)}</select>
      <select value={status} onChange={e => setStatus(e.target.value)} aria-label="狀態">
        {STATUS_FILTERS.map(([k, label]) => <option key={k} value={k}>{label}{k ? "（" + count(k) + "）" : ""}</option>)}
      </select>
      <select value={keeper} onChange={e => setKeeper(e.target.value)} aria-label="保管人"><option value="">全部保管人</option>
        {keepers.map(k => <option key={k} value={k}>{lk.nameOf(k)}</option>)}</select>
      <select value={place} onChange={e => setPlace(e.target.value)} aria-label="放置地點"><option value="">全部放置地點</option>{places.map(p => <option key={p}>{p}</option>)}</select>
      <input type="search" placeholder="搜尋名稱、編號、規格、地點" value={q} onChange={e => setQ(e.target.value)} />
      <span className="muted small">{rows.length} 項</span>
    </div>
    <Loading error={items.error} loading={items.loading && !items.data} />
    {items.data && !rows.length && <p className="empty">沒有符合的資材。</p>}
    {keys.map(g => {
      const [k, cat] = g.split("|");
      return (
      <section key={g} className="inv-group">
        <h3><span className="muted">{k} ›</span> {cat} <span className="muted small">{groups[g].length} 項</span></h3>
        <Table rows={groups[g]} onRow={onEdit} columns={[
          { key: "photo", label: "", render: i => photos.data?.[i.id] ? <img className="thumb" src={photos.data[i.id]} alt={i.name} /> : <span className="thumb thumb-empty" /> },
          { key: "name", label: "名稱", render: i => <><b>{i.name}</b><small className="muted block">{[i.code, i.spec].filter(Boolean).join("・")}</small></> },
          { key: "place", label: "放置地點", hideSm: true, render: i => i.location || <span className="muted">—</span> },
          { key: "mode", label: "管理方式", hideSm: true, render: i => i.kind === "耗材" ? "庫存" : i.track_mode },
          { key: "q", label: "數量", num: true, render: i => i.kind === "耗材"
            ? <span className={i.low_stock ? "red" : ""}>庫存 {i.total} {i.unit || ""}</span>
            : <span className={i.available <= 0 ? "red" : ""}>可用 {i.available}／{i.total} {i.unit || ""}</span> },
          { key: "st", label: "狀態", render: i => <span className="quote-list">
            {i.low_stock && <Badge text="庫存不足" tone="red" />}
            {i.on_loan > 0 && <Badge text={"借出中 " + i.on_loan} tone="yellow" />}
            {i.repair > 0 && <Badge text={"維修中 " + i.repair} tone="red" />}
            {!i.low_stock && !i.on_loan && !i.repair && <Badge text={i.kind === "耗材" ? "正常" : "可借用"} tone="green" />}
          </span> },
          { key: "keeper", label: "保管人", render: i => i.manager_account ? lk.nameOf(i.manager_account) : <span className="muted">未指定</span> },
          { key: "x", label: "", render: i => <span className="row-actions" onClick={e => e.stopPropagation()}>
            <button className="btn small" onClick={() => onEdit(i)}>編輯</button>
            {i.kind === "耗材" ? <>
              <button className="btn small primary" onClick={() => onStock(i, "領用")}>領用</button>
              <button className="btn small" onClick={() => onStock(i, "入庫")}>入庫</button>
            </> : i.track_mode === "逐台"
              ? <button className="btn small primary" onClick={() => onUnits(i)}>單台清單</button>
              : <button className="btn small primary" disabled={i.available <= 0} onClick={() => onBorrow(i)}>借用</button>}
          </span> },
        ]} />
      </section>
      );
    })}
  </>;
}

/** 借用檔：每一次借出與歸還。可依狀態、借用人、專案、資材篩選。 */
function Loans({ loans, busy, onReturn }: { loans: any; busy: boolean; onReturn: (l: any) => void }) {
  const lk = useLookups();
  const [status, setStatus] = useState("借出中");
  const [who, setWho] = useState("");
  const [q, setQ] = useState("");
  const all: any[] = loans.data || [];
  const people = Array.from(new Set(all.map(l => l.borrower_account).filter(Boolean)));
  const rows = all.filter(l => (status === "全部" || (status === "逾期" ? l.overdue : l.status === status)) && (!who || l.borrower_account === who) &&
    (!q || [l.item_name, l.unit_tags.join(" "), l.project_id ? lk.projectName(l.project_id) : "", l.note].some(v => String(v || "").toLowerCase().includes(q.toLowerCase()))));
  return <>
    <div className="toolbar">
      <Tabs tabs={[["借出中", "借出中"], ["逾期", "逾期"], ["已歸還", "已歸還"], ["全部", "全部"]]} value={status} onChange={setStatus} />
      <select value={who} onChange={e => setWho(e.target.value)} aria-label="借用人"><option value="">全部借用人</option>{people.map(p => <option key={p} value={p}>{lk.nameOf(p)}</option>)}</select>
      <input type="search" placeholder="搜尋資材、財產編號、專案" value={q} onChange={e => setQ(e.target.value)} />
      <span className="muted small">{rows.length} 筆</span>
    </div>
    <Loading error={loans.error} loading={loans.loading && !loans.data} />
    {loans.data && <Table rows={rows} empty="沒有符合的借用紀錄。" columns={[
      { key: "s", label: "狀態", render: l => l.overdue ? <Badge text="已逾期" /> : <Badge text={l.status} tone={l.status === "已歸還" ? "green" : "yellow"} /> },
      { key: "item", label: "資材", render: l => <><b>{l.item_name} × {l.quantity} {l.unit || ""}</b>{l.unit_tags.length > 0 && <small className="muted block">{l.unit_tags.join("、")}</small>}</> },
      { key: "who", label: "借用人", render: l => lk.nameOf(l.borrower_account) },
      { key: "p", label: "專案", hideSm: true, render: l => l.project_id ? lk.projectName(l.project_id) : "—" },
      { key: "d", label: "借出／歸還", render: l => <>{shortDate(l.loan_date)}<small className="muted block">{l.status === "已歸還" ? "還 " + shortDate(String(l.returned_at || "").slice(0, 10)) : "預計 " + shortDate(l.due_date)}</small></> },
      { key: "x", label: "", render: l => l.status === "借出中" ? <button className="btn small" disabled={busy} onClick={() => onReturn(l)}>歸還</button> : null },
    ]} />}
  </>;
}

function ItemForm({ item, opts, onClose, onSaved }: { item: any | null; opts: any; onClose: () => void; onSaved: () => void }) {
  // 列表不帶照片：編輯時先把這一項的照片讀進來，再顯示表單
  const photo = useLoad<Record<string, string>>(item?.has_photo ? "inventory.photos" : null, { ids: item ? [item.id] : [] });
  if (item?.has_photo && !photo.data) return <Modal title={item.name} onClose={onClose}><Loading error={photo.error} loading /></Modal>;
  return <ItemFormInner item={item && photo.data ? { ...item, photo: photo.data[item.id] || null } : item} opts={opts} onClose={onClose} onSaved={onSaved} />;
}

function ItemFormInner({ item, opts, onClose, onSaved }: { item: any | null; opts: any; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState(item?.kind || "資產");
  const [mode, setMode] = useState(item?.track_mode || "整批");
  const [converting, setConverting] = useState(false);
  const { busy, run } = useAction();
  const isNew = !item;
  const consumable = kind === "耗材";
  const fields: Field[] = [
    { name: "name", label: "名稱", required: true },
    { name: "code", label: "編號（空白自動給 R-0001…）" },
    ...(isNew ? [
      { name: "kind", label: "大項", type: "select", options: opts.kinds, required: true, hint: "資產：用完要歸還；耗材：用掉就沒了" } as Field,
      ...(!consumable ? [{ name: "track_mode", label: "管理方式", type: "select", options: opts.modes, required: true, hint: "逐台：每台有財產編號（筆電、攝影機）；整批：只記數量（延長線、對講機）" } as Field] : []),
    ] : []),
    { name: "category", label: "中項（文具、3C、展架…）", type: "select", options: Array.from(new Set<string>((opts.categories as string[] || []).concat(item?.category ? [String(item.category)] : []))), required: true, hint: "清單由管理者在系統設定的 inventory_categories 增修" },
    { name: "spec", label: "規格／型號" },
    { name: "unit", label: "單位（台、支、個…）" },
    ...(consumable
      ? [...(isNew ? [{ name: "quantity", label: "期初庫存", type: "number" } as Field] : []), { name: "safety_stock", label: "安全存量（低於就提醒）", type: "number" } as Field]
      : mode === "整批" ? [{ name: "quantity", label: "總數量", type: "number" } as Field]
      : isNew ? [{ name: "quantity", label: "台數（會自動建立單台資料，財產編號之後可改）", type: "number" } as Field] : []),
    { name: "location", label: "放置地點（例如：倉庫 B 第 2 層）" },
    { name: "manager_account", label: "保管人", type: "person", hint: "負責這項資材的人；逐台的可在單台清單另外指定每台的保管人" },
    { name: "photo", label: "照片", type: "image", full: true },
    { name: "photo_url", label: "原圖連結（選填，例如雲端硬碟）", type: "url", full: true },
    { name: "note", label: "備註", type: "textarea" },
  ];
  const save = async (v: any) => {
    const r = await run(async () => {
      if (!isNew) return call("inventory.update", { id: item.id, expectedUpdatedAt: item.updated_at, patch: v });
      const unitMode = v.kind !== "耗材" && v.track_mode === "逐台";
      const created = await call<any>("inventory.create", { record: Object.assign({}, v, unitMode ? { track_mode: "整批" } : {}) });
      // 逐台：先以整批建立，再轉換，系統依台數建立單台資料
      return unitMode ? call("inventory.setMode", { id: created.id, expectedUpdatedAt: created.updated_at, kind: "資產", track_mode: "逐台" }) : created;
    }, "已儲存");
    if (r) onSaved();
  };
  const remove = async () => {
    if (!item) return;
    if (item.on_loan > 0) { alert("「" + item.name + "」還有借出中的紀錄，請先到借用檔歸還再刪除。"); return; }
    const extra = item.track_mode === "逐台" && item.total ? "，連同 " + item.total + " 台單台資料" : "";
    if (!confirm("確定刪除「" + item.name + "」" + (item.code ? "（" + item.code + "）" : "") + extra + "？\n借用與庫存異動的歷史紀錄會保留。")) return;
    const r = await run(() => call("inventory.delete", { id: item.id, expectedUpdatedAt: item.updated_at }), "已刪除");
    if (r) onSaved();
  };
  const convert = async (k: string, m: string) => {
    const r = await run(() => call("inventory.setMode", { id: item.id, expectedUpdatedAt: item.updated_at, kind: k, track_mode: m }), "已轉換為「" + (k === "耗材" ? "耗材" : k + "・" + m) + "」");
    if (r) onSaved();
  };
  return (
    <Modal title={item ? item.name : "新增資材"} onClose={onClose}>
      {!isNew && <p className="muted small">目前是「{kindLabel(item)}」。<button type="button" className="linkish" style={{ color: "var(--brand-2)" }} onClick={() => setConverting(!converting)}>轉換管理方式</button></p>}
      {converting && (
        <div className="card">
          <p className="small">轉換前要先歸還所有借出。整批轉逐台時，系統依目前數量建立單台資料（財產編號 A-0001 起，之後可改）；逐台轉整批時，數量改成未報廢的台數。</p>
          <div className="page-actions">
            {[["資產", "逐台"], ["資產", "整批"], ["耗材", "整批"]].filter(([k, m]) => !(k === item.kind && m === item.track_mode)).map(([k, m]) => (
              <button key={k + m} className="btn small" disabled={busy} onClick={() => convert(k, m)}>改成 {k === "耗材" ? "耗材" : k + "・" + m}</button>
            ))}
          </div>
        </div>
      )}
      <RecordForm busy={busy} initial={item || { kind: "資產", track_mode: "整批" }} onCancel={onClose} onSubmit={save} fields={fields}
        onValuesChange={(n, v) => { if (n === "kind") setKind(v || "資產"); if (n === "track_mode") setMode(v || "整批"); }}
        extra={!isNew && <button type="button" className="btn danger-link" disabled={busy} onClick={remove}>刪除這項資材</button>} />
    </Modal>
  );
}

function BorrowForm({ item, unitIds, onClose, onDone }: { item: any; unitIds: string[] | null; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const submit = async (v: any) => {
    const r = await run(() => call("loan.borrow", { record: Object.assign({ inventory_id: item.id }, v, unitIds ? { unit_ids: unitIds } : {}) }), "已登記借用");
    if (r) onDone();
  };
  return (
    <Modal title={"借用：" + item.name + (unitIds ? "（" + unitIds.length + " 台）" : "")} onClose={onClose}>
      <RecordForm busy={busy} initial={undefined} onCancel={onClose} onSubmit={submit} submitLabel="登記借用" fields={[
        ...(unitIds ? [] : [{ name: "quantity", label: "數量（可借 " + item.available + "）", type: "number", required: true } as Field]),
        { name: "borrower_account", label: "借用人（空白是自己）", type: "person" }, { name: "project_id", label: "用在哪個專案", type: "project" },
        { name: "due_date", label: "預計歸還日", type: "date" }, { name: "note", label: "備註", type: "textarea" },
      ]} />
    </Modal>
  );
}

function Units({ item, opts, onClose }: { item: any; opts: any; onClose: () => void }) {
  const lk = useLookups();
  const units = useLoad<any[]>("inventory.units", { inventory_id: item.id });
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const [borrow, setBorrow] = useState(false);
  const { busy, run } = useAction();
  const ids = Object.keys(picked).filter(k => picked[k]);
  const save = async (v: any) => {
    const r = await run(() => editing
      ? call("inventory.updateUnit", { id: editing.id, expectedUpdatedAt: editing.updated_at, patch: v })
      : call("inventory.addUnit", { inventory_id: item.id, record: v }), "已儲存");
    if (r) { setEditing(undefined); units.reload(); }
  };
  const remove = async () => {
    if (!editing || !confirm("確定刪除 " + editing.asset_tag + "？不用了建議改成「報廢」保留紀錄。")) return;
    const r = await run(() => call("inventory.deleteUnit", { id: editing.id, expectedUpdatedAt: editing.updated_at }), "已刪除");
    if (r) { setEditing(undefined); units.reload(); }
  };
  const tone = (s: string) => s === "可用" ? "green" : s === "借出" ? "yellow" : s === "維修" ? "red" : "";
  return (
    <Modal title={item.name + "：單台清單"} onClose={onClose} wide>
      <div className="toolbar">
        <span className="muted small">勾選「可用」的台後按借用。</span><span className="spacer" />
        <button className="btn small" onClick={() => setEditing(null)}>＋ 新增一台</button>
        <button className="btn small primary" disabled={!ids.length} onClick={() => setBorrow(true)}>借用所選（{ids.length}）</button>
      </div>
      <Loading error={units.error} loading={units.loading && !units.data} />
      {units.data && <Table rows={units.data} onRow={u => setEditing(u)} empty="還沒有單台資料。" columns={[
        { key: "c", label: "", render: u => <input type="checkbox" disabled={u.status !== "可用"} checked={!!picked[u.id]} onClick={e => e.stopPropagation()}
          onChange={e => setPicked({ ...picked, [u.id]: e.target.checked })} aria-label={u.asset_tag} /> },
        { key: "tag", label: "財產編號", render: u => <><b>{u.asset_tag}</b><small className="muted block">{u.serial_no ? "序號 " + u.serial_no : ""}</small></> },
        { key: "s", label: "狀態", render: u => <><Badge text={u.status} tone={tone(u.status)} />{u.borrower_account && <small className="muted block">{lk.nameOf(u.borrower_account)}{u.due_date ? "・" + shortDate(u.due_date) + " 還" : ""}</small>}</> },
        { key: "keeper", label: "保管人", render: u => u.custodian_account ? lk.nameOf(u.custodian_account) : <span className="muted">{item.manager_account ? lk.nameOf(item.manager_account) : "—"}</span> },
        { key: "loc", label: "位置", hideSm: true, render: u => u.location || "—" },
        { key: "w", label: "保固到", hideSm: true, render: u => u.warranty_until ? shortDate(u.warranty_until) : "—" },
      ]} />}
      {editing !== undefined && <Modal title={editing ? editing.asset_tag : "新增一台"} onClose={() => setEditing(undefined)}>
        <RecordForm busy={busy} initial={editing || undefined} onCancel={() => setEditing(undefined)} onSubmit={save} fields={[
          { name: "asset_tag", label: "財產編號（空白自動編）" }, { name: "serial_no", label: "序號" },
          ...(editing && editing.status === "借出" ? [] : [{ name: "status", label: "狀態", type: "select", options: opts.unitStatuses } as Field]),
          { name: "custodian_account", label: "這台的保管人（空白＝資材保管人）", type: "person" },
          { name: "location", label: "存放位置" }, { name: "purchase_date", label: "購入日", type: "date" }, { name: "cost", label: "購入金額", type: "number" },
          { name: "warranty_until", label: "保固到期", type: "date" }, { name: "note", label: "備註", type: "textarea" },
        ]} extra={editing && editing.status !== "借出" && <button type="button" className="btn danger-link" onClick={remove}>刪除這台</button>} />
      </Modal>}
      {borrow && <BorrowForm item={item} unitIds={ids} onClose={() => setBorrow(false)} onDone={() => { setBorrow(false); setPicked({}); units.reload(); }} />}
    </Modal>
  );
}

function StockMove({ item, initialKind, onClose, onDone }: { item: any; initialKind: string; onClose: () => void; onDone: () => void }) {
  const lk = useLookups();
  const moves = useLoad<any[]>("stock.moves", { inventory_id: item.id });
  const [kind, setKind] = useState(initialKind);
  const { busy, run } = useAction();
  const submit = async (v: any) => {
    const r = await run(() => call("stock.move", { record: Object.assign({ inventory_id: item.id, kind }, v) }), kind + "完成");
    if (r) onDone();
  };
  return (
    <Modal title={item.name + "（庫存 " + item.total + " " + (item.unit || "") + "）"} onClose={onClose} wide>
      <Tabs tabs={[["領用", "領用"], ["入庫", "入庫"], ["盤點調整", "盤點"]]} value={kind} onChange={setKind} />
      <RecordForm key={kind} busy={busy} initial={undefined} onCancel={onClose} onSubmit={submit} submitLabel={kind === "盤點調整" ? "更新庫存" : kind} fields={[
        { name: "quantity", label: kind === "盤點調整" ? "實際清點數量" : kind + "數量", type: "number", required: true },
        ...(kind === "領用" ? [{ name: "project_id", label: "用在哪個專案", type: "project" } as Field, { name: "account", label: "領用人（空白是自己）", type: "person" } as Field] : []),
        { name: "note", label: "備註", type: "textarea" },
      ]} />
      <h3>進出紀錄</h3>
      <Loading error={moves.error} loading={moves.loading && !moves.data} />
      {moves.data && <Table rows={moves.data.slice(0, 50)} empty="沒有紀錄。" columns={[
        { key: "d", label: "日期", render: m => shortDate(m.move_date) },
        { key: "k", label: "類型", render: m => m.kind },
        { key: "q", label: "數量", num: true, render: m => <span className={m.quantity < 0 ? "red" : ""}>{m.quantity > 0 ? "+" : ""}{m.quantity}</span> },
        { key: "b", label: "結存", num: true, render: m => m.balance },
        { key: "w", label: "人／專案", hideSm: true, render: m => lk.nameOf(m.account) + (m.project_id ? "・" + lk.projectName(m.project_id) : "") },
      ]} />}
    </Modal>
  );
}

function ReturnUnits({ loan, busy, onClose, onReturn }: { loan: any; busy: boolean; onClose: () => void; onReturn: (damaged: string[]) => void }) {
  const ids = String(loan.unit_ids).split(",");
  const [damaged, setDamaged] = useState<Record<string, boolean>>({});
  return (
    <Modal title={"歸還：" + loan.item_name} onClose={onClose}>
      <p className="muted small">有損壞的請勾選，會改成「維修」；其他回到「可用」。</p>
      <div className="chips">{ids.map((id, i) => (
        <label key={id} className={"chip" + (damaged[id] ? " on" : "")}><input type="checkbox" checked={!!damaged[id]} onChange={e => setDamaged({ ...damaged, [id]: e.target.checked })} />{loan.unit_tags[i]}{damaged[id] ? " 損壞" : ""}</label>
      ))}</div>
      <div className="modal-foot"><button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={busy} onClick={() => onReturn(ids.filter(id => damaged[id]))}>確認歸還</button></div>
    </Modal>
  );
}
