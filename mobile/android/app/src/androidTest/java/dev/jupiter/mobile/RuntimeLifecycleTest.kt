package dev.jupiter.mobile

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.core.app.ActivityScenario
import androidx.lifecycle.Lifecycle
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RuntimeLifecycleTest {
    @Test fun backgroundIdlePausesAndForegroundReopens() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
            withService { service ->
                val first = awaitPhase(service, "ready", 240)
                scenario.moveToState(Lifecycle.State.CREATED)
                awaitPhase(service, "idle", 85)
                scenario.moveToState(Lifecycle.State.RESUMED)
                val next = awaitPhase(service, "ready", 90)
                assertNotEquals(first.runId, next.runId)
                assertEquals(java.net.URI(first.url).authority, java.net.URI(next.url).authority)
            }
        }
    }

    @Test fun cancellationDuringStartupDoesNotPoisonTheNextLaunch() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        withService { service ->
            instrumentation.runOnMainSync { service.stopRuntime() }
            awaitPhase(service, "idle", 20)
            repeat(5) {
                instrumentation.runOnMainSync { context.startForegroundService(Intent(context, EngineService::class.java)) }
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                while (service.snapshot.phase !in setOf("starting", "ready", "fault") && System.nanoTime() < deadline) Thread.sleep(5)
                assertNotEquals("Runtime failed before cancellation", "fault", service.snapshot.phase)
                assertTrue("Startup never reached the cancellable process stage", service.snapshot.phase in setOf("starting", "ready"))
                val phases = java.util.concurrent.CopyOnWriteArrayList<String>()
                val observer: (EngineService.Snapshot) -> Unit = { phases.add(it.phase) }
                instrumentation.runOnMainSync { service.observe(observer); phases.clear() }
                instrumentation.runOnMainSync { service.stopRuntime() }
                awaitPhase(service, "idle", 20)
                instrumentation.runOnMainSync { service.unobserve(observer) }
                assertFalse("A late readiness packet reopened a stopping run", phases.contains("ready"))
                assertFalse("Startup cancellation left uncertain cleanup", File(context.filesDir, "runtime-cleanup-uncertain").exists())
            }
            instrumentation.runOnMainSync { context.startForegroundService(Intent(context, EngineService::class.java)) }
            awaitPhase(service, "ready", 90)
            instrumentation.runOnMainSync { service.stopRuntime() }
            awaitPhase(service, "idle", 20)
        }
    }

    @Test fun repeatedCleanupCannotEraseAnUncertainProcessTree() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        withService { service ->
            InstrumentationRegistry.getInstrumentation().runOnMainSync { service.stopRuntime() }
            awaitPhase(service, "idle", 20)
            val marker = File(context.filesDir, "runtime-cleanup-uncertain")
            assertFalse("Fixture requires a clean prior runtime", marker.exists())
            val process = ProcessBuilder("/system/bin/sleep", "30").start()
            try {
                val type = Class.forName("dev.jupiter.mobile.EngineService\$OwnedProcess")
                val constructor = type.getDeclaredConstructor(Process::class.java, String::class.java).apply { isAccessible = true }
                val owned = constructor.newInstance(process, java.util.UUID.randomUUID().toString())
                val identity = type.getDeclaredField("identified").apply { isAccessible = true }.get(owned) as CountDownLatch
                identity.countDown() // PID remains deliberately unverified: fallback must retain uncertainty.
                val cleanup = EngineService::class.java.getDeclaredMethod("terminateOwned", type).apply { isAccessible = true }
                cleanup.invoke(service, owned)
                assertFalse(process.isAlive)
                val cleaned = type.getDeclaredField("cleaned").apply { isAccessible = true }.get(owned) as java.util.concurrent.atomic.AtomicBoolean
                assertFalse(cleaned.get())
                assertTrue(marker.isFile)
                cleanup.invoke(service, owned)
                assertFalse("Second cleanup promoted a force-killed tree to clean", cleaned.get())
                assertTrue(marker.isFile)
            } finally {
                if (process.isAlive) process.destroyForcibly()
                assertTrue(process.waitFor(5, TimeUnit.SECONDS))
                assertTrue("Could not remove the generated fixture marker", marker.delete() || !marker.exists())
            }
        }
    }

    private fun withService(block: (EngineService) -> Unit) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val connected = CountDownLatch(1)
        var service: EngineService? = null
        val connection = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName, binder: IBinder) {
                service = (binder as EngineService.LocalBinder).service(); connected.countDown()
            }
            override fun onServiceDisconnected(name: ComponentName) { service = null }
        }
        instrumentation.runOnMainSync { assertTrue(context.bindService(Intent(context, EngineService::class.java), connection, Context.BIND_AUTO_CREATE)) }
        try {
            assertTrue("Service binding timed out", connected.await(10, TimeUnit.SECONDS))
            block(service!!)
        } finally { instrumentation.runOnMainSync { service?.stopRuntime(); context.unbindService(connection) } }
    }

    @Test fun productionHostStartsStopsAndReopensWithoutReplay() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val connected = CountDownLatch(1)
        var service: EngineService? = null
        val connection = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName, binder: IBinder) {
                service = (binder as EngineService.LocalBinder).service(); connected.countDown()
            }
            override fun onServiceDisconnected(name: ComponentName) { service = null }
        }
        instrumentation.runOnMainSync {
            context.startForegroundService(Intent(context, EngineService::class.java))
            assertTrue(context.bindService(Intent(context, EngineService::class.java), connection, Context.BIND_AUTO_CREATE))
        }
        try {
            assertTrue("Service binding timed out", connected.await(10, TimeUnit.SECONDS))
            val first = awaitPhase(service!!, "ready", 240)
            assertNotNull(first.runId)
            assertTrue("Live runtime has no persistent ownership marker", File(context.filesDir, "runtime-cleanup-uncertain").isFile)
            instrumentation.runOnMainSync { service!!.stopRuntime() }
            awaitPhase(service!!, "idle", 20)
            assertFalse("Clean shutdown retained an ownership marker", File(context.filesDir, "runtime-cleanup-uncertain").exists())
            instrumentation.runOnMainSync { context.startForegroundService(Intent(context, EngineService::class.java)) }
            val second = awaitPhase(service!!, "ready", 90)
            assertNotEquals("Restart reused the previous generation", first.runId, second.runId)
            assertEquals("Restart changed the WebView storage origin", java.net.URI(first.url).authority, java.net.URI(second.url).authority)
            instrumentation.runOnMainSync { service!!.stopRuntime() }
            awaitPhase(service!!, "idle", 20)
        } finally {
            instrumentation.runOnMainSync { service?.stopRuntime(); context.unbindService(connection) }
        }
    }

    private fun awaitPhase(service: EngineService, phase: String, seconds: Long): EngineService.Snapshot {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds)
        while (System.nanoTime() < deadline) {
            val state = service.snapshot
            if (state.phase == phase) return state
            assertNotEquals("Runtime failed: ${state.message}", "fault", state.phase)
            Thread.sleep(100)
        }
        throw AssertionError("Runtime did not reach $phase (last phase ${service.snapshot.phase})")
    }
}
