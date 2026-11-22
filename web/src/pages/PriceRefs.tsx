/** 報價參考：公司估算單價與各廠商報價。比價看同一品項各家價格；做專案預算時在預算分頁「從報價參考加入」。 */
import { useState } from "react";
import { CrudPage, Loading, Page, Table, Tabs, money, pct, useLoad, useLookups } from "../ui";

export default function PriceRefs() {
  const lk = useLookups();
  const [tab, setTab] = useState("compare");
  return (
    <>
      <Tabs tabs={[["compare", "比價"], ["all", "全部資料"]]} value={tab} onChange={setTab} />
      {tab === "compare" ? <Compare /> : <CrudPage title="報價參考" sub="廠商留空白的是公司估算價；有填廠商的是該廠商的報價。"
        prefix="priceRef" canWrite listAction="priceRef.list" searchKeys={["item", "type", "vendor_name", "note"]}
        importAction={lk.can("admin", "manager") ? "import.priceRefs" : undefined}
        importHint="表頭要有「品項」「估價」，可有「類型」「單位」「備註」「廠商」「對客戶報價」。有填廠商的列是廠商報價，沒填的是公司估算價。同品項＋類型＋廠商的會更新單價。"
        fields={[
          { name: "item", label: "品項", required: true }, { name: "type", label: "類型" },
          { name: "unit_price", label: "成本單價", type: "number" }, { name: "unit", label: "單位（張、座、才…）" },
          { name: "quote_price", label: "對客戶報價（單價，填在公司估算那列即可）", type: "number" },
          { name: "vendor_name", label: "廠商（空白＝公司估算）" }, { name: "supplier_id", label: "對應供應商", type: "supplier" },
          { name: "quoted_at", label: "報價日期", type: "date" }, { name: "note", label: "備註", type: "textarea" },
        ]} columns={[
          { key: "item", label: "品項", render: r => <><b>{r.item}</b><small className="muted block">{r.type || ""}</small></> },
          { key: "vendor", label: "來源", render: r => r.vendor_name ? r.vendor_name + (r.supplier_name && r.supplier_name !== r.vendor_name ? "（" + r.supplier_name + "）" : "") : <span className="muted">公司估算</span> },
          { key: "price", label: "成本單價", num: true, render: r => r.unit_price == null ? "—" : money(r.unit_price) + " / " + (r.unit || "") },
          { key: "quote", label: "對客戶報價", num: true, hideSm: true, render: r => r.quote_price == null ? "—" : money(r.quote_price) },
          { key: "note", label: "備註", hideSm: true },
        ]} />}
    </>
  );
}

function Compare() {
  const { data, error, loading } = useLoad<any[]>("priceRef.compare");
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const types = Array.from(new Set((data || []).map(g => g.type).filter(Boolean))).sort();
  const rows = (data || []).filter(g => (!type || g.type === type) && (!q || [g.item, g.type, ...g.quotes.map((x: any) => x.vendor_name)].some(v => String(v || "").toLowerCase().includes(q.toLowerCase()))));
  return (
    <Page title="比價" sub="同一品項的公司估算價、各廠商報價與對客戶報價；綠色是最低的廠商報價。毛利率以對客戶報價和最低成本計算。做預算時到專案的「預算」分頁按「從報價參考加入」。">
      <div className="toolbar">
        <select value={type} onChange={e => setType(e.target.value)} aria-label="類型"><option value="">全部類型</option>{types.map(t => <option key={t}>{t}</option>)}</select>
        <input type="search" placeholder="搜尋品項、廠商" value={q} onChange={e => setQ(e.target.value)} />
        <span className="muted">{rows.length} 個品項</span>
      </div>
      <Loading error={error} loading={loading && !data} />
      {data && <Table rows={rows} empty="還沒有報價資料，可到「全部資料」從 Excel 匯入。" columns={[
        { key: "item", label: "品項", render: g => <><b>{g.item}</b><small className="muted block">{g.type || ""}{g.unit ? "・每" + g.unit : ""}</small></> },
        { key: "est", label: "公司估算", num: true, render: g => g.estimate?.unit_price != null ? money(g.estimate.unit_price) : "—" },
        { key: "quote", label: "對客戶報價", num: true, render: g => g.quote_price == null ? <span className="muted">未填</span>
          : <>{money(g.quote_price)}{g.quote_is_markup && <small className="muted block">依加成推算</small>}</> },
        { key: "margin", label: "毛利率", num: true, hideSm: true, render: g => {
          const costs = [g.estimate?.unit_price, g.lowest?.unit_price].filter((x: any) => x != null);
          const cost = costs.length ? Math.min(...costs) : null;
          return g.quote_price && cost != null ? <span className={(g.quote_price - cost) / g.quote_price < 0.2 ? "red" : ""}>{pct((g.quote_price - cost) / g.quote_price)}</span> : "—";
        } },
        { key: "quotes", label: "廠商報價", render: g => g.quotes.length ? <span className="quote-list">{g.quotes.map((x: any) => (
          <span key={x.id} className={g.lowest && x.id === g.lowest.id ? "badge green" : "badge"}>{x.vendor_name} {x.unit_price != null ? money(x.unit_price) : "未報價"}</span>
        ))}</span> : <span className="muted">—</span> },
      ]} />}
    </Page>
  );
}
