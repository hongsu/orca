import { Session } from 'node:inspector'
import { pathToFileURL } from 'node:url'
import { crashReporter } from 'electron'
import { recordDurableCrashBreadcrumb } from '../breadcrumbs/durable-crash-breadcrumb'
import { currentWorkerEntryLayout } from '../../worker-threads/worker-thread-entry-path'
import {
  parseMacHangPressure,
  readMacMemorySysctl
} from '../../hang-watchdog/hang-incident-snapshot'
import { readSamplingProfile, summarizeSamplingProfile } from './heap-allocation-sites'

/**
 * Main and its worker threads share one ~3.25 GB V8 cage, and it fills before main's own heap limit,
 * so V8's near-heap-limit hooks never fire and a heap snapshot would need the heap's size again.
 * Instead, V8's sampling heap profiler runs once the cage is busy, and its live allocation sites
 * are recorded as the cage nears full. Names come only from Orca's own bundle.
 */
const SAMPLING_INTERVAL_BYTES = 512 * 1024
const GB = 2 ** 30
const MB = 2 ** 20
// Early enough that a fast fill from here to the cage limit is still sampled.
const START_BYTES = 1 * GB
const STOP_BYTES = 0.75 * GB
const FIRST_READ_BYTES = 2.5 * GB
// Each read runs a full GC on main, so later reads wait for real growth.
const READ_GROWTH_BYTES = 512 * MB
// kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical.
const MAC_PRESSURE_WARN_LEVEL = 2
// Pressure can clear while the heap is still swapped out; a read then paged it all back in.
const MIN_RESIDENT_HEAP_SHARE = 0.5
const ANNOTATED_SITES = 2
const ANNOTATION_MAX_LENGTH = 127

type Sampling = {
  session: Session
  startedAtMs: number
  startedAtMB: number
  ready: boolean
  reading: boolean
  nextReadBytes: number
}

let sampling: Sampling | undefined
let checkingPressure = false
let latestTotalBytes = 0
let latestMainBytes = 0

function post(
  session: Session,
  method: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    session.post(method, params, (error, result) => (error ? reject(error) : resolve(result)))
  })
}

/** Fed each committed-heap total (main plus in-process workers) by the worker heap sampler. */
export function noteMainCageHeap(totalBytes: number, mainBytes: number): void {
  latestTotalBytes = totalBytes
  latestMainBytes = mainBytes
  if (sampling && totalBytes < STOP_BYTES) {
    stop()
    return
  }
  const current = sampling
  const wantsStart = !current && totalBytes >= START_BYTES
  const wantsRead =
    current !== undefined &&
    current.ready &&
    !current.reading &&
    totalBytes >= current.nextReadBytes
  if ((!wantsStart && !wantsRead) || checkingPressure) {
    return
  }
  // Under swap, the read's full GC pages the whole heap back in and froze main for 8-43 s.
  checkingPressure = true
  void machineUnderMemoryPressure()
    .then((pressured) => {
      if (pressured || sampling !== current) {
        return
      }
      // A newer sample may have dropped below the line while the check was pending.
      if (!current) {
        if (latestTotalBytes >= START_BYTES) {
          start(latestTotalBytes)
        }
      } else if (latestTotalBytes >= current.nextReadBytes && !mainHeapMayBePagedOut()) {
        read(current, latestTotalBytes, latestMainBytes)
      }
    })
    .catch(() => undefined)
    .finally(() => {
      checkingPressure = false
    })
}

async function machineUnderMemoryPressure(): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return false
  }
  const level = parseMacHangPressure(await readMacMemorySysctl(), '').systemMemoryPressureLevel
  // An unreadable level usually means sysctl timed out, which happens under the swap this guards.
  return level === null || level >= MAC_PRESSURE_WARN_LEVEL
}

// rss can't split main from workers, so count workers as fully resident: a wrong skip loses a diagnostic, a wrong read freezes main.
function mainHeapMayBePagedOut(): boolean {
  const workerBytes = latestTotalBytes - latestMainBytes
  return process.memoryUsage().rss < workerBytes + latestMainBytes * MIN_RESIDENT_HEAP_SHARE
}

function start(totalBytes: number): void {
  let session: Session
  try {
    session = new Session()
    session.connect()
  } catch {
    return
  }
  const current: Sampling = {
    session,
    startedAtMs: Date.now(),
    startedAtMB: Math.round(totalBytes / MB),
    ready: false,
    reading: false,
    nextReadBytes: FIRST_READ_BYTES
  }
  sampling = current
  void post(session, 'HeapProfiler.enable')
    .then(() =>
      post(session, 'HeapProfiler.startSampling', { samplingInterval: SAMPLING_INTERVAL_BYTES })
    )
    .then(() => {
      current.ready = true
    })
    .catch(() => {
      if (sampling === current) {
        stop()
      }
    })
}

/** Disconnecting stops sampling without stopSampling's forced GC. */
function stop(): void {
  const current = sampling
  sampling = undefined
  try {
    current?.session.disconnect()
  } catch {
    // Diagnostics only.
  }
  // Sites from an earlier peak would mislead a later, unrelated crash.
  annotateCrashReport({})
}

function read(current: Sampling, totalBytes: number, mainBytes: number): void {
  current.reading = true
  current.nextReadBytes = totalBytes + READ_GROWTH_BYTES
  void post(current.session, 'HeapProfiler.getSamplingProfile')
    .then((result) => {
      const profile = readSamplingProfile(result)
      if (!profile || sampling !== current) {
        return
      }
      const summary = summarizeSamplingProfile(profile, mainBundlePrefix())
      recordDurableCrashBreadcrumb('main_heap_allocation_profile', {
        totalHeapMB: Math.round(totalBytes / MB),
        mainHeapMB: Math.round(mainBytes / MB),
        startedAtMB: current.startedAtMB,
        sampledMinutes: Math.round((Date.now() - current.startedAtMs) / 60_000),
        ...summary
      })
      annotateCrashReport(summary)
    })
    .catch(() => undefined)
    .finally(() => {
      current.reading = false
    })
}

/** A cage-wide OOM aborts before any JS runs, so the minidump carries the last read's top sites. */
function annotateCrashReport(summary: Record<string, unknown>): void {
  try {
    for (let index = 1; index <= ANNOTATED_SITES; index += 1) {
      const site = summary[`site${String(index).padStart(2, '0')}`]
      const key = `orca-main-heap-site-${index}`
      if (typeof site === 'string') {
        crashReporter.addExtraParameter(key, site.slice(0, ANNOTATION_MAX_LENGTH))
      } else {
        crashReporter.removeExtraParameter(key)
      }
    }
  } catch {
    // Crash reporting may be off; diagnostics only.
  }
}

function mainBundlePrefix(): string {
  return `${pathToFileURL(currentWorkerEntryLayout(__dirname).moduleDir).href}/`
}
