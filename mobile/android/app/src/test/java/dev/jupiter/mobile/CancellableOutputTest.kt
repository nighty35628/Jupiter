package dev.jupiter.mobile

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.OutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.*
import org.junit.Test

class CancellableOutputTest {
    private fun worker() = Executors.newSingleThreadExecutor { Thread(it, "qa-shared-work").apply { isDaemon = true } }

    @Test fun revokingBlockedOutputFreesTheSharedWorkerAndClosesTheOutput() {
        val worker = worker()
        val sink = BlockingSink()
        val allowed = AtomicBoolean(true)
        val copy = CancellableOutput(2_000, Semaphore(1))
        try {
            val result = worker.submit<Throwable?> {
                runCatching { copy.copy({ byteArrayOf(1).inputStream() }, { sink }, { allowed.get() }) }.exceptionOrNull()
            }
            assertTrue(sink.entered.await(1, TimeUnit.SECONDS))
            allowed.set(false)
            copy.close()
            val next = CountDownLatch(1)
            worker.execute { next.countDown() }
            assertTrue("Revoked SAF write monopolized the shared worker", next.await(750, TimeUnit.MILLISECONDS))
            assertTrue(result.get(1, TimeUnit.SECONDS) is IOException)
            assertTrue(sink.closed.await(1, TimeUnit.SECONDS))
        } finally { sink.release.countDown(); worker.shutdownNow(); worker.awaitTermination(2, TimeUnit.SECONDS) }
    }

    @Test fun deadlineFreesTheSharedWorkerEvenWhenWriteAndCloseIgnoreCancellation() {
        val worker = worker()
        val sink = BlockingSink(ignoreClose = true)
        val lane = Semaphore(1)
        val copy = CancellableOutput(100, lane)
        try {
            val result = worker.submit<Throwable?> {
                runCatching { copy.copy({ byteArrayOf(1).inputStream() }, { sink }, { true }) }.exceptionOrNull()
            }
            assertTrue(sink.entered.await(1, TimeUnit.SECONDS))
            val next = CountDownLatch(1)
            worker.execute { next.countDown() }
            assertTrue("Output deadline failed to free the shared worker", next.await(750, TimeUnit.MILLISECONDS))
            assertTrue(result.get(1, TimeUnit.SECONDS) is IOException)
            assertThrows(IOException::class.java) {
                CancellableOutput(100, lane).copy({ byteArrayOf(2).inputStream() }, { ByteArrayOutputStream() }, { true })
            }
            assertEquals("An uncooperative provider must not allow unbounded writer threads", 0, lane.availablePermits())
        } finally {
            sink.release.countDown(); worker.shutdownNow(); worker.awaitTermination(2, TimeUnit.SECONDS)
            assertTrue("Writer lane did not recover after provider release", lane.tryAcquire(2, TimeUnit.SECONDS))
            lane.release()
        }
    }

    @Test fun normalWritesRemainBoundedAndTheLaneIsReusable() {
        val lane = Semaphore(1)
        val output = ByteArrayOutputStream()
        CancellableOutput(1_000, lane).copy({ "hello".byteInputStream() }, { output }, { true }, 5)
        assertEquals("hello", output.toString("UTF-8"))
        assertThrows(IOException::class.java) {
            CancellableOutput(1_000, lane).copy({ "too big".byteInputStream() }, { ByteArrayOutputStream() }, { true }, 2)
        }
        assertTrue(lane.tryAcquire(1, TimeUnit.SECONDS)); lane.release()
    }

    @Test fun cancellationBeforeOpeningDoesNotTouchTheDestination() {
        val opened = AtomicBoolean(false)
        val copy = CancellableOutput()
        copy.close()
        assertThrows(IOException::class.java) {
            copy.copy({ byteArrayOf(1).inputStream() }, { opened.set(true); ByteArrayOutputStream() }, { true })
        }
        assertFalse(opened.get())
    }

    @Test fun aLateDescriptorAfterDeadlineCannotWriteIntoTheNewRun() {
        val worker = worker()
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val cancelled = CountDownLatch(1)
        val lane = Semaphore(1)
        val destination = ByteArrayOutputStream()
        val copy = CancellableOutput(100, lane, onCancel = { cancelled.countDown() })
        try {
            val result = worker.submit<Throwable?> {
                runCatching { copy.copy({ byteArrayOf(1).inputStream() }, {
                    entered.countDown()
                    while (release.count > 0) { try { release.await() } catch (_: InterruptedException) { } }
                    destination
                }, { true }) }.exceptionOrNull()
            }
            assertTrue(entered.await(1, TimeUnit.SECONDS))
            assertTrue(result.get(1, TimeUnit.SECONDS) is IOException)
            assertTrue(cancelled.await(1, TimeUnit.SECONDS))
        } finally {
            release.countDown(); worker.shutdownNow(); worker.awaitTermination(2, TimeUnit.SECONDS)
            assertTrue(lane.tryAcquire(2, TimeUnit.SECONDS)); lane.release()
        }
        assertEquals("A late descriptor must be closed without writing", 0, destination.size())
    }

