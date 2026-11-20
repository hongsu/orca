// Kept apart from the hang snapshot's file reads so the main process can use these.
import type { HangMachineSnapshot } from './hang-observations'

function numberMatch(text: string, expression: RegExp): number | null {
  const match = expression.exec(text)
  const value = match ? Number(match[1]) : Number.NaN
  return Number.isFinite(value) && value >= 0 ? value : null
}
export function parseMacHangPressure(
  sysctl: string,
  vmStat: string
): Pick<
  HangMachineSnapshot,
  | 'systemMemorySwapTotalMB'
  | 'systemMemorySwapUsedMB'
  | 'systemMemoryCompressorMB'
  | 'systemMemoryPressureLevel'
  | 'systemMemoryStatusLevel'
> {
  const swap = (key: string): number | null => {
    const match = new RegExp(`\\b${key} = ([\\d.]+)([KMGT])\\b`).exec(sysctl)
    if (!match) {
      return null
    }
    const factor = { K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 }[match[2]]
    const value = Number(match[1]) * (factor ?? Number.NaN)
    return Number.isFinite(value) && value >= 0 ? value : null
  }
  const pageSize = numberMatch(vmStat, /page size of (\d+) bytes/)
  const compressor = numberMatch(vmStat, /^Pages occupied by compressor:\s+(\d+)\.?\s*$/m)
  const compressorMB =
    pageSize !== null && compressor !== null ? (pageSize * compressor) / 1024 / 1024 : null
  return {
    systemMemorySwapTotalMB: swap('total'),
    systemMemorySwapUsedMB: swap('used'),
    systemMemoryCompressorMB:
      compressorMB !== null && Number.isFinite(compressorMB) ? compressorMB : null,
    systemMemoryPressureLevel: numberMatch(
      sysctl,
      /^kern\.memorystatus_vm_pressure_level:\s+(\d+)\s*$/m
    ),
    systemMemoryStatusLevel: numberMatch(sysctl, /^kern\.memorystatus_level:\s+(\d+)\s*$/m)
  }
}

export function completeStdout(result: {
  stdout: string
  timedOut: boolean
  outputTruncated?: boolean
}): string {
  return result.timedOut || result.outputTruncated ? '' : result.stdout
}

/** Swap usage and the kernel's memory-pressure levels; empty when unreadable. */
export async function readMacMemorySysctl(signal?: AbortSignal): Promise<string> {
  const { runProcess } = await import('@orca/process-host')
  return runProcess({
    program: '/usr/sbin/sysctl',
    args: ['vm.swapusage', 'kern.memorystatus_level', 'kern.memorystatus_vm_pressure_level'],
    timeoutMs: 2_000,
    maxOutputBytes: 32 * 1024,
    signal
  }).then(completeStdout, () => '')
}
