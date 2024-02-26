/**
 * A shared buffer with async and sync streaming access.
 */
export class SyncAsyncStream {
    // [32 bit readPosition, 32 bit writePosition, 32 bit state, bytes...]
    static #indexBytes = 3 * 4;
    #buffer: SharedArrayBuffer;
    #index: Int32Array;
    #data: Uint8Array;

    constructor(sizeInBytes: number);
    constructor(buffer: SharedArrayBuffer);
    constructor(sizeInBytesOrBuffer: number | SharedArrayBuffer) {
        if (typeof sizeInBytesOrBuffer === "number") {
            this.#buffer = new SharedArrayBuffer(
                sizeInBytesOrBuffer + SyncAsyncStream.#indexBytes
            );
        } else {
            this.#buffer = sizeInBytesOrBuffer;
        }
        this.#index = new Int32Array(
            this.#buffer,
            0,
            SyncAsyncStream.#indexBytes
        );
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
        let totalBytesWritten = 0;

        while (totalBytesWritten < source.length) {
            const [bytesWritten, checkedReadPosition] = this.#writeBytes(
                source.subarray(totalBytesWritten)
            );
            if (bytesWritten > 0) {
                totalBytesWritten += bytesWritten;
            } else {
                await Atomics.waitAsync(this.#index, 0, checkedReadPosition, 10)
                    .value;
            }
        }

        return totalBytesWritten;
    }

    writeSync(source: Uint8Array): number {
        let totalBytesWritten = 0;

        while (totalBytesWritten < source.length) {
            const [bytesWritten, checkedReadPosition] = this.#writeBytes(
                source.subarray(totalBytesWritten)
            );
            if (bytesWritten > 0) {
                totalBytesWritten += bytesWritten;
            } else {
                Atomics.wait(this.#index, 0, checkedReadPosition, 10);
            }
        }

        return totalBytesWritten;
    }

    async read(
        target: Uint8Array,
        offset: number,
        limit: number
    ): Promise<number> {
        if (this.#endOfStream) {
            return -1;
        }

        let bytesRead = 0;
        while (bytesRead < limit) {
            let checkedWritePosition = -1;
            // Wait for data
            while (
                this.#readPosition ==
                (checkedWritePosition = this.#writePosition)
            ) {
                if (this.#closed) {
                    this.#setEndOfStream();
                    return bytesRead;
                }

                await Atomics.waitAsync(
                    this.#index,
                    1,
                    checkedWritePosition,
                    10
                ).value;
            }
            bytesRead += this.#readBytes(target, offset + bytesRead);
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
            while (
                this.#readPosition ==
                (checkedWritePosition = this.#writePosition)
            ) {
                if (this.#closed) {
                    this.#setEndOfStream();
                    return bytesRead;
                }

                Atomics.wait(this.#index, 1, checkedWritePosition, 10);
            }
            bytesRead += this.#readBytes(target, offset + bytesRead);
        }
        return bytesRead;
    }

    reset() {
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

    #writeBytes(bytes: Uint8Array): [number, number] {
        const currentWritePosition = this.#writePosition;
        const currentReadPosition = this.#readPosition;

        // Full
        if (
            (currentWritePosition + 1) % this.#data.length ==
            currentReadPosition
        ) {
            return [0, currentReadPosition];
        }

        const contiguousSpace =
            currentReadPosition > currentWritePosition
                ? currentReadPosition - currentWritePosition
                : this.#data.length - currentWritePosition;

        var bytesToWrite = Math.min(bytes.length, contiguousSpace);
        var nextWritePosition =
            (currentWritePosition + bytesToWrite) % this.#data.length;

        // Never overwrite unread data
        if (nextWritePosition == currentReadPosition) {
            nextWritePosition--;
            bytesToWrite--;
            if (nextWritePosition < 0) {
                nextWritePosition += this.#data.length;
            }
        }

        this.#data.set(bytes.subarray(0, bytesToWrite), currentWritePosition);
        this.#writePosition = nextWritePosition;
        this.#notifyReaders();

        return [bytesToWrite, currentReadPosition];
    }

    #readBytes(target: Uint8Array, offset: number): number {
        const currentWritePosition = this.#writePosition;
        const currentReadPosition = this.#readPosition;

        const contiguousData =
            currentReadPosition < currentWritePosition
                ? currentWritePosition - currentReadPosition
                : this.#data.length - currentReadPosition;

        const bytesToRead = Math.min(target.length - offset, contiguousData);
        target.set(this.#data.subarray(currentReadPosition, currentReadPosition + bytesToRead), offset);
        this.#readPosition = (currentReadPosition + bytesToRead) % this.#data.length;
        this.#notifyWriters();
        return bytesToRead;
    }
}
