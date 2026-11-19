/**
 * 後端 API：Apps Script 部署，身分用帳號中心的憑證（和入口網站共用 localStorage）。
 * 以 text/plain 送 JSON，避開 Apps Script 不支援的 CORS 預檢。
 */
export const API_URL: string = import.meta.env.VITE_API_URL || "";
const TOKEN_KEY = "impr_sso_token";
const LOGIN_URL = "https://imprjoseph.github.io/total-system/login/";

export type Role = "admin" | "manager" | "accountant" | "staff" | "dispatch";
export interface Me { account: string; name: string; email: string; dept: string; manager: string; type: string; role: Role }

export class ApiError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function goLogin(): never {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* 無痕模式 */ }
  location.href = LOGIN_URL + "?next=" + encodeURIComponent(location.href);
  throw new ApiError("TOKEN", "請重新登入");
}

/** 只看憑證有沒有過期，不驗簽章（驗證由後端向帳號中心做）。 */
export function tokenExpired(token: string): boolean {
  try {
    const p = token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p + "===".slice(0, (4 - p.length % 4) % 4)), c => c.charCodeAt(0))));
    return !json.exp || json.exp * 1000 <= Date.now();
  } catch { return true; }
}

export async function call<T = any>(action: string, payload?: Record<string, unknown>): Promise<T> {
  const token = getToken();
  if (!token || tokenExpired(token)) goLogin();
  if (!API_URL) throw new ApiError("CONFIG", "尚未設定後端網址（VITE_API_URL）");
  let res: Response;
  try {
    res = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action, token, payload: payload || {} }) });
  } catch {
    throw new ApiError("NETWORK", "連線失敗，請檢查網路後再試");
  }
  let json: any;
  try { json = await res.json(); } catch { throw new ApiError("INTERNAL", "系統暫時無法使用，請稍後再試"); }
  if (json.ok) return json.data as T;
  const authCode = json.error.details && json.error.details.authCode;
  if (authCode === "TOKEN" || authCode === "DISABLED") goLogin();
  throw new ApiError(json.error.code, json.error.message, json.error.details);
}
