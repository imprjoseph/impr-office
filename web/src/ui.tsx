/**
 * 共用元件：資料表、表單、對話框、提示、選單資料（人員、專案、客戶、供應商）。
 * 各頁只描述欄位，增刪改查的畫面行為都在這裡，整個系統的操作方式才會一致。
 */
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { call, ApiError, Me } from "./api";
import { readXlsx, SheetRows } from "./xlsx";

// ---------- 格式 ----------
export const money = (n: unknown) => (n === null || n === undefined || n === "" ? "—" : Number(n).toLocaleString("zh-TW", { maximumFractionDigits: 0 }));
export const pct = (n: unknown) => (n === null || n === undefined || n === "" ? "—" : Math.round(Number(n) * 1000) / 10 + "%");
export const shortDate = (d?: string | null) => (d ? d.slice(5).replace("-", "/") : "—");
export const todayIso = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

// ---------- 讀取資料 ----------
// 同一次開啟網頁內，各列表最後一次載入的結果：回到看過的頁面先顯示上次的資料，背景再更新，不用從空白等起。
// 只放在記憶體（關掉分頁就清掉），帳密不暫存。
const loadMemo = new Map<string, unknown>();
const NO_MEMO = /^credential\./;

export function useLoad<T>(action: string | null, payload?: Record<string, unknown>, deps: unknown[] = []) {
  const key = JSON.stringify(payload || {});
  const memoKey = action + "|" + key;
  const [data, setData] = useState<T | null>(() => (action && loadMemo.has(memoKey) ? loadMemo.get(memoKey) as T : null));
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    if (!action) return;
    if (loadMemo.has(memoKey)) setData(loadMemo.get(memoKey) as T);
    setLoading(true);
    setError("");
    try {
      const d = await call<T>(action, payload);
      if (!NO_MEMO.test(action)) loadMemo.set(memoKey, d);
      setData(d);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, key, ...deps]);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

/** 登出或換帳號時清掉暫存，下一個人不會看到上一個人的資料。 */
export function clearLoadMemo() { loadMemo.clear(); }

// ---------- 登入者與選單資料 ----------
interface Lookups {
  me: Me;
  people: any[];
  projects: any[];
  clients: any[];
  suppliers: any[];
  nameOf: (account?: string | null) => string;
  projectName: (id?: string | null) => string;
  refresh: (which?: string[]) => Promise<void>;
  can: (...roles: string[]) => boolean;
}
const LookupContext = createContext<Lookups | null>(null);
export const useLookups = () => useContext(LookupContext)!;

export function LookupProvider({ me, children }: { me: Me; children: ReactNode }) {
  const internal = me.role !== "dispatch";
  const [state, setState] = useState({ people: [] as any[], projects: [] as any[], clients: [] as any[], suppliers: [] as any[] });
  const refresh = useCallback(async (which = ["people", "projects", "clients", "suppliers"]) => {
    if (!internal) return;
    // 主管與管理者每次開啟系統，在背景從帳號中心同步一次人員（不擋畫面）；同步完再更新人員名單。
    if (which.includes("people") && ["admin", "manager"].includes(me.role) && !sessionStorage.getItem("impr_people_synced")) {
      sessionStorage.setItem("impr_people_synced", "1");
      call("people.sync").then(() => call<any[]>("people.list")).then(people => setState(st => ({ ...st, people })))
        .catch(() => sessionStorage.removeItem("impr_people_synced"));
    }
    const actions: Record<string, string> = { people: "people.list", projects: "project.list", clients: "client.list", suppliers: "supplier.list" };
    const results = await Promise.all(which.map(w => call<any[]>(actions[w]).catch(() => [])));
    setState(s => Object.assign({}, s, Object.fromEntries(which.map((w, i) => [w, results[i]]))));
  }, [internal, me.role]);
  useEffect(() => { refresh(); }, [refresh]);
  const value = useMemo<Lookups>(() => ({
    me, ...state, refresh,
    nameOf: a => (a ? (state.people.find(p => p.account === a)?.name || a) : "—"),
    projectName: id => (id ? (state.projects.find(p => p.id === id)?.name || "（已刪除的專案）") : "—"),
    can: (...roles) => roles.includes(me.role),
  }), [me, state, refresh]);
  return <LookupContext.Provider value={value}>{children}</LookupContext.Provider>;
}

