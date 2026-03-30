export function clearNavigationReport(): void {
  history.replaceState(null, '', `${location.pathname}${location.search}`)
}

export function publishNavigationReport(report: unknown): void {
  const encoded = encodeURIComponent(JSON.stringify(report))
  history.replaceState(null, '', `${location.pathname}${location.search}#report=${encoded}`)
}
