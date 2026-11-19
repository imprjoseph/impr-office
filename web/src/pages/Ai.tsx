import { useState } from "react";
import { call } from "../api";
import { Loading, Page, Tabs, useAction, useLoad, useLookups } from "../ui";

export default function Ai() {
  const [tab, setTab] = useState("doc");
  return (
    <Page title="AI 文件與設計" sub="AI 產出的是初稿：送出前請人工確認事實、人名與數字；資料沒有的地方會標【待補】。">
      <Tabs tabs={[["doc", "文件產出"], ["design", "平面設計"]]} value={tab} onChange={setTab} />
      {tab === "doc" ? <Docs /> : <Design />}
    </Page>
  );
}

function Docs() {
  const lk = useLookups();
  const kinds = useLoad<any[]>("ai.docKinds");
  const [kind, setKind] = useState("press_release");
  const [projectId, setProjectId] = useState("");
  const [extra, setExtra] = useState("");
  const [result, setResult] = useState<any | null>(null);
  const { busy, run } = useAction();
  const go = async () => {
    setResult(null);
    const r = await run(() => call<any>("ai.generateDocument", { kind, project_id: projectId, extra: extra || null }), "已產出，並存成 Google 文件");
    if (r) setResult(r);
  };
  return (
    <div className="card">
      <div className="form-grid">
        <label className="field"><span>文件類型</span><select value={kind} onChange={e => setKind(e.target.value)}>{(kinds.data || []).map(k => <option key={k.kind} value={k.kind}>{k.label}</option>)}</select></label>
        <label className="field"><span>專案 *</span><select value={projectId} onChange={e => setProjectId(e.target.value)}><option value="">請選擇</option>{lk.projects.map(p => <option key={p.id} value={p.id}>{p.code} {p.name}</option>)}</select></label>
        <label className="field full"><span>補充說明（貴賓、重點、語氣…）</span><textarea value={extra} onChange={e => setExtra(e.target.value)} /></label>
      </div>
      <div className="modal-foot"><button className="btn primary" disabled={busy || !projectId} onClick={go}>{busy ? "AI 撰寫中，約需 30–60 秒…" : "產出初稿"}</button></div>
      {result && <>
        <p><a className="btn" href={result.url} target="_blank" rel="noopener noreferrer">開啟 Google 文件 ↗</a> <button className="btn" onClick={() => navigator.clipboard.writeText(result.text)}>複製全文</button></p>
        <pre className="doc">{result.text}</pre>
      </>}
    </div>
  );
}

function Design() {
  const lk = useLookups();
  const [v, setV] = useState({ title: "", usage: "主視覺", theme: "", organizer: "", size: "16:9", project_id: "" });
  const [result, setResult] = useState<any | null>(null);
  const { busy, run } = useAction();
  const go = async () => {
    setResult(null);
    const r = await run(() => call<any>("ai.design", Object.assign({}, v, { project_id: v.project_id || null })), "已產出設計");
    if (r) setResult(r);
  };
  const set = (k: string) => (e: any) => setV({ ...v, [k]: e.target.value });
  const src = result ? "data:" + result.image.mimeType + ";base64," + result.image.base64 : "";
  return (
    <div className="card">
      <div className="form-grid">
        <label className="field full"><span>活動名稱 *</span><input value={v.title} onChange={set("title")} /></label>
        <label className="field"><span>用途</span><select value={v.usage} onChange={set("usage")}>{["主視覺", "背板", "海報", "社群貼文", "EDM 橫幅"].map(o => <option key={o}>{o}</option>)}</select></label>
        <label className="field"><span>比例</span><select value={v.size} onChange={set("size")}>{["16:9", "1:1", "4:5", "9:16", "3:4"].map(o => <option key={o}>{o}</option>)}</select></label>
        <label className="field"><span>主辦單位</span><input value={v.organizer} onChange={set("organizer")} /></label>
        <label className="field"><span>專案</span><select value={v.project_id} onChange={set("project_id")}><option value="">（不指定）</option>{lk.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="field full"><span>主題與調性</span><textarea value={v.theme} onChange={set("theme")} placeholder="例如：國際醫學論壇，沉穩專業、帶一點溫度，主色深藍與暖金" /></label>
      </div>
      <div className="modal-foot"><button className="btn primary" disabled={busy || !v.title} onClick={go}>{busy ? "設計中…" : "產出設計"}</button></div>
      <Loading loading={busy} />
      {result && (
        <div className="design">
          <div className="design-img">
            <img src={src} alt={result.plan.concept} />
            <div className="design-text"><b>{result.plan.headline}</b><span>{result.plan.subheadline}</span></div>
          </div>
          <dl className="dl">
            <dt>主標</dt><dd>{result.plan.headline}</dd><dt>副標</dt><dd>{result.plan.subheadline}</dd>
            <dt>文案</dt><dd>{result.plan.copy}</dd><dt>設計概念</dt><dd>{result.plan.concept}</dd>
          </dl>
          <a className="btn" href={src} download={(v.title || "design") + ".png"}>下載底圖</a>
        </div>
      )}
    </div>
  );
}
