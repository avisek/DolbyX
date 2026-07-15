/**
 * A synthetic audio plugin for the Slice 16 (#24) E2E: dials the
 * daemon's Unix plugin socket and speaks the real plugin ↔ daemon
 * protocol (epic #8) — `[u32 length][u32 opcode][payload]`,
 * little-endian, `length` counting the opcode word plus the payload.
 * Audio is int16 interleaved stereo, exactly what the daemon ferries.
 */
import { createConnection, type Socket } from 'node:net'

const OP_HELLO = 0x01
const OP_HELLO_ACK = 0x02
const OP_PROCESS = 0x10
const OP_PROCESSED = 0x11

interface Frame {
  readonly opcode: number
  readonly payload: Buffer
}

export class TonePlugin {
  readonly #socket: Socket
  #received: Buffer = Buffer.alloc(0)
  readonly #waiters: ((frame: Frame) => void)[] = []

  private constructor(socket: Socket) {
    this.#socket = socket
    socket.on('data', (chunk: Buffer) => {
      this.#received = Buffer.concat([this.#received, chunk])
      this.#deliver()
    })
  }

  static async connect(socketPath: string): Promise<TonePlugin> {
    const socket = createConnection(socketPath)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    return new TonePlugin(socket)
  }

  /** `Hello` → the daemon's `HelloAck`, returning the session id. */
  async hello(sampleRate: number, maxFrames: number): Promise<number> {
    const payload = Buffer.alloc(8)
    payload.writeUInt32LE(sampleRate, 0)
    payload.writeUInt32LE(maxFrames, 4)
    this.#send(OP_HELLO, payload)
    const ack = await this.#next()
    if (ack.opcode !== OP_HELLO_ACK) {
      throw new Error(`expected HelloAck, got opcode ${String(ack.opcode)}`)
    }
    return ack.payload.readUInt32LE(0)
  }

  /** `Process` one block → awaits the daemon's `Processed`. */
  async process(pcm: Int16Array): Promise<void> {
    const payload = Buffer.alloc(4 + pcm.length * 2)
    payload.writeUInt32LE(pcm.length / 2, 0) // frames — stereo interleaved
    for (const [index, sample] of pcm.entries()) {
      payload.writeInt16LE(sample, 4 + index * 2)
    }
    this.#send(OP_PROCESS, payload)
    const reply = await this.#next()
    if (reply.opcode !== OP_PROCESSED) {
      throw new Error(`expected Processed, got opcode ${String(reply.opcode)}`)
    }
  }

  /** Hangs up — the daemon destroys the session on disconnect. */
  end(): void {
    this.#socket.destroy()
  }

  #send(opcode: number, payload: Buffer): void {
    const header = Buffer.alloc(8)
    header.writeUInt32LE(payload.length + 4, 0)
    header.writeUInt32LE(opcode, 4)
    this.#socket.write(Buffer.concat([header, payload]))
  }

  #next(): Promise<Frame> {
    return new Promise((resolve) => {
      this.#waiters.push(resolve)
      this.#deliver()
    })
  }

  #deliver(): void {
    while (this.#waiters.length > 0 && this.#received.length >= 8) {
      const length = this.#received.readUInt32LE(0)
      if (this.#received.length < 4 + length) return
      const opcode = this.#received.readUInt32LE(4)
      const payload = this.#received.subarray(8, 4 + length)
      this.#received = this.#received.subarray(4 + length)
      this.#waiters.shift()?.({ opcode, payload })
    }
  }
}
