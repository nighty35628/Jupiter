package dev.jupiter.mobile

import android.os.ParcelFileDescriptor
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.FilterOutputStream
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Real descriptor backpressure, without a general provider fixture or any user document. */
@RunWith(AndroidJUnit4::class)
class CancellableOutputPipeTest {
    @Test fun revokingAFullPipeFreesTheSharedWorker() = checkPipe(revoke = true)
    @Test fun aFullPipeHasABoundedWriteDeadline() = checkPipe(revoke = false)

    private fun checkPipe(revoke: Boolean) {
        val pipe = ParcelFileDescriptor.createPipe()
        try {
            val flags = Os.fcntlInt(pipe[1].fileDescriptor, OsConstants.F_GETFL, 0)
            Os.fcntlInt(pipe[1].fileDescriptor, OsConstants.F_SETFL, flags or OsConstants.O_NONBLOCK)
            try {
                for (buffer in listOf(ByteArray(4096), ByteArray(1))) {
                    try { while (true) Os.write(pipe[1].fileDescriptor, buffer, 0, buffer.size) }
                    catch (error: ErrnoException) { if (error.errno != OsConstants.EAGAIN) throw error }
                }
            } finally { Os.fcntlInt(pipe[1].fileDescriptor, OsConstants.F_SETFL, flags) }
        } catch (failure: Exception) {
            pipe.forEach { runCatching { it.close() } }
            throw failure
        }
        val entered = CountDownLatch(1)
        val output = object : FilterOutputStream(ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) {
            override fun write(bytes: ByteArray, offset: Int, length: Int) {
                entered.countDown(); out.write(bytes, offset, length)
            }
        }
        val allowed = AtomicBoolean(true)
        val lane = Semaphore(1)
        val copy = CancellableOutput(if (revoke) 2_000 else 300, lane)
        val worker = Executors.newSingleThreadExecutor()
        try {
            val result = worker.submit<Throwable?> {
                runCatching { copy.copy({ byteArrayOf(1).inputStream() }, { output }, { allowed.get() }) }.exceptionOrNull()
            }
            assertTrue("Pipe writer did not enter write", entered.await(1, TimeUnit.SECONDS))
            assertFalse("A full undrained pipe unexpectedly completed", result.isDone)
            if (revoke) { allowed.set(false); copy.close() }
            val next = CountDownLatch(1)
            worker.execute { next.countDown() }
            assertTrue("A blocked document output monopolized shared work", next.await(1, TimeUnit.SECONDS))
            assertTrue(result.get(1, TimeUnit.SECONDS) is IOException)
        } finally {
            // Releasing the reader also recovers platforms where closing the writer cannot interrupt write.
            pipe[0].close()
            copy.close()
            worker.shutdownNow()
            assertTrue(worker.awaitTermination(2, TimeUnit.SECONDS))
            assertTrue("Output lane did not recover after reader release", lane.tryAcquire(2, TimeUnit.SECONDS))
            lane.release()
            runCatching { output.close() }
        }
    }
}
