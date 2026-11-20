import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { openJournalDomainDatabase } from './database/journal-domain-database'
import { openJournalDatabase, runJournalTransaction } from './database/journal-database'
import { journalDatabasePath } from './database/journal-host-database'
import { JournalSqlDatabase } from './database/journal-sql-database'
import { writeJournalDomainCurrentItem } from './journal-domain-current-item'
import { journalSqlReaderPath, journalSqlWorkerPath } from './journal-sql-worker-bundle.test-fixture'
import * as Real from './journal-stored-output'
import type * as StoredOutput from './journal-stored-output'

// Seeds are always written inline, as builds before the switch wrote them.
const switches = vi.hoisted(() => ({ writes: null as boolean | null }))
vi.mock('./journal-stored-output', async (load) => {
  const actual = await load<typeof StoredOutput>()
  return {
    ...actual,
    get JOURNAL_STORED_OUTPUT_WRITES() {
      return switches.writes ?? actual.JOURNAL_STORED_OUTPUT_WRITES
    }
  }
})

const ROOT = process.env.MEASURE_ROOT ?? '/tmp/journal-measure'
const ROWS = Number(process.env.MEASURE_ROWS ?? 1_250_000)
const TEMPLATE_ROWS = Math.min(ROWS, 50_000)
const MINUTES = Number(process.env.MEASURE_MINUTES ?? 12)
const WORKSPACES = 1900
const ROWS_PER_HOUR = 5000

let seed = 1
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
const words = Array.from({ length: 3000 }, () => Math.floor(rand() * 2 ** 40).toString(36))
function outputText(bytes: number): string {
  const lines: string[] = []
  let size = 0
  while (size < bytes) {
    const n = 4 + Math.floor(rand() * 10)
    const line = `src/${words[Math.floor(rand() * 200)]}/${words[Math.floor(rand() * 3000)]}.ts:${Math.floor(rand() * 900)}  ${Array.from({ length: n }, () => words[Math.floor(rand() * 3000)]).join(' ')} ${Math.floor(rand() * 2 ** 32).toString(16)}`
    lines.push(line)
    size += line.length + 1
  }
  return lines.join('\n')
}
// The measured mix of a real heavy profile: 61% <4K, 37% 4-32K, 1.8% 32-128K, 0.2% 128K-1M.
function outputBytes(): number {
  const r = rand()
  return r < 0.61
    ? 300 + rand() * 3500
    : r < 0.98
      ? 4096 + rand() * 14000
      : r < 0.998
        ? 32768 + rand() * 40000
        : 131072 + rand() * 300000
}
let next = 0
function toolCall(): AgentJournalRenderItem {
  next++
  const head = outputText(outputBytes())
  return {
    itemId: `tool-${next}`,
    revision: 1,
    sequence: next,
    observedAt: 1,
    body: {
      kind: 'tool-call',
      name: 'shell',
      callId: `tool-${next}`,
      input: { command: `rg ${words[next % 3000]} src` },
      state: 'completed',
      output: { head, byteLength: Buffer.byteLength(head), digest: String(next), truncated: false }
    }
  } as AgentJournalRenderItem
}

function writeRows(db: Database.Database, rows: number) {
  for (let i = 0; i < rows; i += 50) {
    runJournalTransaction(db, () => {
      for (let j = i; j < Math.min(rows, i + 50); j++) {
        writeJournalDomainCurrentItem(
          db,
          { sessionId: `chat-${j % WORKSPACES}`, epoch: 'epoch' },
          { item: toolCall(), hidden: false, ownerFence: 1 }
        )
      }
    })
  }
}

function sizes(db: Database.Database, file: string) {
  db.pragma('wal_checkpoint(TRUNCATE)')
  const pages = Number(db.pragma('page_count', { simple: true }))
  const free = Number(db.pragma('freelist_count', { simple: true }))
  return {
    fileMB: Math.round(statSync(file).size / 2 ** 20),
    liveMB: Math.round(((pages - free) * 4096) / 2 ** 20),
    freeMB: Math.round((free * 4096) / 2 ** 20)
  }
}

function createStore(dir: string) {
  mkdirSync(dir, { recursive: true })
  openJournalDatabase(journalDatabasePath(dir)).db.close()
  const file = join(dir, 'agent-session-domain.db')
  const { db } = openJournalDomainDatabase(file)
  const insert = db.prepare(
    `INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence) VALUES(?,?,?,900,1)`
  )
  for (let w = 0; w < WORKSPACES; w++) {
    insert.run(`ws-${w}`, `chat-${w}`, 'epoch')
  }
  return { db, file }
}

/** Inline seed: real writes for a template, then SQL copies of it up to ROWS. */
function buildSeed(dir: string) {
  if (existsSync(join(dir, 'done'))) {
    return
  }
  rmSync(dir, { recursive: true, force: true })
  switches.writes = false
  const { db, file } = createStore(dir)
  writeRows(db, TEMPLATE_ROWS)
  const columns = db
    .prepare(`PRAGMA table_info(journal_items)`)
    .all()
    .map((c) => String(c.name))
  for (let copy = 1; copy * TEMPLATE_ROWS < ROWS; copy++) {
    const select = columns
      .map((c) =>
        c === 'item_id'
          ? `item_id||'-c${copy}'`
          : c === 'ordinal' || c === 'sequence'
            ? `${c}+${copy * TEMPLATE_ROWS}`
            : c
      )
      .join(',')
    const limit = Math.min(TEMPLATE_ROWS, ROWS - copy * TEMPLATE_ROWS)
    db.exec(
      `INSERT INTO journal_items(${columns.join(',')}) SELECT ${select} FROM journal_items WHERE rowid<=${limit}`
    )
  }
  const result = { rows: Number(db.prepare('SELECT COUNT(*) n FROM journal_items').get()!.n), ...sizes(db, file) }
  db.close()
  switches.writes = null
  writeFileSync(join(dir, 'done'), JSON.stringify(result))
}

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b)
  return +(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? 0).toFixed(2)
}