    @Test fun outputCloseIsAlsoIncludedInTheWriteDeadline() {
        val release = CountDownLatch(1)
        val lane = Semaphore(1)
        val destination = object : ByteArrayOutputStream() {
            override fun close() {
                while (release.count > 0) { try { release.await() } catch (_: InterruptedException) { } }
            }
        }
        try {
            assertThrows(IOException::class.java) {
                CancellableOutput(100, lane).copy({ byteArrayOf(1).inputStream() }, { destination }, { true })
            }
            assertEquals(0, lane.availablePermits())
        } finally {
            release.countDown()
            assertTrue(lane.tryAcquire(2, TimeUnit.SECONDS)); lane.release()
        }
    }

    @Test fun cancellationSignalIsNotBlockedBehindOutputClose() {
        val releaseClose = CountDownLatch(1); val closeEntered = CountDownLatch(1); val signal = CountDownLatch(1)
        val lane = Semaphore(1)
        val destination = object : ByteArrayOutputStream() {
            override fun close() {
                closeEntered.countDown()
                while (releaseClose.count > 0) { try { releaseClose.await() } catch (_: InterruptedException) { } }
            }
        }
        try {
            assertThrows(IOException::class.java) {
                CancellableOutput(100, lane, onCancel = { signal.countDown() })
                    .copy({ byteArrayOf(1).inputStream() }, { destination }, { true })
            }
            assertTrue(closeEntered.await(1, TimeUnit.SECONDS))
            assertTrue("CancellationSignal was queued behind a hostile close", signal.await(1, TimeUnit.SECONDS))
            assertEquals(1L, releaseClose.count)
        } finally {
            releaseClose.countDown()
            assertTrue(lane.tryAcquire(2, TimeUnit.SECONDS)); lane.release()
        }
    }

    @Test fun hostileCancellationSignalDoesNotBlockOutputClosureOrGrowThreads() {
        val signalEntered = CountDownLatch(1); val releaseSignal = CountDownLatch(1)
        val sink = BlockingSink()
        val lane = Semaphore(1)
        val copy = CancellableOutput(2_000, lane, onCancel = {
            signalEntered.countDown()
            while (releaseSignal.count > 0) { try { releaseSignal.await() } catch (_: InterruptedException) { } }
        })
        val worker = worker()
        try {
            val result = worker.submit<Throwable?> {
                runCatching { copy.copy({ byteArrayOf(1).inputStream() }, { sink }, { true }) }.exceptionOrNull()
            }
            assertTrue(sink.entered.await(1, TimeUnit.SECONDS))
            copy.close()
            assertTrue(signalEntered.await(1, TimeUnit.SECONDS))
            assertTrue(sink.closed.await(1, TimeUnit.SECONDS))
            assertTrue(result.get(1, TimeUnit.SECONDS) is IOException)
            for (name in listOf("jupiter-saf-cancel", "jupiter-saf-close")) {
                assertTrue(Thread.getAllStackTraces().keys.count { it.name == name } <= 1)
            }
        } finally {
            releaseSignal.countDown(); sink.release.countDown(); worker.shutdownNow(); worker.awaitTermination(2, TimeUnit.SECONDS)
        }
    }

    private class BlockingSink(private val ignoreClose: Boolean = false) : OutputStream() {
        val entered = CountDownLatch(1)
        val closed = CountDownLatch(1)
        val release = CountDownLatch(1)
        override fun write(value: Int) = write(byteArrayOf(value.toByte()))
        override fun write(bytes: ByteArray, offset: Int, length: Int) {
            entered.countDown()
            while (true) {
                try { release.await(); break } catch (_: InterruptedException) { /* Simulate a provider ignoring interruption. */ }
            }
            if (closed.count == 0L) throw IOException("Output closed")
        }
        override fun close() {
            closed.countDown()
            if (!ignoreClose) release.countDown()
            else while (release.count > 0) { try { release.await() } catch (_: InterruptedException) { } }
        }
    }
}
