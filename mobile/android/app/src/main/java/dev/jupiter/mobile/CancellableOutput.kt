package dev.jupiter.mobile

import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.ExecutionException
import java.util.concurrent.FutureTask
import java.util.concurrent.Semaphore
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Absolute output deadline (not inactivity), including opening, flush and close. Slow cloud targets
 * can fail despite making progress. Cancellation/close are best effort: an uncooperative provider
 * retains the sole writer permit until it really exits; later exports fail fast, never queue behind
 * it on the engine worker. No automatic retry of a possibly partially written destination.
 */
internal class CancellableOutput(
    private val timeoutMillis: Long = 30_000,
    private val lane: Semaphore = writerLane,
    private val onCancel: () -> Unit = {},
) : Closeable {
    init { require(timeoutMillis > 0) }
    private val input = AtomicReference<InputStream?>()
    private val output = AtomicReference<OutputStream?>()
    private val revoked = AtomicBoolean(false)
    private val used = AtomicBoolean(false)

    fun copy(openInput: () -> InputStream, openOutput: () -> OutputStream, allowed: () -> Boolean, byteLimit: Long = 512L * 1024 * 1024) {
        require(byteLimit > 0)
        checkAccess(allowed)
        if (!used.compareAndSet(false, true) || !lane.tryAcquire()) throw IOException("A previous output provider is still busy")
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis)
        val task = FutureTask<Unit> {
            try {
                checkAccess(allowed)
                openInput().use { source ->
                    input.set(source)
                    checkAccess(allowed)
                    openOutput().use { destination ->
                        output.set(destination)
                        val bytes = ByteArray(65536)
                        var total = 0L
                        while (true) {
                            checkAccess(allowed)
                            val count = source.read(bytes)
                            checkAccess(allowed)
                            if (count == -1) break
                            total += count
                            if (total > byteLimit) throw IOException("Output exceeds its size limit")
                            destination.write(bytes, 0, count)
                            checkAccess(allowed)
                        }
                        destination.flush()
                        checkAccess(allowed)
                    }
                }
            } finally { input.set(null); output.set(null); lane.release() }
        }
        val writer = Thread(task, "jupiter-saf-output").apply { isDaemon = true }
        try { writer.start() }
        catch (failure: RuntimeException) { lane.release(); throw IOException("Output worker could not start", failure) }
        try {
            while (true) {
                checkAccess(allowed)
                val remaining = deadline - System.nanoTime()
                if (remaining <= 0) throw IOException("Output deadline exceeded")
                try {
                    task.get(minOf(remaining, TimeUnit.MILLISECONDS.toNanos(25)), TimeUnit.NANOSECONDS)
                    checkAccess(allowed)
                    return
                } catch (_: TimeoutException) { /* Poll authorization without waiting on the provider. */ }
            }
        } catch (failure: Exception) {
            close(); writer.interrupt()
            if (failure is InterruptedException) Thread.currentThread().interrupt()
            val cause = if (failure is ExecutionException) failure.cause ?: failure else failure
            throw if (cause is IOException) cause else IOException("Output did not complete", cause)
        }
    }

    private fun checkAccess(allowed: () -> Boolean) {
        if (revoked.get() || !allowed()) throw IOException("Output operation cancelled")
    }

    override fun close() {
        if (!revoked.compareAndSet(false, true)) return
        // close/cancel can also be hostile provider calls; never execute them on UI/shared work.
        runCatching { canceller.execute { runCatching(onCancel) } }
        runCatching { closer.execute {
            runCatching { output.get()?.close() }
            runCatching { input.get()?.close() }
        } }
    }

    companion object {
        private val writerLane = Semaphore(1)
        private val canceller = ThreadPoolExecutor(0, 1, 30, TimeUnit.SECONDS, ArrayBlockingQueue(1),
            { Thread(it, "jupiter-saf-cancel").apply { isDaemon = true } })
        private val closer = ThreadPoolExecutor(0, 1, 30, TimeUnit.SECONDS, ArrayBlockingQueue(1),
            { Thread(it, "jupiter-saf-close").apply { isDaemon = true } })
    }
}