function procIo(): { read: number; write: number } | null {
  try {
    const text = readFileSync('/proc/self/io', 'utf8')
    const value = (key: string) => Number(new RegExp(`^${key}: (\\d+)`, 'm').exec(text)?.[1] ?? 0)
    return { read: value('read_bytes'), write: value('write_bytes') }
  } catch {
    return null
  }
}

async function window(database: JournalSqlDatabase, minutes: number) {
  const writer = (database as unknown as { writer: { maintain: (op: unknown) => Promise<unknown> } }).writer
  const loop = monitorEventLoopDelay({ resolution: 5 })
  loop.enable()
  const probes: number[] = []
  const ioPerSecond: number[] = []
  let lastIo = procIo()
  let stop = false
  const probing = (async () => {
    while (!stop) {
      const t = performance.now()
      await writer.maintain({ kind: 'compaction-state' })
      probes.push(performance.now() - t)
      await new Promise((r) => setTimeout(r, 200))
    }
  })()
  const io = setInterval(() => {
    const now = procIo()
    if (now && lastIo) {
      ioPerSecond.push((now.write - lastIo.write) / 2 ** 20)
    }
    lastIo = now
  }, 1000)
  const startIo = procIo()
  await new Promise((r) => setTimeout(r, minutes * 60_000))
  stop = true
  clearInterval(io)
  await probing
  loop.disable()
  const endIo = procIo()
  return {
    minutes,
    eventLoopDelayMs: {
      p50: +(loop.percentile(50) / 1e6).toFixed(2),
      p99: +(loop.percentile(99) / 1e6).toFixed(2),
      max: +(loop.max / 1e6).toFixed(2)
    },
    writerRoundTripMs: { n: probes.length, p50: percentile(probes, 50), p99: percentile(probes, 99), max: percentile(probes, 100) },
    diskWriteMB: endIo && startIo ? Math.round((endIo.write - startIo.write) / 2 ** 20) : null,
    diskWriteMBps: ioPerSecond.length
      ? { p50: percentile(ioPerSecond, 50), p99: percentile(ioPerSecond, 99), max: percentile(ioPerSecond, 100) }
      : null
  }
}

it('measures journal growth and stored-output compaction cost', { timeout: 6 * 3_600_000 }, async () => {
  const out: Record<string, unknown> = { writes: Real.JOURNAL_STORED_OUTPUT_WRITES, rows: ROWS }
  // Growth over one hour of a heavy user's tool output, with this build's write setting.
  seed = 7
  const hourDir = join(ROOT, `hour-${Date.now()}`)
  const hour = createStore(hourDir)
  const before = sizes(hour.db, hour.file)
  writeRows(hour.db, ROWS_PER_HOUR)
  out.hourOfWrites = { before, after: sizes(hour.db, hour.file) }
  hour.db.close()
  rmSync(hourDir, { recursive: true, force: true })

  const seedDir = join(ROOT, `seed-${ROWS}`)
  buildSeed(seedDir)
  out.seed = JSON.parse(readFileSync(join(seedDir, 'done'), 'utf8'))
  const run = join(ROOT, `run-${Date.now()}`)
  mkdirSync(run, { recursive: true })
  for (const name of readdirSync(seedDir)) {
    if (!name.endsWith('-wal') && !name.endsWith('-shm') && name !== 'done') {
      copyFileSync(join(seedDir, name), join(run, name))
    }
  }
  const errors: unknown[] = []
  const database = await JournalSqlDatabase.open(run, {
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath(),
    onMaintenanceError: (error) => errors.push(error)
  })
  out.idle = await window(database, 1)
  void database.startMaintenance()
  out.maintaining = await window(database, MINUTES)
  database.stopMaintenance()
  await database.close()
  const db = new Database(join(run, 'agent-session-domain.db'))
  const cursor = db
    .prepare(`SELECT value FROM agent_session_store_meta WHERE key='journal.stored-output.cursor'`)
    .get()
  const compacted = Number(db.prepare('SELECT COUNT(*) n FROM journal_items WHERE output_blob IS NOT NULL').get()!.n)
  out.after = { cursorRowid: cursor ? Number(cursor.value) : 0, compactedRows: compacted, rowsPerMinute: Math.round(compacted / MINUTES), ...sizes(db, join(run, 'agent-session-domain.db')) }
  db.close()
  out.errors = errors.map(String).slice(0, 5)
  rmSync(run, { recursive: true, force: true })
  writeFileSync(process.env.MEASURE_OUT ?? '/tmp/measure-result.json', JSON.stringify(out, null, 1))
  process.stderr.write(`MEASURE ${JSON.stringify(out)}\n`)
  expect(errors).toEqual([])
})
