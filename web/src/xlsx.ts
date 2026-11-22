/**
 * 在瀏覽器裡讀 .xlsx（不用第三方套件）：xlsx 是 zip 包 XML，用瀏覽器內建的 DecompressionStream 解壓、DOMParser 讀 XML。
 * 檔案內容只在使用者的瀏覽器裡處理，再直接送到公司自己的後端，不經過其他服務。
 * 只取儲存格的「值」（文字、數字），公式取計算後的結果，日期序號轉成 yyyy-mm-dd。
 */

export interface SheetRows { name: string; header: string[]; rows: Record<string, string>[] }

async function unzip(buf: ArrayBuffer): Promise<Record<string, Uint8Array>> {
  const v = new DataView(buf);
  const bytes = new Uint8Array(buf);
  // 找 End of Central Directory
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 Excel 檔（.xlsx）");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out: Record<string, Uint8Array> = {};
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!/^xl\/(workbook\.xml|sharedStrings\.xml|worksheets\/[^/]+\.xml|_rels\/workbook\.xml\.rels)$/.test(name)) continue;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + csize);
    if (method === 0) out[name] = data;
    else if (method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      out[name] = new Uint8Array(await new Response(stream).arrayBuffer());
    }
  }
  return out;
}

const xml = (b?: Uint8Array) => new DOMParser().parseFromString(b ? new TextDecoder().decode(b) : "<x/>", "application/xml");
const texts = (el: Element) => Array.from(el.getElementsByTagName("t")).map(t => t.textContent || "").join("");

function colIndex(ref: string): number {
  const letters = (ref.match(/^[A-Z]+/) || ["A"])[0];
  return letters.split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

/** 讀出每個工作表；表頭取「第一列有 3 格以上有值」的那一列，之後的每列轉成 { 表頭: 值 }。 */
export async function readXlsx(file: File): Promise<SheetRows[]> {
  const files = await unzip(await file.arrayBuffer());
  const shared = Array.from(xml(files["xl/sharedStrings.xml"]).getElementsByTagName("si")).map(texts);
  const rels: Record<string, string> = {};
  Array.from(xml(files["xl/_rels/workbook.xml.rels"]).getElementsByTagName("Relationship")).forEach(r => { rels[r.getAttribute("Id") || ""] = r.getAttribute("Target") || ""; });
  const sheets = Array.from(xml(files["xl/workbook.xml"]).getElementsByTagName("sheet"));
  return sheets.map(s => {
    const rid = s.getAttribute("r:id") || s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") || "";
    const target = rels[rid] || "";
    const path = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
    const doc = xml(files[path]);
    const grid: string[][] = Array.from(doc.getElementsByTagName("row")).map(row => {
      const cells: string[] = [];
      Array.from(row.getElementsByTagName("c")).forEach(c => {
        const t = c.getAttribute("t");
        const vEl = c.getElementsByTagName("v")[0];
        let val = t === "inlineStr" ? texts(c) : vEl ? vEl.textContent || "" : "";
        if (t === "s") val = shared[Number(val)] || "";
        cells[colIndex(c.getAttribute("r") || "A")] = val.trim();
      });
      return Array.from(cells, x => x || "");
    }).filter(r => r.some(x => x));
    const hi = grid.findIndex(r => r.filter(Boolean).length >= 3);
    if (hi < 0) return { name: s.getAttribute("name") || "", header: [], rows: [] };
    const header = grid[hi].map(h => h.trim());
    const rows = grid.slice(hi + 1).map(r => {
      const o: Record<string, string> = {};
      header.forEach((h, i) => { if (h && r[i]) o[h] = r[i]; });
      return o;
    }).filter(o => Object.keys(o).length);
    return { name: s.getAttribute("name") || "", header, rows };
  });
}
