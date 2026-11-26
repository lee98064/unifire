const streams = new Set<() => void>()
let closing = false

export function trackEventStream(close: () => void) {
  if (closing) close()
  else streams.add(close)
}

export function forgetEventStream(close: () => void) {
  streams.delete(close)
}

export function closeEventStreams() {
  closing = true
  for (const close of streams) close()
}
