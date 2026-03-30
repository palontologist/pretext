import { spawnSync, type ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import {
  acquireBrowserAutomationLock,
  createBrowserSession,
  ensurePageServer,
  getAvailablePort,
  loadHashReport,
  type BrowserKind,
} from './browser-automation.ts'

type GatsbyLineMismatch = {
  line: number
  ours: string
  browser: string
}

type GatsbyNavigationBreakMismatch = {
  line: number
  deltaText: string
  oursContext: string
  browserContext: string
  reasonGuess: string
}

type GatsbyNavigationReport = {
  status: 'ready' | 'error'
  requestId?: string
  width?: number
  predictedHeight?: number
  actualHeight?: number
  diffPx?: number
  predictedLineCount?: number
  browserLineCount?: number
  mismatchCount?: number
  firstMismatch?: GatsbyLineMismatch | null
  firstBreakMismatch?: GatsbyNavigationBreakMismatch | null
  message?: string
}

type SweepMismatch = {
  width: number
  diffPx: number
  predictedHeight: number
  actualHeight: number
  predictedLineCount: number | null
  browserLineCount: number | null
  mismatchCount: number | null
  firstBreakMismatch: GatsbyNavigationBreakMismatch | null
  firstMismatch: GatsbyLineMismatch | null
}

type SweepSummary = {
  browser: BrowserKind
  start: number
  end: number
  step: number
  widthCount: number
  exactCount: number
  mismatches: SweepMismatch[]
}

type SweepOptions = {
  start: number
  end: number
  step: number
  port: number
  browser: BrowserKind
  diagnose: boolean
  diagnoseLimit: number
  output: string | null
}

function parseNumberFlag(name: string, fallback: number): number {
  const prefix = `--${name}=`
  const arg = process.argv.find(value => value.startsWith(prefix))
  if (arg === undefined) return fallback
  const parsed = Number.parseInt(arg.slice(prefix.length), 10)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid value for --${name}: ${arg.slice(prefix.length)}`)
  }
  return parsed
}

function parseStringFlag(name: string): string | null {
  const prefix = `--${name}=`
  const arg = process.argv.find(value => value.startsWith(prefix))
  return arg === undefined ? null : arg.slice(prefix.length)
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function parseBrowser(value: string | null): BrowserKind {
  const browser = (value ?? process.env['GATSBY_CHECK_BROWSER'] ?? 'chrome').toLowerCase()
  if (browser !== 'chrome' && browser !== 'safari') {
    throw new Error(`Unsupported browser ${browser}; expected chrome or safari`)
  }
  return browser
}

function parseOptions(): SweepOptions {
  const start = parseNumberFlag('start', 300)
  const end = parseNumberFlag('end', 900)
  const step = parseNumberFlag('step', 10)
  const port = parseNumberFlag('port', Number.parseInt(process.env['GATSBY_CHECK_PORT'] ?? '0', 10))
  const browser = parseBrowser(parseStringFlag('browser'))
  const diagnose = hasFlag('diagnose')
  const diagnoseLimit = parseNumberFlag('diagnose-limit', 6)
  const output = parseStringFlag('output')

  if (step <= 0) throw new Error('--step must be > 0')
  if (end < start) throw new Error('--end must be >= --start')

  return { start, end, step, port, browser, diagnose, diagnoseLimit, output }
}

function getTargetWidths(options: SweepOptions): number[] {
  const widths: number[] = []
  for (let width = options.start; width <= options.end; width += options.step) {
    widths.push(width)
  }
  return widths
}

function formatSignedInt(value: number): string {
  return `${value > 0 ? '+' : ''}${Math.round(value)}`
}

function formatRanges(widths: number[], step: number): string {
  if (widths.length === 0) return '-'

  const parts: string[] = []
  let rangeStart = widths[0]!
  let previous = widths[0]!

  for (let i = 1; i < widths.length; i++) {
    const width = widths[i]!
    if (width === previous + step) {
      previous = width
      continue
    }
    parts.push(rangeStart === previous ? `${rangeStart}` : `${rangeStart}-${previous}`)
    rangeStart = width
    previous = width
  }

  parts.push(rangeStart === previous ? `${rangeStart}` : `${rangeStart}-${previous}`)
  return parts.join(', ')
}

function printSummary(summary: SweepSummary): void {
  console.log(
    `swept ${summary.widthCount} widths (${summary.start}-${summary.end} step ${summary.step}) in ${summary.browser}: ${summary.exactCount} exact, ${summary.mismatches.length} nonzero`,
  )

  if (summary.mismatches.length === 0) {
    return
  }

  const byDiff = new Map<number, number[]>()
  for (const mismatch of summary.mismatches) {
    const bucket = byDiff.get(mismatch.diffPx)
    if (bucket === undefined) {
      byDiff.set(mismatch.diffPx, [mismatch.width])
    } else {
      bucket.push(mismatch.width)
    }
  }

  const sortedBuckets = [...byDiff.entries()].sort((a, b) => a[0] - b[0])
  for (const [diffPx, widths] of sortedBuckets) {
    console.log(`  ${formatSignedInt(diffPx)}px: ${formatRanges(widths, summary.step)}`)
  }

  console.log('  first mismatches:')
  for (const mismatch of summary.mismatches.slice(0, 10)) {
    const lines =
      mismatch.predictedLineCount !== null && mismatch.browserLineCount !== null
        ? ` | lines ${mismatch.predictedLineCount}/${mismatch.browserLineCount}`
        : ''
    const reason = mismatch.firstBreakMismatch?.reasonGuess ?? 'no break diagnostic'
    console.log(`    ${mismatch.width}px -> ${formatSignedInt(mismatch.diffPx)}px${lines} | ${reason}`)
  }
}

function maybeWriteSummary(summary: SweepSummary, output: string | null): void {
  if (output === null) return
  writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  console.log(`wrote ${output}`)
}

function runDetailedDiagnose(mismatches: SweepMismatch[], options: SweepOptions): void {
  if (!options.diagnose || mismatches.length === 0) return

  const widths = mismatches
    .slice(0, options.diagnoseLimit)
    .map(mismatch => String(mismatch.width))

  console.log(`diagnosing ${widths.length} widths with slow checker: ${widths.join(', ')}`)

  const result = spawnSync(
    'bun',
    ['run', 'scripts/gatsby-check.ts', ...widths],
    {
      cwd: process.cwd(),
      env: { ...process.env, GATSBY_CHECK_BROWSER: options.browser, GATSBY_CHECK_PORT: String(options.port) },
      encoding: 'utf8',
    },
  )

  if (result.stdout.length > 0) process.stdout.write(result.stdout)
  if (result.stderr.length > 0) process.stderr.write(result.stderr)
  if (result.status !== 0) {
    throw new Error(`gatsby-check exited with status ${result.status ?? 'unknown'}`)
  }
}

const options = parseOptions()
options.port = await getAvailablePort(options.port === 0 ? null : options.port)
const lock = await acquireBrowserAutomationLock(options.browser)
const session = createBrowserSession(options.browser)
let serverProcess: ChildProcess | null = null

try {
  const pageServer = await ensurePageServer(options.port, '/gatsby', process.cwd())
  serverProcess = pageServer.process
  const baseUrl = `${pageServer.baseUrl}/gatsby`
  const mismatches: SweepMismatch[] = []
  const widths = getTargetWidths(options)

  for (let index = 0; index < widths.length; index++) {
    const width = widths[index]!
    const requestId = `${Date.now()}-${width}-${Math.random().toString(36).slice(2, 8)}`
    const url = `${baseUrl}?report=1&diagnostic=light&width=${width}&requestId=${requestId}`
    const report = await loadHashReport<GatsbyNavigationReport>(session, url, requestId, options.browser)

    if (report.status === 'error') {
      throw new Error(report.message ?? `Gatsby report failed at width ${width}`)
    }

    const diffPx = report.diffPx ?? 0
    if (diffPx !== 0) {
      mismatches.push({
        width: report.width ?? width,
        diffPx,
        predictedHeight: report.predictedHeight ?? 0,
        actualHeight: report.actualHeight ?? 0,
        predictedLineCount: report.predictedLineCount ?? null,
        browserLineCount: report.browserLineCount ?? null,
        mismatchCount: report.mismatchCount ?? null,
        firstBreakMismatch: report.firstBreakMismatch ?? null,
        firstMismatch: report.firstMismatch ?? null,
      })

      console.log(
        `${width}px -> ${formatSignedInt(diffPx)}px | ${report.predictedHeight ?? 0}/${report.actualHeight ?? 0}${report.firstBreakMismatch?.reasonGuess ? ` | ${report.firstBreakMismatch.reasonGuess}` : ''}`,
      )
    }

    if ((index + 1) % 50 === 0 || index === widths.length - 1) {
      console.log(`progress ${index + 1}/${widths.length}`)
    }
  }

  const summary: SweepSummary = {
    browser: options.browser,
    start: options.start,
    end: options.end,
    step: options.step,
    widthCount: widths.length,
    exactCount: widths.length - mismatches.length,
    mismatches,
  }

  printSummary(summary)
  maybeWriteSummary(summary, options.output)
  runDetailedDiagnose(mismatches, options)
} finally {
  session.close()
  serverProcess?.kill('SIGTERM')
  lock.release()
}
