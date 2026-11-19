/**
 * Service 層共用的寫入流程：LockService + 樂觀鎖。
 *
 * GAS 沒有交易隔離，兩者缺一不可：
 * - script lock 防止兩個請求同時寫 Sheet（例如同時新增寫進同一列）；
 * - 樂觀鎖防止使用者拿著幾分鐘前讀到的舊畫面，覆蓋掉別人剛存的修改。
 * 各模組的 Service 都透過這裡寫入，不直接呼叫 Repository 的寫入方法。
 * actor 一律是帳號中心的帳號（account），由 Controller 從驗證過的憑證取得。
 */

const LOCK_TIMEOUT_MS_ = 10 * 1000;
let lockDepth_ = 0;

/**
 * 可重入：Service 互相呼叫時（例如建立會議時順便同步里程碑）只在最外層取得與釋放 lock。
 * 若每層都 release，內層一結束就會提早放掉外層的 lock，後續寫入就失去保護。
 */
function withScriptLock_(fn) {
  if (lockDepth_ > 0) {
    lockDepth_++;
    try {
      return fn();
    } finally {
      lockDepth_--;
    }
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS_)) {
    throw new AppError(ERROR_CODES.LOCK, '系統忙碌中，請稍後再試');
  }
  lockDepth_ = 1;
  try {
    return fn();
  } finally {
    lockDepth_ = 0;
    lock.releaseLock();
  }
}

function createRecords_(tableName, list, actor) {
  return withScriptLock_(() => repo_(tableName).insertMany(list, actor));
}

function createRecord_(tableName, data, actor) {
  return createRecords_(tableName, [data], actor)[0];
}

function updateRecord_(tableName, id, expectedUpdatedAt, patch, actor) {
  return withScriptLock_(() => {
    const repo = repo_(tableName);
    const snapshot = loadCurrentForWrite_(repo, id, expectedUpdatedAt);
    return repo.writeSnapshot(snapshot, patch, actor);
  });
}

function softDeleteRecord_(tableName, id, expectedUpdatedAt, actor) {
  return withScriptLock_(() => {
    const repo = repo_(tableName);
    const snapshot = loadCurrentForWrite_(repo, id, expectedUpdatedAt);
    return repo.markDeleted(snapshot, actor);
  });
}

function loadCurrentForWrite_(repo, id, expectedUpdatedAt) {
  // 不帶 expectedUpdatedAt 等於關掉樂觀鎖，所以視為呼叫錯誤而不是預設放行。
  if (!expectedUpdatedAt) {
    throw new AppError(ERROR_CODES.VALIDATION, '更新必須帶 expectedUpdatedAt');
  }
  const snapshot = repo.readForWrite(id);
  if (!snapshot || snapshot.record.is_deleted) {
    throw new AppError(ERROR_CODES.NOT_FOUND, '找不到資料：' + id, { id });
  }
  if (snapshot.record.updated_at !== expectedUpdatedAt) {
    throw new AppError(ERROR_CODES.CONFLICT, '資料已被其他人修改，請重新整理後再試', {
      id,
      expectedUpdatedAt,
      currentUpdatedAt: snapshot.record.updated_at,
      currentUpdatedBy: snapshot.record.updated_by,
    });
  }
  return snapshot;
}
