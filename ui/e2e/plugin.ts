/**
 * A synthetic audio plugin speaking the real plugin protocol over the
 * daemon's AF_UNIX socket — the TS twin of
 * `ddp-daemon/tests/common/plugin.rs`, here to drive real audio
 * through the real engine (issue #24 behavior 13). Framing per the
 * epic's wire tables: little-endian `[u32 length][u32 opcode][payload]`,
 * `length` counting the opcode word plus the payload.
 */
import { createConnection, type Socket } from 'node:net'

const OP_HELLO = 0x01
const OP_HELLO_ACK = 0x02
const OP_PROCESS = 0x10
const OP_PROCESSED = 0x11
const OP_GOODBYE = 0x20

interface Frame {
  readonly opcode: number
  readonly payload: Buffer
}

/** One synthetic plugin connection. */
export class SyntheticPlugin {
  readonly #socket: Socket
  #buffer: Buffer = Buffer.alloc(0)
  readonly #frames: Frame[] = []
  #wake: (() => void) | undefined
  #closed = false

  private constructor(socket: Socket) {
    this.#socket = socket
    // No encoding is ever set, so 'data' always carries a Buffer.
    socket.on('data', (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk])
      while (this.#buffer.length >= 8) {
        const length = this.#buffer.readUInt32LE(0)
        if (this.#buffer.length < 4 + length) break
        this.#frames.push({
          opcode: this.#buffer.readUInt32LE(4),
          payload: this.#buffer.subarray(8, 4 + length),
        })
        this.#buffer = this.#buffer.subarray(4 + length)
      }
      this.#wake?.()
    })
    socket.on('close', () => {
      this.#closed = true
      this.#wake?.()
    })
  }

  /** Connects to the daemon's plugin socket. */
  static connect(path: string): Promise<SyntheticPlugin> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path)
      socket.once('connect', () => {
        resolve(new SyntheticPlugin(socket))
      })
      socket.once('error', reject)
    })
  }

  /** `Hello` → awaits the `HelloAck`, returning the session id. */
  async hello(sampleRate: number, maxFrames: number): Promise<number> {
    const payload = Buffer.alloc(8)
    payload.writeUInt32LE(sampleRate, 0)
    payload.writeUInt32LE(maxFrames, 4)
    this.#send(OP_HELLO, payload)
    const ack = await this.#recv()
    if (ack.opcode !== OP_HELLO_ACK) {
      throw new Error(`expected a HelloAck, got opcode ${String(ack.opcode)}`)
    }
    return ack.payload.readUInt32LE(0)
  }

  /**
   * `Process` one interleaved-stereo block → awaits the `Processed`,
   * returning its PCM.
   */
  async process(pcm: Int16Array): Promise<Int16Array> {
    const payload = Buffer.alloc(4 + pcm.length * 2)
    payload.writeUInt32LE(pcm.length / 2, 0)
    for (const [index, sample] of pcm.entries()) {
      payload.writeInt16LE(sample, 4 + index * 2)
    }
    this.#send(OP_PROCESS, payload)
    const reply = await this.#recv()
    if (reply.opcode !== OP_PROCESSED) {
      throw new Error(
        `expected a Processed, got opcode ${String(reply.opcode)}`,
      )
    }
    return Int16Array.from({ length: reply.payload.length / 2 }, (_slot, i) =>
      reply.payload.readInt16LE(i * 2),
    )
  }

  /** The clean close: says `Goodbye` and hangs up. */
  goodbye(): void {
    this.#send(OP_GOODBYE, Buffer.alloc(0))
    this.#socket.end()
  }

  #send(opcode: number, payload: Buffer): void {
    const frame = Buffer.alloc(8 + payload.length)
    frame.writeUInt32LE(4 + payload.length, 0)
    frame.writeUInt32LE(opcode, 4)
    payload.copy(frame, 8)
    this.#socket.write(frame)
  }

  /** The next daemon message; throws once the daemon closed. */
  async #recv(): Promise<Frame> {
    for (;;) {
      const frame = this.#frames.shift()
      if (frame) return frame
      if (this.#closed) throw new Error('plugin socket closed')
      await new Promise<void>((resolve) => {
        this.#wake = resolve
      })
      this.#wake = undefined
    }
  }
}
