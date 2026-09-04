// Map of noise prefixes → clean replacement line printed to stdout once per event
const BAILEYS_NOISE_MAP: Record<string, string | null> = {
  "Failed to decrypt message with any known session":
    "[ ATLAS ] Signal: failed to decrypt (session key mismatch — skipped)",
  "Session error:": "[ ATLAS ] Signal: session error (Bad MAC — skipped)",
  "Closing open session in favor of incoming prekey bundle":
    "[ ATLAS ] Signal: rotating session (new prekey bundle received)",
  "Closing session:": null, // suppress entirely — too verbose (raw key dump)
  "Opening session:": null,
};

function matchNoise(str: string): { matched: boolean; replacement?: string | null } {
  for (const [prefix, replacement] of Object.entries(BAILEYS_NOISE_MAP)) {
    if (str.startsWith(prefix)) return { matched: true, replacement };
  }
  return { matched: false };
}

let isInitialized = false;

/**
 * Patches console.log, console.error, console.info, and process.stderr.write
 * to filter out verbose libsignal/Baileys session noise.
 */
export function initLoggerNoiseFilter(): void {
  if (isInitialized) return;
  isInitialized = true;

  // Patch console.log (stdout)
  const origLog = console.log;
  console.log = (...args: any[]) => {
    const first = String(args[0] ?? "");
    const { matched, replacement } = matchNoise(first);
    if (matched) {
      if (replacement) origLog(replacement);
      return;
    }
    origLog(...args);
  };

  // Patch console.error (stderr) — libsignal uses this path
  const origErr = console.error;
  console.error = (...args: any[]) => {
    const first = String(args[0] ?? "");
    const { matched, replacement } = matchNoise(first);
    if (matched) {
      if (replacement) origLog(replacement); // route clean msg to stdout
      return;
    }
    origErr(...args);
  };

  // Patch console.info — libsignal uses console.info("Closing session:", session)
  const origInfo = console.info;
  console.info = (...args: any[]) => {
    const first = String(args[0] ?? "");
    const { matched, replacement } = matchNoise(first);
    if (matched) {
      if (replacement) origLog(replacement);
      return;
    }
    origInfo(...args);
  };

  // Patch process.stderr.write — final fallback used by some internal Node streams
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: any, ...rest: any[]): boolean => {
    const str = typeof chunk === "string" ? chunk : chunk.toString();
    const { matched, replacement } = matchNoise(str.trimStart());
    if (matched) {
      if (replacement) origLog(replacement);
      return true;
    }
    return (origStderrWrite as any)(chunk, ...rest);
  };
}
