export interface TraceLocalTimeOptions {
  timeZone?: string
}

export function formatTraceLocalTime(
  timestamp: string,
  options: TraceLocalTimeOptions = {},
): string {
  const date = new Date(timestamp)

  if (Number.isNaN(date.getTime())) {
    return 'invalid local time'
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  })
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  )

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} local`
}
