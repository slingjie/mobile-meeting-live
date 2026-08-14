export function shouldDisableExport({ entryCount, finalizingCount }) {
  return Number(entryCount) <= 0 || Number(finalizingCount) > 0;
}