// ---------- 提示 ----------
const ToastContext = createContext<(msg: string, kind?: "ok" | "err") => void>(() => {});
export const useToast = () => useContext(ToastContext);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<{ text: string; kind: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((text: string, kind: "ok" | "err" = "ok") => {
    setMsg({ text, kind });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), kind === "err" ? 6000 : 2600);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {msg && <div className={"toast " + msg.kind} role="status">{msg.text}</div>}
    </ToastContext.Provider>
  );
}

/** 包住會寫入的操作：按鈕忙碌中、成功提示、失敗顯示原因。資料衝突時提示重新整理。 */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) toast(ok);
      return r;
    } catch (e) {
      const err = e as ApiError;
      toast(err.code === "CONFLICT_ERROR" ? "資料已被別人修改，請重新整理後再試" : err.message, "err");
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return { busy, run };
}

// ---------- 版面 ----------
export function Page({ title, actions, children, sub }: { title: string; actions?: ReactNode; children: ReactNode; sub?: string }) {
  return (
    <section className="page">
      <header className="page-head">
        <div><h1>{title}</h1>{sub && <p className="muted">{sub}</p>}</div>
        <div className="page-actions">{actions}</div>
      </header>
      {children}
    </section>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: [string, string][]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([k, label]) => (
        <button key={k} role="tab" aria-selected={value === k} className={value === k ? "tab on" : "tab"} onClick={() => onChange(k)}>{label}</button>
      ))}
    </div>
  );
}

export function Badge({ text, tone }: { text: string; tone?: string }) {
  const auto = /紅燈|已逾期|卡關|駁回|退回|已退回|rejected|lost/.test(text) ? "red"
    : /黃燈|即將到期|待|久未更新|submitted|approved|preparing|evaluating/.test(text) ? "yellow"
    : /綠燈|已完成|核准|已付款|已確認|won|paid|正常|已歸還|active/.test(text) ? "green" : "";
  return <span className={"badge " + (tone || auto)}>{text}</span>;
}

export function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}

export function Loading({ error, loading }: { error?: string; loading?: boolean }) {
  if (error) return <p className="error">載入失敗：{error}</p>;
  if (loading) return <p className="muted">載入中…</p>;
  return null;
}

