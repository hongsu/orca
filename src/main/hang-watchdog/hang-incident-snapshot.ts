import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { freemem, loadavg, totalmem } from 'node:os'
import { sanitizeCrashReportString } from '../../shared/crash-reporting/crash-report-redaction'
import { redactString } from '../../shared/observability/redactor'
import type { CompletedHangContext, HangMachineSnapshot } from './hang-observations'
import { completeStdout, parseMacHangPressure, readMacMemorySysctl } from './mac-memory-pressure'

export async function collectHangMachineSnapshot(
  signal: AbortSignal
): Promise<HangMachineSnapshot> {
  const loads = loadavg()
  const snapshot: HangMachineSnapshot = {
    startedAt: Date.now(),
    completedAt: null,
    systemMemoryTotalMB: totalmem() / 1024 / 1024,
    systemMemoryFreeMB: freemem() / 1024 / 1024,
    systemMemorySwapTotalMB: null,
    systemMemorySwapUsedMB: null,
    systemMemoryCompressorMB: null,
    systemMemoryPressureLevel: null,
    systemMemoryStatusLevel: null,
    load1: process.platform === 'win32' ? null : loads[0],
    load5: process.platform === 'win32' ? null : loads[1],
    load15: process.platform === 'win32' ? null : loads[2]
  }
  if (process.platform === 'darwin' && !signal.aborted) {
    const { runProcess } = await import('@orca/process-host')
    const [sysctl, vmStat] = await Promise.all([
      readMacMemorySysctl(signal),
      runProcess({
        program: '/usr/bin/vm_stat',
        timeoutMs: 2_000,
        maxOutputBytes: 32 * 1024,
        signal
      }).then(completeStdout, () => '')
    ])
    Object.assign(snapshot, parseMacHangPressure(sysctl, vmStat))
  }
  snapshot.completedAt = Date.now()
  return snapshot
}

export function readCompletedHangContext(
  tracePath: string | undefined
): CompletedHangContext[] | null {
  if (!tracePath) {
    return null
  }
  let fd: number | undefined
  try {
    fd = openSync(tracePath, 'r')
    const size = fstatSync(fd).size
    const offset = Math.max(0, size - 32 * 1024)
    const buffer = Buffer.allocUnsafe(Math.min(size, 32 * 1024))
    const bytes = readSync(fd, buffer, 0, buffer.length, offset)
    const lines = buffer.subarray(0, bytes).toString('utf8').split('\n')
    lines.pop()
    if (offset > 0) {
      lines.shift()
    }
    const spans: CompletedHangContext[] = []
    for (let index = lines.length - 1; index >= 0 && spans.length < 8; index--) {
      try {
        const data = JSON.parse(lines[index])
        if (
          data?.type !== 'effect-span' ||
          typeof data.name !== 'string' ||
          typeof data.startTimeUnixNano !== 'string' ||
          !/^\d{1,24}$/.test(data.startTimeUnixNano) ||
          typeof data.endTimeUnixNano !== 'string' ||
          !/^\d{1,24}$/.test(data.endTimeUnixNano)
        ) {
          continue
        }
        const startedAt = Number(data.startTimeUnixNano) / 1_000_000
        const completedAt = Number(data.endTimeUnixNano) / 1_000_000
        if (startedAt > completedAt) {
          continue
        }
        spans.push({
          name: sanitizeCrashReportString(redactString(data.name), 120).slice(0, 120),
          startedAt,
          completedAt
        })
      } catch {
        // Concurrent appends and interrupted writes can leave incomplete records.
      }
    }
    return spans.toReversed()
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}
