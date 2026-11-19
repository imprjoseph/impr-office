/**
 * AI 文件與設計：同仁逐項填（能選的用選的），可先「套用範本」看示範內容再改。
 * 欄位定義由後端 ai.forms 提供，前後端用同一份。平面設計只產出提示詞，同仁貼到生圖工具使用。
 */
import { useState } from "react";
import { call } from "../api";
import { Loading, Page, Tabs, useAction, useLoad, useLookups } from "../ui";

interface Field { name: string; label: string; type: string; options?: string[]; required?: boolean; placeholder?: string; fromProject?: string }
type Values = Record<string, any>;

export default function Ai() {
  const [tab, setTab] = useState("doc");
  const forms = useLoad<any>("ai.forms");
  return (
    <Page title="AI 文件與設計" sub="照項目填寫，能選的直接選；不確定怎麼填，先按「套用範本」看示範。AI 產出的是初稿，送出前請確認事實、人名與數字；沒填的地方會標【待補】。">
      <Tabs tabs={[["doc", "文件產出"], ["design", "平面設計提示詞"]]} value={tab} onChange={setTab} />
      <Loading error={forms.error} loading={forms.loading && !forms.data} />
      {forms.data && (tab === "doc" ? <Docs forms={forms.data.docs} /> : <Design form={forms.data.design} />)}
    </Page>
  );
}

/** 選專案時，把專案資料帶進有 fromProject 的欄位（只補空白的，不蓋掉同仁已填的）。 */
function fillFromProject(fields: Field[], values: Values, project: any): Values {
  const next = { ...values };
  fields.forEach(f => {
    if (f.fromProject && project && project[f.fromProject] && !next[f.name]) next[f.name] = project[f.fromProject];
  });
  return next;
}

function FormFields({ fields, values, onChange }: { fields: Field[]; values: Values; onChange: (v: Values) => void }) {
  const set = (name: string, v: any) => onChange({ ...values, [name]: v });
  return (
    <div className="form-grid">
      {fields.map(f => {
        const label = <span>{f.label}{f.required ? " *" : ""}</span>;
        const v = values[f.name];
        if (f.type === "multi") {
          const picked: string[] = Array.isArray(v) ? v : [];
          return (
            <div key={f.name} className="field full">{label}
              <div className="chips">{(f.options || []).map(o => (
                <label key={o} className={"chip" + (picked.includes(o) ? " on" : "")}>
                  <input type="checkbox" checked={picked.includes(o)} onChange={e => set(f.name, e.target.checked ? [...picked, o] : picked.filter(x => x !== o))} />{o}
                </label>
              ))}</div>
            </div>
          );
        }
        if (f.type === "select") return (
          <label key={f.name} className="field">{label}
            <select value={v || ""} onChange={e => set(f.name, e.target.value)}>
              <option value="">請選擇</option>{(f.options || []).map(o => <option key={o}>{o}</option>)}
            </select>
          </label>
        );
        if (f.type === "textarea") return (
          <label key={f.name} className="field full">{label}<textarea value={v || ""} placeholder={f.placeholder} onChange={e => set(f.name, e.target.value)} /></label>
        );
        return (
          <label key={f.name} className="field">{label}
            <input type={f.type === "date" ? "date" : f.type === "number" ? "number" : "text"} value={v ?? ""} placeholder={f.placeholder} onChange={e => set(f.name, e.target.value)} />
          </label>
        );
      })}
    </div>
  );
}

function missing(fields: Field[], values: Values) {
  return fields.filter(f => f.required && (Array.isArray(values[f.name]) ? !values[f.name].length : !String(values[f.name] ?? "").trim())).map(f => f.label);
}

function ProjectPicker({ value, onPick, required }: { value: string; onPick: (id: string, project: any) => void; required?: boolean }) {
  const lk = useLookups();
  return (
    <label className="field"><span>專案{required ? " *" : "（選填，選了會自動帶入資料）"}</span>
      <select value={value} onChange={e => onPick(e.target.value, lk.projects.find(p => p.id === e.target.value))}>
        <option value="">{required ? "請選擇" : "不指定"}</option>
        {lk.projects.map(p => <option key={p.id} value={p.id}>{p.code} {p.name}</option>)}
      </select>
    </label>
  );
}