// ---------- 資料表 ----------
export interface Column<T> { key: string; label: string; render?: (row: T) => ReactNode; num?: boolean; hideSm?: boolean }
// 列資料一律當 any：後端回傳的欄位依表而異，逐表寫型別的成本大於好處。
export function Table({ rows, columns, onRow, empty }: { rows: any[]; columns: Column<any>[]; onRow?: (r: any) => void; empty?: string }) {
  if (!rows.length) return <Empty text={empty || "沒有資料"} />;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{columns.map(c => <th key={c.key} className={(c.num ? "num " : "") + (c.hideSm ? "hide-sm" : "")}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id || i} className={onRow ? "clickable" : ""} tabIndex={onRow ? 0 : undefined}
              onClick={onRow ? () => onRow(r) : undefined} onKeyDown={onRow ? e => { if (e.key === "Enter") onRow(r); } : undefined}>
              {columns.map(c => <td key={c.key} className={(c.num ? "num " : "") + (c.hideSm ? "hide-sm" : "")}>{c.render ? c.render(r) : String((r as any)[c.key] ?? "—")}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- 對話框與表單 ----------
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={"modal" + (wide ? " wide" : "")} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head"><h2>{title}</h2><button className="x" onClick={onClose} aria-label="關閉">×</button></div>
        {children}
      </div>
    </div>
  );
}

export type FieldType = "text" | "number" | "date" | "time" | "textarea" | "select" | "person" | "project" | "client" | "supplier" | "checkbox" | "url" | "email" | "multi" | "image";
export interface Field { name: string; label: string; type?: FieldType; options?: string[] | [string, string][]; required?: boolean; hint?: string; full?: boolean; filter?: (row: any) => boolean }

export function FieldInput({ f, value, onChange }: { f: Field; value: any; onChange: (v: any) => void }) {
  const lk = useLookups();
  const id = "f-" + f.name;
  const common = { id, name: f.name, required: f.required };
  const opts = (rows: any[], val: (r: any) => string, label: (r: any) => string) => (
    <select {...common} value={value ?? ""} onChange={e => onChange(e.target.value || null)}>
      <option value="">{f.required ? "請選擇" : "（不指定）"}</option>
      {rows.filter(f.filter || (() => true)).map(r => <option key={val(r)} value={val(r)}>{label(r)}</option>)}
    </select>
  );
  switch (f.type) {
    case "textarea": return <textarea {...common} value={value ?? ""} onChange={e => onChange(e.target.value)} />;
    case "number": return <input {...common} type="number" inputMode="decimal" step="any" value={value ?? ""} onChange={e => onChange(e.target.value === "" ? null : Number(e.target.value))} />;
    case "date": case "time": case "url": case "email": return <input {...common} type={f.type} value={value ?? ""} onChange={e => onChange(e.target.value)} />;
    case "checkbox": return <input {...common} type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} />;
    case "image": return <ImageInput value={value} onChange={onChange} />;
    // 複選：存成頓號分隔的文字（例如「論壇、研討會」）
    case "multi": {
      const picked = String(value || "").split(/[,、，]/).map(s => s.trim()).filter(Boolean);
      const toggle = (o: string) => {
        const next = picked.includes(o) ? picked.filter(x => x !== o) : [...picked, o];
        onChange(next.length ? next.join("、") : null);
      };
      return (
        <div className="chips" id={id}>{(f.options || []).map(o => {
          const v = Array.isArray(o) ? o[0] : o, l = Array.isArray(o) ? o[1] : o;
          return <label key={v} className={"chip" + (picked.includes(v) ? " on" : "")}><input type="checkbox" checked={picked.includes(v)} onChange={() => toggle(v)} />{l}</label>;
        })}</div>
      );
    }
    case "select": return (
      <select {...common} value={value ?? ""} onChange={e => onChange(e.target.value || null)}>
        <option value="">{f.required ? "請選擇" : "（不指定）"}</option>
        {(f.options || []).map(o => Array.isArray(o) ? <option key={o[0]} value={o[0]}>{o[1]}</option> : <option key={o}>{o}</option>)}
      </select>
    );
    case "person": return opts(lk.people, r => r.account, r => r.name + (r.dept ? "（" + r.dept + "）" : ""));
    case "project": return opts(lk.projects, r => r.id, r => r.code + " " + r.name);
    case "client": return opts(lk.clients, r => r.id, r => r.name);
    case "supplier": return opts(lk.suppliers, r => r.id, r => r.name + (r.category ? "（" + r.category + "）" : ""));
    default: return <input {...common} value={value ?? ""} onChange={e => onChange(e.target.value)} />;
  }
}

/** 表單：只送有變動的欄位（更新時），新增時送全部有值的欄位。 */
export function RecordForm({ fields, initial, onSubmit, onCancel, submitLabel, busy, extra, onValuesChange }: {
  fields: Field[]; initial?: any; onSubmit: (values: any) => void; onCancel: () => void; submitLabel?: string; busy?: boolean; extra?: ReactNode;
  onValuesChange?: (name: string, value: any) => void;
}) {
  const [values, setValues] = useState<any>(() => Object.fromEntries(fields.map(f => [f.name, initial ? initial[f.name] ?? null : null])));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const out: any = {};
    fields.forEach(f => {
      const v = values[f.name];
      if (initial) { if ((initial[f.name] ?? null) !== (v ?? null)) out[f.name] = v === "" ? null : v; }
      else if (v !== null && v !== "" && v !== undefined) out[f.name] = v;
    });
    onSubmit(out);
  };
  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        {fields.map(f => (
          <label key={f.name} className={"field" + (f.full || f.type === "textarea" ? " full" : "")} htmlFor={"f-" + f.name}>
            <span>{f.label}{f.required ? " *" : ""}</span>
            <FieldInput f={f} value={values[f.name]} onChange={v => { setValues((s: any) => ({ ...s, [f.name]: v })); onValuesChange && onValuesChange(f.name, v); }} />
            {f.hint && <small className="muted">{f.hint}</small>}
          </label>
        ))}
      </div>
      {extra}
      <div className="modal-foot">
        <button type="button" className="btn" onClick={onCancel}>取消</button>
        <button type="submit" className="btn primary" disabled={busy}>{busy ? "處理中…" : submitLabel || "儲存"}</button>
      </div>
    </form>
  );
}

