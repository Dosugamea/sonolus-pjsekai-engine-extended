type Line = [string, string]
type RawObject = {
    tick: number
    value: string
}

export type SpeedObject = {
    tick: number
    speed: number
}

export type NoteObject = {
    tick: number
    lane: number
    width: number
    type: number
}

export type Score = {
    tapNotes: NoteObject[]
    directionalNotes: NoteObject[]
    slides: NoteObject[][]
    speeds: SpeedObject[]
    toTime: (tick: number) => number
}

type ToTick = (measure: number, p: number, q: number) => number

export function analyze(sus: string, ticksPerBeat: number): Score {
    const lines: Line[] = []
    const meta = new Map<string, string>()

    sus.split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('#'))
        .forEach((line) => {
            const isLine = line.includes(':')

            const index = line.indexOf(isLine ? ':' : ' ')
            if (index === -1) return

            const left = line.substring(1, index).trim()
            const right = line.substring(index + 1).trim()

            if (isLine) {
                lines.push([left, right])
            } else {
                meta.set(left, right)
            }
        })

    const barLengthObjects: { measure: number; length: number }[] = []

    lines.forEach((line) => {
        const [header, data] = line

        if (header.length !== 5) return
        if (!header.endsWith('02')) return

        const measure = +header.substring(0, 3)
        if (isNaN(measure)) return

        barLengthObjects.push({ measure, length: +data })
    })

    let ticks = 0
    const bars = barLengthObjects
        .sort((a, b) => a.measure - b.measure)
        .map(({ measure, length }, i, values) => {
            const prev = values[i - 1]
            if (prev) {
                ticks += (measure - prev.measure) * prev.length * ticksPerBeat
            }

            return { measure, ticksPerMeasure: length * ticksPerBeat, ticks }
        })
        .reverse()

    const toTick: ToTick = (measure, p, q) => {
        const bar = bars.find((bar) => measure >= bar.measure)
        if (!bar) throw 'Unexpected missing bar'

        return (
            bar.ticks +
            (measure - bar.measure) * bar.ticksPerMeasure +
            (p * bar.ticksPerMeasure) / q
        )
    }

    const bpms = new Map<string, number>()
    const bpmChangeObjects: RawObject[] = []
    const speeds: SpeedObject[] = []
    const tapNotes: NoteObject[] = []
    const directionalNotes: NoteObject[] = []
    const streams = new Map<string, NoteObject[]>()

    lines.forEach((line) => {
        const [header, data] = line

        // BPM
        if (header.length === 5 && header.startsWith('BPM')) {
            bpms.set(header.substring(3), +data)
            return
        }

        // BPM Change
        if (header.length === 5 && header.endsWith('08')) {
            bpmChangeObjects.push(...toRawObjects(line, toTick))
            return
        }

        // Speed Change
        if (header.length === 5 && header.startsWith('TIL')) {
            speeds.push(...toSpeedObjects(line, toTick))
            return
        }

        // Tap Notes
        if (header.length === 5 && header[3] === '1') {
            tapNotes.push(...toNoteObjects(line, toTick))
            return
        }

        // Tap Notes
        if (header.length === 6 && header[3] === '3') {
            const channel = header[5]
            const stream = streams.get(channel)
            if (stream) {
                stream.push(...toNoteObjects(line, toTick))
            } else {
                streams.set(channel, toNoteObjects(line, toTick))
            }
            return
        }

        // Directional Notes
        if (header.length === 5 && header[3] === '5') {
            directionalNotes.push(...toNoteObjects(line, toTick))
            return
        }
    })

    const slides = [...streams.values()].map(toSlides).flat()

    let time = 0
    const timings = bpmChangeObjects
        .sort((a, b) => a.tick - b.tick)
        .map(({ tick, value }) => ({ tick, bpm: bpms.get(value) || 0 }))
        .map(({ tick, bpm }, i, values) => {
            const prev = values[i - 1]
            if (prev) {
                time += ((tick - prev.tick) * 60) / ticksPerBeat / prev.bpm
            }

            return { tick, bpm, time }
        })
        .reverse()

    const waveOffset = +(meta.get('WAVEOFFSET') || '0')
    const toTime = (tick: number) => {
        const timing = timings.find((timing) => tick >= timing.tick)
        if (!timing) throw 'Unexpected missing timing'

        return (
            timing.time +
            -waveOffset +
            ((tick - timing.tick) * 60) / ticksPerBeat / timing.bpm
        )
    }

    return {
        tapNotes,
        directionalNotes,
        slides,
        speeds,
        toTime,
    }
}

function toSpeedObjects(line: Line, toTick: ToTick): SpeedObject[] {
    const pattern =
        /(?<measure>\d)'(?<tick>\d{1,5}):(?<speed>\d{1,3}.\d{1,10})/gm
    const matched = [...line[1].matchAll(pattern)]
        .map((match) => {
            return match.groups
        })
        .filter((match) => {
            return match !== undefined
        }) as unknown as { measure: string; tick: string; speed: string }[]
    const speeds = matched.map((match) => {
        return {
            tick: toTick(+match.measure, 0, 1) + +match.tick,
            speed: +match.speed,
        }
    })
    return speeds
}

function toSlides(stream: NoteObject[]) {
    const slides: NoteObject[][] = []

    let current: NoteObject[] | undefined
    stream
        .sort((a, b) => a.tick - b.tick)
        .forEach((note) => {
            if (!current) {
                current = []
                slides.push(current)
            }

            current.push(note)

            if (note.type === 2) {
                current = undefined
            }
        })

    return slides
}

function toNoteObjects(line: Line, toTick: ToTick) {
    const [header] = line
    const lane = parseInt(header[4], 36)

    return toRawObjects(line, toTick).map(({ tick, value }) => {
        const width = parseInt(value[1], 36)

        return {
            tick,
            lane,
            width,
            type: parseInt(value[0], 36),
        }
    })
}

function toRawObjects([header, data]: Line, toTick: ToTick) {
    const measure = +header.substring(0, 3)
    return (data.match(/.{2}/g) || [])
        .map(
            (value, i, values) =>
                value !== '00' && {
                    tick: toTick(measure, i, values.length),
                    value,
                }
        )
        .filter((object): object is RawObject => !!object)
}
