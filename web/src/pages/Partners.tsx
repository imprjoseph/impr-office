import { useState } from "react";
import { CrudPage, Field, Tabs, useLoad, useLookups } from "../ui";

export function Clients() {
  const lk = useLookups();
  const [tab, setTab] = useState("clients");
  const clientName = (id?: string) => lk.clients.find(c => c.id === id)?.name || "—";
  return (
    <>
      <Tabs tabs={[["clients", "客戶"], ["contacts", "聯絡人"], ["activities", "往來紀錄"]]} value={tab} onChange={setTab} />
      {tab === "clients" && <CrudPage title="客戶" prefix="client" canWrite onChanged={() => lk.refresh(["clients"])} fields={[
        { name: "name", label: "名稱", required: true, full: true }, { name: "tax_id", label: "統一編號" }, { name: "industry", label: "產業" },
        { name: "phone", label: "電話" }, { name: "website", label: "網站", type: "url" }, { name: "address", label: "地址", full: true },
        { name: "owner_account", label: "業務負責人", type: "person" }, { name: "tags", label: "標籤" }, { name: "note", label: "備註", type: "textarea" },
      ]} columns={[
        { key: "name", label: "客戶", render: c => <><b>{c.name}</b><small className="muted block">{[c.industry, c.tax_id && "統編 " + c.tax_id].filter(Boolean).join("・")}</small></> },
        { key: "phone", label: "電話", hideSm: true }, { key: "owner", label: "負責人", render: c => lk.nameOf(c.owner_account) },
      ]} />}
      {tab === "contacts" && <CrudPage title="聯絡人" prefix="contact" canWrite fields={[
        { name: "name", label: "姓名", required: true }, { name: "title", label: "職稱" }, { name: "client_id", label: "客戶", type: "client" },
        { name: "supplier_id", label: "供應商", type: "supplier" }, { name: "phone", label: "電話" }, { name: "email", label: "Email", type: "email" },
        { name: "note", label: "備註", type: "textarea" },
      ]} columns={[
        { key: "name", label: "姓名", render: c => <><b>{c.name}</b><small className="muted block">{c.title || ""}</small></> },
        { key: "org", label: "單位", render: c => c.client_id ? clientName(c.client_id) : (lk.suppliers.find(s => s.id === c.supplier_id)?.name || "—") },
        { key: "phone", label: "電話" }, { key: "email", label: "Email", hideSm: true },
      ]} />}
      {tab === "activities" && <CrudPage title="往來紀錄" prefix="clientActivity" canWrite searchKeys={["summary", "kind"]} fields={[
        { name: "client_id", label: "客戶", type: "client", required: true }, { name: "activity_date", label: "日期", type: "date", required: true },
        { name: "kind", label: "類型", type: "select", options: ["拜訪", "電話", "會議", "提案", "報價", "其他"] }, { name: "project_id", label: "相關專案", type: "project" },
        { name: "owner_account", label: "負責人", type: "person" }, { name: "summary", label: "內容", type: "textarea", required: true },
      ]} columns={[
        { key: "activity_date", label: "日期" }, { key: "client", label: "客戶", render: a => clientName(a.client_id) },
        { key: "kind", label: "類型", hideSm: true }, { key: "summary", label: "內容" },
      ]} />}
    </>
  );
}

export function Suppliers() {
  const lk = useLookups();
  const cats = useLoad<string[]>("supplier.categories");
  const fields: Field[] = [
    { name: "name", label: "名稱", required: true, full: true }, { name: "category", label: "類別", type: "select", options: cats.data || [] },
    { name: "tax_id", label: "統一編號" }, { name: "service_items", label: "服務項目", full: true },
    { name: "contact_name", label: "聯絡人" }, { name: "contact_phone", label: "電話" }, { name: "contact_email", label: "Email", type: "email" },
    { name: "note", label: "備註", type: "textarea" },
  ];
  return <CrudPage title="供應商" sub="全公司唯一的供應商名單；評分只能在專案結案時評。" prefix="supplier" canWrite fields={fields}
    onChanged={() => lk.refresh(["suppliers"])} columns={[
      { key: "name", label: "供應商", render: s => <><b>{s.name}</b><small className="muted block">{[s.service_items, s.tax_id && "統編 " + s.tax_id].filter(Boolean).join("・")}</small></> },
      { key: "category", label: "類別" },
      { key: "contact", label: "聯絡人", hideSm: true, render: s => (s.contact_name || "—") + (s.contact_phone ? " " + s.contact_phone : "") },
      { key: "rating", label: "評價", num: true, render: s => s.rating_count ? Number(s.avg_rating).toFixed(1) + " ★（" + s.rating_count + "）" : "—" },
    ]} />;
}