/**
 * 一般主資料頁：列表、搜尋、新增、編輯、刪除。prefix 對應後端 crudRoutes_ 的路由前綴。
 */
export function CrudPage({ title, sub, prefix, fields, columns, canWrite, listAction, searchKeys, onChanged, importAction, importHint }: {
  title: string; sub?: string; prefix: string; fields: Field[]; columns: Column<any>[]; canWrite: boolean;
  listAction?: string; searchKeys?: string[]; onChanged?: () => void;
  /** 有填就多一顆「從 Excel 匯入」：檔案在瀏覽器裡讀，直接送到後端這個動作。 */
  importAction?: string; importHint?: string;
}) {
  const { data, error, loading, reload } = useLoad<any[]>(listAction || prefix + ".list");
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const [q, setQ] = useState("");
  const { busy, run } = useAction();
  const rows = (data || []).filter(r => !q || (searchKeys || fields.map(f => f.name)).some(k => String(r[k] ?? "").toLowerCase().includes(q.toLowerCase())));
  const save = async (values: any) => {
    const r = await run(() => editing
      ? call(prefix + ".update", { id: editing.id, expectedUpdatedAt: editing.updated_at, patch: values })
      : call(prefix + ".create", { record: values }), "已儲存");
    if (r) { setEditing(undefined); reload(); onChanged && onChanged(); }
  };
  const remove = async () => {
    if (!editing || !confirm("確定要刪除「" + (editing.name || editing.title || editing.service || "這筆") + "」？刪除後在列表上就看不到了。")) return;
    const r = await run(() => call(prefix + ".delete", { id: editing.id, expectedUpdatedAt: editing.updated_at }), "已刪除");
    if (r) { setEditing(undefined); reload(); onChanged && onChanged(); }
  };
  return (
    <Page title={title} sub={sub} actions={<>
      {importAction && <ImportButton action={importAction} hint={importHint} onDone={() => { reload(); onChanged && onChanged(); }} />}
      {canWrite && <button className="btn primary" onClick={() => setEditing(null)}>＋ 新增</button>}
    </>}>
      <div className="toolbar"><input type="search" placeholder="搜尋" value={q} onChange={e => setQ(e.target.value)} aria-label="搜尋" /><span className="muted">{rows.length} 筆</span></div>
      <Loading error={error} loading={loading && !data} />
      {data && <Table rows={rows} columns={columns} onRow={canWrite ? r => setEditing(r) : undefined} />}
      {editing !== undefined && (
        <Modal title={editing ? "編輯" : "新增" + title} onClose={() => setEditing(undefined)}>
          <RecordForm fields={fields} initial={editing || undefined} onSubmit={save} onCancel={() => setEditing(undefined)} busy={busy}
            extra={editing && <button type="button" className="btn danger-link" onClick={remove}>刪除這筆</button>} />
        </Modal>
      )}
    </Page>
  );
}

