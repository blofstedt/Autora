/**
 * How the machine Autora runs on is doing: CPU, memory and disk, for the
 * three bars at the foot of the sidebar.
 *
 * On Umbrel this is the box itself: a container sees the host's processors
 * and memory, and the data directory sits on the host's disk. Nothing here is
 * secret and nothing is changed by reading it, beyond remembering the last
 * CPU sample so the next reading covers the time in between.
 */
import fs from "node:fs";
import os from "node:os";

export interface HostVitals {
  /** Busy share of all cores since the previous reading, 0..1. */
  cpu: number;
  cores: number;
  memory: { used: number; total: number };
  /** The disk holding Autora's data; null where it cannot be read. */
  disk: { used: number; total: number } | null;
}

type CpuSample = { idle: number; total: number };

function sampleCpu(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** The busy share between two samples; null when no time passed. */
export function cpuBetween(before: CpuSample, after: CpuSample): number | null {
  const total = after.total - before.total;
  if (total <= 0) return null;
  const busy = 1 - (after.idle - before.idle) / total;
  return Math.min(1, Math.max(0, busy));
}

let last: CpuSample | null = null;

export function hostVitals(dataDir = process.env.AUTORA_HOME || process.cwd()): HostVitals {
  const cores = Math.max(1, os.cpus().length);
  const now = sampleCpu();
  // The first reading has nothing to compare with: the one-minute load
  // average over the core count stands in until the next one.
  const cpu = (last && cpuBetween(last, now))
    ?? Math.min(1, os.loadavg()[0] / cores);
  last = now;

  const total = os.totalmem();
  const memory = { used: Math.max(0, total - os.freemem()), total };

  let disk: HostVitals["disk"] = null;
  try {
    const s = fs.statfsSync(dataDir);
    const size = s.blocks * s.bsize;
    // `bavail`, not `bfree`: what is left for anyone but root is what the
    // agent's own writes can actually use.
    if (size > 0) disk = { used: size - s.bavail * s.bsize, total: size };
  } catch {
    /* a path that went away, or a filesystem that will not say */
  }

  return { cpu, cores, memory, disk };
}