function Docs({ forms }: { forms: any[] }) {
  const [kind, setKind] = useState(forms[0].kind);
  const [projectId, setProjectId] = useState("");
  const [values, setValues] = useState<Values>({});
  const [result, setResult] = useState<any | null>(null);
  const { busy, run } = useAction();
  const form = forms.find(f => f.kind === kind);
  const lack = missing(form.fields, values);
  const go = async () => {
    setResult(null);
    const r = await run(() => call<any>("ai.generateDocument", { kind, project_id: projectId || null, values }), "已產出，並存成 Google 文件");
    if (r) setResult(r);
  };
  return (
    <div className="card">
      <div className="form-grid">
        <label className="field"><span>文件類型</span>
          <select value={kind} onChange={e => { setKind(e.target.value); setResult(null); }}>{forms.map(f => <option key={f.kind} value={f.kind}>{f.label}</option>)}</select>
        </label>
        <ProjectPicker value={projectId} required={form.needsProject} onPick={(id, p) => { setProjectId(id); setValues(fillFromProject(form.fields, values, p)); }} />
      </div>
      <div className="toolbar">
        <h3>填寫內容</h3><span className="spacer" />
        <button className="btn small" onClick={() => setValues({ ...form.template })}>套用範本</button>
        <button className="btn small" onClick={() => setValues({})}>清空</button>
      </div>
      <FormFields fields={form.fields} values={values} onChange={setValues} />
      <div className="modal-foot">
        {lack.length > 0 && <span className="muted small">還沒填：{lack.join("、")}</span>}
        <button className="btn primary" disabled={busy || lack.length > 0 || (form.needsProject && !projectId)} onClick={go}>{busy ? "AI 撰寫中，約需 30–60 秒…" : "產出初稿"}</button>
      </div>
      {result && <>
        <p><a className="btn" href={result.url} target="_blank" rel="noopener noreferrer">開啟 Google 文件 ↗</a> <button className="btn" onClick={() => navigator.clipboard.writeText(result.text)}>複製全文</button></p>
        <pre className="doc">{result.text}</pre>
      </>}
    </div>
  );
}

function CopyBlock({ title, text }: { title: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="prompt-block">
      <div className="toolbar"><b>{title}</b><span className="spacer" />
        <button className="btn small" onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "已複製" : "複製"}</button>
      </div>
      <pre className="doc">{text}</pre>
    </div>
  );
}

function Design({ form }: { form: any }) {
  const [projectId, setProjectId] = useState("");
  const [values, setValues] = useState<Values>({});
  const [result, setResult] = useState<any | null>(null);
  const { busy, run } = useAction();
  const lack = missing(form.fields, values);
  const go = async () => {
    setResult(null);
    const r = await run(() => call<any>("ai.design", { project_id: projectId || null, values }), "已產出提示詞");
    if (r) setResult(r);
  };
  const p = result?.plan;
  return (
    <div className="card">
      <div className="form-grid">
        <ProjectPicker value={projectId} onPick={(id, pr) => { setProjectId(id); setValues(fillFromProject(form.fields, values, pr)); }} />
      </div>
      <div className="toolbar">
        <h3>設計需求</h3><span className="spacer" />
        <button className="btn small" onClick={() => setValues({ ...form.template })}>套用範本</button>
        <button className="btn small" onClick={() => setValues({})}>清空</button>
      </div>
      <FormFields fields={form.fields} values={values} onChange={setValues} />
      <div className="modal-foot">
        {lack.length > 0 && <span className="muted small">還沒填：{lack.join("、")}</span>}
        <button className="btn primary" disabled={busy || lack.length > 0} onClick={go}>{busy ? "AI 構思中…" : "產出提示詞"}</button>
      </div>
      {p && (
        <div className="design">
          <dl className="dl">
            <dt>主標</dt><dd>{p.headline}</dd><dt>副標</dt><dd>{p.subheadline}</dd>
            <dt>文案</dt><dd>{p.copy}</dd><dt>設計概念</dt><dd>{p.concept}</dd>
          </dl>
          <CopyBlock title={"提示詞（貼到 " + result.tool + "）"} text={p.prompt} />
          {p.prompt_zh && <p className="muted small">中文說明：{p.prompt_zh}</p>}
          {p.negative && <CopyBlock title="要避免的元素（負面提示詞）" text={p.negative} />}
          {(p.variations || []).map((v: string, i: number) => <CopyBlock key={i} title={"變化版 " + (i + 1)} text={v} />)}
        </div>
      )}
    </div>
  );
}