/**
 * 從 Excel 匯入：選檔後在瀏覽器裡讀出各工作表，先顯示要匯入的工作表與筆數（不顯示內容），確認後送到後端。
 * 檔案不經過其他服務，也不留在瀏覽器裡。
 */
export function ImportButton({ action, hint, onDone }: { action: string; hint?: string; onDone: () => void }) {
  const [sheets, setSheets] = useState<SheetRows[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [err, setErr] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const { busy, run } = useAction();
  const pick = async (f?: File | null) => {
    if (!f) return;
    setErr(""); setFileName(f.name);
    try { setSheets((await readXlsx(f)).filter(s => s.rows.length)); }
    catch (e) { setErr((e as Error).message || "讀不到這個檔案，請確認是 .xlsx"); setSheets([]); }
    if (input.current) input.current.value = "";
  };
  const go = async () => {
    const r = await run(() => call<any>(action, { sheets: (sheets || []).map(s => ({ name: s.name, rows: s.rows })) }));
    if (r) { toast("匯入完成：新增 " + r.inserted + " 筆、更新 " + r.updated + " 筆、略過 " + r.skipped + " 筆"); setSheets(null); onDone(); }
  };
  const total = (sheets || []).reduce((n, s) => n + s.rows.length, 0);
  return <>
    <button className="btn" onClick={() => input.current?.click()}>從 Excel 匯入</button>
    <input ref={input} type="file" accept=".xlsx" hidden onChange={e => pick(e.target.files?.[0])} />
    {sheets && <Modal title={"匯入：" + fileName} onClose={() => setSheets(null)}>
      {err && <p className="error">{err}</p>}
      {hint && <p className="muted small">{hint}</p>}
      {sheets.length > 0 && <>
        <p>讀到 {sheets.length} 個工作表，共 {total} 列：</p>
        <ul className="small">{sheets.map(s => <li key={s.name}>{s.name}：{s.rows.length} 列（欄位：{s.header.filter(Boolean).join("、")}）</li>)}</ul>
        <p className="muted small">已存在的資料會更新、不會重複新增。</p>
      </>}
      {!err && sheets.length === 0 && <p className="error">這個檔案裡沒有讀到資料列。</p>}
      <div className="modal-foot"><button className="btn" onClick={() => setSheets(null)}>取消</button>
        <button className="btn primary" disabled={busy || !total} onClick={go}>{busy ? "匯入中…" : "匯入 " + total + " 列"}</button></div>
    </Modal>}
  </>;
}

/**
 * 先改畫面、稍後一次寫入：狀態這類小改動立刻顯示在畫面上，停手 1.5 秒後把累積的改動用一個請求送出
 * （批次動作，例如 task.updateMany）。同一筆改多次會合併成一次。失敗的那筆還原並提示，其他照存。
 * 還有沒存的改動時離開頁面會先詢問。
 */
export function useSaveQueue(batchAction: string, onSaved: () => void, delayMs = 1500) {
  const toast = useToast();
  const pending = useRef<Record<string, { expected: string; patch: Record<string, unknown> }>>({});
  const [overrides, setOverrides] = useState<Record<string, Record<string, unknown>>>({});
  const [saving, setSaving] = useState(0);
  const [waiting, setWaiting] = useState(0);
  const timer = useRef<number | null>(null);
  const flushRef = useRef<() => void>(() => {});

  const flush = useCallback(async () => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    const batch = pending.current;
    pending.current = {};
    setWaiting(0);
    const ids = Object.keys(batch);
    if (!ids.length) return;
    setSaving(n => n + ids.length);
    try {
      const results = await call<any[]>(batchAction, { items: ids.map(id => ({ id, expectedUpdatedAt: batch[id].expected, patch: batch[id].patch })) });
      const failed = results.filter(r => !r.ok);
      setOverrides(o => {
        const next = { ...o };
        results.forEach(r => {
          if (r.ok) next[r.id] = { ...(next[r.id] || {}), ...r.record };
          else delete next[r.id];
        });
        return next;
      });
      if (failed.length) toast(failed.length + " 筆沒有存成功（" + (failed[0].code === "CONFLICT_ERROR" ? "別人剛改過，已還原成最新的" : failed[0].error) + "）", "err");
      onSaved();
    } catch (e) {
      setOverrides(o => { const next = { ...o }; ids.forEach(id => { delete next[id]; }); return next; });
      toast("儲存失敗：" + (e as Error).message + "，畫面已還原", "err");
    } finally {
      setSaving(n => n - ids.length);
    }
  }, [batchAction, onSaved, toast]);
  flushRef.current = flush;

  /** 改一筆：畫面立刻套用，排進待存清單。row 要有 id、updated_at。 */
  const enqueue = useCallback((row: any, patch: Record<string, unknown>) => {
    const cur = pending.current[row.id];
    const ov = overrides[row.id] as any;
    const expected = cur ? cur.expected : (ov && ov.updated_at) || row.updated_at;
    pending.current[row.id] = { expected, patch: { ...(cur ? cur.patch : {}), ...patch } };
    setWaiting(Object.keys(pending.current).length);
    setOverrides(o => ({ ...o, [row.id]: { ...(o[row.id] || {}), ...patch } }));
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => flushRef.current(), delayMs);
  }, [overrides, delayMs]);

  /** 把待存與剛存好的改動套到列表上（伺服器的新資料到了、版本一樣或更新時就以伺服器為準）。 */
  const apply = useCallback(<T extends { id: string; updated_at?: string }>(rows: T[]): T[] => rows.map(r => {
    const ov = overrides[r.id] as any;
    if (!ov) return r;
    if (!pending.current[r.id] && ov.updated_at && r.updated_at && r.updated_at >= ov.updated_at) return r;
    return { ...r, ...ov };
  }), [overrides]);

  // 離開頁面前：還有沒送的就先送；關分頁時提醒
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (Object.keys(pending.current).length) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => { window.removeEventListener("beforeunload", warn); flushRef.current(); };
  }, []);

  return { enqueue, apply, flush, saving, waiting };
}

