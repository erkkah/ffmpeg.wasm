/**
 * A shared buffer with async and sync streaming access.
 */
export class SyncAsyncStream {
    /*
    [32 bit readPosition, 32 bit writePosition, 32 bit state, bytes...]
    */
    static #indexBytes = 3 * 4;
    #buffer: SharedArrayBuffer;
    #index: Int32Array;
    #data: Uint8Array;

    constructor(sizeInBytes: number);
    constructor(buffer: SharedArrayBuffer);
    constructor(sizeInBytesOrBuffer: number | SharedArrayBuffer) {
        if (typeof sizeInBytesOrBuffer === "number") {
            this.#buffer = new SharedArrayBuffer(sizeInBytesOrBuffer + SyncAsyncStream.#indexBytes);
        } else {
            this.#buffer = sizeInBytesOrBuffer;
        }
        this.#index = new Int32Array(this.#buffer, 0, SyncAsyncStream.#indexBytes);
        this.#data = new Uint8Array(this.#buffer, SyncAsyncStream.#indexBytes);
    }

    get buffer(): SharedArrayBuffer {
        return this.#buffer;
    }

    close() {
        this.#setClosed();
        this.#notifyReaders();
    }

    async write(source: Uint8Array): Promise<number> {
        if (this.#closed) {
            this.#reset();
        }

        let bytesWritten = 0;

        while (bytesWritten < source.length) {
            const [didWrite, checkedReadPosition] = this.#writeByte(source[bytesWritten]);
            if (didWrite) {
                bytesWritten++;
            } else {
                await Atomics.waitAsync(this.#index, 0, checkedReadPosition, 10).value;
            }
        }

        return bytesWritten;
    }

    writeSync(source: Uint8Array): number {
        if (this.#closed) {
            this.#reset();
        }

        let bytesWritten = 0;

        while (bytesWritten < source.length) {
            const [didWrite, checkedReadPosition] = this.#writeByte(source[bytesWritten]);
            if (didWrite) {
                bytesWritten++;
            } else {
                Atomics.wait(this.#index, 0, checkedReadPosition, 10);
            }
        }

        return bytesWritten;
    }

    async read(target: Uint8Array, offset: number, limit: number): Promise<number> {
        if (this.#endOfStream) {
            return -1;
        }

        let bytesRead = 0;
        while (bytesRead < limit) {
            let checkedWritePosition = -1;
            while (this.#readPosition == (checkedWritePosition = this.#writePosition)) {
                await Atomics.waitAsync(this.#index, 1, checkedWritePosition, 10).value;
                if (this.#closed) {
                    this.#setEndOfStream();
                    return bytesRead;
                }
            }
            const readPosition = this.#readPosition;
            target[offset + bytesRead] = this.#data[readPosition];
            this.#readPosition = (readPosition + 1) % this.#data.length;
            this.#notifyWriters();
            bytesRead++;
        }
        return bytesRead;
    }

    readSync(target: Uint8Array, offset: number, limit: number): number {
        if (this.#endOfStream) {
            return -1;
        }

        let bytesRead = 0;
        while (bytesRead < limit) {
            let checkedWritePosition = -1;
            while (this.#readPosition == (checkedWritePosition = this.#writePosition)) {
                Atomics.wait(this.#index, 1, checkedWritePosition, 10);
                if (this.#closed) {
                    this.#setEndOfStream();
                    return bytesRead;
                }
            }
            const readPosition = this.#readPosition;
            target[offset + bytesRead] = this.#data[readPosition];
            this.#readPosition = (readPosition + 1) % this.#data.length;
            this.#notifyWriters();
            bytesRead++;
        }
        return bytesRead;
    }

    #reset() {
        for (let i = 0; i < 3; i++) {
            Atomics.store(this.#index, i, 0);
        }
    }

    #notifyReaders(): void {
        // Readers wait on the write index changing
        Atomics.notify(this.#index, 1);
    }

    #notifyWriters(): void {
        // writers wait on the read index changing
        Atomics.notify(this.#index, 0);
    }

    get #closed(): boolean {
        return Atomics.load(this.#index, 2) != 0;
    }

    #setClosed(): void {
        Atomics.or(this.#index, 2, 1);
    }

    get #endOfStream(): boolean {
        return Atomics.load(this.#index, 2) > 1;
    }

    #setEndOfStream(): void {
        Atomics.or(this.#index, 2, 2);
    }
    get #readPosition(): number {
        return Atomics.load(this.#index, 0);
    }

    get #writePosition(): number {
        return Atomics.load(this.#index, 1);
    }

    set #readPosition(pos: number) {
        Atomics.store(this.#index, 0, pos);
    }

    set #writePosition(pos: number) {
        Atomics.store(this.#index, 1, pos);
    }

    #writeByte(byte: number): [boolean, number] {
        const nextWritePosition = (this.#writePosition + 1) % this.#data.length;
        const currentReadPosition = this.#readPosition;
        if (nextWritePosition == currentReadPosition) {
            return [false, currentReadPosition];
        }
        this.#data[this.#writePosition] = byte;
        this.#writePosition = nextWritePosition;
        this.#notifyReaders();
        return [true, currentReadPosition];
    }
}