/**
 * 照片欄：選圖（手機可直接拍照）後在瀏覽器裡縮到長邊 480px、轉 JPEG，存成 data URL（約 30KB 內），
 * 直接放進資料庫，不用另外的雲端硬碟權限。原圖要保留的話另外貼「原圖連結」。
 */
export async function compressImage(file: File, maxSide = 480, maxChars = 44000): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("讀不到這張圖片")); i.src = url; });
    let side = maxSide;
    for (let attempt = 0; attempt < 6; attempt++) {
      const scale = Math.min(1, side / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const q of [0.75, 0.6, 0.45]) {
        const data = canvas.toDataURL("image/jpeg", q);
        if (data.length <= maxChars) return data;
      }
      side = Math.round(side * 0.75);
    }
    throw new Error("這張圖片太大，請換一張");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function ImageInput({ value, onChange }: { value: any; onChange: (v: any) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const pick = async (f?: File | null) => {
    if (!f) return;
    setErr(""); setBusy(true);
    try { onChange(await compressImage(f)); } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); if (input.current) input.current.value = ""; }
  };
  return (
    <div className="image-input">
      {value ? <img src={value} alt="照片" /> : <div className="image-empty">沒有照片</div>}
      <div className="page-actions">
        <button type="button" className="btn small" disabled={busy} onClick={() => input.current?.click()}>{busy ? "處理中…" : value ? "換照片" : "選擇照片／拍照"}</button>
        {value && <button type="button" className="btn small danger-link" onClick={() => onChange(null)}>移除</button>}
      </div>
      <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={e => pick(e.target.files?.[0])} />
      {err && <p className="error small">{err}</p>}
    </div>
  );
}
